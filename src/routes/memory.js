// C:\HDUD_DATA\hdud-api-node\src\routes\memory.js

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";

import { authenticate } from "../middleware/auth.js";
import { requireMemoryOwnership } from "../middleware/ownership.js";
import { getPool, sql } from "../db.js";
import { ROLES, userHasRole } from "../middleware/roles.js";
import { enqueueMemoryAudioTranscriptionJob } from "../queue/memory-audio.queue.js";
import { enqueueMemoryImageProcessingJob } from "../queue/memory-image.queue.js";

import {
  createNarrativeEvent,
  buildEventKey,
} from "../services/narrative-events.js";
import {
  refineMemoryWithOpenAI,
  MEMORY_REFINER_PROMPT_VERSION,
} from "../services/narrative/memory-refiner.service.js";
import { regenerateEditorial, recalculateAffinity } from "../services/memory-editorial-intelligence.service.js";
import {
  getCurrentMemoryProvenance,
  ensureMemoryVersionProvenance,
} from "../services/memories/memory-provenance-segments.service.js";
import {
  checkPlanFeature,
  sendPlanDenied,
} from "../services/plan-enforcement.service.js";

const router = express.Router();

async function getLatestMemoryVersion(pool, memoryId) {
  const r = await pool
    .request()
    .input("memory_id", sql.Int, Number(memoryId))
    .query(`
      SELECT TOP 1 version_id, version_number, title, content, created_at, created_by,
             origin_code, source_proposal_id
      FROM dbo.identity_memory_versions
      WHERE memory_id = @memory_id
      ORDER BY version_number DESC, version_id DESC;
    `);
  return r.recordset?.[0] || null;
}

async function createMemoryAIProposal({
  pool,
  memoryId,
  authorId,
  sourceVersion,
  sourceTitle,
  sourceContent,
}) {
  const r = await pool
    .request()
    .input("memory_id", sql.Int, Number(memoryId))
    .input("author_id", sql.Int, Number(authorId))
    .input("source_version_id", sql.Int, sourceVersion?.version_id ?? null)
    .input("source_version_number", sql.Int, sourceVersion?.version_number ?? null)
    .input("source_title", sql.NVarChar(500), sourceTitle || null)
    .input("source_content", sql.NVarChar(sql.MAX), sourceContent)
    .input("prompt_version", sql.VarChar(50), MEMORY_REFINER_PROMPT_VERSION)
    .query(`
      INSERT INTO dbo.identity_memory_ai_proposal
      (
        memory_id, author_id,
        source_version_id, source_version_number,
        source_title, source_content, source_content_hash,
        prompt_version, proposal_status, created_at
      )
      OUTPUT INSERTED.proposal_id
      VALUES
      (
        @memory_id, @author_id,
        @source_version_id, @source_version_number,
        @source_title, @source_content,
        CONVERT(varchar(64), HASHBYTES('SHA2_256', CONVERT(varbinary(max), @source_content)), 2),
        @prompt_version, 'GENERATING', SYSUTCDATETIME()
      );
    `);
  return Number(r.recordset?.[0]?.proposal_id) || null;
}

async function finalizeMemoryAIProposal({
  pool,
  proposalId,
  aiResult,
  proposedTitle,
  proposedContent,
}) {
  const usageIds = Array.from(
    new Set(
      (Array.isArray(aiResult?.ai_usage_ids) ? aiResult.ai_usage_ids : [])
        .map(Number)
        .filter((v) => Number.isFinite(v) && v > 0)
    )
  );
  const primaryAIUsageId =
    Number(aiResult?.primary_ai_usage_id) ||
    (usageIds.length ? usageIds[usageIds.length - 1] : null);

  await pool
    .request()
    .input("proposal_id", sql.BigInt, Number(proposalId))
    .input("primary_ai_usage_id", sql.BigInt, primaryAIUsageId)
    .input("model", sql.VarChar(120), aiResult?.model || null)
    .input("prompt_version", sql.VarChar(50), aiResult?.prompt_version || MEMORY_REFINER_PROMPT_VERSION)
    .input("proposed_title", sql.NVarChar(500), proposedTitle || null)
    .input("proposed_content", sql.NVarChar(sql.MAX), proposedContent)
    .query(`
      UPDATE dbo.identity_memory_ai_proposal
      SET
        primary_ai_usage_id = @primary_ai_usage_id,
        provider = 'OPENAI',
        model = @model,
        prompt_version = @prompt_version,
        proposed_title = @proposed_title,
        proposed_content = @proposed_content,
        proposed_content_hash =
          CONVERT(varchar(64), HASHBYTES('SHA2_256', CONVERT(varbinary(max), @proposed_content)), 2),
        proposal_status = 'PENDING',
        generated_at = SYSUTCDATETIME(),
        error_detail = NULL
      WHERE proposal_id = @proposal_id;
    `);

  for (let index = 0; index < usageIds.length; index += 1) {
    await pool
      .request()
      .input("proposal_id", sql.BigInt, Number(proposalId))
      .input("ai_usage_id", sql.BigInt, usageIds[index])
      .input("usage_order", sql.Int, index + 1)
      .query(`
        IF NOT EXISTS
        (
          SELECT 1
          FROM dbo.identity_memory_ai_proposal_usage
          WHERE proposal_id=@proposal_id AND ai_usage_id=@ai_usage_id
        )
        BEGIN
          INSERT INTO dbo.identity_memory_ai_proposal_usage
            (proposal_id, ai_usage_id, usage_order)
          VALUES
            (@proposal_id, @ai_usage_id, @usage_order);
        END;
      `);
  }

  return { usageIds, primaryAIUsageId };
}

async function failMemoryAIProposal(pool, proposalId, detail) {
  if (!proposalId) return;
  try {
    await pool
      .request()
      .input("proposal_id", sql.BigInt, Number(proposalId))
      .input("error_detail", sql.NVarChar(1000), String(detail || "Falha ao gerar proposta.").slice(0, 1000))
      .query(`
        UPDATE dbo.identity_memory_ai_proposal
        SET proposal_status='FAILED',
            error_detail=@error_detail,
            generated_at=COALESCE(generated_at, SYSUTCDATETIME())
        WHERE proposal_id=@proposal_id
          AND proposal_status='GENERATING';
      `);
  } catch (err) {
    console.warn("[MEMORY_PROVENANCE] falha ao marcar proposal FAILED:", err?.message || err);
  }
}

async function classifyMemoryEditorialSafe({ memoryId, authorId, changedBy = null }) {
  try {
    const result = await regenerateEditorial({ memoryId, authorId, changedBy });
    // upsertEditorial já recalcula afinidade; chamada explícita mantém o contrato
    // resiliente caso a implementação interna mude no futuro.
    await recalculateAffinity({ memoryId, authorId });
    return { ok: true, result };
  } catch (err) {
    console.warn(`[MEI][memory ${memoryId}] classificação automática não bloqueou a memória:`, err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../../public");
const TMP_UPLOAD_DIR = path.join(PUBLIC_DIR, "_tmp", "memory-images");

try {
  fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
} catch {}

const imageUpload = multer({
  dest: TMP_UPLOAD_DIR,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const mime = String(file?.mimetype || "").trim().toLowerCase();
    if (
      mime === "image/jpeg" ||
      mime === "image/jpg" ||
      mime === "image/png" ||
      mime === "image/webp"
    ) {
      return cb(null, true);
    }

    return cb(
      new Error("Tipo de imagem inválido. Use JPG, JPEG, PNG ou WEBP.")
    );
  },
});

function canEditFromReq(req, authorId) {
  const tokenAuthorId = req.user?.author_id ?? null;

  if (tokenAuthorId == null) return true;
  if (Number(tokenAuthorId) === Number(authorId)) return true;

  return userHasRole(req.user, ROLES.SYSTEM_KERNEL, ROLES.AUTHOR_ADMIN);
}

function assertAuthorAccess(req, res, authorId) {
  if (canEditFromReq(req, authorId)) return true;
  res.status(403).json({ error: "Permissão negada." });
  return false;
}

function attachMeta(row, req, authorId) {
  const currentVersion =
    row?.version_number ??
    row?.current_version ??
    row?.version ??
    row?.versionNumber ??
    null;

  return {
    ...row,
    meta: {
      can_edit: canEditFromReq(req, authorId),
      current_version: currentVersion,
    },
  };
}

function extractSqlErrorDetail(err) {
  const msg =
    err?.originalError?.info?.message ||
    err?.originalError?.message ||
    err?.message ||
    null;

  const proc = err?.originalError?.info?.procName || err?.procName || null;
  const number = err?.originalError?.info?.number || err?.number || null;

  return {
    message: msg,
    procName: proc,
    number,
    code: err?.code || null,
  };
}

function pickFirstNonEmptyString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickFirstInt(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function coercePositiveInt(v) {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function pickAudioSecondsFromBody(body) {
  return (
    coercePositiveInt(body?.audio_seconds) ||
    coercePositiveInt(body?.audioSeconds) ||
    null
  );
}

function normalizeTextInput(v, maxLen = null) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return maxLen ? s.slice(0, maxLen) : s;
}

function normalizePhotoUrlInput(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;

  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, 1000);
}

function parseLifePhaseCode(val) {
  if (val === undefined) return undefined;
  if (val === null) return null;

  const s = String(val).trim();
  if (!s) return null;

  return s.toUpperCase();
}

function parsePhaseIdDirect(body) {
  if (body?.phase_id !== undefined) return body.phase_id;
  if (body?.phaseId !== undefined) return body.phaseId;
  return undefined;
}

function parseLifePhaseFlexible(body) {
  return parseLifePhaseCode(
    body?.life_phase ??
      body?.lifePhase ??
      body?.phase ??
      body?.phase_code ??
      body?.life_phase_code
  );
}

function editorialRefineText(input) {
  const s = String(input || "").trim();
  if (!s) return "";

  let out = s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([.!?])([^\s])/g, "$1 $2")
    .trim();

  if (out && !/[.!?…]$/.test(out)) out += ".";
  if (out.length > 1) out = out.charAt(0).toUpperCase() + out.slice(1);

  return out;
}

function resolvePublicStorageAbsolutePath(storagePath) {
  const raw = String(storagePath || "").trim();
  if (!raw) return null;

  const safeRelative = raw.replace(/^[/\\]+/, "");
  const absolute = path.resolve(PUBLIC_DIR, safeRelative);

  if (!absolute.startsWith(PUBLIC_DIR)) return null;
  return absolute;
}

function inferAudioExtension(media) {
  const mime = String(media?.mime_type || "").trim().toLowerCase();
  const originalName = String(media?.original_file_name || "")
    .trim()
    .toLowerCase();

  if (
    mime === "audio/mp4" ||
    mime === "audio/m4a" ||
    originalName.endsWith(".m4a")
  ) {
    return ".m4a";
  }
  if (mime === "audio/mpeg" || originalName.endsWith(".mp3")) {
    return ".mp3";
  }
  if (mime === "audio/webm" || originalName.endsWith(".webm")) {
    return ".webm";
  }
  if (mime === "audio/wav" || originalName.endsWith(".wav")) {
    return ".wav";
  }
  if (mime === "audio/ogg" || originalName.endsWith(".ogg")) {
    return ".ogg";
  }
  if (originalName.endsWith(".mp4")) {
    return ".mp4";
  }

  return "";
}

function buildExpectedAudioDir(media) {
  const authorId = coercePositiveInt(media?.author_id);
  const memoryId = coercePositiveInt(media?.memory_id);
  const mediaId = coercePositiveInt(media?.media_id);

  if (!authorId || !memoryId || !mediaId) return null;

  return path.resolve(
    PUBLIC_DIR,
    "memory-media",
    String(authorId),
    `memory_${memoryId}`,
    `media_${mediaId}`
  );
}

function resolveExistingOriginalFileInDir(dirPath, media) {
  if (!dirPath || !fs.existsSync(dirPath)) return null;

  const ext = inferAudioExtension(media);
  const preferred = ext ? path.join(dirPath, `original${ext}`) : null;
  if (preferred && fs.existsSync(preferred)) return preferred;

  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);

  const originalFile =
    files.find((name) => /^original\./i.test(name)) ||
    files.find((name) => String(name).toLowerCase() === "original") ||
    null;

  return originalFile ? path.join(dirPath, originalFile) : null;
}

