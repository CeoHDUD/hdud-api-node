// C:\HDUD_DATA\hdud-api-node\src\routes\chapters.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import {
  createNarrativeEvent,
  buildEventKey,
} from "../services/narrative-events.js";
import {
  generateChapterSuggestion,
  getLatestChapterSuggestion,
} from "../services/chapters/chapter-ai.service.js";
import {
  approveEditorialGeneration,
  generateEditorialChapter,
  getEditorialGeneration,
} from "../services/chapters/chapter-editorial.service.js";
import {
  regenerateChapter,
  acceptChapterRegeneration,
  discardChapterRegeneration,
} from "../services/chapters/chapter-regeneration.service.js";
import {
  getChapterProvenance,
} from "../services/chapters/chapter-provenance.service.js";
import {
  persistEditedVersionProvenance,
} from "../services/chapters/chapter-provenance-spans.service.js";
import {
  getChapterStoryLineage,
  linkStoryToChapter,
  unlinkStoryFromChapter,
  rebuildChapterStoryLineage,
} from "../services/chapters/story-chapter-lineage.service.js";
import {
  saveApprovedStory,
} from "../services/story/story-editorial.service.js";
import {
  checkPlanFeature,
  checkNarrativeAiGenerationQuota,
  reservePlanQuota,
  reserveNarrativeAiGenerationQuota,
  commitPlanQuotaReservation,
  releasePlanQuotaReservation,
  sendPlanDenied,
} from "../services/plan-enforcement.service.js";

const router = express.Router();

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function ensureAuthorId(req, res) {
  const authorId = req?.user?.author_id;
  if (!authorId) {
    res.status(401).json({ error: "Não autenticado." });
    return null;
  }
  return Number(authorId);
}

function ensureUserId(req, res) {
  const raw =
    req?.user?.user_id ??
    req?.user?.userId ??
    req?.user?.id ??
    req?.user?.uid ??
    req?.user?.sub;
  const userId = Number(raw);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(401).json({ error: "user_id não encontrado no token." });
    return null;
  }
  return userId;
}

function normalizePublicationStatus(value) {
  const s = String(value ?? "").trim().toUpperCase();

  if (s === "PUBLISHED" || s === "PUBLIC" || s === "SHARED") {
    return "PUBLIC";
  }

  return "DRAFT";
}

function normalizeChapterRow(r) {
  if (!r) return null;

  const publicationStatus = normalizePublicationStatus(
    r.publication_status ??
      r.publication_status_effective ??
      r.status
  );

  return {
    chapter_id: r.chapter_id,
    author_id: r.author_id,
    title: r.title,
    description: r.description,
    status: publicationStatus,
    publication_status: publicationStatus,
    current_version_id: r.current_version_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published_at: publicationStatus === "PUBLIC" ? r.published_at ?? null : null,
    published_version_number:
      r.published_version_number != null ? Number(r.published_version_number) : null,
  };
}

function normalizeChapterVersionRow(r) {
  if (!r) return null;
  return {
    chapter_version_id: r.chapter_version_id,
    chapter_id: r.chapter_id,
    author_id: r.author_id,
    title_snapshot: r.title_snapshot,
    body: r.body,
    created_at: r.created_at,
  };
}

function normalizeApplyScope(value) {
  const s = String(value ?? "all").trim().toLowerCase();
  if (s === "title" || s === "summary" || s === "all") return s;
  return null;
}

function normalizeOptionalText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function normalizeComparableText(value) {
  if (value == null) return "";
  return String(value).replace(/\r\n/g, "\n").trim();
}

function normalizeBitFlag(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value ? 1 : 0;

  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "sim", "s"].includes(s)) return 1;
  if (["0", "false", "no", "n", "nao", "não"].includes(s)) return 0;

  const n = Number(value);
  if (Number.isFinite(n)) return n ? 1 : 0;

  return fallback;
}

function createRequest(db) {
  return new sql.Request(db);
}

async function assertChapterOwned(pool, authorId, chapterId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1 chapter_id
      FROM dbo.identity_chapter
      WHERE chapter_id = @chapter_id
        AND author_id  = @author_id
        AND ISNULL(is_deleted,0) = 0;
    `);

  return !!r.recordset?.[0]?.chapter_id;
}

async function assertMemoryOwned(pool, authorId, memoryId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .query(`
      SELECT TOP 1 memory_id
      FROM dbo.identity_memory
      WHERE memory_id = @memory_id
        AND author_id = @author_id
        AND ISNULL(is_deleted,0) = 0;
    `);

  return !!r.recordset?.[0]?.memory_id;
}

async function getMemoryLinkInChapter(pool, authorId, chapterId, memoryId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("memory_id", sql.Int, memoryId)
    .query(`
      SELECT TOP 1
        chapter_id,
        memory_id,
        is_primary,
        sort_order,
        created_at AS linked_at,
        created_by AS linked_by
      FROM dbo.identity_memory_chapter
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND memory_id = @memory_id;
    `);

  return r?.recordset?.[0] || null;
}

async function listMemoryLinks(pool, authorId, memoryId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .query(`
      SELECT
        mc.chapter_id,
        mc.memory_id,
        mc.is_primary,
        mc.sort_order,
        mc.created_at AS linked_at,
        mc.created_by AS linked_by,
        c.title AS chapter_title
      FROM dbo.identity_memory_chapter mc
      INNER JOIN dbo.identity_chapter c
        ON c.chapter_id = mc.chapter_id
       AND c.author_id = mc.author_id
      WHERE mc.author_id = @author_id
        AND mc.memory_id = @memory_id
        AND ISNULL(c.is_deleted,0) = 0
      ORDER BY
        CASE WHEN ISNULL(mc.is_primary,0) = 1 THEN 0 ELSE 1 END ASC,
        CASE WHEN mc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
        mc.sort_order ASC,
        mc.created_at ASC,
        mc.chapter_id ASC;
    `);

  return (r?.recordset || []).map((x) => ({
    chapter_id: Number(x.chapter_id),
    memory_id: Number(x.memory_id),
    chapter_title: x.chapter_title != null ? String(x.chapter_title) : null,
    is_primary: x.is_primary != null ? Number(x.is_primary) : 0,
    sort_order: x.sort_order != null ? Number(x.sort_order) : null,
    linked_at: x.linked_at ?? null,
    linked_by: x.linked_by ?? null,
  }));
}

async function getChapterTitle(pool, authorId, chapterId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1 title
      FROM dbo.identity_chapter
      WHERE chapter_id = @chapter_id
        AND author_id  = @author_id
        AND ISNULL(is_deleted,0) = 0;
    `);

  return r?.recordset?.[0]?.title ? String(r.recordset[0].title) : null;
}

async function listExistingChapters(pool, authorId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .query(`
      SELECT
        chapter_id,
        author_id,
        title,
        description,
        current_version_id,
        status,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
            THEN COALESCE(
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), publication_status))), ''),
              CONVERT(varchar(50), status)
            )
          ELSE CONVERT(varchar(50), status)
        END AS publication_status_effective,
        created_at,
        updated_at,
        published_at,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'published_version_number') IS NOT NULL
            THEN published_version_number
          ELSE NULL
        END AS published_version_number
      FROM dbo.identity_chapter
      WHERE author_id = @author_id
        AND ISNULL(is_deleted,0) = 0
      ORDER BY
        CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END ASC,
        updated_at DESC,
        created_at DESC,
        chapter_id DESC;
    `);

  return (r?.recordset || []).map((x) => normalizeChapterRow(x));
}

async function getChapterDetailForApply(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .execute("dbo.p_Chapter_Get_ById");

  const recordsets = result?.recordsets || [];
  const chapterRows = recordsets[0] || [];
  const versionRows = recordsets[1] || [];

  if (!chapterRows.length) return null;

  const chapter = chapterRows[0] || null;
  const currentVersion = versionRows[0] || null;

  return {
    chapter,
    currentVersion,
  };
}

async function getSuggestionForApply(pool, authorId, chapterId, suggestionId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("suggestion_id", sql.Int, suggestionId)
    .query(`
      SELECT TOP 1
        suggestion_id,
        chapter_id,
        author_id,
        suggestion_status,
        chapter_title_suggestion,
        chapter_summary,
        themes_json,
        sections_json,
        emotional_arc_json,
        confidence_score,
        llm_provider,
        llm_model,
        prompt_version,
        created_at,
        applied_at,
        discarded_at
      FROM dbo.identity_chapter_ai_suggestion
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;
    `);

  return r?.recordset?.[0] || null;
}

async function markSuggestionApplied(pool, authorId, chapterId, suggestionId) {
  await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("suggestion_id", sql.Int, suggestionId)
    .query(`
      UPDATE dbo.identity_chapter_ai_suggestion
      SET
        applied_at = SYSUTCDATETIME(),
        suggestion_status = 'applied'
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;
    `);
}

async function markSuggestionDiscarded(pool, authorId, chapterId, suggestionId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("suggestion_id", sql.Int, suggestionId)
    .query(`
      UPDATE dbo.identity_chapter_ai_suggestion
      SET
        discarded_at = ISNULL(discarded_at, SYSUTCDATETIME()),
        suggestion_status = 'discarded'
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;

      SELECT TOP 1
        suggestion_id,
        suggestion_status,
        discarded_at
      FROM dbo.identity_chapter_ai_suggestion
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;
    `);

  return result?.recordset?.[0] || null;
}

