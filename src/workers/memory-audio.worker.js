// C:\HDUD_DATA\hdud-api-node\src\workers\memory-audio.worker.js

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";
import { Worker } from "bullmq";
import { getPool, sql } from "../db.js";
import { getRedisConnection } from "../queue/redis.js";
import { MEMORY_AUDIO_QUEUE_NAME } from "../queue/memory-audio.queue.js";

const WORKER_CONCURRENCY = Number(
  process.env.MEMORY_AUDIO_WORKER_CONCURRENCY || 1
);

const OPENAI_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL ||
  process.env.OPENAI_AUDIO_TRANSCRIPTION_MODEL ||
  "gpt-4o-mini-transcribe";

let openaiClient = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) return null;

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: String(apiKey).trim() });
  }
  return openaiClient;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function safeNowIso() {
  return new Date().toISOString();
}

function ensureAbsolutePath(filePath) {
  const p = normalizeString(filePath);
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.join(process.cwd(), p);
}

function buildMockTranscript({ memoryId, mediaId, audioSeconds }) {
  const seconds =
    audioSeconds == null || Number.isNaN(Number(audioSeconds))
      ? null
      : Number(audioSeconds);

  const durationText =
    seconds == null
      ? "Duração não informada."
      : `Duração aproximada do áudio: ${seconds} segundos.`;

  return [
    "TRANSCRIÇÃO INTERNA HDUD (MOCK)",
    "",
    "Este texto foi gerado internamente para manter o pipeline vivo sem consumo da OpenAI.",
    durationText,
    `memory_id: ${memoryId ?? "N/A"}`,
    `media_id: ${mediaId ?? "N/A"}`,
    `generated_at: ${safeNowIso()}`,
    "",
    "Conteúdo simulado:",
    "Olá. Esta é uma transcrição de teste criada pelo worker interno da HDUD.",
    "O objetivo é validar upload, fila, processamento, persistência e leitura final da memória.",
    "Quando a integração real estiver ativa, este conteúdo será substituído pela transcrição oficial do áudio.",
  ].join("\n");
}

async function tableExists(pool, schemaName, tableName) {
  const result = await pool
    .request()
    .input("schema_name", sql.NVarChar(128), schemaName)
    .input("table_name", sql.NVarChar(128), tableName).query(`
      SELECT TOP 1 1 AS ok
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = @schema_name
        AND TABLE_NAME = @table_name
    `);

  return !!result.recordset?.[0]?.ok;
}