function toPublicRelativePath(absolutePath) {
  if (!absolutePath) return null;
  const relative = path.relative(PUBLIC_DIR, absolutePath);
  if (!relative || relative.startsWith("..")) return null;
  return relative.split(path.sep).join("/");
}

function resolveAudioStorageMeta(media) {
  const currentStoragePath = normalizeTextInput(media?.storage_path);
  const expectedDir = buildExpectedAudioDir(media);

  if (currentStoragePath) {
    const absoluteCurrent = resolvePublicStorageAbsolutePath(currentStoragePath);
    if (absoluteCurrent && fs.existsSync(absoluteCurrent)) {
      return {
        absolutePath: absoluteCurrent,
        relativePath: toPublicRelativePath(absoluteCurrent),
        exists: true,
      };
    }
  }

  const reconstructed = resolveExistingOriginalFileInDir(expectedDir, media);
  if (reconstructed && fs.existsSync(reconstructed)) {
    return {
      absolutePath: reconstructed,
      relativePath: toPublicRelativePath(reconstructed),
      exists: true,
    };
  }

  if (currentStoragePath) {
    const absoluteCurrent = resolvePublicStorageAbsolutePath(currentStoragePath);
    return {
      absolutePath: absoluteCurrent,
      relativePath: currentStoragePath.replace(/^[/\\]+/, ""),
      exists: !!absoluteCurrent && fs.existsSync(absoluteCurrent),
    };
  }

  return {
    absolutePath: null,
    relativePath: null,
    exists: false,
  };
}

function getAudioDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const duration = Number(metadata?.format?.duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) {
        return reject(new Error("Duração do áudio inválida."));
      }

      resolve(Math.ceil(duration));
    });
  });
}

function buildImageOriginalStoragePath(authorId, memoryId, mediaId, extension = "jpg") {
  return [
    "memory-media",
    String(authorId),
    `memory_${memoryId}`,
    `media_${mediaId}`,
    `original.${String(extension || "jpg").replace(/^\./, "")}`,
  ].join("/");
}