async function getNextSortOrder(db, authorId, chapterId) {
  const result = await createRequest(db)
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT ISNULL(MAX(sort_order), 0) + 1 AS next_sort
      FROM dbo.identity_memory_chapter
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id;
    `);

  return Number(result?.recordset?.[0]?.next_sort ?? 1);
}

async function ensureMemoryPrimaryLink(db, authorId, memoryId, preferredChapterId = null) {
  const request = createRequest(db)
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId);

  const preferredSql =
    preferredChapterId != null
      ? `
        CASE WHEN chapter_id = @preferred_chapter_id THEN 0 ELSE 1 END ASC,
      `
      : "";

  if (preferredChapterId != null) {
    request.input("preferred_chapter_id", sql.Int, preferredChapterId);
  }

  const linksResult = await request.query(`
    SELECT
      chapter_id,
      ISNULL(is_primary, 0) AS is_primary,
      sort_order,
      created_at
    FROM dbo.identity_memory_chapter
    WHERE author_id = @author_id
      AND memory_id = @memory_id
    ORDER BY
      ${preferredSql}
      CASE WHEN ISNULL(is_primary,0) = 1 THEN 0 ELSE 1 END ASC,
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END ASC,
      sort_order ASC,
      created_at ASC,
      chapter_id ASC;
  `);

  const links = linksResult?.recordset || [];
  if (!links.length) return null;

  let chosen = null;

  if (preferredChapterId != null) {
    chosen = links.find((x) => Number(x.chapter_id) === Number(preferredChapterId)) || null;
  }

  if (!chosen) {
    const existingPrimary = links.filter((x) => Number(x.is_primary) === 1);
    if (existingPrimary.length === 1) {
      chosen = existingPrimary[0];
    } else {
      chosen = links[0];
    }
  }

  await createRequest(db)
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .input("primary_chapter_id", sql.Int, Number(chosen.chapter_id))
    .query(`
      UPDATE dbo.identity_memory_chapter
      SET is_primary =
        CASE
          WHEN chapter_id = @primary_chapter_id THEN 1
          ELSE 0
        END
      WHERE author_id = @author_id
        AND memory_id = @memory_id;
    `);

  return Number(chosen.chapter_id);
}

async function getMoveSourceLink(pool, authorId, memoryId, targetChapterId, explicitFromChapterId) {
  const request = pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .input("target_chapter_id", sql.Int, targetChapterId);

  if (explicitFromChapterId != null) {
    request.input("from_chapter_id", sql.Int, explicitFromChapterId);

    const explicit = await request.query(`
      SELECT TOP 1
        imc.chapter_id,
        c.title AS chapter_title,
        ISNULL(imc.is_primary,0) AS is_primary,
        imc.sort_order,
        imc.created_at
      FROM dbo.identity_memory_chapter imc
      INNER JOIN dbo.identity_chapter c
        ON c.chapter_id = imc.chapter_id
       AND c.author_id = imc.author_id
      WHERE imc.author_id = @author_id
        AND imc.memory_id = @memory_id
        AND imc.chapter_id = @from_chapter_id
        AND ISNULL(c.is_deleted,0) = 0;
    `);

    return explicit?.recordset?.[0] || null;
  }

  const fallback = await request.query(`
    SELECT TOP 1
      imc.chapter_id,
      c.title AS chapter_title,
      ISNULL(imc.is_primary,0) AS is_primary,
      imc.sort_order,
      imc.created_at
    FROM dbo.identity_memory_chapter imc
    INNER JOIN dbo.identity_chapter c
      ON c.chapter_id = imc.chapter_id
     AND c.author_id = imc.author_id
    WHERE imc.author_id = @author_id
      AND imc.memory_id = @memory_id
      AND imc.chapter_id <> @target_chapter_id
      AND ISNULL(c.is_deleted,0) = 0
    ORDER BY
      CASE WHEN ISNULL(imc.is_primary,0) = 1 THEN 0 ELSE 1 END ASC,
      CASE WHEN imc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
      imc.sort_order ASC,
      imc.created_at ASC,
      imc.chapter_id ASC;
  `);

  return fallback?.recordset?.[0] || null;
}

async function getChapterEditorialState(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        c.chapter_id,
        c.author_id,
        c.title,
        c.description,
        c.status,
        c.current_version_id,
        c.created_at,
        c.updated_at,
        c.published_at,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
            THEN COALESCE(
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), c.publication_status))), ''),
              CONVERT(varchar(50), c.status)
            )
          ELSE CONVERT(varchar(50), c.status)
        END AS publication_status_effective,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'published_version_number') IS NOT NULL
            THEN c.published_version_number
          ELSE NULL
        END AS published_version_number
      FROM dbo.identity_chapter c
      WHERE c.chapter_id = @chapter_id
        AND c.author_id = @author_id
        AND ISNULL(c.is_deleted, 0) = 0;
    `);

  const row = result?.recordset?.[0] || null;
  if (!row) return null;

  const currentVersionResult = await pool
    .request()
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        chapter_version_id,
        chapter_id,
        author_id,
        title_snapshot,
        body,
        created_at
      FROM dbo.identity_chapter_versions
      WHERE chapter_id = @chapter_id
      ORDER BY created_at DESC, chapter_version_id DESC;
    `);

  const currentVersion = currentVersionResult?.recordset?.[0] || null;

  return {
    chapter: row,
    currentVersion,
  };
}

function buildChapterPublicationPendingRequirements(detail) {
  const out = [];
  const chapter = detail?.chapter || null;
  const version = detail?.currentVersion || null;

  const title = String(chapter?.title ?? "").trim();
  const body = String(version?.body ?? "").trim();

  if (!title) out.push("MISSING_TITLE");
  if (!body) out.push("MISSING_CONTENT");

  const chapterVersionId = Number(version?.chapter_version_id ?? chapter?.current_version_id ?? 0);
  if (!Number.isInteger(chapterVersionId) || chapterVersionId <= 0) {
    out.push("INVALID_VERSION");
  }

  return out;
}

function buildChapterPublicationSnapshot(detail) {
  const chapter = detail?.chapter || null;
  const version = detail?.currentVersion || null;
  const publicationStatus = normalizePublicationStatus(
    chapter?.publication_status_effective ?? chapter?.status
  );
  const pending = buildChapterPublicationPendingRequirements(detail);

  return {
    chapter_id: Number(chapter?.chapter_id ?? 0),
    status: publicationStatus,
    persisted_status: publicationStatus,
    is_publishable: pending.length === 0,
    pending_requirements: pending,
    published_at: publicationStatus === "PUBLIC" ? chapter?.published_at ?? null : null,
    published_version_number:
      publicationStatus === "PUBLIC"
        ? Number(chapter?.published_version_number ?? version?.chapter_version_id ?? 0) || null
        : null,
    current_version_id: Number(version?.chapter_version_id ?? chapter?.current_version_id ?? 0) || null,
  };
}


function safeJsonParseObject(value, fallback = null) {
  try {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

async function listChapterVersions(pool, authorId, chapterId) {
  const okChapter = await assertChapterOwned(pool, authorId, chapterId);
  if (!okChapter) return null;

  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT
        v.chapter_version_id,
        v.chapter_id,
        v.author_id,
        v.title_snapshot,
        v.body,
        v.created_at,
        CASE
          WHEN c.current_version_id = v.chapter_version_id THEN 1
          ELSE 0
        END AS is_current_version,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'published_version_number') IS NOT NULL
           AND c.published_version_number = v.chapter_version_id THEN 1
          ELSE 0
        END AS is_published_version
      FROM dbo.identity_chapter_versions v
      INNER JOIN dbo.identity_chapter c
        ON c.chapter_id = v.chapter_id
       AND c.author_id = v.author_id
      WHERE v.chapter_id = @chapter_id
        AND v.author_id = @author_id
        AND ISNULL(c.is_deleted, 0) = 0
      ORDER BY v.chapter_version_id DESC;
    `);

  return (result?.recordset || []).map((row) => ({
    chapter_version_id: Number(row.chapter_version_id),
    chapter_id: Number(row.chapter_id),
    author_id: Number(row.author_id),
    title_snapshot: row.title_snapshot ?? null,
    body: row.body ?? "",
    created_at: row.created_at ?? null,
    is_current_version: Number(row.is_current_version ?? 0) === 1,
    is_published_version: Number(row.is_published_version ?? 0) === 1,
  }));
}

async function listChapterTimeline(pool, authorId, chapterId) {
  const okChapter = await assertChapterOwned(pool, authorId, chapterId);
  if (!okChapter) return null;

  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT
        e.chapter_evolution_id,
        e.author_id,
        e.chapter_id,
        e.event_type,
        e.source_version_id,
        e.target_version_id,
        e.memory_id,
        m.title AS memory_title,
        e.metadata_json,
        e.created_at
      FROM dbo.identity_chapter_evolution e
      LEFT JOIN dbo.identity_memory m
        ON m.memory_id = e.memory_id
       AND m.author_id = e.author_id
      WHERE e.author_id = @author_id
        AND e.chapter_id = @chapter_id
      ORDER BY e.created_at DESC, e.chapter_evolution_id DESC;
    `);

  return (result?.recordset || []).map((row) => ({
    chapter_evolution_id: Number(row.chapter_evolution_id),
    author_id: Number(row.author_id),
    chapter_id: Number(row.chapter_id),
    event_type: row.event_type != null ? String(row.event_type) : null,
    source_version_id:
      row.source_version_id != null ? Number(row.source_version_id) : null,
    target_version_id:
      row.target_version_id != null ? Number(row.target_version_id) : null,
    memory_id: row.memory_id != null ? Number(row.memory_id) : null,
    memory_title: row.memory_title ?? null,
    metadata: safeJsonParseObject(row.metadata_json, null),
    created_at: row.created_at ?? null,
  }));
}

async function getChapterEditorialProfile(pool, authorId, chapterId) {
  const okChapter = await assertChapterOwned(pool, authorId, chapterId);
  if (!okChapter) return null;

  const result = await pool
    .request()
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        chapter_id,
        theme,
        life_phase,
        period_start,
        period_end,
        memory_count,
        confidence_score,
        factual_score,
        updated_at
      FROM dbo.identity_chapter_editorial_profile
      WHERE chapter_id = @chapter_id;
    `);

  const row = result?.recordset?.[0] || null;
  if (!row) {
    return {
      chapter_id: chapterId,
      theme: null,
      life_phase: null,
      period_start: null,
      period_end: null,
      memory_count: 0,
      confidence_score: null,
      factual_score: null,
      updated_at: null,
      empty: true,
    };
  }

  return {
    chapter_id: Number(row.chapter_id),
    theme: row.theme ?? null,
    life_phase: row.life_phase ?? null,
    period_start: row.period_start ?? null,
    period_end: row.period_end ?? null,
    memory_count: row.memory_count != null ? Number(row.memory_count) : 0,
    confidence_score:
      row.confidence_score != null ? Number(row.confidence_score) : null,
    factual_score: row.factual_score != null ? Number(row.factual_score) : null,
    updated_at: row.updated_at ?? null,
    empty: false,
  };
}