async function getColumns(pool, schemaName, tableName) {
  const result = await pool
    .request()
    .input("schema_name", sql.NVarChar(128), schemaName)
    .input("table_name", sql.NVarChar(128), tableName).query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema_name
        AND TABLE_NAME = @table_name
    `);

  return new Set((result.recordset || []).map((r) => String(r.COLUMN_NAME)));
}

async function resolveMediaTable(pool) {
  const candidates = [
    { schema: "dbo", table: "identity_memory_media" },
    { schema: "dbo", table: "memory_media" },
    { schema: "dco", table: "identity_memory_media" },
    { schema: "dco", table: "memory_media" },
  ];

  for (const candidate of candidates) {
    if (await tableExists(pool, candidate.schema, candidate.table)) {
      const columns = await getColumns(pool, candidate.schema, candidate.table);
      return { ...candidate, columns };
    }
  }

  throw new Error(
    "Tabela de mídia da memória não encontrada. Esperado: dbo.identity_memory_media ou dbo.memory_media."
  );
}

async function resolveUserTable(pool) {
  const candidates = [
    { schema: "dbo", table: "identity_user" },
    { schema: "dbo", table: "users" },
    { schema: "dco", table: "identity_user" },
  ];

  for (const candidate of candidates) {
    if (await tableExists(pool, candidate.schema, candidate.table)) {
      const columns = await getColumns(pool, candidate.schema, candidate.table);
      return { ...candidate, columns };
    }
  }

  return null;
}

async function fetchMediaContext(pool, mediaTable, mediaId) {
  const idCol = mediaTable.columns.has("media_id")
    ? "media_id"
    : mediaTable.columns.has("id")
      ? "id"
      : null;

  if (!idCol) {
    throw new Error(
      `Tabela ${mediaTable.schema}.${mediaTable.table} sem coluna identificadora compatível (media_id/id).`
    );
  }

  const fileCandidates = [
    "storage_path",
    "file_path",
    "path",
    "local_path",
    "disk_path",
    "blob_path",
    "relative_path",
    "public_url",
    "url",
    "file_url",
  ].filter((c) => mediaTable.columns.has(c));

  const statusCandidates = [
    "transcription_status",
    "status",
    "processing_status",
  ].filter((c) => mediaTable.columns.has(c));

  const memoryIdCol = mediaTable.columns.has("memory_id")
    ? "memory_id"
    : mediaTable.columns.has("identity_memory_id")
      ? "identity_memory_id"
      : null;

  const authorIdCol = mediaTable.columns.has("author_id")
    ? "author_id"
    : mediaTable.columns.has("identity_author_id")
      ? "identity_author_id"
      : null;

  const userIdCol = mediaTable.columns.has("user_id")
    ? "user_id"
    : mediaTable.columns.has("identity_user_id")
      ? "identity_user_id"
      : null;

  const secondsCandidates = [
    "duration_seconds",
    "audio_seconds",
    "duration_sec",
    "seconds",
  ].filter((c) => mediaTable.columns.has(c));

  const selectParts = [`m.[${idCol}] AS media_id`];

  if (memoryIdCol) selectParts.push(`m.[${memoryIdCol}] AS memory_id`);
  if (authorIdCol) selectParts.push(`m.[${authorIdCol}] AS author_id`);
  if (userIdCol) selectParts.push(`m.[${userIdCol}] AS user_id`);

  for (const c of fileCandidates) {
    selectParts.push(`m.[${c}] AS [${c}]`);
  }

  for (const c of statusCandidates) {
    selectParts.push(`m.[${c}] AS [${c}]`);
  }

  for (const c of secondsCandidates) {
    selectParts.push(`m.[${c}] AS [${c}]`);
  }

  const result = await pool
    .request()
    .input("media_id", sql.BigInt, Number(mediaId)).query(`
      SELECT TOP 1
        ${selectParts.join(",\n        ")}
      FROM [${mediaTable.schema}].[${mediaTable.table}] m
      WHERE m.[${idCol}] = @media_id
    `);

  const row = result.recordset?.[0];
  if (!row) {
    throw new Error(`Mídia ${mediaId} não encontrada.`);
  }

  const filePath =
    normalizeString(row.storage_path) ||
    normalizeString(row.file_path) ||
    normalizeString(row.path) ||
    normalizeString(row.local_path) ||
    normalizeString(row.disk_path) ||
    normalizeString(row.blob_path) ||
    normalizeString(row.relative_path) ||
    normalizeString(row.public_url) ||
    normalizeString(row.url) ||
    normalizeString(row.file_url) ||
    null;

  const transcriptionStatus =
    normalizeString(row.transcription_status) ||
    normalizeString(row.processing_status) ||
    normalizeString(row.status) ||
    null;

  const seconds =
    toInt(row.duration_seconds) ??
    toInt(row.audio_seconds) ??
    toInt(row.duration_sec) ??
    toInt(row.seconds) ??
    null;

  return {
    mediaId: toInt(row.media_id),
    memoryId: toInt(row.memory_id),
    authorId: toInt(row.author_id),
    userId: toInt(row.user_id),
    filePath,
    transcriptionStatus,
    audioSeconds: seconds,
  };
}

async function fetchUserContext(pool, userTable, userId) {
  if (!userTable || userId == null) {
    return {
      userId: userId ?? null,
      isMockTranscriptionEnabled: false,
      planCode: null,
    };
  }

  const idCol = userTable.columns.has("user_id")
    ? "user_id"
    : userTable.columns.has("id")
      ? "id"
      : null;

  if (!idCol) {
    return {
      userId,
      isMockTranscriptionEnabled: false,
      planCode: null,
    };
  }

  const mockCol = userTable.columns.has("is_mock_transcription_enabled")
    ? "is_mock_transcription_enabled"
    : null;

  const planCol = userTable.columns.has("plan_code")
    ? "plan_code"
    : userTable.columns.has("current_plan_code")
      ? "current_plan_code"
      : null;

  const selectParts = [`u.[${idCol}] AS user_id`];
  if (mockCol) selectParts.push(`u.[${mockCol}] AS is_mock_transcription_enabled`);
  if (planCol) selectParts.push(`u.[${planCol}] AS plan_code`);

  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId)).query(`
      SELECT TOP 1
        ${selectParts.join(",\n        ")}
      FROM [${userTable.schema}].[${userTable.table}] u
      WHERE u.[${idCol}] = @user_id
    `);

  const row = result.recordset?.[0];

  return {
    userId: toInt(row?.user_id) ?? userId,
    isMockTranscriptionEnabled:
      row?.is_mock_transcription_enabled === true ||
      row?.is_mock_transcription_enabled === 1,
    planCode: normalizeString(row?.plan_code)?.toUpperCase() || null,
  };
}

async function updateMediaStatus(pool, mediaTable, mediaId, payload) {
  const idCol = mediaTable.columns.has("media_id")
    ? "media_id"
    : mediaTable.columns.has("id")
      ? "id"
      : null;

  if (!idCol) return;

  const assignments = [];
  const request = pool.request().input("media_id", sql.BigInt, Number(mediaId));

  function setIfColumn(column, inputName, sqlType, value) {
    if (!mediaTable.columns.has(column) || value === undefined) return;
    assignments.push(`[${column}] = @${inputName}`);
    request.input(inputName, sqlType, value);
  }

  setIfColumn(
    "transcription_status",
    "transcription_status",
    sql.NVarChar(sql.MAX),
    payload.transcriptionStatus
  );
  setIfColumn("status", "status", sql.NVarChar(sql.MAX), payload.status);
  setIfColumn(
    "processing_status",
    "processing_status",
    sql.NVarChar(sql.MAX),
    payload.processingStatus
  );
  setIfColumn(
    "transcription_raw",
    "transcription_raw",
    sql.NVarChar(sql.MAX),
    payload.transcriptionRaw
  );
  setIfColumn(
    "transcription_text",
    "transcription_text",
    sql.NVarChar(sql.MAX),
    payload.transcriptionText
  );
  setIfColumn("transcript", "transcript", sql.NVarChar(sql.MAX), payload.transcript);
  setIfColumn(
    "transcript_text",
    "transcript_text",
    sql.NVarChar(sql.MAX),
    payload.transcriptText
  );
  setIfColumn(
    "provider",
    "provider",
    sql.NVarChar(100),
    payload.provider
  );
  setIfColumn(
    "transcription_provider",
    "transcription_provider",
    sql.NVarChar(100),
    payload.transcriptionProvider
  );
  setIfColumn(
    "transcription_mode",
    "transcription_mode",
    sql.NVarChar(50),
    payload.transcriptionMode
  );
  setIfColumn(
    "transcription_started_at",
    "transcription_started_at",
    sql.DateTime2,
    payload.transcriptionStartedAt
  );
  setIfColumn(
    "started_at",
    "started_at",
    sql.DateTime2,
    payload.startedAt
  );
  setIfColumn(
    "processing_started_at",
    "processing_started_at",
    sql.DateTime2,
    payload.processingStartedAt
  );
  setIfColumn(
    "transcription_completed_at",
    "transcription_completed_at",
    sql.DateTime2,
    payload.transcriptionCompletedAt
  );
  setIfColumn(
    "completed_at",
    "completed_at",
    sql.DateTime2,
    payload.completedAt
  );
  setIfColumn(
    "processing_completed_at",
    "processing_completed_at",
    sql.DateTime2,
    payload.processingCompletedAt
  );
  setIfColumn(
    "transcription_error",
    "transcription_error",
    sql.NVarChar(sql.MAX),
    payload.transcriptionError
  );
  setIfColumn(
    "error_message",
    "error_message",
    sql.NVarChar(sql.MAX),
    payload.errorMessage
  );
  setIfColumn("error", "error", sql.NVarChar(sql.MAX), payload.error);

  if (!assignments.length) return;

  await request.query(`
    UPDATE [${mediaTable.schema}].[${mediaTable.table}]
       SET ${assignments.join(",\n           ")}
     WHERE [${idCol}] = @media_id
  `);
}

async function tryMirrorTranscriptIntoMemory(pool, mediaTable, context, transcript) {
  if (!context.memoryId || !transcript) return;

  const candidates = [
    { schema: "dbo", table: "identity_memory" },
    { schema: "dbo", table: "memory" },
    { schema: "dco", table: "identity_memory" },
  ];

  let memoryTable = null;
  for (const candidate of candidates) {
    if (await tableExists(pool, candidate.schema, candidate.table)) {
      memoryTable = {
        ...candidate,
        columns: await getColumns(pool, candidate.schema, candidate.table),
      };
      break;
    }
  }

  if (!memoryTable) return;

  const idCol = memoryTable.columns.has("memory_id")
    ? "memory_id"
    : memoryTable.columns.has("id")
      ? "id"
      : null;

  if (!idCol) return;

  const contentCol = memoryTable.columns.has("content")
    ? "content"
    : memoryTable.columns.has("body")
      ? "body"
      : memoryTable.columns.has("description")
        ? "description"
        : null;

  if (!contentCol) return;

  const allowOverwrite =
    String(process.env.MEMORY_AUDIO_TRANSCRIPTION_OVERWRITE || "false")
      .trim()
      .toLowerCase() === "true";

  if (allowOverwrite) {
    await pool
      .request()
      .input("memory_id", sql.BigInt, Number(context.memoryId))
      .input("content", sql.NVarChar(sql.MAX), transcript).query(`
        UPDATE [${memoryTable.schema}].[${memoryTable.table}]
           SET [${contentCol}] = @content
         WHERE [${idCol}] = @memory_id
      `);
    return;
  }

  await pool
    .request()
    .input("memory_id", sql.BigInt, Number(context.memoryId))
    .input("content", sql.NVarChar(sql.MAX), transcript).query(`
      UPDATE [${memoryTable.schema}].[${memoryTable.table}]
         SET [${contentCol}] = @content
       WHERE [${idCol}] = @memory_id
         AND (
              [${contentCol}] IS NULL
              OR LTRIM(RTRIM(CONVERT(nvarchar(max), [${contentCol}]))) = ''
         )
    `);
}

async function readAudioBuffer(filePath) {
  const absolutePath = ensureAbsolutePath(filePath);
  if (!absolutePath) {
    throw new Error("Caminho do áudio não encontrado.");
  }

  return {
    absolutePath,
    buffer: await fs.readFile(absolutePath),
  };
}

async function transcribeWithOpenAI(filePath) {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const { absolutePath, buffer } = await readAudioBuffer(filePath);
  const fileName = path.basename(absolutePath) || "audio.webm";

  const response = await client.audio.transcriptions.create({
    file: new File([buffer], fileName),
    model: OPENAI_MODEL,
  });

  const text =
    typeof response?.text === "string"
      ? response.text.trim()
      : typeof response === "string"
        ? response.trim()
        : "";

  if (!text) {
    throw new Error("OpenAI retornou transcrição vazia.");
  }

  return text;
}

function shouldUseMock({ userContext, jobData }) {
  if (userContext?.isMockTranscriptionEnabled) return true;

  const userPlan = normalizeString(userContext?.planCode)?.toUpperCase();
  const jobPlan = normalizeString(jobData?.planCode)?.toUpperCase();

  if (userPlan === "INTERNAL") return true;
  if (jobPlan === "INTERNAL") return true;

  const envMock = String(process.env.MEMORY_AUDIO_FORCE_MOCK || "false")
    .trim()
    .toLowerCase();

  return envMock === "1" || envMock === "true" || envMock === "yes";
}

async function processJob(job) {
  const pool = await getPool();
  const mediaTable = await resolveMediaTable(pool);
  const userTable = await resolveUserTable(pool);

  const inputMemoryId = toInt(job?.data?.memoryId);
  const inputMediaId = toInt(job?.data?.mediaId);
  const inputAuthorId = toInt(job?.data?.authorId);
  const inputUserId = toInt(job?.data?.userId);
  const inputAudioSeconds = toInt(job?.data?.audioSeconds);
  const inputPlanCode = normalizeString(job?.data?.planCode)?.toUpperCase() || null;

  if (!inputMediaId) {
    throw new Error("Job inválido: mediaId ausente.");
  }

  const mediaContext = await fetchMediaContext(pool, mediaTable, inputMediaId);

  const effectiveContext = {
    memoryId: mediaContext.memoryId ?? inputMemoryId,
    mediaId: mediaContext.mediaId ?? inputMediaId,
    authorId: mediaContext.authorId ?? inputAuthorId,
    userId: mediaContext.userId ?? inputUserId,
    filePath: mediaContext.filePath,
    audioSeconds: inputAudioSeconds ?? mediaContext.audioSeconds,
  };

  const userContext = await fetchUserContext(pool, userTable, effectiveContext.userId);

  await updateMediaStatus(pool, mediaTable, effectiveContext.mediaId, {
    transcriptionStatus: "PROCESSING",
    status: "PROCESSING",
    processingStatus: "PROCESSING",
    transcriptionStartedAt: new Date(),
    startedAt: new Date(),
    processingStartedAt: new Date(),
    transcriptionError: null,
    errorMessage: null,
    error: null,
  });

  const useMock = shouldUseMock({
    userContext,
    jobData: { planCode: inputPlanCode },
  });

  const transcript = useMock
    ? buildMockTranscript(effectiveContext)
    : await transcribeWithOpenAI(effectiveContext.filePath);

  await updateMediaStatus(pool, mediaTable, effectiveContext.mediaId, {
    transcriptionStatus: "DONE",
    status: "DONE",
    processingStatus: "DONE",
    transcriptionRaw: transcript,
    transcriptionText: transcript,
    transcript,
    transcriptText: transcript,
    provider: useMock ? "internal-mock" : "openai",
    transcriptionProvider: useMock ? "internal-mock" : "openai",
    transcriptionMode: useMock ? "mock" : "live",
    transcriptionCompletedAt: new Date(),
    completedAt: new Date(),
    processingCompletedAt: new Date(),
    transcriptionError: null,
    errorMessage: null,
    error: null,
  });

  await tryMirrorTranscriptIntoMemory(
    pool,
    mediaTable,
    effectiveContext,
    transcript
  );

  return {
    ok: true,
    mediaId: effectiveContext.mediaId,
    memoryId: effectiveContext.memoryId,
    authorId: effectiveContext.authorId,
    userId: effectiveContext.userId,
    mode: useMock ? "mock" : "live",
    planCode: userContext.planCode || inputPlanCode,
    processedAt: safeNowIso(),
  };
}

export function startMemoryAudioWorker() {
  const worker = new Worker(
    MEMORY_AUDIO_QUEUE_NAME,
    async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        const pool = await getPool().catch(() => null);
        if (pool) {
          try {
            const mediaTable = await resolveMediaTable(pool);
            const mediaId = toInt(job?.data?.mediaId);
            if (mediaId) {
              await updateMediaStatus(pool, mediaTable, mediaId, {
                transcriptionStatus: "FAILED",
                status: "FAILED",
                processingStatus: "FAILED",
                transcriptionCompletedAt: new Date(),
                completedAt: new Date(),
                processingCompletedAt: new Date(),
                transcriptionError: err?.message || "Erro desconhecido.",
                errorMessage: err?.message || "Erro desconhecido.",
                error: err?.message || "Erro desconhecido.",
              });
            }
          } catch (_) {
            // noop
          }
        }

        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: WORKER_CONCURRENCY,
    }
  );

  worker.on("ready", () => {
    console.log(
      `[memory-audio.worker] ready queue=${MEMORY_AUDIO_QUEUE_NAME} concurrency=${WORKER_CONCURRENCY}`
    );
  });

  worker.on("active", (job) => {
    console.log(
      `[memory-audio.worker] active jobId=${job?.id} mediaId=${job?.data?.mediaId ?? "N/A"}`
    );
  });

  worker.on("completed", (job, result) => {
    console.log(
      `[memory-audio.worker] completed jobId=${job?.id} mediaId=${job?.data?.mediaId ?? "N/A"} mode=${result?.mode ?? "unknown"}`
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[memory-audio.worker] failed jobId=${job?.id} mediaId=${job?.data?.mediaId ?? "N/A"} error=${err?.message || err}`
    );
  });

  worker.on("error", (err) => {
    console.error("[memory-audio.worker] worker error:", err);
  });

  return worker;
}

const worker = startMemoryAudioWorker();

console.log("[WORKER] iniciado e aguardando jobs...");

setInterval(() => {}, 1000 * 60 * 60);

export default worker;