function buildImagePendingStoragePath(authorId, memoryId, tempToken = null) {
  const suffix =
    normalizeTextInput(tempToken, 120) ||
    `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return [
    "memory-media",
    String(authorId),
    `memory_${memoryId}`,
    `${suffix}.upload`,
  ].join("/");
}

function inferImageExtensionFromUpload(file) {
  const mime = String(file?.mimetype || "").trim().toLowerCase();
  const original = String(file?.originalname || "").trim().toLowerCase();

  if (
    mime === "image/jpeg" ||
    mime === "image/jpg" ||
    original.endsWith(".jpg") ||
    original.endsWith(".jpeg")
  ) {
    return "jpg";
  }

  if (mime === "image/png" || original.endsWith(".png")) {
    return "png";
  }

  if (mime === "image/webp" || original.endsWith(".webp")) {
    return "webp";
  }

  return "jpg";
}


function ensureParentDirSync(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function resolvePublicRelativeToAbsolute(relativePath) {
  const safeRelative = String(relativePath || "").replace(/^[/\\]+/, "");
  if (!safeRelative) return null;

  const absolute = path.resolve(PUBLIC_DIR, safeRelative);
  if (!absolute.startsWith(PUBLIC_DIR)) return null;

  return absolute;
}

function normalizePublicCdnMemoryUrl(authorId, memoryId, variant = "original") {
  return `/cdn/memories/${Number(authorId)}/${Number(memoryId)}?variant=${String(
    variant || "original"
  ).toLowerCase()}`;
}

function safeRemoveDirectorySync(dirPath) {
  if (!dirPath) return;

  try {
    const absolute = path.resolve(dirPath);
    if (!absolute.startsWith(PUBLIC_DIR)) return;
    if (!fs.existsSync(absolute)) return;
    fs.rmSync(absolute, { recursive: true, force: true });
  } catch (err) {
    console.warn("[memory/photo] Falha ao remover diretório antigo:", err?.message || err);
  }
}

function imageMediaFolderFromStoragePath(storagePath) {
  const absolute = resolvePublicRelativeToAbsolute(storagePath);
  if (!absolute) return null;

  // storage_path aponta para original.jpg; a pasta da mídia é o parent.
  return path.dirname(absolute);
}

async function listOldImageMediaForCleanup(pool, memoryId, keepMediaId) {
  const result = await pool
    .request()
    .input("memory_id", sql.Int, Number(memoryId))
    .input("keep_media_id", sql.BigInt, Number(keepMediaId))
    .query(`
      SELECT
        media_id,
        storage_path
      FROM dbo.identity_memory_media
      WHERE memory_id = @memory_id
        AND media_type = 'image'
        AND media_id <> @keep_media_id;
    `);

  return result.recordset || [];
}

async function enforceSingleActiveImageMedia(pool, memoryId, keepMediaId) {
  await pool
    .request()
    .input("memory_id", sql.Int, Number(memoryId))
    .input("keep_media_id", sql.BigInt, Number(keepMediaId))
    .query(`
      UPDATE dbo.identity_memory_media
      SET
        is_primary_for_memory = CASE WHEN media_id = @keep_media_id THEN 1 ELSE 0 END,
        is_deleted = CASE WHEN media_id = @keep_media_id THEN 0 ELSE 1 END,
        updated_at = SYSUTCDATETIME()
      WHERE memory_id = @memory_id
        AND media_type = 'image';
    `);
}

async function resolveUserIdAndCode(pool, req, authorId) {
  let userId = pickFirstInt(req.user, ["user_id", "userId", "id", "uid"]);

  if (userId == null) {
    const subAsInt = pickFirstInt(req.user, ["sub"]);
    if (subAsInt != null) userId = subAsInt;
  }

  const email = pickFirstNonEmptyString(req.user, ["email", "mail", "upn"]);

  if (userId == null && email) {
    const r = await pool
      .request()
      .input("email", sql.NVarChar(510), email)
      .query(`
        SELECT TOP 1
          user_id,
          author_id,
          email
        FROM dbo.identity_user
        WHERE email = @email
        ORDER BY user_id DESC;
      `);

    const row = r.recordset?.[0] || null;
    if (row?.user_id != null) userId = Number(row.user_id);
    if (
      (authorId == null || Number.isNaN(Number(authorId))) &&
      row?.author_id != null
    ) {
      authorId = Number(row.author_id);
    }
  }

  let userCode = null;
  if (authorId != null && !Number.isNaN(Number(authorId))) {
    const r2 = await pool
      .request()
      .input("author_id", sql.Int, Number(authorId))
      .query(`
        SELECT TOP 1 author_code
        FROM dbo.identity_author
        WHERE author_id = @author_id;
      `);

    userCode = r2.recordset?.[0]?.author_code
      ? String(r2.recordset[0].author_code)
      : null;
  }

  if (!userCode) userCode = email || "hdud_api";
  userCode = String(userCode).slice(0, 200);

  return { userId, userCode, email, authorId };
}

async function resolveUserAudioProcessingProfile(pool, userId) {
  const profile = {
    userId: userId ?? null,
    isMockTranscriptionEnabled: false,
    planCode: null,
  };

  if (userId == null || Number.isNaN(Number(userId))) return profile;

  const userResult = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .query(`
      DECLARE @has_mock BIT = CASE
        WHEN COL_LENGTH('dbo.identity_user', 'is_mock_transcription_enabled') IS NOT NULL THEN 1
        ELSE 0
      END;

      DECLARE @has_plan_code BIT = CASE
        WHEN COL_LENGTH('dbo.identity_user', 'plan_code') IS NOT NULL THEN 1
        ELSE 0
      END;

      DECLARE @sql NVARCHAR(MAX) = N'
        SELECT TOP 1
          user_id, ';

      IF (@has_mock = 1)
        SET @sql += N'CONVERT(int, is_mock_transcription_enabled) AS is_mock_transcription_enabled, ';
      ELSE
        SET @sql += N'0 AS is_mock_transcription_enabled, ';

      IF (@has_plan_code = 1)
        SET @sql += N'CONVERT(varchar(30), plan_code) AS plan_code ';
      ELSE
        SET @sql += N'NULL AS plan_code ';

      SET @sql += N'
        FROM dbo.identity_user
        WHERE user_id = @user_id;
      ';

      EXEC sp_executesql
        @sql,
        N'@user_id BIGINT',
        @user_id = @user_id;
    `);

  const userRow = userResult.recordset?.[0] || null;
  if (userRow) {
    profile.isMockTranscriptionEnabled =
      userRow.is_mock_transcription_enabled === 1 ||
      userRow.is_mock_transcription_enabled === true;
    profile.planCode = userRow.plan_code
      ? String(userRow.plan_code).trim().toUpperCase()
      : null;
  }

  if (!profile.planCode) {
    const subResult = await pool
      .request()
      .input("user_id", sql.BigInt, Number(userId))
      .query(`
        SELECT TOP 1
          sp.code AS plan_code
        FROM dbo.user_subscription us
        JOIN dbo.subscription_plan sp
          ON sp.plan_id = us.plan_id
        WHERE us.user_id = @user_id
          AND us.status = 'ACTIVE'
        ORDER BY us.starts_at DESC, us.user_subscription_id DESC;
      `);

    const subRow = subResult.recordset?.[0] || null;
    if (subRow?.plan_code) {
      profile.planCode = String(subRow.plan_code).trim().toUpperCase();
    }
  }

  return profile;
}

async function resolvePhaseIdByCode(pool, phaseCodeOrNull) {
  if (phaseCodeOrNull == null) return null;

  const r = await pool
    .request()
    .input("phase_code", sql.NVarChar(50), phaseCodeOrNull)
    .query(`
      SELECT TOP 1 phase_id
      FROM dbo.identity_phase
      WHERE phase_code = @phase_code
        AND ISNULL(is_active, 1) = 1;
    `);

  const id = r.recordset?.[0]?.phase_id ?? null;
  return id != null ? Number(id) : null;
}

async function updateMemoryPhase(pool, memoryId, authorId, phaseCodeOrNull) {
  const phaseId = await resolvePhaseIdByCode(pool, phaseCodeOrNull);

  if (phaseCodeOrNull != null && phaseId == null) {
    const err = new Error(`life_phase inválida: ${phaseCodeOrNull}`);
    err.status = 422;
    throw err;
  }

  const req = pool.request();
  req.input("memory_id", sql.Int, memoryId);
  req.input("author_id", sql.Int, authorId);
  req.input("phase_id", sql.Int, phaseId);

  await req.query(`
    UPDATE m
    SET m.phase_id = @phase_id
    FROM dbo.identity_memory m
    WHERE m.memory_id = @memory_id
      AND m.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0;
  `);
}

async function updateMemoryPhotoUrl(pool, memoryId, photoUrl) {
  await pool
    .request()
    .input("memory_id", sql.Int, memoryId)
    .input("photo_url", sql.VarChar(1000), photoUrl)
    .query(`
      UPDATE dbo.identity_memory
      SET photo_url = @photo_url
      WHERE memory_id = @memory_id;
    `);
}

async function updateMemoryOriginType(pool, memoryId, originType) {
  await pool
    .request()
    .input("memory_id", sql.Int, memoryId)
    .input("origin_type", sql.VarChar(30), originType)
    .query(`
      IF COL_LENGTH('dbo.identity_memory', 'origin_type') IS NOT NULL
      BEGIN
        UPDATE dbo.identity_memory
        SET origin_type = @origin_type
        WHERE memory_id = @memory_id;
      END
    `);
}

async function persistMediaDurationSeconds(pool, mediaId, durationSeconds) {
  if (
    !Number.isInteger(Number(durationSeconds)) ||
    Number(durationSeconds) <= 0
  ) {
    return;
  }

  await pool
    .request()
    .input("media_id", sql.BigInt, mediaId)
    .input("duration_seconds", sql.Int, Number(durationSeconds))
    .query(`
      UPDATE dbo.identity_memory_media
      SET
        duration_seconds = @duration_seconds,
        updated_at = SYSUTCDATETIME()
      WHERE media_id = @media_id
        AND (
          duration_seconds IS NULL
          OR duration_seconds <> @duration_seconds
        );
    `);
}

async function persistMediaStoragePath(pool, mediaId, storagePath) {
  const normalized = normalizeTextInput(storagePath, 1000);
  if (!normalized) return;

  await pool
    .request()
    .input("media_id", sql.BigInt, mediaId)
    .input("storage_path", sql.VarChar(1000), normalized)
    .query(`
      UPDATE dbo.identity_memory_media
      SET
        storage_path = @storage_path,
        updated_at = SYSUTCDATETIME()
      WHERE media_id = @media_id
        AND ISNULL(storage_path, '') <> @storage_path;
    `);
}

async function ensureMemoryEditable(pool, memoryId) {
  const mem = await pool
    .request()
    .input("id", sql.Int, memoryId)
    .query(`
      SELECT TOP 1
        memory_id,
        author_id,
        is_deleted,
        title,
        content,
        version_number,
        publication_status,
        published_at,
        published_version_number
      FROM dbo.identity_memory
      WHERE memory_id = @id;
    `);

  const row = mem.recordset?.[0] || null;
  if (!row || row.is_deleted) return null;
  return row;
}

async function selectMemoryById(pool, memoryId) {
  const result = await pool
    .request()
    .input("id", sql.Int, memoryId)
    .query(`
      SELECT
        m.*,
        mc.chapter_id,
        m.phase_id,
        p.phase_code AS life_phase,
        p.name AS phase_name
      FROM dbo.identity_memory m
      OUTER APPLY (
        SELECT TOP 1 chapter_id
        FROM dbo.identity_memory_chapter
        WHERE memory_id = m.memory_id
        ORDER BY chapter_id ASC
      ) mc
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.memory_id = @id;
    `);

  return result.recordset?.[0] ?? null;
}

async function selectMemoryMediaById(pool, memoryId, mediaId) {
  const result = await pool
    .request()
    .input("memory_id", sql.Int, memoryId)
    .input("media_id", sql.BigInt, mediaId)
    .query(`
      SELECT TOP 1
        media_id,
        memory_id,
        author_id,
        media_type,
        storage_provider,
        storage_path,
        original_file_name,
        mime_type,
        file_size_bytes,
        duration_seconds,
        transcription_status,
        transcription_raw,
        transcription_validated,
        transcription_refined,
        language_code,
        stt_provider,
        stt_job_id,
        is_primary_for_memory,
        is_deleted,
        created_at,
        updated_at
      FROM dbo.identity_memory_media
      WHERE memory_id = @memory_id
        AND media_id = @media_id
        AND ISNULL(is_deleted, 0) = 0;
    `);

  return result.recordset?.[0] || null;
}

async function listMemoryMedia(pool, memoryId, mediaType = null) {
  const req = pool.request().input("memory_id", sql.Int, memoryId);

  let whereMediaType = "";
  if (mediaType) {
    req.input("media_type", sql.VarChar(20), mediaType);
    whereMediaType = " AND media_type = @media_type ";
  }

  const result = await req.query(`
    SELECT
      media_id,
      memory_id,
      author_id,
      media_type,
      storage_provider,
      storage_path,
      original_file_name,
      mime_type,
      file_size_bytes,
      duration_seconds,
      transcription_status,
      transcription_raw,
      transcription_validated,
      transcription_refined,
      language_code,
      stt_provider,
      stt_job_id,
      is_primary_for_memory,
      is_deleted,
      created_at,
      updated_at
    FROM dbo.identity_memory_media
    WHERE memory_id = @memory_id
      AND ISNULL(is_deleted, 0) = 0
      ${whereMediaType}
    ORDER BY is_primary_for_memory DESC, created_at DESC, media_id DESC;
  `);

  return result.recordset || [];
}

function attachMediaComputed(row) {
  if (!row) return null;

  return {
    ...row,
    audio_url:
      row.media_type === "audio" &&
      row.memory_id != null &&
      row.media_id != null &&
      row.author_id != null
        ? `/cdn/memory-media/${Number(row.author_id)}/${Number(
            row.memory_id
          )}/${Number(row.media_id)}/original`
        : null,
  };
}

async function insertMediaRevision(
  pool,
  {
    mediaId,
    memoryId,
    authorId,
    revisionType,
    contentText,
    approvedByAuthor = false,
  }
) {
  if (!contentText || !String(contentText).trim()) return;

  await pool
    .request()
    .input("media_id", sql.BigInt, mediaId)
    .input("memory_id", sql.Int, memoryId)
    .input("author_id", sql.Int, authorId)
    .input("revision_type", sql.VarChar(30), revisionType)
    .input("content_text", sql.NVarChar(sql.MAX), String(contentText))
    .input("approved_by_author", sql.Bit, approvedByAuthor ? 1 : 0)
    .query(`
      INSERT INTO dbo.identity_memory_media_revision
      (
        media_id,
        memory_id,
        author_id,
        revision_type,
        content_text,
        approved_by_author
      )
      VALUES
      (
        @media_id,
        @memory_id,
        @author_id,
        @revision_type,
        @content_text,
        @approved_by_author
      );
    `);
}

async function emitNarrativeEventSafe(payload) {
  try {
    await createNarrativeEvent(payload);
  } catch (err) {
    console.warn("NarrativeEvent failed:", err?.message);
  }
}

function getPublicationStatus(row) {
  const raw = normalizeTextInput(row?.publication_status, 20);
  return raw && raw.toUpperCase() === "PUBLISHED" ? "PUBLISHED" : "DRAFT";
}

function buildPublicationPendingRequirements(memory) {
  const out = [];

  if (!normalizeTextInput(memory?.title)) out.push("MISSING_TITLE");
  if (!normalizeTextInput(memory?.content)) out.push("MISSING_CONTENT");
  if (memory?.is_deleted) out.push("MEMORY_DELETED");

  const versionNumber = Number(memory?.version_number);
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    out.push("INVALID_VERSION");
  }

  return out;
}

function isMemoryPublishable(memory) {
  return buildPublicationPendingRequirements(memory).length === 0;
}

function buildPublicationSnapshot(memory) {
  const persistedStatus = getPublicationStatus(memory);
  const publishable = isMemoryPublishable(memory);

  return {
    persisted_status: persistedStatus,
    status: persistedStatus,
    is_publishable: publishable,
    pending_requirements: publishable
      ? []
      : buildPublicationPendingRequirements(memory),
    published_at:
      persistedStatus === "PUBLISHED" ? memory?.published_at ?? null : null,
    published_version_number:
      persistedStatus === "PUBLISHED"
        ? memory?.published_version_number ?? null
        : null,
  };
}

router.post("/", authenticate, async (req, res) => {
  try {
    const { author_id, title = null, content } = req.body || {};
    const photoUrlInput = normalizePhotoUrlInput(req.body?.photo_url);

    const authorIdCandidate = author_id ?? req.user?.author_id ?? null;

    if (
      authorIdCandidate == null ||
      Number.isNaN(parseInt(authorIdCandidate, 10))
    ) {
      return res
        .status(400)
        .json({ error: "author_id é obrigatório e deve ser número." });
    }

    const authorId = parseInt(authorIdCandidate, 10);
    if (!assertAuthorAccess(req, res, authorId)) return;

    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "content é obrigatório." });
    }

    const pool = await getPool();
    const { userId, userCode } = await resolveUserIdAndCode(pool, req, authorId);

    if (userId == null || Number.isNaN(Number(userId))) {
      return res.status(400).json({
        error: "Não foi possível resolver UserId (identity_user por email).",
      });
    }

    const result = await pool
      .request()
      .input("AuthorId", sql.Int, Number(authorId))
      .input("Title", sql.NVarChar(500), title ? String(title) : null)
      .input("Content", sql.NVarChar(sql.MAX), String(content))
      .input("UserId", sql.Int, Number(userId))
      .input("UserCode", sql.NVarChar(100), String(userCode).slice(0, 100))
      .execute("dbo.p_CreateMemory_WithVersion");

    const row = result?.recordset?.[0];
    if (!row) return res.status(500).json({ error: "Falha ao criar memória." });

    const memoryId = Number(row.memory_id);

    if (photoUrlInput !== undefined) {
      await updateMemoryPhotoUrl(pool, memoryId, photoUrlInput);
    }

    let fresh = await selectMemoryById(pool, memoryId);

    await classifyMemoryEditorialSafe({
      memoryId,
      authorId,
      changedBy: String(userCode || "hdud_api"),
    });
    fresh = await selectMemoryById(pool, memoryId);

    await emitNarrativeEventSafe({
      authorId,
      eventType: "memory_created",
      memoryId,
      eventKey: buildEventKey("memory_created", [
        "author",
        authorId,
        "memory",
        memoryId,
      ]),
      metadata: {
        title: row.title ?? null,
      },
    });

    return res.status(201).json(attachMeta(fresh || row, req, authorId));
  } catch (err) {
    console.error("[POST /memory] erro:", err);
    return res.status(500).json({
      error: "Erro ao criar memória.",
      detail: extractSqlErrorDetail(err),
    });
  }
});

router.get("/:id", authenticate, async (req, res) => {
  try {
    const memoryId = coercePositiveInt(req.params.id);

    if (memoryId == null) {
      return res.status(400).json({ error: "id inválido." });
    }

    const pool = await getPool();
    const memory = await selectMemoryById(pool, memoryId);

    if (!memory || memory.is_deleted) {
      return res.status(404).json({ error: "Memória não encontrada." });
    }

    const authorId = coercePositiveInt(memory.author_id);
    if (authorId == null) {
      return res.status(500).json({ error: "Autor da memória inválido." });
    }

    const tokenAuthorId = coercePositiveInt(req.user?.author_id);
    const isPrivileged = userHasRole(
      req.user,
      ROLES.SYSTEM_KERNEL,
      ROLES.AUTHOR_ADMIN
    );

    if ((tokenAuthorId != null && tokenAuthorId === authorId) || isPrivileged) {
      return res.json(attachMeta(memory, req, authorId));
    }

    let viewerAuthorId = tokenAuthorId;

    let resolvedIdentity = null;
    if (viewerAuthorId == null) {
      resolvedIdentity = await resolveUserIdAndCode(pool, req, null);
      viewerAuthorId = coercePositiveInt(resolvedIdentity?.authorId);
    }

    if (viewerAuthorId == null) {
      const fallbackUserId =
        coercePositiveInt(resolvedIdentity?.userId) ??
        coercePositiveInt(req.user?.user_id) ??
        coercePositiveInt(req.user?.userId) ??
        coercePositiveInt(req.user?.id) ??
        coercePositiveInt(req.user?.uid) ??
        coercePositiveInt(req.user?.sub);

      if (fallbackUserId != null) {
        const authorResult = await pool
          .request()
          .input("user_id", sql.Int, fallbackUserId)
          .query(`
            SELECT TOP 1 author_id
            FROM dbo.identity_author
            WHERE user_id = @user_id
            ORDER BY author_id DESC;
          `);

        viewerAuthorId = coercePositiveInt(authorResult.recordset?.[0]?.author_id);
      }
    }

    if (viewerAuthorId != null && viewerAuthorId === authorId) {
      return res.json(attachMeta(memory, req, authorId));
    }

    if (viewerAuthorId == null) {
      return res.status(403).json({ error: "Permissão negada." });
    }

    if (getPublicationStatus(memory) !== "PUBLISHED") {
      return res.status(403).json({ error: "Permissão negada." });
    }

    const followCheck = await pool
      .request()
      .input("viewer_id", sql.Int, viewerAuthorId)
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT TOP 1 1 AS ok
        FROM dbo.identity_follow
        WHERE follower_id = @viewer_id
          AND followed_id = @author_id;
      `);

    if (!followCheck.recordset?.length) {
      return res.status(403).json({ error: "Permissão negada." });
    }

    return res.json(attachMeta(memory, req, authorId));
  } catch (err) {
    console.error("[GET /memory/:id] erro:", err);
    return res.status(500).json({
      error: "Erro ao carregar memória.",
      detail: extractSqlErrorDetail(err),
    });
  }
});