async function getCurrentChapterVersionId(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1 current_version_id
      FROM dbo.identity_chapter
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND ISNULL(is_deleted, 0) = 0;
    `);

  const n = Number(result?.recordset?.[0]?.current_version_id ?? 0);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function createChapterEvolution(pool, payload) {
  const metadataJson = (() => {
    try {
      return JSON.stringify(payload.metadata ?? {});
    } catch {
      return "{}";
    }
  })();

  await pool
    .request()
    .input("author_id", sql.Int, payload.author_id)
    .input("chapter_id", sql.Int, payload.chapter_id)
    .input("event_type", sql.VarChar(50), payload.event_type)
    .input("source_version_id", sql.Int, payload.source_version_id ?? null)
    .input("target_version_id", sql.Int, payload.target_version_id ?? null)
    .input("memory_id", sql.Int, payload.memory_id ?? null)
    .input("metadata_json", sql.NVarChar(sql.MAX), metadataJson)
    .query(`
      INSERT INTO dbo.identity_chapter_evolution
      (
        author_id,
        chapter_id,
        event_type,
        source_version_id,
        target_version_id,
        memory_id,
        metadata_json,
        created_at
      )
      VALUES
      (
        @author_id,
        @chapter_id,
        @event_type,
        @source_version_id,
        @target_version_id,
        @memory_id,
        @metadata_json,
        SYSUTCDATETIME()
      );
    `);
}

router.get("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const pool = await getPool();
    const rows = await listExistingChapters(pool, authorId);

    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const title = String(req.body?.title ?? "").trim();
    const description =
      req.body?.description != null ? String(req.body.description).trim() : null;
    const body = req.body?.body != null ? String(req.body.body) : "";
    const requestedStatus =
      req.body?.status != null ? String(req.body.status).toUpperCase() : "DRAFT";

    if (!title) {
      return res.status(400).json({ error: "title é obrigatório." });
    }

    const safeStatus = requestedStatus === "PUBLIC" ? "PUBLIC" : "DRAFT";

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("title", sql.NVarChar(200), title)
      .input("description", sql.NVarChar(400), description)
      .input("body", sql.NVarChar(sql.MAX), body)
      .input("status", sql.VarChar(20), safeStatus)
      .output("chapter_id", sql.Int)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Create_WithVersion");

    const out = result?.output || {};
    const firstRow = result?.recordset?.[0] || null;
    const chapterId = out.chapter_id ?? firstRow?.chapter_id ?? null;

    try {
      if (chapterId != null) {
        await createNarrativeEvent({
          authorId,
          eventType: "chapter_created",
          chapterId,
          eventKey: buildEventKey("chapter_created", [
            "author",
            authorId,
            "chapter",
            chapterId,
          ]),
          metadata: {
            title,
            status: safeStatus,
            source: "chapters.create",
          },
        });
      }
    } catch (e) {
      console.warn("NarrativeEvent chapter_created failed:", e?.message);
    }

    return res.status(201).json({
      chapter_id: chapterId,
      chapter_version_id:
        out.chapter_version_id ?? firstRow?.chapter_version_id ?? null,
      status: safeStatus,
      publication_status: safeStatus,
    });
  } catch (err) {
    return next(err);
  }
});


router.post("/story-editorial/save", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const title = String(req.body?.title ?? "").trim();
    const content = String(
      req.body?.content ??
      req.body?.narrative_content ??
      req.body?.draft?.content ??
      req.body?.draft?.narrative_content ??
      ""
    ).trim();

    const selectedMemoryIds = [
      ...new Set(
        (Array.isArray(req.body?.selected_memory_ids)
          ? req.body.selected_memory_ids
          : Array.isArray(req.body?.selectedMemoryIds)
            ? req.body.selectedMemoryIds
            : []
        )
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      ),
    ];

    if (!title) {
      return res.status(422).json({ ok: false, error: "A História precisa de um título." });
    }

    if (content.length < 20) {
      return res.status(422).json({
        ok: false,
        error: "A História precisa de conteúdo narrativo para ser salva.",
      });
    }

    if (!selectedMemoryIds.length) {
      return res.status(422).json({
        ok: false,
        error: "A História precisa de ao menos uma memória aprovada.",
      });
    }

    const suppliedMemories = Array.isArray(req.body?.memories)
      ? req.body.memories
      : [];

    const memories = suppliedMemories.length
      ? suppliedMemories
      : selectedMemoryIds.map((memory_id) => ({ memory_id }));

    const result = await saveApprovedStory({
      authorId,
      sourceStoryId: req.body?.source_story_id ?? req.body?.sourceStoryId ?? null,
      persistedStoryId: req.body?.persisted_story_id ?? req.body?.persistedStoryId ?? null,
      title,
      subtitle: req.body?.subtitle ?? null,
      content,
      editorialPlan: req.body?.editorial_plan ?? req.body?.editorialPlan ?? null,
      timeline: Array.isArray(req.body?.timeline) ? req.body.timeline : [],
      memories,
      relationships: Array.isArray(req.body?.relationships)
        ? req.body.relationships
        : Array.isArray(req.body?.lineage)
          ? req.body.lineage
          : [],
      lineage: Array.isArray(req.body?.lineage)
        ? req.body.lineage
        : Array.isArray(req.body?.relationships)
          ? req.body.relationships
          : [],
      generationPayload: {
        ...(req.body?.draft || req.body || {}),
        hypothesis_id: req.body?.hypothesis_id ?? req.body?.draft?.hypothesis_id ?? null,
        editorial_plan: req.body?.editorial_plan ?? req.body?.editorialPlan ?? req.body?.draft?.editorial_plan ?? null,
        lineage: Array.isArray(req.body?.lineage)
          ? req.body.lineage
          : Array.isArray(req.body?.relationships)
            ? req.body.relationships
            : [],
        selected_memory_ids: selectedMemoryIds,
        approval_status: "APPROVED",
        persistence_source: "chapters.story-editorial.save",
      },
    });

    if (!result?.ok) {
      return res.status(422).json(result || {
        ok: false,
        error: "Não conseguimos salvar a História.",
      });
    }

    const wasUpdate = Number.isInteger(Number(req.body?.persisted_story_id ?? req.body?.persistedStoryId)) && Number(req.body?.persisted_story_id ?? req.body?.persistedStoryId) > 0;
    return res.status(wasUpdate ? 200 : 201).json({
      ...result,
      approved: true,
      status: "STORY",
      hypothesis_id: req.body?.hypothesis_id ?? null,
      selected_memory_ids: selectedMemoryIds,
    });
  } catch (err) {
    return next(err);
  }
});


router.post("/from-story", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toInt(req.body?.story_id ?? req.body?.storyId);
    if (!Number.isFinite(storyId) || storyId <= 0) {
      return res.status(400).json({ error: "story_id inválido." });
    }

    const pool = await getPool();
    const storyResult = await pool
      .request()
      .input("author_id", sql.BigInt, authorId)
      .input("story_id", sql.BigInt, storyId)
      .query(`
        SELECT TOP 1
          s.story_id,
          s.title,
          s.subtitle,
          v.content
        FROM dbo.identity_story s
        OUTER APPLY (
          SELECT TOP 1 sv.content
          FROM dbo.identity_story_version sv
          WHERE sv.story_id = s.story_id
            AND sv.author_id = s.author_id
          ORDER BY sv.version_number DESC, sv.story_version_id DESC
        ) v
        WHERE s.story_id = @story_id
          AND s.author_id = @author_id
          AND ISNULL(s.is_deleted, 0) = 0;
      `);

    const story = storyResult?.recordset?.[0] || null;
    if (!story) {
      return res.status(404).json({ error: "História não encontrada." });
    }

    const title = String(story.title || "Capítulo sem título").trim();
    const description = story.subtitle != null ? String(story.subtitle).trim() : null;
    const body = String(story.content || "");

    if (!body.trim()) {
      return res.status(422).json({ error: "A História não possui manuscrito para virar Capítulo." });
    }

    const createResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("title", sql.NVarChar(200), title.slice(0, 200))
      .input("description", sql.NVarChar(400), description ? description.slice(0, 400) : null)
      .input("body", sql.NVarChar(sql.MAX), body)
      .input("status", sql.VarChar(20), "DRAFT")
      .output("chapter_id", sql.Int)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Create_WithVersion");

    const output = createResult?.output || {};
    const firstRow = createResult?.recordset?.[0] || null;
    const chapterId = Number(output.chapter_id ?? firstRow?.chapter_id ?? 0);
    const chapterVersionId = Number(output.chapter_version_id ?? firstRow?.chapter_version_id ?? 0) || null;

    if (!Number.isInteger(chapterId) || chapterId <= 0) {
      throw new Error("O Capítulo foi criado sem identificador válido.");
    }

    const memoriesResult = await pool
      .request()
      .input("author_id", sql.BigInt, authorId)
      .input("story_id", sql.BigInt, storyId)
      .query(`
        SELECT memory_id, sort_order
        FROM dbo.identity_story_memory
        WHERE story_id = @story_id
          AND author_id = @author_id
        ORDER BY sort_order ASC, memory_id ASC;
      `);

    const memoryRows = memoriesResult?.recordset || [];

    const assetsResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("story_id", sql.Int, storyId)
      .query(`
        SELECT
          sm.memory_id,
          sm.sort_order AS display_order,
          mm.media_id,
          CASE WHEN mm.storage_path IS NULL THEN NULL ELSE '/cdn/' + REPLACE(mm.storage_path, '\\', '/') END AS image_url
        FROM dbo.identity_story_memory sm
        INNER JOIN dbo.identity_memory_media mm
          ON mm.memory_id = sm.memory_id
         AND mm.author_id = sm.author_id
         AND mm.media_type = 'image'
         AND ISNULL(mm.is_deleted, 0) = 0
        WHERE sm.story_id = @story_id
          AND sm.author_id = @author_id
        ORDER BY sm.sort_order ASC, ISNULL(mm.is_primary_for_memory, 0) DESC, mm.created_at ASC;
      `);
    const inheritedAssets = assetsResult?.recordset || [];

    for (let index = 0; index < memoryRows.length; index += 1) {
      const memoryId = Number(memoryRows[index]?.memory_id);
      if (!Number.isInteger(memoryId) || memoryId <= 0) continue;

      await pool
        .request()
        .input("author_id", sql.Int, authorId)
        .input("chapter_id", sql.Int, chapterId)
        .input("memory_id", sql.Int, memoryId)
        .input("sort_order", sql.Int, index + 1)
        .query(`
          IF NOT EXISTS (
            SELECT 1
            FROM dbo.identity_memory_chapter
            WHERE author_id = @author_id
              AND chapter_id = @chapter_id
              AND memory_id = @memory_id
          )
          BEGIN
            INSERT INTO dbo.identity_memory_chapter
            (
              author_id,
              chapter_id,
              memory_id,
              is_primary,
              sort_order,
              created_at,
              created_by
            )
            VALUES
            (
              @author_id,
              @chapter_id,
              @memory_id,
              0,
              @sort_order,
              SYSUTCDATETIME(),
              @author_id
            );
          END
        `);
    }

    try {
      await linkStoryToChapter({
        authorId,
        chapterId,
        storyId,
        confidence: 1,
        reason: "Capítulo criado diretamente a partir da História aprovada pelo autor.",
        source: "chapters.from-story",
      });
    } catch (lineageError) {
      console.warn("Story lineage from-story failed:", lineageError?.message);
    }

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_created_from_story",
        chapterId,
        eventKey: buildEventKey("chapter_created_from_story", [
          "author",
          authorId,
          "story",
          storyId,
          "chapter",
          chapterId,
        ]),
        metadata: {
          story_id: storyId,
          chapter_id: chapterId,
          chapter_version_id: chapterVersionId,
          memory_ids: memoryRows.map((row) => Number(row.memory_id)).filter(Boolean),
          inherited_story_assets: inheritedAssets,
          source: "chapters.from-story",
          regenerated: false,
        },
      });
    } catch (eventError) {
      console.warn("NarrativeEvent chapter_created_from_story failed:", eventError?.message);
    }

    return res.status(201).json({
      ok: true,
      story_id: storyId,
      chapter_id: chapterId,
      chapter_version_id: chapterVersionId,
      status: "DRAFT",
      publication_status: "DRAFT",
      assets: inheritedAssets,
      memory_count: memoryRows.length,
      generation_mode: "AUTHOR_APPROVED_STORY",
      regenerated: false,
      source_policy: "Capítulo criado com o texto exato da História aprovada, sem nova geração por IA.",
    });
  } catch (err) {
    return next(err);
  }
});


router.post("/editorial/generate", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;
    const userId = ensureUserId(req, res);
    if (!userId) return;

    const memoryIds = Array.isArray(req.body?.memory_ids)
      ? req.body.memory_ids
      : Array.isArray(req.body?.memoryIds)
        ? req.body.memoryIds
        : [];

    const title = normalizeOptionalText(req.body?.title);

    const pool = await getPool();
    const planCheck = await checkNarrativeAiGenerationQuota({
      pool,
      userId,
      requestedValue: 1,
    });

    if (!planCheck.allowed) {
      return sendPlanDenied(res, planCheck, {
        status: 403,
        message: "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    const reservation = await reserveNarrativeAiGenerationQuota({
      pool,
      userId,
      targetFeatureCode: "CHAPTER_AI_GENERATION_COUNT",
      reserveValue: 1,
      entityType: "CHAPTER_EDITORIAL_GENERATION",
      entityId: null,
      metadata: {
        author_id: authorId,
        source: "chapters.editorial.generate",
        economic_operation: "CHAPTER_AI_GENERATION",
      },
    });

    if (!reservation.allowed || !reservation.reservation_event_id) {
      return sendPlanDenied(res, reservation, {
        status: 403,
        message: "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    let result;
    try {
      result = await generateEditorialChapter({
        userId,
        authorId,
        memoryIds,
        title,
      });
    } catch (error) {
      try {
        await releasePlanQuotaReservation({
          pool,
          userId,
          reservationEventId: reservation.reservation_event_id,
          reasonCode: error?.code || "CHAPTER_EDITORIAL_GENERATION_FAILED",
          metadata: { author_id: authorId, source: "chapters.editorial.generate" },
        });
      } catch (releaseError) {
        console.error("[PLAN][CHAPTER] Falha ao liberar reserva:", releaseError?.message || releaseError);
      }
      throw error;
    }

    const quotaResult = await commitPlanQuotaReservation({
      pool,
      userId,
      reservationEventId: reservation.reservation_event_id,
      metadata: {
        author_id: authorId,
        generation_id: result?.generation_id ?? null,
        source: "chapters.editorial.generate",
        economic_operation: "CHAPTER_AI_GENERATION",
      },
    });

    if (!quotaResult.allowed) {
      return res.status(409).json({
        ok: false,
        error: "A geração foi concluída, mas a reserva econômica não pôde ser consolidada.",
        code: quotaResult.reason_code || "PLAN_QUOTA_COMMIT_FAILED",
      });
    }

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_editorial_generated",
        eventKey: buildEventKey("chapter_editorial_generated", [
          "author",
          authorId,
          "generation",
          result.generation_id,
        ]),
        metadata: {
          generation_id: result.generation_id,
          source_memory_ids: result.source_memory_ids,
          source_memory_count: result.source_memory_count,
          source: "chapters.editorial.generate",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_editorial_generated failed:", e?.message);
    }

    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

router.get("/editorial/generations/:generationId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const generationId = toInt(req.params.generationId);
    if (!Number.isFinite(generationId) || generationId <= 0) {
      return res.status(400).json({ error: "generation_id inválido." });
    }

    const result = await getEditorialGeneration({ authorId, generationId });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/editorial/generations/:generationId/approve", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const generationId = toInt(req.params.generationId);
    if (!Number.isFinite(generationId) || generationId <= 0) {
      return res.status(400).json({ error: "generation_id inválido." });
    }

    const result = await approveEditorialGeneration({
      authorId,
      generationId,
      title: req.body?.title,
      description: req.body?.description,
      content: req.body?.content ?? req.body?.body,
    });

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_editorial_approved",
        chapterId: result.chapter_id ?? null,
        eventKey: buildEventKey("chapter_editorial_approved", [
          "author",
          authorId,
          "generation",
          generationId,
          "chapter",
          result.chapter_id ?? "none",
        ]),
        metadata: {
          generation_id: generationId,
          chapter_id: result.chapter_id ?? null,
          chapter_version_id: result.chapter_version_id ?? null,
          linked_memory_ids: result.linked_memory_ids || [],
          source: "chapters.editorial.approve",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_editorial_approved failed:", e?.message);
    }

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detail = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detail?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const chapter = normalizeChapterRow(detail.chapter);
    const currentVersion = detail.currentVersion
      ? normalizeChapterVersionRow(detail.currentVersion)
      : null;

    const resolvedStatus = chapter?.status === "PUBLIC" ? "PUBLIC" : "DRAFT";

    return res.json({
      chapter_id: chapter.chapter_id,
      author_id: chapter.author_id,
      title: chapter.title,
      description: chapter.description ?? null,
      status: resolvedStatus,
      publication_status: resolvedStatus,
      current_version_id: chapter.current_version_id ?? null,
      created_at: chapter.created_at ?? null,
      updated_at: chapter.updated_at ?? null,
      published_at: chapter.published_at ?? null,
      published_version_number: chapter.published_version_number ?? null,
      body: currentVersion?.body ?? "",
      chapter,
      current_version: currentVersion,
    });
  } catch (err) {
    return next(err);
  }
});


router.get("/:id/provenance", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const result = await getChapterProvenance({ authorId, chapterId });
    return res.json(result);
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({
        error: err.message || "Falha ao carregar proveniência do capítulo.",
        code: err.code || "CHAPTER_PROVENANCE_FAILED",
      });
    }
    return next(err);
  }
});


router.get("/:id/story-lineage", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const owned = await assertChapterOwned(pool, authorId, chapterId);
    if (!owned) return res.status(404).json({ error: "Capítulo não encontrado." });

    const lineage = await getChapterStoryLineage({ authorId, chapterId });
    return res.json(lineage);
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/story-lineage", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const storyId = toInt(req.body?.story_id ?? req.body?.storyId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    if (!Number.isFinite(storyId) || storyId <= 0) {
      return res.status(400).json({ error: "story_id inválido." });
    }

    const pool = await getPool();
    const owned = await assertChapterOwned(pool, authorId, chapterId);
    if (!owned) return res.status(404).json({ error: "Capítulo não encontrado." });

    const result = await linkStoryToChapter({
      authorId,
      chapterId,
      storyId,
      confidence: req.body?.confidence,
      reason: req.body?.reason,
      source: req.body?.source || "chapter.manual_lineage",
    });

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "story_chapter_linked",
        eventKey: buildEventKey(["story_chapter_linked", chapterId, storyId]),
        entityType: "chapter",
        entityId: chapterId,
        metadata: {
          chapter_id: chapterId,
          story_id: storyId,
          confidence: result?.link?.confidence ?? null,
          source: "chapters.story-lineage.link",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent story_chapter_linked failed:", e?.message);
    }

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/story-lineage/rebuild", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const owned = await assertChapterOwned(pool, authorId, chapterId);
    if (!owned) return res.status(404).json({ error: "Capítulo não encontrado." });

    const result = await rebuildChapterStoryLineage({
      authorId,
      chapterId,
      limit: req.body?.limit,
      minConfidence: req.body?.min_confidence ?? req.body?.minConfidence,
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.delete("/:id/story-lineage/:storyId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const storyId = toInt(req.params.storyId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    if (!Number.isFinite(storyId) || storyId <= 0) {
      return res.status(400).json({ error: "story_id inválido." });
    }

    const pool = await getPool();
    const owned = await assertChapterOwned(pool, authorId, chapterId);
    if (!owned) return res.status(404).json({ error: "Capítulo não encontrado." });

    const result = await unlinkStoryFromChapter({ authorId, chapterId, storyId });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/publication", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detail = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detail?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const publication = buildChapterPublicationSnapshot(detail);

    return res.json(publication);
  } catch (err) {
    return next(err);
  }
});


router.post("/:id/regenerate/accept", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) return res.status(400).json({ error: "chapter_id inválido." });
    const result = await acceptChapterRegeneration({
      authorId, chapterId,
      generationId: req.body?.generation_id,
      sourceVersionId: req.body?.source_version_id,
      title: req.body?.title,
      description: req.body?.description ?? null,
      body: req.body?.body,
    });
    return res.json(result);
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message, code: err.code || "CHAPTER_REGENERATION_ACCEPT_FAILED" });
    return next(err);
  }
});

router.post("/:id/regenerate/discard", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) return res.status(400).json({ error: "chapter_id inválido." });
    const result = await discardChapterRegeneration({ authorId, chapterId, generationId: req.body?.generation_id, sourceVersionId: req.body?.source_version_id });
    return res.json(result);
  } catch (err) {
    if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message, code: err.code || "CHAPTER_REGENERATION_DISCARD_FAILED" });
    return next(err);
  }
});

router.post("/:id/regenerate", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;
    const userId = ensureUserId(req, res);
    if (!userId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();

    // Contrato econômico do Chapter Composer:
    // - sem manuscrito existente = primeira geração por IA -> CHAPTER_AI_GENERATION_COUNT
    // - com manuscrito existente = regeneração -> AI_REGENERATION_COUNT
    //
    // O evento CHAPTER_REGENERATED continua como marcador persistente auxiliar,
    // inclusive se o autor posteriormente apagar manualmente o corpo do texto.
    const [detail, priorAiGenerationResult] = await Promise.all([
      getChapterEditorialState(pool, authorId, chapterId),
      pool
        .request()
        .input("author_id", sql.Int, Number(authorId))
        .input("chapter_id", sql.Int, Number(chapterId))
        .query(`
          SELECT TOP (1) 1 AS has_prior_ai_generation
          FROM dbo.identity_chapter_evolution
          WHERE author_id = @author_id
            AND chapter_id = @chapter_id
            AND event_type = 'CHAPTER_REGENERATED'
          ORDER BY created_at DESC;
        `),
    ]);

    if (!detail?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const hasExistingManuscript =
      String(detail?.currentVersion?.body ?? "").trim().length > 0;
    const hasPriorAiMarker =
      Number(priorAiGenerationResult?.recordset?.[0]?.has_prior_ai_generation || 0) === 1;
    const hasPriorAiGeneration = hasExistingManuscript || hasPriorAiMarker;

    const quotaFeatureCode = hasPriorAiGeneration
      ? "AI_REGENERATION_COUNT"
      : "CHAPTER_AI_GENERATION_COUNT";

    const planCheck = hasPriorAiGeneration
      ? await checkPlanFeature({ pool, userId, featureCode: quotaFeatureCode, requestedValue: 1 })
      : await checkNarrativeAiGenerationQuota({ pool, userId, requestedValue: 1 });

    if (!planCheck.allowed) {
      return sendPlanDenied(res, planCheck, {
        status: 403,
        message: hasPriorAiGeneration
          ? "A franquia mensal de regenerações foi atingida."
          : "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    const economicSource = hasPriorAiGeneration
      ? "chapters.regenerate"
      : "chapters.first_ai_manuscript";

    const reservation = hasPriorAiGeneration
      ? await reservePlanQuota({
          pool,
          userId,
          featureCode: "AI_REGENERATION_COUNT",
          reserveValue: 1,
          entityType: "CHAPTER",
          entityId: chapterId,
          metadata: {
            author_id: authorId,
            source: economicSource,
            economic_operation: "REGENERATION",
          },
        })
      : await reserveNarrativeAiGenerationQuota({
          pool,
          userId,
          targetFeatureCode: "CHAPTER_AI_GENERATION_COUNT",
          reserveValue: 1,
          entityType: "CHAPTER",
          entityId: chapterId,
          metadata: {
            author_id: authorId,
            source: economicSource,
            economic_operation: "CHAPTER_AI_GENERATION",
          },
        });

    if (!reservation.allowed || !reservation.reservation_event_id) {
      return sendPlanDenied(res, reservation, {
        status: 403,
        message: hasPriorAiGeneration
          ? "A franquia mensal de regenerações foi atingida."
          : "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    let result;
    try {
      result = await regenerateChapter({
        userId,
        authorId,
        chapterId,
        title: req.body?.title ?? null,
        // Defesa de contrato: se já existe versão corrente/manuscrito, /regenerate
        // somente gera proposta. A persistência da próxima versão pertence exclusivamente
        // a POST /:id/regenerate/accept.
        proposalOnly: hasPriorAiGeneration || Number(detail?.chapter?.current_version_id || 0) > 0,
      });
    } catch (error) {
      try {
        await releasePlanQuotaReservation({
          pool,
          userId,
          reservationEventId: reservation.reservation_event_id,
          reasonCode: error?.code || "CHAPTER_REGENERATION_FAILED",
          metadata: { author_id: authorId, chapter_id: chapterId, source: economicSource },
        });
      } catch (releaseError) {
        console.error("[PLAN][CHAPTER] Falha ao liberar reserva:", releaseError?.message || releaseError);
      }
      throw error;
    }

    const quotaResult = await commitPlanQuotaReservation({
      pool,
      userId,
      reservationEventId: reservation.reservation_event_id,
      metadata: {
        author_id: authorId,
        chapter_id: chapterId,
        source: economicSource,
        economic_operation: hasPriorAiGeneration ? "REGENERATION" : "CHAPTER_AI_GENERATION",
        target_version_id: result?.target_version_id ?? result?.chapter_version_id ?? null,
      },
    });

    if (!quotaResult.allowed) {
      return res.status(409).json({
        ok: false,
        error: "A operação foi concluída, mas a reserva econômica não pôde ser consolidada.",
        code: quotaResult.reason_code || "PLAN_QUOTA_COMMIT_FAILED",
      });
    }

    try {
      const isProposal = result?.proposal === true;
      const narrativeEventType = isProposal
        ? "chapter_regeneration_proposed"
        : "chapter_regenerated";

      await createNarrativeEvent({
        authorId,
        eventType: narrativeEventType,
        chapterId,
        eventKey: buildEventKey(narrativeEventType, [
          "author",
          authorId,
          "chapter",
          chapterId,
          isProposal ? "generation" : "version",
          isProposal
            ? (result.generation_id ?? result?.meta?.generation_id ?? "na")
            : (result.target_version_id ?? result.chapter_version_id ?? "na"),
        ]),
        metadata: {
          source_memory_count: result.source_memory_count ?? null,
          source_memory_ids: result.source_memory_ids ?? [],
          chapter_version_id: result.chapter_version_id ?? null,
          source_version_id: result.source_version_id ?? null,
          target_version_id: result.target_version_id ?? null,
          provider: result?.meta?.provider ?? null,
          model: result?.meta?.model ?? null,
          prompt_version: result?.meta?.prompt_version ?? null,
          generation_id: result.generation_id ?? result?.meta?.generation_id ?? null,
          proposal: isProposal,
          source: "chapters.regenerate",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent regeneration/proposal failed:", e?.message);
    }

    return res.status(201).json(result);
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    if (err?.statusCode) {
      return res.status(err.statusCode).json({
        error: err.message || "Falha ao regenerar capítulo.",
        code: err.code || "CHAPTER_REGENERATION_FAILED",
        details: err.details || null,
      });
    }
    return next(err);
  }
});

router.get("/:id/versions", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const items = await listChapterVersions(pool, authorId, chapterId);
    if (items === null) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    return res.json({
      chapter_id: chapterId,
      items,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/timeline", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const items = await listChapterTimeline(pool, authorId, chapterId);
    if (items === null) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    return res.json({
      chapter_id: chapterId,
      items,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/editorial-profile", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const profile = await getChapterEditorialProfile(pool, authorId, chapterId);
    if (profile === null) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    return res.json(profile);
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const title = String(req.body?.title ?? "").trim();
    const description =
      req.body?.description != null ? String(req.body.description).trim() : null;
    const body = req.body?.body != null ? String(req.body.body) : null;

    if (!title) return res.status(400).json({ error: "title é obrigatório." });
    if (body === null) return res.status(400).json({ error: "body é obrigatório." });

    const pool = await getPool();
    const before = await getChapterEditorialState(pool, authorId, chapterId);
    if (!before?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const currentTitle = String(before.chapter.title ?? "").trim();
    const currentDescription =
      before.chapter.description != null ? String(before.chapter.description).trim() : null;
    const currentBody = String(before.currentVersion?.body ?? "");
    const sourceVersionId = Number(
      before.chapter.current_version_id ?? before.currentVersion?.chapter_version_id ?? 0
    ) || null;

    const titleChanged =
      normalizeComparableText(title) !== normalizeComparableText(currentTitle);
    const descriptionChanged =
      normalizeComparableText(description) !== normalizeComparableText(currentDescription);
    const bodyChanged =
      normalizeComparableText(body) !== normalizeComparableText(currentBody);

    if (!titleChanged && !descriptionChanged && !bodyChanged) {
      return res.status(200).json({
        ok: true,
        updated: false,
        code: "NO_CHANGES",
        message: "Nenhuma alteração detectada. Nenhuma nova versão foi criada.",
        chapter_id: chapterId,
        chapter_version_id: sourceVersionId,
        changes: {
          title_changed: false,
          description_changed: false,
          body_changed: false,
        },
      });
    }

    // GAP #16 — antes de criar a nova versão, congela a proveniência da versão fonte.
    // Em bases anteriores à implantação da tabela granular, getChapterProvenance executa
    // um único backfill determinístico; dali em diante a cadeia é propagada versão a versão.
    if (sourceVersionId) {
      try {
        await getChapterProvenance({ authorId, chapterId });
      } catch (error) {
        console.warn("Chapter provenance source bootstrap failed:", error?.message);
      }
    }

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("title", sql.NVarChar(200), title)
      .input("description", sql.NVarChar(400), description)
      .input("body", sql.NVarChar(sql.MAX), body)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Update_WithVersion");

    const out = result?.output || {};
    const firstRow = result?.recordset?.[0] || null;
    const chapterVersionId =
      out.chapter_version_id ?? firstRow?.chapter_version_id ?? null;

    let granularProvenancePersisted = false;
    if (sourceVersionId && chapterVersionId != null) {
      try {
        const persisted = await persistEditedVersionProvenance(pool, {
          authorId,
          chapterId,
          sourceVersionId,
          targetVersionId: Number(chapterVersionId),
          sourceText: currentBody,
          targetText: body,
        });
        granularProvenancePersisted = persisted.length > 0;
      } catch (error) {
        // Não quebra o save legado. A próxima leitura de provenance executará backfill,
        // mas novas instalações com o SQL aplicado chegarão sempre pelo caminho persistido.
        console.warn("Chapter granular provenance edit persist failed:", error?.message);
      }
    }

    // GAP #7 — um capítulo PUBLIC permanece publicado na versão corrente.
    // Ao existir edição real, a nova versão passa automaticamente a ser também
    // a versão publicada, sem exigir Despublicar/Publicar novamente.
    const wasPublic =
      normalizePublicationStatus(
        before.chapter.publication_status_effective ?? before.chapter.status
      ) === "PUBLIC";

    if (wasPublic && chapterVersionId != null) {
      await pool
        .request()
        .input("author_id", sql.Int, authorId)
        .input("chapter_id", sql.Int, chapterId)
        .input("chapter_version_id", sql.Int, Number(chapterVersionId))
        .query(`
          UPDATE dbo.identity_chapter
          SET
            status = 'PUBLIC',
            publication_status = 'PUBLIC',
            published_version_number = @chapter_version_id,
            published_at = COALESCE(published_at, SYSUTCDATETIME()),
            updated_at = SYSUTCDATETIME()
          WHERE chapter_id = @chapter_id
            AND author_id = @author_id
            AND ISNULL(is_deleted, 0) = 0;
        `);
    }

    try {
      await createChapterEvolution(pool, {
        author_id: authorId,
        chapter_id: chapterId,
        event_type: "CHAPTER_EDITED",
        source_version_id: sourceVersionId,
        target_version_id:
          chapterVersionId != null ? Number(chapterVersionId) : null,
        memory_id: null,
        metadata: {
          source: "chapters.update",
          title_changed: titleChanged,
          description_changed: descriptionChanged,
          body_changed: bodyChanged,
          publication_status: wasPublic ? "PUBLIC" : "DRAFT",
          published_version_number:
            wasPublic && chapterVersionId != null ? Number(chapterVersionId) : null,
          publication_auto_synced: wasPublic,
          provenance_granularity: granularProvenancePersisted ? "PERSISTED_SEGMENTS_V1" : "DEFERRED_BACKFILL",
        },
      });
    } catch (e) {
      console.warn("ChapterEvolution CHAPTER_EDITED failed:", e?.message);
    }

    return res.json({
      ok: true,
      updated: true,
      chapter_id: chapterId,
      chapter_version_id: chapterVersionId,
      source_version_id: sourceVersionId,
      publication_status: wasPublic ? "PUBLIC" : normalizePublicationStatus(before.chapter.publication_status_effective ?? before.chapter.status),
      published_version_number:
        wasPublic && chapterVersionId != null ? Number(chapterVersionId) : before.chapter.published_version_number ?? null,
      publication_auto_synced: wasPublic,
      provenance_granularity: granularProvenancePersisted ? "PERSISTED_SEGMENTS_V1" : "DEFERRED_BACKFILL",
      changes: {
        title_changed: titleChanged,
        description_changed: descriptionChanged,
        body_changed: bodyChanged,
      },
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

router.post("/:id/publish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detailBefore = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detailBefore?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const publicationBefore = buildChapterPublicationSnapshot(detailBefore);
    if (publicationBefore.status === "PUBLIC") {
      return res.status(409).json({
        error: "Capítulo já publicado.",
        code: "CHAPTER_ALREADY_PUBLISHED",
      });
    }

    if (!publicationBefore.is_publishable) {
      return res.status(422).json({
        error: "Capítulo não publicável.",
        code: "CHAPTER_NOT_PUBLISHABLE",
        pending_requirements: publicationBefore.pending_requirements,
      });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Publish");

    const detailAfter = await getChapterEditorialState(pool, authorId, chapterId);
    const publicationAfter = buildChapterPublicationSnapshot(detailAfter);

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_published",
        chapterId,
        eventKey: buildEventKey("chapter_published", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "version",
          publicationAfter.published_version_number ?? publicationAfter.current_version_id ?? "na",
        ]),
        metadata: {
          publication_status: "PUBLIC",
          published_version_number: publicationAfter.published_version_number ?? null,
          source: "chapters.publish",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_published failed:", e?.message);
    }

    try {
      await createChapterEvolution(pool, {
        author_id: authorId,
        chapter_id: chapterId,
        event_type: "CHAPTER_PUBLISHED",
        source_version_id: publicationAfter.current_version_id ?? null,
        target_version_id: publicationAfter.published_version_number ?? publicationAfter.current_version_id ?? null,
        memory_id: null,
        metadata: {
          publication_status: "PUBLIC",
          source: "chapters.publish",
        },
      });
    } catch (e) {
      console.warn("ChapterEvolution CHAPTER_PUBLISHED failed:", e?.message);
    }

    return res.json({
      ok: true,
      chapter_id: chapterId,
      status: "PUBLIC",
      publication_status: "PUBLIC",
      published_at: publicationAfter.published_at,
      published_version_number: publicationAfter.published_version_number,
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

router.post("/:id/unpublish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detailBefore = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detailBefore?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const publicationBefore = buildChapterPublicationSnapshot(detailBefore);
    if (publicationBefore.status !== "PUBLIC") {
      return res.status(409).json({
        error: "Capítulo já está em rascunho.",
        code: "CHAPTER_ALREADY_DRAFT",
      });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Unpublish");

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_unpublished",
        chapterId,
        eventKey: buildEventKey("chapter_unpublished", [
          "author",
          authorId,
          "chapter",
          chapterId,
        ]),
        metadata: {
          publication_status: "DRAFT",
          source: "chapters.unpublish",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_unpublished failed:", e?.message);
    }

    try {
      const currentVersionId = await getCurrentChapterVersionId(pool, authorId, chapterId);
      await createChapterEvolution(pool, {
        author_id: authorId,
        chapter_id: chapterId,
        event_type: "CHAPTER_UNPUBLISHED",
        source_version_id: currentVersionId,
        target_version_id: currentVersionId,
        memory_id: null,
        metadata: {
          publication_status: "DRAFT",
          source: "chapters.unpublish",
        },
      });
    } catch (e) {
      console.warn("ChapterEvolution CHAPTER_UNPUBLISHED failed:", e?.message);
    }

    return res.json({
      ok: true,
      chapter_id: chapterId,
      status: "DRAFT",
      publication_status: "DRAFT",
      published_at: null,
      published_version_number: null,
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

router.get("/:id/memories", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .query(`
        SELECT
          m.memory_id,
          m.author_id,
          m.title,
          m.content,
          m.created_at,
          m.version_number,
          m.phase_id,
          p.phase_code AS life_phase,
          p.name       AS phase_name,

          mc.chapter_id,
          mc.is_primary,
          mc.sort_order,
          mc.created_at AS linked_at,
          mc.created_by AS linked_by,

          media.media_id,
          media.image_url,
          media.image_url AS media_url,
          media.image_url AS detail_url,
          media.image_url AS feed_url
        FROM dbo.identity_memory_chapter mc
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = mc.memory_id
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        OUTER APPLY (
          SELECT TOP 1
            mm.media_id,
            CASE
              WHEN mm.storage_path IS NULL OR LTRIM(RTRIM(mm.storage_path)) = '' THEN NULL
              WHEN mm.storage_path LIKE '/cdn/%' THEN REPLACE(mm.storage_path, '\\', '/')
              ELSE '/cdn/' + REPLACE(mm.storage_path, '\\', '/')
            END AS image_url
          FROM dbo.identity_memory_media mm
          WHERE mm.memory_id = m.memory_id
            AND mm.author_id = m.author_id
            AND LOWER(ISNULL(mm.media_type, '')) = 'image'
            AND ISNULL(mm.is_deleted, 0) = 0
          ORDER BY
            ISNULL(mm.is_primary_for_memory, 0) DESC,
            mm.created_at ASC,
            mm.media_id ASC
        ) media
        WHERE mc.chapter_id = @chapter_id
          AND mc.author_id  = @author_id
          AND m.author_id   = @author_id
          AND ISNULL(m.is_deleted,0) = 0
        ORDER BY
          CASE WHEN mc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
          mc.sort_order ASC,
          mc.created_at ASC,
          m.created_at DESC,
          m.memory_id DESC;
      `);

    return res.json({
      chapter_id: chapterId,
      items: result.recordset || [],
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/suggest", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const options = {
      language:
        req.body?.options?.language != null
          ? String(req.body.options.language)
          : "pt-BR",
      tone:
        req.body?.options?.tone != null
          ? String(req.body.options.tone)
          : "autobiografico",
      maxSections:
        req.body?.options?.max_sections != null
          ? Number(req.body.options.max_sections)
          : 6,
      maxThemes:
        req.body?.options?.max_themes != null
          ? Number(req.body.options.max_themes)
          : 5,
    };

    const userId = ensureUserId(req, res);
    if (!userId) return;

    const pool = await getPool();
    const planCheck = await checkNarrativeAiGenerationQuota({
      pool,
      userId,
      requestedValue: 1,
    });

    if (!planCheck.allowed) {
      return sendPlanDenied(res, planCheck, {
        status: 403,
        message: "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    const reservation = await reserveNarrativeAiGenerationQuota({
      pool,
      userId,
      targetFeatureCode: "CHAPTER_AI_GENERATION_COUNT",
      reserveValue: 1,
      entityType: "CHAPTER_AI_SUGGESTION",
      entityId: chapterId,
      metadata: {
        author_id: authorId,
        chapter_id: chapterId,
        source: "chapters.suggest",
        economic_operation: "CHAPTER_AI_GENERATION",
      },
    });

    if (!reservation.allowed || !reservation.reservation_event_id) {
      return sendPlanDenied(res, reservation, {
        status: 403,
        message: "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    let result;
    try {
      result = await generateChapterSuggestion({
        authorId,
        chapterId,
        options,
      });
    } catch (error) {
      try {
        await releasePlanQuotaReservation({
          pool,
          userId,
          reservationEventId: reservation.reservation_event_id,
          reasonCode: error?.code || "CHAPTER_SUGGEST_FAILED",
          metadata: { author_id: authorId, chapter_id: chapterId, source: "chapters.suggest" },
        });
      } catch (releaseError) {
        console.error("[PLAN][CHAPTER] Falha ao liberar reserva:", releaseError?.message || releaseError);
      }
      throw error;
    }

    if (!result?.ok) {
      try {
        await releasePlanQuotaReservation({
          pool,
          userId,
          reservationEventId: reservation.reservation_event_id,
          reasonCode: result?.code || "CHAPTER_SUGGEST_FAILED",
          metadata: { author_id: authorId, chapter_id: chapterId, source: "chapters.suggest" },
        });
      } catch (releaseError) {
        console.error("[PLAN][CHAPTER] Falha ao liberar reserva:", releaseError?.message || releaseError);
      }
      return res.status(result?.status || 400).json({
        ok: false,
        code: result?.code || "CHAPTER_SUGGEST_FAILED",
        message: result?.message || "Falha ao gerar sugestão de capítulo.",
        meta: result?.meta || null,
      });
    }

    const quotaResult = await commitPlanQuotaReservation({
      pool,
      userId,
      reservationEventId: reservation.reservation_event_id,
      metadata: {
        author_id: authorId,
        chapter_id: chapterId,
        suggestion_id: result?.suggestion_id ?? null,
        source: "chapters.suggest",
        economic_operation: "CHAPTER_AI_GENERATION",
      },
    });

    if (!quotaResult.allowed) {
      return res.status(409).json({
        ok: false,
        error: "A sugestão foi concluída, mas a reserva econômica não pôde ser consolidada.",
        code: quotaResult.reason_code || "PLAN_QUOTA_COMMIT_FAILED",
      });
    }

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_ai_suggestion_generated",
        chapterId,
        eventKey: buildEventKey("chapter_ai_suggestion_generated", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "suggestion",
          result.suggestion_id,
        ]),
        metadata: {
          suggestion_id: result.suggestion_id,
          source_memory_count: result?.meta?.source_memory_count ?? null,
          provider: result?.meta?.provider ?? "mock",
          model: result?.meta?.model ?? "chapter-engine-v1-local",
          themes: result?.data?.themes ?? [],
          source: "chapters.suggest",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_ai_suggestion_generated failed:", e?.message);
    }

    return res.status(result.status || 201).json(result);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/suggestions/latest", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const result = await getLatestChapterSuggestion({
      authorId,
      chapterId,
    });

    if (!result?.ok) {
      return res.status(result?.status || 404).json({
        ok: false,
        code: result?.code || "SUGGESTION_NOT_FOUND",
        message: result?.message || "Nenhuma sugestão encontrada.",
      });
    }

    return res.status(result.status || 200).json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/suggestions/:suggestionId/apply", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const suggestionId = toInt(req.params.suggestionId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    if (!Number.isFinite(suggestionId) || suggestionId <= 0) {
      return res.status(400).json({ error: "suggestion_id inválido." });
    }

    const applyScope = normalizeApplyScope(req.body?.apply_scope ?? req.body?.scope ?? "all");
    if (!applyScope) {
      return res.status(422).json({
        error: "apply_scope inválido.",
        detail: "Use: title, summary ou all.",
      });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const suggestion = await getSuggestionForApply(pool, authorId, chapterId, suggestionId);
    if (!suggestion) {
      return res.status(404).json({
        error: "Sugestão não encontrada.",
        code: "SUGGESTION_NOT_FOUND",
      });
    }

    const suggestionStatus = String(suggestion.suggestion_status ?? "").trim().toLowerCase();
    if (suggestionStatus === "discarded") {
      return res.status(409).json({
        error: "Sugestão descartada não pode ser aplicada.",
        code: "SUGGESTION_ALREADY_DISCARDED",
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status: "discarded",
          discarded_at: suggestion.discarded_at ?? null,
        },
      });
    }

    const detail = await getChapterDetailForApply(pool, authorId, chapterId);
    if (!detail?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const currentTitle = normalizeOptionalText(detail.chapter.title) ?? "";
    const currentDescription = normalizeOptionalText(detail.chapter.description);
    const currentBody =
      detail.currentVersion?.body != null ? String(detail.currentVersion.body) : "";

    const suggestedTitle = normalizeOptionalText(suggestion.chapter_title_suggestion);
    const suggestedSummary = normalizeOptionalText(suggestion.chapter_summary);

    if (applyScope === "title" && !suggestedTitle) {
      return res.status(422).json({
        error: "Sugestão sem título aplicável.",
        code: "SUGGESTION_HAS_NO_TITLE",
      });
    }

    if (applyScope === "summary" && !suggestedSummary) {
      return res.status(422).json({
        error: "Sugestão sem resumo aplicável.",
        code: "SUGGESTION_HAS_NO_SUMMARY",
      });
    }

    if (applyScope === "all" && !suggestedTitle && !suggestedSummary) {
      return res.status(422).json({
        error: "Sugestão sem conteúdo aplicável.",
        code: "SUGGESTION_HAS_NO_CONTENT",
      });
    }

    const nextTitle =
      applyScope === "title" || applyScope === "all"
        ? suggestedTitle || currentTitle
        : currentTitle;

    const nextBody =
      applyScope === "summary" || applyScope === "all"
        ? suggestedSummary || currentBody
        : currentBody;

    if (!nextTitle) {
      return res.status(422).json({
        error: "O capítulo ficaria sem título após aplicar a sugestão.",
        code: "INVALID_RESULTING_TITLE",
      });
    }

    const titleChanged =
      normalizeComparableText(nextTitle) !== normalizeComparableText(currentTitle);
    const bodyChanged =
      normalizeComparableText(nextBody) !== normalizeComparableText(currentBody);

    if (!titleChanged && !bodyChanged) {
      return res.status(200).json({
        ok: true,
        applied: false,
        code: "NO_CHANGES_TO_APPLY",
        message: "A sugestão já está refletida no capítulo. Nenhuma nova versão foi criada.",
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        apply_scope: applyScope,
        chapter_version_id:
          detail.chapter?.current_version_id != null
            ? Number(detail.chapter.current_version_id)
            : null,
        chapter: {
          chapter_id: chapterId,
          title: currentTitle,
          description: currentDescription,
          body: currentBody,
        },
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status:
            suggestion.suggestion_status != null ? String(suggestion.suggestion_status) : null,
          applied_at: suggestion.applied_at ?? null,
        },
        changes: {
          title_changed: false,
          body_changed: false,
        },
      });
    }

    const updateResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("title", sql.NVarChar(200), nextTitle)
      .input("description", sql.NVarChar(400), currentDescription)
      .input("body", sql.NVarChar(sql.MAX), nextBody)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Update_WithVersion");

    const chapterVersionId =
      updateResult?.output?.chapter_version_id ??
      updateResult?.recordset?.[0]?.chapter_version_id ??
      null;

    await markSuggestionApplied(pool, authorId, chapterId, suggestionId);

    const appliedAtIso = new Date().toISOString();

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_ai_suggestion_applied",
        chapterId,
        eventKey: buildEventKey("chapter_ai_suggestion_applied", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "suggestion",
          suggestionId,
          "scope",
          applyScope,
        ]),
        metadata: {
          suggestion_id: suggestionId,
          apply_scope: applyScope,
          chapter_version_id: chapterVersionId,
          title_applied: titleChanged,
          summary_applied: bodyChanged,
          provider: suggestion.llm_provider ?? null,
          model: suggestion.llm_model ?? null,
          prompt_version: suggestion.prompt_version ?? null,
          confidence_score:
            suggestion.confidence_score != null ? Number(suggestion.confidence_score) : null,
          source: "chapters.apply_suggestion",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_ai_suggestion_applied failed:", e?.message);
    }

    return res.status(200).json({
      ok: true,
      applied: true,
      chapter_id: chapterId,
      suggestion_id: suggestionId,
      apply_scope: applyScope,
      chapter_version_id: chapterVersionId != null ? Number(chapterVersionId) : null,
      chapter: {
        chapter_id: chapterId,
        title: nextTitle,
        description: currentDescription,
        body: nextBody,
      },
      suggestion: {
        suggestion_id: Number(suggestion.suggestion_id),
        suggestion_status: "applied",
        applied_at: appliedAtIso,
      },
      changes: {
        title_changed: titleChanged,
        body_changed: bodyChanged,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/suggestions/:suggestionId/discard", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const suggestionId = toInt(req.params.suggestionId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    if (!Number.isFinite(suggestionId) || suggestionId <= 0) {
      return res.status(400).json({ error: "suggestion_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const suggestion = await getSuggestionForApply(pool, authorId, chapterId, suggestionId);
    if (!suggestion) {
      return res.status(404).json({
        error: "Sugestão não encontrada.",
        code: "SUGGESTION_NOT_FOUND",
      });
    }

    const suggestionStatus = String(suggestion.suggestion_status ?? "").trim().toLowerCase();

    if (suggestionStatus === "applied") {
      return res.status(409).json({
        error: "Sugestão já aplicada não pode ser descartada.",
        code: "SUGGESTION_ALREADY_APPLIED",
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status: "applied",
          applied_at: suggestion.applied_at ?? null,
        },
      });
    }

    if (suggestionStatus === "discarded") {
      return res.status(200).json({
        ok: true,
        discarded: true,
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status: "discarded",
          discarded_at: suggestion.discarded_at ?? null,
        },
      });
    }

    const discardedRow = await markSuggestionDiscarded(pool, authorId, chapterId, suggestionId);
    const discardedAtIso =
      discardedRow?.discarded_at != null
        ? new Date(discardedRow.discarded_at).toISOString()
        : new Date().toISOString();

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_ai_suggestion_discarded",
        chapterId,
        eventKey: buildEventKey("chapter_ai_suggestion_discarded", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "suggestion",
          suggestionId,
        ]),
        metadata: {
          suggestion_id: suggestionId,
          provider: suggestion.llm_provider ?? null,
          model: suggestion.llm_model ?? null,
          prompt_version: suggestion.prompt_version ?? null,
          confidence_score:
            suggestion.confidence_score != null ? Number(suggestion.confidence_score) : null,
          source: "chapters.discard_suggestion",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_ai_suggestion_discarded failed:", e?.message);
    }

    return res.status(200).json({
      ok: true,
      discarded: true,
      chapter_id: chapterId,
      suggestion_id: suggestionId,
      suggestion: {
        suggestion_id: Number(discardedRow?.suggestion_id ?? suggestionId),
        suggestion_status:
          discardedRow?.suggestion_status != null
            ? String(discardedRow.suggestion_status)
            : "discarded",
        discarded_at: discardedAtIso,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/memories/:memoryId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }

    const requestedPrimary = normalizeBitFlag(
      req.body?.is_primary ?? req.body?.isPrimary,
      0
    );

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const existingInChapter = await getMemoryLinkInChapter(pool, authorId, chapterId, memoryId);
    if (existingInChapter?.chapter_id != null) {
      const links = await listMemoryLinks(pool, authorId, memoryId);

      return res.status(200).json({
        ok: true,
        already_linked: true,
        chapter_id: chapterId,
        memory_id: memoryId,
        linked_at: existingInChapter.linked_at ?? null,
        linked_by: existingInChapter.linked_by ?? null,
        is_primary: existingInChapter.is_primary != null ? Number(existingInChapter.is_primary) : 0,
        sort_order:
          existingInChapter.sort_order != null ? Number(existingInChapter.sort_order) : null,
        all_links: links,
      });
    }

    const existingLinks = await listMemoryLinks(pool, authorId, memoryId);
    const shouldBePrimary = existingLinks.length === 0 ? 1 : requestedPrimary;

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      const nextOrder = await getNextSortOrder(tx, authorId, chapterId);

      await createRequest(tx)
        .input("author_id", sql.Int, authorId)
        .input("chapter_id", sql.Int, chapterId)
        .input("memory_id", sql.Int, memoryId)
        .input("is_primary", sql.Bit, shouldBePrimary)
        .input("sort_order", sql.Int, nextOrder)
        .query(`
          INSERT INTO dbo.identity_memory_chapter
            (author_id, memory_id, chapter_id, is_primary, sort_order, created_by)
          VALUES
            (@author_id, @memory_id, @chapter_id, @is_primary, @sort_order, NULL);
        `);

      if (shouldBePrimary === 1) {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId, chapterId);
      } else {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId);
      }

      await tx.commit();

      let primaryChapterId = null;
      try {
        const finalLinks = await listMemoryLinks(pool, authorId, memoryId);
        primaryChapterId =
          finalLinks.find((x) => Number(x.is_primary) === 1)?.chapter_id ?? null;
      } catch {}

      try {
        await createNarrativeEvent({
          authorId,
          eventType: "memory_linked_to_chapter",
          memoryId,
          chapterId,
          eventKey: buildEventKey("memory_linked_to_chapter", [
            "author",
            authorId,
            "chapter",
            chapterId,
            "memory",
            memoryId,
          ]),
          metadata: {
            is_primary_requested: requestedPrimary,
            is_primary_effective: primaryChapterId === chapterId ? 1 : 0,
            source: "chapters.link_memory",
          },
        });
      } catch (e) {
        console.warn("NarrativeEvent memory_linked_to_chapter failed:", e?.message);
      }

      try {
        const currentVersionId = await getCurrentChapterVersionId(pool, authorId, chapterId);
        await createChapterEvolution(pool, {
          author_id: authorId,
          chapter_id: chapterId,
          event_type: "CHAPTER_MEMORY_ADDED",
          source_version_id: currentVersionId,
          target_version_id: currentVersionId,
          memory_id: memoryId,
          metadata: {
            is_primary_requested: requestedPrimary,
            is_primary_effective: primaryChapterId === chapterId ? 1 : 0,
            source: "chapters.link_memory",
          },
        });
      } catch (e) {
        console.warn("ChapterEvolution CHAPTER_MEMORY_ADDED failed:", e?.message);
      }

      return res.status(201).json({
        ok: true,
        chapter_id: chapterId,
        memory_id: memoryId,
        created: true,
        requested_primary: requestedPrimary,
        is_primary: primaryChapterId === chapterId ? 1 : 0,
      });
    } catch (e) {
      try {
        await tx.rollback();
      } catch {}
      throw e;
    }
  } catch (err) {
    const msg = String(err?.message || "");

    if (msg.includes("UX_imc_memory_primary") || msg.includes("duplicate key")) {
      const authorId = Number(req?.user?.author_id || 0);
      const chapterId = toInt(req.params.id);
      const memoryId = toInt(req.params.memoryId);

      try {
        const pool = await getPool();
        const existingLinks =
          authorId > 0 && Number.isFinite(memoryId) && memoryId > 0
            ? await listMemoryLinks(pool, authorId, memoryId)
            : [];

        return res.status(409).json({
          error:
            "A API agora aceita memória em múltiplos capítulos, mas o banco ainda está bloqueando este vínculo.",
          code: "MEMORY_LINK_BLOCKED_BY_DB_CONSTRAINT",
          memory_id: Number.isFinite(memoryId) ? memoryId : null,
          requested_chapter_id: Number.isFinite(chapterId) ? chapterId : null,
          existing_links: existingLinks,
          hint:
            "Revise a constraint/índice único da tabela dbo.identity_memory_chapter para permitir unicidade por (memory_id, chapter_id) e, se houver regra de primário, no máximo um vínculo primário por memória.",
        });
      } catch {
        return res.status(409).json({
          error:
            "A API agora aceita memória em múltiplos capítulos, mas o banco ainda está bloqueando este vínculo.",
          code: "MEMORY_LINK_BLOCKED_BY_DB_CONSTRAINT",
          hint:
            "Revise a constraint/índice único da tabela dbo.identity_memory_chapter para permitir unicidade por (memory_id, chapter_id) e, se houver regra de primário, no máximo um vínculo primário por memória.",
        });
      }
    }

    return next(err);
  }
});

router.post("/:id/memories/:memoryId/move", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);
    const fromChapterIdRaw =
      req.body?.from_chapter_id ??
      req.body?.fromChapterId ??
      req.query?.from_chapter_id ??
      req.query?.fromChapterId ??
      null;
    const fromChapterId =
      fromChapterIdRaw == null || fromChapterIdRaw === "" ? null : toInt(fromChapterIdRaw);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }
    if (fromChapterIdRaw != null && (!Number.isFinite(fromChapterId) || fromChapterId <= 0)) {
      return res.status(400).json({ error: "from_chapter_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const sourceLink = await getMoveSourceLink(
      pool,
      authorId,
      memoryId,
      chapterId,
      fromChapterId
    );

    if (!sourceLink) {
      return res.status(404).json({
        error: "Vínculo de origem não encontrado para esta memória.",
        code: "LINK_NOT_FOUND",
        memory_id: memoryId,
        from_chapter_id: fromChapterId,
      });
    }

    const fromChapterResolvedId = Number(sourceLink.chapter_id);
    const fromChapterTitle =
      sourceLink.chapter_title != null ? String(sourceLink.chapter_title) : null;
    const sourceWasPrimary = Number(sourceLink.is_primary ?? 0) === 1;

    if (fromChapterResolvedId === chapterId) {
      return res.status(200).json({
        ok: true,
        code: "ALREADY_IN_CHAPTER",
        memory_id: memoryId,
        from_chapter_id: fromChapterResolvedId,
        from_chapter_title: fromChapterTitle,
        to_chapter_id: chapterId,
      });
    }

    const targetLink = await getMemoryLinkInChapter(pool, authorId, chapterId, memoryId);

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      let nextOrder = null;

      if (!targetLink) {
        nextOrder = await getNextSortOrder(tx, authorId, chapterId);

        await createRequest(tx)
          .input("author_id", sql.Int, authorId)
          .input("memory_id", sql.Int, memoryId)
          .input("to_chapter_id", sql.Int, chapterId)
          .input("sort_order", sql.Int, nextOrder)
          .input("is_primary", sql.Bit, sourceWasPrimary ? 1 : 0)
          .query(`
            INSERT INTO dbo.identity_memory_chapter
              (author_id, memory_id, chapter_id, is_primary, sort_order, created_by)
            VALUES
              (@author_id, @memory_id, @to_chapter_id, @is_primary, @sort_order, NULL);
          `);
      }

      await createRequest(tx)
        .input("author_id", sql.Int, authorId)
        .input("memory_id", sql.Int, memoryId)
        .input("from_chapter_id", sql.Int, fromChapterResolvedId)
        .query(`
          DELETE FROM dbo.identity_memory_chapter
          WHERE author_id = @author_id
            AND memory_id = @memory_id
            AND chapter_id = @from_chapter_id;
        `);

      if (sourceWasPrimary) {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId, chapterId);
      } else {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId);
      }

      await tx.commit();

      const finalLinks = await listMemoryLinks(pool, authorId, memoryId);
      const finalTargetLink =
        finalLinks.find((x) => Number(x.chapter_id) === Number(chapterId)) || null;
      const primaryChapterId =
        finalLinks.find((x) => Number(x.is_primary) === 1)?.chapter_id ?? null;

      try {
        await createNarrativeEvent({
          authorId,
          eventType: "memory_reordered",
          memoryId,
          chapterId,
          eventKey: buildEventKey("memory_reordered", [
            "author",
            authorId,
            "from",
            fromChapterResolvedId,
            "to",
            chapterId,
            "memory",
            memoryId,
          ]),
          metadata: {
            from_chapter_id: fromChapterResolvedId,
            from_chapter_title: fromChapterTitle,
            to_chapter_id: chapterId,
            target_already_linked: !!targetLink,
            sort_order:
              finalTargetLink?.sort_order != null
                ? Number(finalTargetLink.sort_order)
                : nextOrder,
            promoted_to_primary: primaryChapterId === chapterId ? 1 : 0,
            source: "chapters.move_memory",
          },
        });
      } catch (e) {
        console.warn("NarrativeEvent memory_reordered(move) failed:", e?.message);
      }

      return res.status(200).json({
        ok: true,
        code: targetLink ? "MERGED_AND_MOVED" : "MOVED",
        memory_id: memoryId,
        from_chapter_id: fromChapterResolvedId,
        from_chapter_title: fromChapterTitle,
        to_chapter_id: chapterId,
        sort_order:
          finalTargetLink?.sort_order != null ? Number(finalTargetLink.sort_order) : nextOrder,
        is_primary: primaryChapterId === chapterId ? 1 : 0,
      });
    } catch (e) {
      try {
        await tx.rollback();
      } catch {}
      throw e;
    }
  } catch (err) {
    const msg = String(err?.message || "");

    if (msg.includes("UX_imc_memory_primary") || msg.includes("duplicate key")) {
      return res.status(409).json({
        error:
          "O movimento foi interpretado em domínio N:N, mas o banco ainda possui restrição incompatível com o vínculo final.",
        code: "MEMORY_MOVE_BLOCKED_BY_DB_CONSTRAINT",
        hint:
          "Garanta unicidade por (memory_id, chapter_id) e apenas um vínculo primário por memória, se essa regra existir no banco.",
      });
    }

    return next(err);
  }
});

router.delete("/:id/memories/:memoryId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const existingLink = await getMemoryLinkInChapter(pool, authorId, chapterId, memoryId);
    if (!existingLink) {
      return res.status(404).json({ error: "Vínculo não encontrado." });
    }

    const wasPrimary = Number(existingLink.is_primary ?? 0) === 1;

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      await createRequest(tx)
        .input("author_id", sql.Int, authorId)
        .input("chapter_id", sql.Int, chapterId)
        .input("memory_id", sql.Int, memoryId)
        .query(`
          DELETE FROM dbo.identity_memory_chapter
          WHERE author_id=@author_id
            AND chapter_id=@chapter_id
            AND memory_id=@memory_id;
        `);

      await ensureMemoryPrimaryLink(tx, authorId, memoryId);

      await tx.commit();

      try {
        const currentVersionId = await getCurrentChapterVersionId(pool, authorId, chapterId);
        await createChapterEvolution(pool, {
          author_id: authorId,
          chapter_id: chapterId,
          event_type: "CHAPTER_MEMORY_REMOVED",
          source_version_id: currentVersionId,
          target_version_id: currentVersionId,
          memory_id: memoryId,
          metadata: {
            removed_primary: wasPrimary,
            source: "chapters.unlink_memory",
          },
        });
      } catch (e) {
        console.warn("ChapterEvolution CHAPTER_MEMORY_REMOVED failed:", e?.message);
      }

      return res.json({
        ok: true,
        chapter_id: chapterId,
        memory_id: memoryId,
        removed_primary: wasPrimary,
      });
    } catch (e) {
      try {
        await tx.rollback();
      } catch {}
      throw e;
    }
  } catch (err) {
    return next(err);
  }
});

router.put("/:id/memories/:memoryId/order", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }

    const sortOrderRaw = req.body?.sort_order ?? req.body?.sortOrder ?? null;
    const sortOrder =
      sortOrderRaw === null || sortOrderRaw === undefined ? null : Number(sortOrderRaw);

    if (
      sortOrder !== null &&
      (!Number.isInteger(sortOrder) || sortOrder < 1 || sortOrder > 1000000)
    ) {
      return res.status(422).json({ error: "sort_order inválido (use int >= 1 ou null)." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const exists = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("memory_id", sql.Int, memoryId)
      .query(`
        SELECT TOP 1 1 AS ok
        FROM dbo.identity_memory_chapter
        WHERE author_id=@author_id AND chapter_id=@chapter_id AND memory_id=@memory_id;
      `);

    if (!exists.recordset?.[0]?.ok) {
      return res.status(404).json({ error: "Vínculo não encontrado." });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("memory_id", sql.Int, memoryId)
      .input("sort_order", sql.Int, sortOrder)
      .query(`
        UPDATE dbo.identity_memory_chapter
        SET sort_order = @sort_order
        WHERE author_id=@author_id AND chapter_id=@chapter_id AND memory_id=@memory_id;
      `);

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "memory_reordered",
        memoryId,
        chapterId,
        eventKey: buildEventKey("memory_reordered", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "memory",
          memoryId,
          "sort",
          sortOrder ?? "null",
        ]),
        metadata: {
          sort_order: sortOrder,
          source: "chapters.update_order",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent memory_reordered(order) failed:", e?.message);
    }

    return res.json({
      ok: true,
      chapter_id: chapterId,
      memory_id: memoryId,
      sort_order: sortOrder,
    });
  } catch (err) {
    return next(err);
  }
});


// GO LIVE 010 — Lifecycle Editorial de Capítulo
router.delete("/:id", authRequired, async (req, res, next) => {
  const transaction = new sql.Transaction(await getPool());
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;
    const chapterId = toInt(req.params.id);
    if (!Number.isInteger(chapterId) || chapterId <= 0) {
      return res.status(400).json({ ok: false, error: "chapterId inválido." });
    }

    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    const request = new sql.Request(transaction);
    request.input("author_id", sql.Int, authorId);
    request.input("chapter_id", sql.Int, chapterId);

    const exists = await request.query(`
      SELECT TOP 1 chapter_id, publication_status
      FROM dbo.identity_chapter
      WHERE chapter_id=@chapter_id AND author_id=@author_id
        AND ISNULL(is_deleted,0)=0;
    `);
    if (!exists.recordset?.[0]) {
      await transaction.rollback();
      return res.status(404).json({ ok: false, error: "Capítulo não encontrado." });
    }

    await request.query(`
      DELETE FROM dbo.identity_memory_chapter
      WHERE chapter_id=@chapter_id AND author_id=@author_id;

      IF OBJECT_ID('dbo.identity_story_chapter_lineage','U') IS NOT NULL
        DELETE FROM dbo.identity_story_chapter_lineage
        WHERE chapter_id=@chapter_id AND author_id=@author_id;

      UPDATE dbo.identity_chapter
      SET is_deleted=1,
          publication_status='DRAFT',
          published_at=NULL,
          updated_at=SYSUTCDATETIME()
      WHERE chapter_id=@chapter_id AND author_id=@author_id
        AND ISNULL(is_deleted,0)=0;
    `);
    await transaction.commit();

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_deleted",
        chapterId,
        eventKey: buildEventKey("chapter_deleted", ["author", authorId, "chapter", chapterId]),
        metadata: { source: "chapters.lifecycle", lifecycle: "ARCHIVED" },
      });
    } catch (eventError) {
      console.warn("NarrativeEvent chapter_deleted failed:", eventError?.message);
    }

    return res.json({ ok: true, chapter_id: chapterId, deleted: true, lifecycle: "ARCHIVED" });
  } catch (error) {
    try { if (transaction._aborted !== true) await transaction.rollback(); } catch {}
    return next(error);
  }
});

export default router;