router.post(
  "/:id/editorial-suggestion",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = coercePositiveInt(req.params.id);
      if (memoryId == null) {
        return res.status(400).json({ error: "id inválido." });
      }

      const pool = await getPool();
      const memory = await selectMemoryById(pool, memoryId);

      if (!memory || memory.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = coercePositiveInt(memory.author_id);
      if (authorId == null) {
        return res.status(500).json({ error: "Autor da memória inválido." });
      }

      if (!assertAuthorAccess(req, res, authorId)) return;

      const { userId } = await resolveUserIdAndCode(pool, req, authorId);

      const sourceTitle = normalizeTextInput(req.body?.title, 510);
      const sourceContent = normalizeTextInput(req.body?.content);

      const memoryForRefine = {
        ...memory,
        title: sourceTitle !== undefined ? sourceTitle : memory.title,
        content: sourceContent !== undefined ? sourceContent : memory.content,
        phase_code: memory.life_phase || memory.phase_code || null,
      };

      if (!normalizeTextInput(memoryForRefine.content)) {
        return res.status(422).json({
          error: "Conteúdo obrigatório para sugestão editorial.",
        });
      }

      const sourceVersion = await getLatestMemoryVersion(pool, memoryId);
      const proposalId = await createMemoryAIProposal({
        pool,
        memoryId,
        authorId,
        sourceVersion,
        sourceTitle: memoryForRefine.title || null,
        sourceContent: memoryForRefine.content || "",
      });

      if (!proposalId) {
        return res.status(500).json({ error: "Não foi possível abrir a proposta editorial." });
      }

      let aiResult;
      try {
        aiResult = await refineMemoryWithOpenAI({
          memory: memoryForRefine,
          options: {
            mode: "memory_editorial_suggestion",
            preserve_voice: true,
            intensity: Number(req.body?.intensity || 7),
            language: req.body?.language || "pt-BR",
          },
          voiceProfile: null,
          usageContext: {
            userId,
            authorId,
            operationCode: "MEMORY_EDITORIAL_REFINE",
            entityType: "MEMORY",
            entityId: memoryId,
            metadata: {
              memory_id: memoryId,
              proposal_id: proposalId,
              prompt_version: MEMORY_REFINER_PROMPT_VERSION,
            },
          },
        });
      } catch (err) {
        await failMemoryAIProposal(pool, proposalId, err?.message || err);
        throw err;
      }

      if (!aiResult?.ok) {
        await failMemoryAIProposal(pool, proposalId, aiResult?.reason);
        return res.status(503).json({
          error: "Não foi possível gerar sugestão editorial agora.",
          detail: aiResult?.reason || "Serviço editorial indisponível.",
          proposal_id: proposalId,
        });
      }

      const proposedTitle =
        aiResult.result?.refined_title || memoryForRefine.title || null;
      const proposedContent =
        aiResult.result?.refined_content || memoryForRefine.content || "";

      const provenance = await finalizeMemoryAIProposal({
        pool,
        proposalId,
        aiResult,
        proposedTitle,
        proposedContent,
      });

      return res.json({
        ok: true,
        memory_id: memoryId,
        proposal_id: proposalId,
        ai_usage_id: provenance.primaryAIUsageId,
        ai_usage_ids: provenance.usageIds,
        prompt_version: aiResult.prompt_version || MEMORY_REFINER_PROMPT_VERSION,
        original: {
          title: memoryForRefine.title || null,
          content: memoryForRefine.content || "",
        },
        suggestion: {
          title: proposedTitle,
          content: proposedContent,
        },
        editorial: {
          model: aiResult.model || null,
          prompt_version: aiResult.prompt_version || MEMORY_REFINER_PROMPT_VERSION,
          voice_preserved: aiResult.result?.voice_preserved !== false,
          voice_profile_used: aiResult.result?.voice_profile_used === true,
          emotional_intensity: aiResult.result?.emotional_intensity ?? null,
          changes_summary: Array.isArray(aiResult.result?.changes_summary)
            ? aiResult.result.changes_summary
            : [],
          source_policy:
            aiResult.result?.source_policy ||
            "Somente memória real do autor. Sem conteúdo inventado.",
        },
      });
    } catch (err) {
      console.error("[POST /memory/:id/editorial-suggestion] erro:", err);
      return res.status(500).json({
        error: "Erro ao gerar sugestão editorial.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.post(
  "/:id/editorial-apply",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = coercePositiveInt(req.params.id);
      if (memoryId == null) {
        return res.status(400).json({ error: "id inválido." });
      }

      const proposalId = coercePositiveInt(req.body?.proposal_id);
      if (proposalId == null) {
        return res.status(422).json({
          error: "proposal_id é obrigatório para aplicar sugestão editorial.",
        });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);

      if (!mem) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(mem.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const { userId, userCode } = await resolveUserIdAndCode(pool, req, authorId);
      if (!userId) {
        return res.status(401).json({ error: "userId não encontrado no token." });
      }

      const transaction = new sql.Transaction(pool);
      await transaction.begin();

      let updated = null;
      let acceptedVersion = null;
      let proposal = null;
      let versionOriginCode = null;
      let acceptanceMode = null;

      try {
        const proposalResult = await new sql.Request(transaction)
          .input("proposal_id", sql.BigInt, Number(proposalId))
          .input("memory_id", sql.Int, memoryId)
          .input("author_id", sql.Int, authorId)
          .query(`
            SELECT TOP 1 *
            FROM dbo.identity_memory_ai_proposal WITH (UPDLOCK, HOLDLOCK)
            WHERE proposal_id=@proposal_id
              AND memory_id=@memory_id
              AND author_id=@author_id;
          `);

        proposal = proposalResult.recordset?.[0] || null;

        if (!proposal) {
          await transaction.rollback();
          return res.status(404).json({ error: "Proposta editorial não encontrada." });
        }

        if (String(proposal.proposal_status).toUpperCase() !== "PENDING") {
          await transaction.rollback();
          return res.status(409).json({
            error: "Proposta editorial já decidida ou indisponível.",
            proposal_status: proposal.proposal_status,
          });
        }

        const proposedContent = normalizeTextInput(proposal.proposed_content);
        if (!proposedContent) {
          await transaction.rollback();
          return res.status(422).json({ error: "Proposta editorial sem conteúdo persistido." });
        }

        const acceptedContent =
          normalizeTextInput(req.body?.content) || proposedContent;

        const proposedTitle =
          normalizeTextInput(proposal.proposed_title, 510) ??
          (mem.title != null ? String(mem.title).slice(0, 510) : null);

        const acceptedTitle =
          normalizeTextInput(req.body?.title, 510) ?? proposedTitle;

        const authorModifiedProposal =
          acceptedContent !== proposedContent ||
          String(acceptedTitle || "") !== String(proposedTitle || "");

        versionOriginCode = authorModifiedProposal
          ? "AUTHOR_EDIT"
          : "AI_ACCEPTED";

        acceptanceMode = authorModifiedProposal
          ? "AUTHOR_MODIFIED"
          : "EXACT";

        const newContent = acceptedContent;
        const titleToPersist = acceptedTitle;

        const result = await new sql.Request(transaction)
          .input("MemoryId", sql.Int, memoryId)
          .input("NewTitle", sql.NVarChar(510), titleToPersist)
          .input("NewContent", sql.NVarChar(sql.MAX), newContent)
          .input("UserId", sql.Int, Number(userId))
          .input("AuthorId", sql.Int, authorId)
          .input("UserCode", sql.NVarChar(200), String(userCode).slice(0, 200))
          .execute("dbo.p_UpdateMemory_WithVersion");

        updated = result?.recordset?.[0] || null;

        const versionResult = await new sql.Request(transaction)
          .input("memory_id", sql.Int, memoryId)
          .input("proposal_id", sql.BigInt, Number(proposalId))
          .query(`
            SELECT TOP 1 version_id, version_number
            FROM dbo.identity_memory_versions
            WHERE memory_id=@memory_id
            ORDER BY version_number DESC, version_id DESC;
          `);

        acceptedVersion = versionResult.recordset?.[0] || null;
        if (!acceptedVersion?.version_id) {
          throw new Error("Versão aceita não foi localizada após atualização.");
        }

        await new sql.Request(transaction)
          .input("VersionId", sql.Int, Number(acceptedVersion.version_id))
          .input("ProposalId", sql.BigInt, Number(proposalId))
          .input("OriginCode", sql.VarChar(32), versionOriginCode)
          .input("UserId", sql.Int, Number(userId))
          .input("AuthorId", sql.Int, authorId)
          .input("AcceptedTitle", sql.NVarChar(500), acceptedTitle || null)
          .input("AcceptedContent", sql.NVarChar(sql.MAX), acceptedContent)
          .input("AcceptanceMode", sql.VarChar(24), acceptanceMode)
          .execute("dbo.p_SetMemoryVersionProvenance");

        await transaction.commit();
      } catch (txErr) {
        try {
          if (transaction._aborted !== true) await transaction.rollback();
        } catch {}
        throw txErr;
      }

      // Persistência granular é idempotente e também possui backfill no GET /provenance.
      // Se houver falha operacional aqui, não invalidamos o aceite já commitado.
      try {
        if (acceptedVersion?.version_id) {
          await ensureMemoryVersionProvenance(pool, Number(acceptedVersion.version_id));
        }
      } catch (provenanceErr) {
        console.error("[memory provenance] falha ao persistir versão aceita:", provenanceErr);
      }

      const fresh = await selectMemoryById(pool, memoryId);

      return res.json({
        ok: true,
        memory_id: memoryId,
        proposal_id: proposalId,
        ai_usage_id: proposal?.primary_ai_usage_id || null,
        accepted_version_id: acceptedVersion?.version_id || null,
        accepted_version_number: acceptedVersion?.version_number || null,
        origin_code: versionOriginCode,
        acceptance_mode: acceptanceMode,
        applied: true,
        versioned: true,
        source: "memory_editorial_suggestion",
        memory: attachMeta(fresh || updated || { ok: true, memory_id: memoryId }, req, authorId),
      });
    } catch (err) {
      console.error("[POST /memory/:id/editorial-apply] erro:", err);
      return res.status(500).json({
        error: "Erro ao aplicar sugestão editorial.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.post(
  "/:id/editorial-reject",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = coercePositiveInt(req.params.id);
      const proposalId = coercePositiveInt(req.body?.proposal_id);

      if (memoryId == null || proposalId == null) {
        return res.status(400).json({ error: "memory_id/proposal_id inválido." });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);
      if (!mem) return res.status(404).json({ error: "Memória não encontrada." });

      const authorId = Number(mem.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const { userId } = await resolveUserIdAndCode(pool, req, authorId);

      const result = await pool
        .request()
        .input("proposal_id", sql.BigInt, Number(proposalId))
        .input("memory_id", sql.Int, memoryId)
        .input("author_id", sql.Int, authorId)
        .input("user_id", sql.Int, Number(userId))
        .query(`
          UPDATE dbo.identity_memory_ai_proposal
          SET proposal_status='REJECTED',
              decided_at=SYSUTCDATETIME(),
              decided_by_user_id=@user_id,
              decided_by_author_id=@author_id
          OUTPUT INSERTED.proposal_id, INSERTED.proposal_status, INSERTED.decided_at
          WHERE proposal_id=@proposal_id
            AND memory_id=@memory_id
            AND author_id=@author_id
            AND proposal_status='PENDING';
        `);

      const rejected = result.recordset?.[0] || null;
      if (!rejected) {
        const current = await pool
          .request()
          .input("proposal_id", sql.BigInt, Number(proposalId))
          .input("memory_id", sql.Int, memoryId)
          .query(`
            SELECT TOP 1 proposal_status
            FROM dbo.identity_memory_ai_proposal
            WHERE proposal_id=@proposal_id AND memory_id=@memory_id;
          `);

        if (!current.recordset?.[0]) {
          return res.status(404).json({ error: "Proposta editorial não encontrada." });
        }

        return res.status(409).json({
          error: "Proposta editorial já decidida ou indisponível.",
          proposal_status: current.recordset[0].proposal_status,
        });
      }

      return res.json({
        ok: true,
        memory_id: memoryId,
        proposal_id: Number(rejected.proposal_id),
        proposal_status: rejected.proposal_status,
        decided_at: rejected.decided_at,
        memory_unchanged: true,
      });
    } catch (err) {
      console.error("[POST /memory/:id/editorial-reject] erro:", err);
      return res.status(500).json({
        error: "Erro ao rejeitar sugestão editorial.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.put(
  "/:id",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "id inválido." });
      }

      const newTitle =
        typeof req.body?.title === "string"
          ? req.body.title.trim().slice(0, 510)
          : null;

      const newContent =
        typeof req.body?.content === "string" ? req.body.content.trim() : "";

      if (!newContent) {
        return res.status(400).json({ error: "content é obrigatório." });
      }

      const photoUrlInput = normalizePhotoUrlInput(req.body?.photo_url);
      const phaseIdDirectRaw = parsePhaseIdDirect(req.body || {});
      const lifePhaseCodeParsed = parseLifePhaseFlexible(req.body || {});

      const pool = await getPool();

      const mem = await pool
        .request()
        .input("id", sql.Int, memoryId)
        .query(
          `SELECT TOP 1 memory_id, author_id, is_deleted FROM dbo.identity_memory WHERE memory_id=@id;`
        );

      const row = mem.recordset?.[0] || null;
      if (!row || row.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(row.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const { userId, userCode } = await resolveUserIdAndCode(pool, req, authorId);
      if (!userId) {
        return res.status(401).json({ error: "userId não encontrado no token." });
      }

      const result = await pool
        .request()
        .input("MemoryId", sql.Int, memoryId)
        .input("NewTitle", sql.NVarChar(510), newTitle)
        .input("NewContent", sql.NVarChar(sql.MAX), newContent)
        .input("UserId", sql.Int, Number(userId))
        .input("AuthorId", sql.Int, authorId)
        .input("UserCode", sql.NVarChar(200), String(userCode).slice(0, 200))
        .execute("dbo.p_UpdateMemory_WithVersion");

      const updated = result?.recordset?.[0] || null;

      // Edição manual: a procedure cria nova versão; o trigger a classifica
      // como AUTHOR_EDIT e aqui persistimos a granularidade herdando a
      // proveniência da versão anterior.
      try {
        const latestAfterAuthorEdit = await getLatestMemoryVersion(pool, memoryId);
        if (latestAfterAuthorEdit?.version_id) {
          await ensureMemoryVersionProvenance(pool, Number(latestAfterAuthorEdit.version_id));
        }
      } catch (provenanceErr) {
        console.error("[memory provenance] falha ao persistir edição autoral:", provenanceErr);
      }

      if (phaseIdDirectRaw !== undefined) {
        if (phaseIdDirectRaw === null) {
          await updateMemoryPhase(pool, memoryId, authorId, null);
        } else {
          const n = Number(phaseIdDirectRaw);
          if (!Number.isInteger(n) || n <= 0) {
            return res.status(422).json({ error: "phase_id inválido." });
          }

          const chk = await pool
            .request()
            .input("pid", sql.Int, n)
            .query(`
              SELECT TOP 1 phase_id
              FROM dbo.identity_phase
              WHERE phase_id=@pid AND ISNULL(is_active,1)=1;
            `);

          if (!chk.recordset?.[0]?.phase_id) {
            return res.status(422).json({
              error: "phase_id não existe ou está inativo.",
            });
          }

          const reqUp = pool.request();
          reqUp.input("memory_id", sql.Int, memoryId);
          reqUp.input("author_id", sql.Int, authorId);
          reqUp.input("phase_id", sql.Int, n);

          await reqUp.query(`
            UPDATE m
            SET m.phase_id = @phase_id
            FROM dbo.identity_memory m
            WHERE m.memory_id = @memory_id
              AND m.author_id = @author_id
              AND ISNULL(m.is_deleted, 0) = 0;
          `);
        }
      } else if (lifePhaseCodeParsed !== undefined) {
        await updateMemoryPhase(pool, memoryId, authorId, lifePhaseCodeParsed);
      }

      if (photoUrlInput !== undefined) {
        await updateMemoryPhotoUrl(pool, memoryId, photoUrlInput);
      }

      const fresh = await selectMemoryById(pool, memoryId);
      return res.json(
        attachMeta(
          fresh || updated || { ok: true, memory_id: memoryId },
          req,
          authorId
        )
      );
    } catch (err) {
      if (err?.status === 422) {
        return res.status(422).json({ error: err.message });
      }

      console.error("[PUT /memory/:id] erro:", err);
      return res.status(500).json({
        error: "Erro ao atualizar memória.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.get(
  "/:id/provenance",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "id inválido." });
      }
      const pool = await getPool();
      const provenance = await getCurrentMemoryProvenance(pool, memoryId);
      if (!provenance) return res.status(404).json({ error: "Memória/versão não encontrada." });
      return res.json({ ok: true, ...provenance });
    } catch (err) {
      console.error("[GET /memory/:id/provenance] erro:", err);
      return res.status(500).json({
        error: "Erro ao carregar proveniência da memória.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.get(
  "/:id/versions",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (Number.isNaN(memoryId)) {
        return res.status(400).json({ error: "id inválido." });
      }

      const pool = await getPool();
      const result = await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .query(`
          SELECT
            memory_id,
            version_number,
            title,
            content,
            created_at,
            created_by
          FROM dbo.identity_memory_versions
          WHERE memory_id = @memory_id
          ORDER BY version_number DESC;
        `);

      return res.json({ memory_id: memoryId, versions: result.recordset || [] });
    } catch (err) {
      console.error("[GET /memory/:id/versions] erro:", err);
      return res.status(500).json({ error: "Erro ao carregar versões." });
    }
  }
);

// =========================================================
// HDUD — Publication Engine v2
// Base editorial: DRAFT | PUBLISHED
// =========================================================

router.get(
  "/:id/publication",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "id inválido." });
      }

      const pool = await getPool();
      const memory = await selectMemoryById(pool, memoryId);

      if (!memory || memory.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const publication = buildPublicationSnapshot(memory);

      return res.json({
        memory_id: memoryId,
        status: publication.status,
        persisted_status: publication.persisted_status,
        is_publishable: publication.is_publishable,
        pending_requirements: publication.pending_requirements,
        published_at: publication.published_at,
        published_version_number: publication.published_version_number,
      });
    } catch (err) {
      console.error("[GET /memory/:id/publication] erro:", err);
      return res
        .status(500)
        .json({ error: "Erro ao carregar status de publicação." });
    }
  }
);

router.post(
  "/:id/publish",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "id inválido." });
      }

      const expectedVersion = Number(req.body?.expected_version_number);
      if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
        return res.status(400).json({
          error: "expected_version_number é obrigatório.",
          code: "MEMORY_VERSION_CONFLICT",
        });
      }

      const pool = await getPool();
      const memory = await selectMemoryById(pool, memoryId);

      if (!memory || memory.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(memory.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const currentStatus = getPublicationStatus(memory);

      if (currentStatus === "PUBLISHED") {
        return res.status(409).json({
          error: "Memória já publicada.",
          code: "MEMORY_ALREADY_PUBLISHED",
        });
      }

      const publication = buildPublicationSnapshot(memory);
      if (!publication.is_publishable) {
        return res.status(422).json({
          error: "Memória não publicável.",
          code: "MEMORY_NOT_PUBLISHABLE",
          pending_requirements: publication.pending_requirements,
        });
      }

      const currentVersion = Number(memory.version_number);
      if (currentVersion !== expectedVersion) {
        return res.status(409).json({
          error: "Conflito de versão da memória.",
          code: "MEMORY_VERSION_CONFLICT",
          current_version_number: currentVersion,
          expected_version_number: expectedVersion,
        });
      }

      const updateResult = await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .input("expected_version_number", sql.Int, expectedVersion)
        .query(`
          UPDATE dbo.identity_memory
          SET
            publication_status = 'PUBLISHED',
            published_at = SYSUTCDATETIME(),
            published_version_number = @expected_version_number
          WHERE memory_id = @memory_id
            AND ISNULL(is_deleted, 0) = 0
            AND version_number = @expected_version_number
            AND UPPER(LTRIM(RTRIM(ISNULL(CONVERT(varchar(50), publication_status), 'DRAFT')))) <> 'PUBLISHED';

          SELECT @@ROWCOUNT AS affected_rows;
        `);

      const affectedRows = Number(updateResult.recordset?.[0]?.affected_rows || 0);
      if (affectedRows !== 1) {
        const fresh = await selectMemoryById(pool, memoryId);
        const freshVersion = Number(fresh?.version_number);

        if (getPublicationStatus(fresh) === "PUBLISHED") {
          return res.status(409).json({
            error: "Memória já publicada.",
            code: "MEMORY_ALREADY_PUBLISHED",
          });
        }

        return res.status(409).json({
          error: "Conflito de versão da memória.",
          code: "MEMORY_VERSION_CONFLICT",
          current_version_number: freshVersion || null,
          expected_version_number: expectedVersion,
        });
      }

      await emitNarrativeEventSafe({
        authorId,
        eventType: "MEMORY_PUBLISHED",
        memoryId,
        eventKey: buildEventKey("memory_published", [
          "author",
          authorId,
          "memory",
          memoryId,
          "version",
          expectedVersion,
        ]),
        metadata: {
          publication_status: "PUBLISHED",
          published_version_number: expectedVersion,
        },
      });

      const fresh = await selectMemoryById(pool, memoryId);

      return res.json({
        ok: true,
        memory_id: memoryId,
        status: "PUBLISHED",
        published_at: fresh?.published_at || new Date().toISOString(),
        published_version_number: expectedVersion,
      });
    } catch (err) {
      console.error("[POST /memory/:id/publish] erro:", err);
      return res.status(500).json({
        error: "Erro ao publicar memória.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.post(
  "/:id/unpublish",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "id inválido." });
      }

      const pool = await getPool();
      const memory = await selectMemoryById(pool, memoryId);

      if (!memory || memory.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(memory.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const currentStatus = getPublicationStatus(memory);

      if (currentStatus !== "PUBLISHED") {
        return res.status(409).json({
          error: "Memória já está em rascunho.",
          code: "MEMORY_ALREADY_DRAFT",
        });
      }

      await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .query(`
          UPDATE dbo.identity_memory
          SET
            publication_status = 'DRAFT',
            published_at = NULL,
            published_version_number = NULL
          WHERE memory_id = @memory_id
            AND ISNULL(is_deleted, 0) = 0
            AND UPPER(LTRIM(RTRIM(ISNULL(CONVERT(varchar(50), publication_status), 'DRAFT')))) = 'PUBLISHED';
        `);

      await emitNarrativeEventSafe({
        authorId,
        eventType: "MEMORY_UNPUBLISHED",
        memoryId,
        eventKey: buildEventKey("memory_unpublished", [
          "author",
          authorId,
          "memory",
          memoryId,
        ]),
        metadata: {
          publication_status: "DRAFT",
        },
      });

      return res.json({
        ok: true,
        memory_id: memoryId,
        status: "DRAFT",
        published_at: null,
        published_version_number: null,
      });
    } catch (err) {
      console.error("[POST /memory/:id/unpublish] erro:", err);
      return res.status(500).json({
        error: "Erro ao despublicar memória.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

/* =========================================================
   HDUD — Foto da Memória (Media Pipeline Assíncrono)
   ========================================================= */

router.post(
  "/:id/photo",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  imageUpload.single("file"),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        if (req.file?.path) {
          try {
            fs.unlinkSync(req.file.path);
          } catch {}
        }
        return res.status(400).json({ error: "memory_id inválido." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "Arquivo de imagem obrigatório." });
      }

      const pool = await getPool();
      const memory = await ensureMemoryEditable(pool, memoryId);

      if (!memory) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(memory.author_id);
      if (!assertAuthorAccess(req, res, authorId)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return;
      }

      const { userId } = await resolveUserIdAndCode(pool, req, authorId);
      if (userId == null || Number.isNaN(Number(userId))) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res.status(401).json({
          ok: false,
          error: "userId não encontrado no token.",
        });
      }

      const uploadCheck = await checkPlanFeature({
        pool,
        userId,
        featureCode: "UPLOAD_MAX_BYTES",
        requestedValue: Number(req.file.size || 0),
      });

      if (!uploadCheck.allowed) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return sendPlanDenied(res, uploadCheck, {
          status: 413,
          message: "O arquivo excede o limite de upload do seu plano.",
        });
      }

      const uploadExt = inferImageExtensionFromUpload(req.file);
      const pendingStoragePath = buildImagePendingStoragePath(
        authorId,
        memoryId,
        path.basename(String(req.file.filename || "upload"))
      );

      const insertResult = await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .input("author_id", sql.Int, authorId)
        .input("media_type", sql.VarChar(20), "image")
        .input("storage_provider", sql.VarChar(30), "local")
        .input("storage_path", sql.NVarChar(500), pendingStoragePath)
        .input(
          "original_file_name",
          sql.NVarChar(260),
          normalizeTextInput(req.file.originalname, 260)
        )
        .input(
          "mime_type",
          sql.VarChar(100),
          normalizeTextInput(req.file.mimetype, 100)
        )
        .input("file_size_bytes", sql.BigInt, Number(req.file.size || 0))
        .query(`
          INSERT INTO dbo.identity_memory_media
          (
            memory_id,
            author_id,
            media_type,
            storage_provider,
            storage_path,
            original_file_name,
            mime_type,
            file_size_bytes,
            is_primary_for_memory,
            is_deleted,
            created_at,
            updated_at
          )
          OUTPUT INSERTED.media_id
          VALUES
          (
            @memory_id,
            @author_id,
            @media_type,
            @storage_provider,
            @storage_path,
            @original_file_name,
            @mime_type,
            @file_size_bytes,
            0,
            0,
            SYSUTCDATETIME(),
            SYSUTCDATETIME()
          );
        `);

      const mediaId = Number(insertResult.recordset?.[0]?.media_id || 0);

      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res.status(500).json({ error: "Falha ao registrar mídia da imagem." });
      }

      const finalStoragePath = buildImageOriginalStoragePath(
        authorId,
        memoryId,
        mediaId,
        uploadExt
      );
      const finalAbsolutePath = resolvePublicRelativeToAbsolute(finalStoragePath);

      if (!finalAbsolutePath) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res.status(500).json({ error: "storage_path final da imagem inválido." });
      }

      ensureParentDirSync(finalAbsolutePath);
      fs.copyFileSync(req.file.path, finalAbsolutePath);

      if (!fs.existsSync(finalAbsolutePath)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res.status(500).json({ error: "Falha ao persistir imagem no storage final." });
      }

      await persistMediaStoragePath(pool, mediaId, finalStoragePath);

      const oldImageMedia = await listOldImageMediaForCleanup(pool, memoryId, mediaId);
      await enforceSingleActiveImageMedia(pool, memoryId, mediaId);

      const canonicalPhotoUrl = normalizePublicCdnMemoryUrl(authorId, memoryId, "original");
      await updateMemoryPhotoUrl(pool, memoryId, canonicalPhotoUrl);

      // Regra de produto HDUD: 1 memória = 1 mídia de imagem ativa.
      // Histórico editorial permanece em versões/diff/rollback; imagem antiga vira lixo operacional.
      for (const oldMedia of oldImageMedia) {
        const oldDir = imageMediaFolderFromStoragePath(oldMedia?.storage_path);
        const finalDir = path.dirname(finalAbsolutePath);
        if (oldDir && path.resolve(oldDir) !== path.resolve(finalDir)) {
          safeRemoveDirectorySync(oldDir);
        }
      }

      const job = await enqueueMemoryImageProcessingJob({
        memoryId,
        mediaId,
        authorId,
        userId:
          coercePositiveInt(req.user?.user_id) ??
          coercePositiveInt(req.user?.userId) ??
          coercePositiveInt(req.user?.id) ??
          coercePositiveInt(req.user?.uid) ??
          coercePositiveInt(req.user?.sub) ??
          null,
        mimeType: req.file.mimetype,
        originalFileName: req.file.originalname,
        requestedVariant: "feed",
        tempFilePath: req.file.path,
      });

      await emitNarrativeEventSafe({
        authorId,
        eventType: "memory_image_uploaded",
        memoryId,
        eventKey: buildEventKey("memory_image_uploaded", [
          "author",
          authorId,
          "memory",
          memoryId,
          "media",
          mediaId,
        ]),
        metadata: {
          media_id: mediaId,
          media_type: "image",
          mime_type: req.file.mimetype || null,
          queued: true,
          queue_job_id: String(job.id),
          storage_path: finalStoragePath,
        },
      });

      return res.status(202).json({
        ok: true,
        queued: true,
        memory_id: memoryId,
        media_id: mediaId,
        queue_job_id: String(job.id),
        media_type: "image",
        processing_status: "pending",
        storage_path: finalStoragePath,
        cdn: {
          canonical_memory_url: canonicalPhotoUrl,
          canonical_media_url: `/cdn/memory-media/${authorId}/${memoryId}/${mediaId}/feed`,
        },
      });
    } catch (err) {
      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }

      const isMulterFileSize =
        err?.code === "LIMIT_FILE_SIZE" ||
        /File too large/i.test(String(err?.message || ""));

      const isMulterMime =
        /Tipo de imagem inválido/i.test(String(err?.message || ""));

      console.error("[POST /memory/:id/photo] erro:", err);

      if (isMulterFileSize) {
        return res.status(413).json({
          error: "Arquivo muito grande.",
          detail: "O arquivo excede o teto técnico de 50MB.",
        });
      }

      if (isMulterMime) {
        return res.status(415).json({
          error: "Tipo de imagem inválido.",
          detail: "Use JPG, JPEG, PNG ou WEBP.",
        });
      }

      return res.status(500).json({
        error: "Erro ao enviar imagem da memória.",
        detail: err?.message || extractSqlErrorDetail(err),
      });
    }
  }
);

/* =========================================================
   HDUD — Voz da Memória
   ========================================================= */

router.get(
  "/:id/audio",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);
      if (!mem) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const items = await listMemoryMedia(pool, memoryId, "audio");
      return res.json({
        ok: true,
        memory_id: memoryId,
        items: items.map(attachMediaComputed),
      });
    } catch (err) {
      console.error("[GET /memory/:id/audio] erro:", err);
      return res
        .status(500)
        .json({ error: "Erro ao carregar áudios da memória." });
    }
  }
);

router.get(
  "/:id/audio/:mediaId",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      const mediaId = parseInt(req.params.mediaId, 10);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return res.status(400).json({ error: "media_id inválido." });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);
      if (!mem) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const media = await selectMemoryMediaById(pool, memoryId, mediaId);
      if (!media || String(media.media_type).toLowerCase() !== "audio") {
        return res.status(404).json({ error: "Áudio não encontrado." });
      }

      return res.json({
        ok: true,
        memory_id: memoryId,
        media: attachMediaComputed(media),
      });
    } catch (err) {
      console.error("[GET /memory/:id/audio/:mediaId] erro:", err);
      return res.status(500).json({ error: "Erro ao carregar áudio da memória." });
    }
  }
);

router.post(
  "/:id/audio/:mediaId/transcribe",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      const mediaId = parseInt(req.params.mediaId, 10);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return res.status(400).json({ error: "media_id inválido." });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);
      if (!mem) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(mem.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const { userId } = await resolveUserIdAndCode(pool, req, authorId);

      const media = await selectMemoryMediaById(pool, memoryId, mediaId);
      if (!media || String(media.media_type).toLowerCase() !== "audio") {
        return res.status(404).json({ error: "Áudio não encontrado." });
      }

      const transcriptionRaw = normalizeTextInput(req.body?.transcription_raw);
      const languageCode =
        normalizeTextInput(req.body?.language_code, 20) || "pt-BR";
      const sttProvider =
        normalizeTextInput(req.body?.stt_provider, 50) || "openai";

      if (transcriptionRaw) {
        const newStatus = "transcribed";
        const sttJobId = `manual:${Date.now()}`;

        await pool
          .request()
          .input("media_id", sql.BigInt, mediaId)
          .input("transcription_status", sql.VarChar(30), newStatus)
          .input("transcription_raw", sql.NVarChar(sql.MAX), transcriptionRaw)
          .input("language_code", sql.VarChar(20), languageCode)
          .input("stt_provider", sql.VarChar(50), sttProvider)
          .input("stt_job_id", sql.NVarChar(120), sttJobId)
          .query(`
            UPDATE dbo.identity_memory_media
            SET
              transcription_status = @transcription_status,
              transcription_raw = @transcription_raw,
              language_code = COALESCE(@language_code, language_code),
              stt_provider = COALESCE(@stt_provider, stt_provider),
              stt_job_id = COALESCE(@stt_job_id, stt_job_id),
              updated_at = SYSUTCDATETIME()
            WHERE media_id = @media_id;
          `);

        await insertMediaRevision(pool, {
          mediaId,
          memoryId,
          authorId,
          revisionType: "raw",
          contentText: transcriptionRaw,
          approvedByAuthor: false,
        });

        await emitNarrativeEventSafe({
          authorId,
          eventType: "memory_audio_transcribed",
          memoryId,
          eventKey: buildEventKey("memory_audio_transcribed", [
            "author",
            authorId,
            "memory",
            memoryId,
            "media",
            mediaId,
            "status",
            newStatus,
          ]),
          metadata: {
            media_id: mediaId,
            media_type: "audio",
            transcription_status: newStatus,
            stt_provider: sttProvider,
            stt_job_id: sttJobId,
          },
        });

        const freshManual = await selectMemoryMediaById(pool, memoryId, mediaId);

        return res.json({
          ok: true,
          queued: false,
          memory_id: memoryId,
          media_id: mediaId,
          media: attachMediaComputed(freshManual),
        });
      }

      if (userId == null || Number.isNaN(Number(userId))) {
        return res.status(401).json({
          ok: false,
          error: "userId não encontrado no token.",
        });
      }

      const processingProfile = await resolveUserAudioProcessingProfile(pool, userId);
      const isInternalProcessing =
        processingProfile.isMockTranscriptionEnabled ||
        String(processingProfile.planCode || "").toUpperCase() === "INTERNAL";

      const storageMeta = resolveAudioStorageMeta(media);

      if (!storageMeta.absolutePath || !storageMeta.relativePath) {
        return res.status(500).json({
          ok: false,
          error: "storage_path do áudio inválido.",
        });
      }

      if (!storageMeta.exists) {
        return res.status(404).json({
          ok: false,
          error: "Arquivo de áudio não encontrado no storage local.",
        });
      }

      if (
        storageMeta.relativePath &&
        String(media.storage_path || "").trim() !== storageMeta.relativePath
      ) {
        await persistMediaStoragePath(pool, mediaId, storageMeta.relativePath);
      }

      const requestedAudioSeconds = pickAudioSecondsFromBody(req.body || {});
      const existingMediaDurationSeconds = coercePositiveInt(media.duration_seconds);

      let audioSeconds = requestedAudioSeconds;

      if (audioSeconds == null) {
        try {
          audioSeconds = await getAudioDurationSeconds(storageMeta.absolutePath);
        } catch (durationErr) {
          if (existingMediaDurationSeconds != null) {
            console.warn(
              "[memory/transcribe] ffprobe falhou; usando duration_seconds já persistido:",
              existingMediaDurationSeconds,
              durationErr?.message || durationErr
            );
            audioSeconds = existingMediaDurationSeconds;
          } else if (!isInternalProcessing) {
            console.error("[quota/getAudioDurationSeconds] erro:", durationErr);
            return res.status(500).json({
              ok: false,
              error: "Não foi possível identificar a duração do áudio.",
              detail: durationErr?.message || null,
            });
          } else {
            console.warn(
              "[memory/transcribe] duração não identificada em modo INTERNAL/mock:",
              durationErr?.message || durationErr
            );
            audioSeconds = 1;
          }
        }
      }

      if (coercePositiveInt(audioSeconds)) {
        await persistMediaDurationSeconds(pool, mediaId, Number(audioSeconds));
      }

      const transcriptionCheck = await checkPlanFeature({
        pool,
        userId,
        featureCode: "AUDIO_TRANSCRIPTION_SECONDS",
        requestedValue: Number(audioSeconds || 0),
      });

      if (!transcriptionCheck.allowed) {
        return sendPlanDenied(res, transcriptionCheck, {
          status: 403,
          message: "A franquia mensal de áudio/transcrição foi atingida.",
        });
      }

      // A rota faz o CHECK econômico antes do enqueue.
      // A reserva/consumo definitivo do áudio continua pertencendo ao worker,
      // preservando o fluxo assíncrono e a contabilização homologada.
      //
      // Regra editorial de retranscrição:
      // - tentativa ainda não validada/refinada/aprovada é descartável;
      // Retranscrever = nova tentativa editorial.
      // A memória já aplicada/versionada NÃO é revertida e o histórico em
      // identity_memory_media_revision permanece preservado. Somente o estado
      // corrente do wizard é reiniciado antes do enqueue.
      //
      // Fazemos isso ANTES do enqueue para evitar condição de corrida com worker rápido.
      await pool
        .request()
        .input("media_id", sql.BigInt, mediaId)
        .input("transcription_status", sql.VarChar(30), "processing")
        .input(
          "stt_provider",
          sql.VarChar(50),
          isInternalProcessing ? "internal_queue" : "openai_queue"
        )
        .query(`
          UPDATE dbo.identity_memory_media
          SET
            transcription_status = @transcription_status,
            stt_provider = @stt_provider,
            stt_job_id = NULL,
            transcription_raw = NULL,
            transcription_validated = NULL,
            transcription_refined = NULL,
            updated_at = SYSUTCDATETIME()
          WHERE media_id = @media_id;
        `);

      let job;
      try {
        job = await enqueueMemoryAudioTranscriptionJob({
          memoryId,
          mediaId,
          authorId,
          userId,
          audioSeconds,
          planCode: processingProfile.planCode || null,
        });
      } catch (queueErr) {
        await pool
          .request()
          .input("media_id", sql.BigInt, mediaId)
          .query(`
            UPDATE dbo.identity_memory_media
            SET transcription_status = 'failed',
                updated_at = SYSUTCDATETIME()
            WHERE media_id = @media_id;
          `)
          .catch(() => {});
        throw queueErr;
      }

      await pool
        .request()
        .input("media_id", sql.BigInt, mediaId)
        .input("stt_job_id", sql.NVarChar(120), String(job.id))
        .query(`
          UPDATE dbo.identity_memory_media
          SET stt_job_id = @stt_job_id,
              updated_at = SYSUTCDATETIME()
          WHERE media_id = @media_id;
        `);

      const fresh = await selectMemoryMediaById(pool, memoryId, mediaId);

      return res.status(202).json({
        ok: true,
        queued: true,
        memory_id: memoryId,
        media_id: mediaId,
        queue_job_id: String(job.id),
        media: attachMediaComputed(fresh),
      });
    } catch (err) {
      let status = Number(err?.status) || 500;

      if (status === 401 || status === 403) {
        status = 502;
      }

      console.error("[POST /memory/:id/audio/:mediaId/transcribe] erro:", err);

      return res.status(status).json({
        error: "Erro ao enfileirar transcrição do áudio da memória.",
        detail: err?.message || extractSqlErrorDetail(err),
      });
    }
  }
);

router.put(
  "/:id/audio/:mediaId/validate",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      const mediaId = parseInt(req.params.mediaId, 10);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return res.status(400).json({ error: "media_id inválido." });
      }

      const transcriptionValidated = normalizeTextInput(
        req.body?.transcription_validated
      );

      if (!transcriptionValidated) {
        return res.status(400).json({
          error: "transcription_validated é obrigatório.",
        });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);
      if (!mem) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(mem.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const media = await selectMemoryMediaById(pool, memoryId, mediaId);
      if (!media || String(media.media_type).toLowerCase() !== "audio") {
        return res.status(404).json({ error: "Áudio não encontrado." });
      }

      await pool
        .request()
        .input("media_id", sql.BigInt, mediaId)
        .input("transcription_validated", sql.NVarChar(sql.MAX), transcriptionValidated)
        .query(`
          UPDATE dbo.identity_memory_media
          SET
            transcription_validated = @transcription_validated,
            transcription_status = 'validated',
            updated_at = SYSUTCDATETIME()
          WHERE media_id = @media_id;
        `);

      await insertMediaRevision(pool, {
        mediaId,
        memoryId,
        authorId,
        revisionType: "validated",
        contentText: transcriptionValidated,
        approvedByAuthor: true,
      });

      await emitNarrativeEventSafe({
        authorId,
        eventType: "memory_audio_validated",
        memoryId,
        eventKey: buildEventKey("memory_audio_validated", [
          "author",
          authorId,
          "memory",
          memoryId,
          "media",
          mediaId,
        ]),
        metadata: {
          media_id: mediaId,
          media_type: "audio",
          transcription_status: "validated",
        },
      });

      const fresh = await selectMemoryMediaById(pool, memoryId, mediaId);

      return res.json({
        ok: true,
        memory_id: memoryId,
        media_id: mediaId,
        media: attachMediaComputed(fresh),
      });
    } catch (err) {
      console.error("[PUT /memory/:id/audio/:mediaId/validate] erro:", err);
      return res.status(500).json({
        error: "Erro ao validar transcrição do áudio.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.post(
  "/:id/audio/:mediaId/refine",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      const mediaId = parseInt(req.params.mediaId, 10);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return res.status(400).json({ error: "media_id inválido." });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);
      if (!mem) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(mem.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const { userId } = await resolveUserIdAndCode(pool, req, authorId);

      const media = await selectMemoryMediaById(pool, memoryId, mediaId);
      if (!media || String(media.media_type).toLowerCase() !== "audio") {
        return res.status(404).json({ error: "Áudio não encontrado." });
      }

      const sourceText =
        normalizeTextInput(req.body?.source_text) ||
        normalizeTextInput(media.transcription_validated) ||
        normalizeTextInput(media.transcription_raw);

      if (!sourceText) {
        return res.status(422).json({
          error: "Não há texto para refinar.",
          detail: "Transcreva e valide o áudio antes do retoque editorial.",
        });
      }

      const aiResult = await refineMemoryWithOpenAI({
        memory: {
          ...mem,
          memory_id: memoryId,
          author_id: authorId,
          title: mem.title || null,
          content: sourceText,
          phase_code: mem.life_phase || mem.phase_code || null,
        },
        options: {
          mode: "memory_audio_editorial_refine",
          preserve_voice: true,
          intensity: Number(req.body?.intensity || 7),
          language: req.body?.language || "pt-BR",
        },
        voiceProfile: null,
        usageContext: {
          userId,
          authorId,
          operationCode: "AUDIO_EDITORIAL_REFINE",
          entityType: "MEMORY_MEDIA",
          entityId: mediaId,
          metadata: { memory_id: memoryId },
        },
      });

      if (!aiResult?.ok || !normalizeTextInput(aiResult?.result?.refined_content)) {
        return res.status(503).json({
          error: "Não foi possível gerar o refino editorial agora.",
          detail:
            aiResult?.reason ||
            "O motor editorial não retornou um texto refinado válido.",
        });
      }

      const refinedText = String(aiResult.result.refined_content).trim();

      await pool
        .request()
        .input("media_id", sql.BigInt, mediaId)
        .input("transcription_refined", sql.NVarChar(sql.MAX), refinedText)
        .query(`
          UPDATE dbo.identity_memory_media
          SET
            transcription_refined = @transcription_refined,
            transcription_status = 'refined',
            updated_at = SYSUTCDATETIME()
          WHERE media_id = @media_id;
        `);

      await insertMediaRevision(pool, {
        mediaId,
        memoryId,
        authorId,
        revisionType: "refined",
        contentText: refinedText,
        approvedByAuthor: false,
      });

      await emitNarrativeEventSafe({
        authorId,
        eventType: "memory_audio_refined",
        memoryId,
        eventKey: buildEventKey("memory_audio_refined", [
          "author",
          authorId,
          "memory",
          memoryId,
          "media",
          mediaId,
        ]),
        metadata: {
          media_id: mediaId,
          media_type: "audio",
          transcription_status: "refined",
        },
      });

      const fresh = await selectMemoryMediaById(pool, memoryId, mediaId);

      return res.json({
        ok: true,
        memory_id: memoryId,
        media_id: mediaId,
        media: attachMediaComputed(fresh),
      });
    } catch (err) {
      console.error("[POST /memory/:id/audio/:mediaId/refine] erro:", err);
      return res.status(500).json({
        error: "Erro ao gerar retoque editorial do áudio.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

router.post(
  "/:id/audio/:mediaId/apply",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      const mediaId = parseInt(req.params.mediaId, 10);

      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return res.status(400).json({ error: "media_id inválido." });
      }

      const mode = String(req.body?.mode || "replace_memory_content")
        .trim()
        .toLowerCase();
      if (mode !== "replace_memory_content" && mode !== "append_memory_content") {
        return res.status(400).json({
          error: "mode inválido.",
          detail: "Use replace_memory_content ou append_memory_content.",
        });
      }

      const pool = await getPool();
      const mem = await ensureMemoryEditable(pool, memoryId);
      if (!mem) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(mem.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const media = await selectMemoryMediaById(pool, memoryId, mediaId);
      if (!media || String(media.media_type).toLowerCase() !== "audio") {
        return res.status(404).json({ error: "Áudio não encontrado." });
      }

      const finalText =
        normalizeTextInput(media.transcription_refined) ||
        normalizeTextInput(media.transcription_validated) ||
        normalizeTextInput(media.transcription_raw);

      if (!finalText) {
        return res.status(422).json({
          error: "Não há texto final para aplicar.",
          detail: "Transcreva/valide/refine antes de aplicar na memória.",
        });
      }

      const { userId, userCode } = await resolveUserIdAndCode(pool, req, authorId);
      if (!userId) {
        return res.status(401).json({ error: "userId não encontrado no token." });
      }

      const existingTitle = mem.title != null ? String(mem.title) : null;
      const currentContent = mem.content != null ? String(mem.content) : "";
      const newContent =
        mode === "append_memory_content"
          ? [currentContent.trim(), finalText.trim()].filter(Boolean).join("\n\n")
          : finalText;

      const result = await pool
        .request()
        .input("MemoryId", sql.Int, memoryId)
        .input("NewTitle", sql.NVarChar(510), existingTitle)
        .input("NewContent", sql.NVarChar(sql.MAX), newContent)
        .input("UserId", sql.Int, Number(userId))
        .input("AuthorId", sql.Int, authorId)
        .input("UserCode", sql.NVarChar(200), String(userCode).slice(0, 200))
        .execute("dbo.p_UpdateMemory_WithVersion");

      await pool
        .request()
        .input("media_id", sql.BigInt, mediaId)
        .query(`
          UPDATE dbo.identity_memory_media
          SET
            transcription_status = 'approved',
            updated_at = SYSUTCDATETIME()
          WHERE media_id = @media_id;
        `);

      await updateMemoryOriginType(pool, memoryId, "narrated_audio");

      await insertMediaRevision(pool, {
        mediaId,
        memoryId,
        authorId,
        revisionType: "approved",
        contentText: finalText,
        approvedByAuthor: true,
      });

      await emitNarrativeEventSafe({
        authorId,
        eventType: "memory_audio_approved",
        memoryId,
        eventKey: buildEventKey("memory_audio_approved", [
          "author",
          authorId,
          "memory",
          memoryId,
          "media",
          mediaId,
        ]),
        metadata: {
          media_id: mediaId,
          media_type: "audio",
          transcription_status: "approved",
          apply_mode: mode,
        },
      });

      await classifyMemoryEditorialSafe({
        memoryId,
        authorId,
        changedBy: String(userCode || "hdud_api"),
      });

      const freshMemory = await selectMemoryById(pool, memoryId);
      const freshMedia = await selectMemoryMediaById(pool, memoryId, mediaId);

      return res.json({
        ok: true,
        applied: true,
        mode,
        memory_id: memoryId,
        media_id: mediaId,
        memory: attachMeta(
          freshMemory || result?.recordset?.[0] || { memory_id: memoryId },
          req,
          authorId
        ),
        media: attachMediaComputed(freshMedia),
      });
    } catch (err) {
      console.error("[POST /memory/:id/audio/:mediaId/apply] erro:", err);
      return res.status(500).json({
        error: "Erro ao aplicar texto do áudio na memória.",
        detail: extractSqlErrorDetail(err),
      });
    }
  }
);

export default router;