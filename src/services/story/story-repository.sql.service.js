// C:\HDUD_DATA\hdud-api-node\src\services\story\story-repository.sql.service.js

import crypto from "crypto";
import { getPool, sql } from "../../db.js";

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanText(value, fallback = null) {
  if (value == null) return fallback;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length ? s : fallback;
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Number(n.toFixed(4));
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function safeJsonParse(value, fallback = null) {
  try {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeStatus(value, fallback = "EMERGING") {
  const s = cleanText(value, fallback)?.toUpperCase();

  if (s === "DISCOVERING") return "DISCOVERING";
  if (s === "EMERGING") return "EMERGING";
  if (s === "MATURE") return "MATURE";
  if (s === "VALIDATED") return "VALIDATED";
  if (s === "EDITORIAL_READY") return "EDITORIAL_READY";
  if (s === "ACCEPTED") return "ACCEPTED";
  if (s === "DISCARDED") return "DISCARDED";
  if (s === "SNOOZED") return "SNOOZED";
  if (s === "CONVERTED_TO_CHAPTER") return "CONVERTED_TO_CHAPTER";

  return fallback;
}

function normalizeRelatedMemories(story) {
  const values =
    story?.related_memories ??
    story?.relatedMemories ??
    story?.memory_ids ??
    story?.memoryIds ??
    [];

  const out = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const memoryId =
      toPositiveInt(value?.memory_id) ??
      toPositiveInt(value?.memoryId) ??
      toPositiveInt(value?.id) ??
      toPositiveInt(value);

    if (!memoryId || seen.has(memoryId)) continue;
    seen.add(memoryId);

    out.push({
      memory_id: memoryId,
      evidence_weight: clampConfidence(value?.weight ?? value?.evidence_weight ?? 0.55),
      evidence_reason: cleanText(value?.reason ?? value?.evidence_reason, null),
    });
  }

  return out;
}

function normalizeEvidence(story) {
  const values = Array.isArray(story?.evidence) ? story.evidence : [];

  return values.map((item) => ({
    evidence_type: cleanText(item?.type, "STORY_SIGNAL"),
    evidence_label: cleanText(item?.label, null),
    evidence_reason: cleanText(item?.reason, null),
    evidence_weight: clampConfidence(item?.weight ?? 0.5),
    source_engine: cleanText(item?.source ?? item?.source_engine, null),
    payload: item?.payload ?? item ?? null,
  }));
}

export function buildStableStoryKey(story = {}) {
  const theme =
    cleanText(story.central_theme_code, null) ||
    cleanText(story.centralThemeCode, null) ||
    cleanText(story.central_theme, null) ||
    cleanText(story.centralTheme, null) ||
    cleanText(story.title, null) ||
    cleanText(story.suggested_title, null) ||
    "story";

  const memoryIds = normalizeRelatedMemories(story)
    .map((item) => item.memory_id)
    .sort((a, b) => a - b);

  const raw = JSON.stringify({
    theme: String(theme).toLowerCase(),
    memories: memoryIds,
  });

  return crypto.createHash("sha1").update(raw).digest("hex");
}

export function normalizeStoryForPersistence(story = {}, options = {}) {
  const relatedMemories = normalizeRelatedMemories(story);
  const evidence = normalizeEvidence(story);

  return {
    author_id: toPositiveInt(options.authorId ?? story.author_id ?? story.authorId),
    story_key: cleanText(story.story_key, null) || buildStableStoryKey(story),
    story_status: normalizeStatus(story.status ?? story.story_status, "EMERGING"),
    central_theme:
      cleanText(story.central_theme, null) ||
      cleanText(story.centralTheme, null) ||
      cleanText(story.title, null) ||
      cleanText(story.suggested_title, null) ||
      "História emergente",
    central_theme_code:
      cleanText(story.central_theme_code, null) ||
      cleanText(story.centralThemeCode, null) ||
      cleanText(story.theme_code, null),
    central_question:
      cleanText(story.central_question, null) ||
      cleanText(story.centralQuestion, null) ||
      cleanText(story.mainQuestion, null),
    summary:
      cleanText(story.summary, null) ||
      cleanText(story.description, null),
    main_transformation:
      cleanText(story.main_transformation, null) ||
      cleanText(story.mainTransformation, null),
    confidence_score: clampConfidence(story.confidence ?? story.confidence_score),
    source_engine:
      cleanText(story.engine, null) ||
      cleanText(options.sourceEngine, "story-discovery-orchestrator"),
    source_version:
      cleanText(story.version, null) ||
      cleanText(options.sourceVersion, null),
    source_payload_json: safeJson(story),
    related_memories: relatedMemories,
    evidence,
  };
}

function normalizeStoryRow(row) {
  if (!row) return null;

  return {
    story_id: Number(row.story_id),
    story_key: row.story_key,
    author_id: Number(row.author_id),
    status: row.story_status,
    story_status: row.story_status,
    central_theme: row.central_theme ?? null,
    central_theme_code: row.central_theme_code ?? null,
    central_question: row.central_question ?? null,
    summary: row.summary ?? null,
    main_transformation: row.main_transformation ?? null,
    confidence: Number(row.confidence_score ?? 0),
    confidence_score: Number(row.confidence_score ?? 0),
    source_engine: row.source_engine ?? null,
    source_version: row.source_version ?? null,
    source_payload: safeJsonParse(row.source_payload_json, null),
    first_detected_at: row.first_detected_at ?? null,
    last_detected_at: row.last_detected_at ?? null,
    accepted_at: row.accepted_at ?? null,
    discarded_at: row.discarded_at ?? null,
    snoozed_until: row.snoozed_until ?? null,
    converted_to_chapter_at: row.converted_to_chapter_at ?? null,
    converted_chapter_id:
      row.converted_chapter_id != null ? Number(row.converted_chapter_id) : null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export async function upsertNarrativeStory(story, options = {}) {
  const payload = normalizeStoryForPersistence(story, options);

  if (!payload.author_id) {
    return {
      ok: false,
      reason: "authorId inválido para persistir NarrativeStory.",
    };
  }

  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, payload.author_id)
    .input("story_key", sql.NVarChar(128), payload.story_key)
    .input("story_status", sql.VarChar(50), payload.story_status)
    .input("central_theme", sql.NVarChar(255), payload.central_theme)
    .input("central_theme_code", sql.VarChar(80), payload.central_theme_code)
    .input("central_question", sql.NVarChar(500), payload.central_question)
    .input("summary", sql.NVarChar(sql.MAX), payload.summary)
    .input("main_transformation", sql.NVarChar(500), payload.main_transformation)
    .input("confidence_score", sql.Decimal(5, 4), payload.confidence_score)
    .input("source_engine", sql.VarChar(120), payload.source_engine)
    .input("source_version", sql.VarChar(120), payload.source_version)
    .input("source_payload_json", sql.NVarChar(sql.MAX), payload.source_payload_json)
    .execute("dbo.p_NarrativeStory_Upsert");

  const row = result?.recordset?.[0] || null;
  const saved = normalizeStoryRow(row);

  if (!saved?.story_id) {
    return {
      ok: false,
      reason: "Falha ao persistir NarrativeStory.",
    };
  }

  await replaceStoryMemories({
    pool,
    storyId: saved.story_id,
    authorId: payload.author_id,
    relatedMemories: payload.related_memories,
  });

  await replaceStoryEvidence({
    pool,
    storyId: saved.story_id,
    authorId: payload.author_id,
    evidence: payload.evidence,
  });

  return {
    ok: true,
    story: {
      ...saved,
      related_memories: payload.related_memories,
      evidence: payload.evidence,
    },
  };
}

async function replaceStoryMemories({ pool, storyId, authorId, relatedMemories }) {
  await pool.request().input("story_id", sql.BigInt, storyId).query(`
    DELETE FROM dbo.identity_narrative_story_memory
    WHERE story_id = @story_id;
  `);

  for (const item of Array.isArray(relatedMemories) ? relatedMemories : []) {
    await pool
      .request()
      .input("story_id", sql.BigInt, storyId)
      .input("author_id", sql.BigInt, authorId)
      .input("memory_id", sql.BigInt, item.memory_id)
      .input("evidence_weight", sql.Decimal(5, 4), item.evidence_weight)
      .input("evidence_reason", sql.NVarChar(1000), item.evidence_reason)
      .query(`
        INSERT INTO dbo.identity_narrative_story_memory
        (
          story_id,
          author_id,
          memory_id,
          evidence_weight,
          evidence_reason
        )
        VALUES
        (
          @story_id,
          @author_id,
          @memory_id,
          @evidence_weight,
          @evidence_reason
        );
      `);
  }
}

async function replaceStoryEvidence({ pool, storyId, authorId, evidence }) {
  await pool.request().input("story_id", sql.BigInt, storyId).query(`
    DELETE FROM dbo.identity_narrative_story_evidence
    WHERE story_id = @story_id;
  `);

  for (const item of Array.isArray(evidence) ? evidence : []) {
    await pool
      .request()
      .input("story_id", sql.BigInt, storyId)
      .input("author_id", sql.BigInt, authorId)
      .input("evidence_type", sql.VarChar(80), item.evidence_type)
      .input("evidence_label", sql.NVarChar(255), item.evidence_label)
      .input("evidence_reason", sql.NVarChar(1000), item.evidence_reason)
      .input("evidence_weight", sql.Decimal(5, 4), item.evidence_weight)
      .input("source_engine", sql.VarChar(120), item.source_engine)
      .input("payload_json", sql.NVarChar(sql.MAX), safeJson(item.payload))
      .query(`
        INSERT INTO dbo.identity_narrative_story_evidence
        (
          story_id,
          author_id,
          evidence_type,
          evidence_label,
          evidence_reason,
          evidence_weight,
          source_engine,
          payload_json
        )
        VALUES
        (
          @story_id,
          @author_id,
          @evidence_type,
          @evidence_label,
          @evidence_reason,
          @evidence_weight,
          @source_engine,
          @payload_json
        );
      `);
  }
}


export async function clearAuthorNarrativeDiscovery({ authorId } = {}) {
  const safeAuthorId = toPositiveInt(authorId);

  if (!safeAuthorId) {
    return {
      ok: false,
      reason: "authorId inválido para reconstruir Narrative Stories.",
      cleared_story_count: 0,
    };
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

    const request = new sql.Request(transaction);
    request.input("author_id", sql.BigInt, safeAuthorId);

    const result = await request.query(`
      DECLARE @ActiveStories TABLE (story_id BIGINT PRIMARY KEY);

      INSERT INTO @ActiveStories (story_id)
      SELECT story_id
      FROM dbo.identity_narrative_story
      WHERE author_id = @author_id
        AND is_active = 1;

      DELETE e
      FROM dbo.identity_narrative_story_evidence e
      INNER JOIN @ActiveStories a
        ON a.story_id = e.story_id;

      DELETE sm
      FROM dbo.identity_narrative_story_memory sm
      INNER JOIN @ActiveStories a
        ON a.story_id = sm.story_id;

      UPDATE s
      SET
        is_active = 0,
        updated_at = SYSUTCDATETIME()
      FROM dbo.identity_narrative_story s
      INNER JOIN @ActiveStories a
        ON a.story_id = s.story_id;

      SELECT COUNT_BIG(1) AS cleared_story_count
      FROM @ActiveStories;
    `);

    await transaction.commit();

    return {
      ok: true,
      cleared_story_count: Number(result?.recordset?.[0]?.cleared_story_count || 0),
    };
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // Preserva o erro original.
    }
    throw error;
  }
}

export async function saveNarrativeStories(stories = [], options = {}) {
  const out = [];

  for (const story of Array.isArray(stories) ? stories : []) {
    out.push(await upsertNarrativeStory(story, options));
  }

  return {
    ok: out.every((item) => item?.ok !== false),
    saved_count: out.filter((item) => item?.ok).length,
    results: out,
  };
}

export async function listActiveNarrativeStories({
  authorId,
  limit = 20,
  includeSnoozed = false,
} = {}) {
  const safeAuthorId = toPositiveInt(authorId);

  if (!safeAuthorId) {
    return {
      ok: false,
      reason: "authorId inválido.",
      stories: [],
    };
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .input("limit", sql.Int, safeLimit)
    .query(`
      SELECT TOP (@limit)
        story_id,
        story_key,
        author_id,
        story_status,
        central_theme,
        central_theme_code,
        central_question,
        summary,
        main_transformation,
        confidence_score,
        source_engine,
        source_version,
        source_payload_json,
        first_detected_at,
        last_detected_at,
        accepted_at,
        discarded_at,
        snoozed_until,
        converted_to_chapter_at,
        converted_chapter_id,
        created_at,
        updated_at
      FROM dbo.identity_narrative_story
      WHERE author_id = @author_id
        AND is_active = 1
        AND story_status NOT IN ('DISCARDED', 'CONVERTED_TO_CHAPTER')
        AND (
          ${includeSnoozed ? "1" : "0"} = 1
          OR snoozed_until IS NULL
          OR snoozed_until <= SYSUTCDATETIME()
        )
      ORDER BY
        confidence_score DESC,
        last_detected_at DESC,
        story_id DESC;
    `);

  return {
    ok: true,
    stories: (result?.recordset || []).map((row) => normalizeStoryRow(row)),
  };
}

export async function setNarrativeStoryStatus({
  authorId,
  storyId,
  status,
  snoozedUntil = null,
  chapterId = null,
} = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeStoryId = toPositiveInt(storyId);
  const normalizedStatus = normalizeStatus(status, null);

  if (!safeAuthorId || !safeStoryId || !normalizedStatus) {
    return {
      ok: false,
      reason: "Parâmetros inválidos para atualizar NarrativeStory.",
    };
  }

  const pool = await getPool();

  const statusFields = {
    ACCEPTED: "accepted_at = COALESCE(accepted_at, SYSUTCDATETIME())",
    DISCARDED: "discarded_at = COALESCE(discarded_at, SYSUTCDATETIME())",
    SNOOZED: "snoozed_until = @snoozed_until",
    CONVERTED_TO_CHAPTER:
      "converted_to_chapter_at = COALESCE(converted_to_chapter_at, SYSUTCDATETIME()), converted_chapter_id = @chapter_id",
  };

  const extraSql = statusFields[normalizedStatus] || "";
  const request = pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .input("story_id", sql.BigInt, safeStoryId)
    .input("story_status", sql.VarChar(50), normalizedStatus);

  if (normalizedStatus === "SNOOZED") {
    request.input(
      "snoozed_until",
      sql.DateTime2,
      snoozedUntil ? new Date(snoozedUntil) : null
    );
  }

  if (normalizedStatus === "CONVERTED_TO_CHAPTER") {
    request.input("chapter_id", sql.BigInt, toPositiveInt(chapterId));
  }

  const result = await request.query(`
    UPDATE dbo.identity_narrative_story
    SET
      story_status = @story_status,
      ${extraSql ? `${extraSql},` : ""}
      updated_at = SYSUTCDATETIME()
    WHERE story_id = @story_id
      AND author_id = @author_id;

    SELECT TOP 1
      story_id,
      story_key,
      author_id,
      story_status,
      central_theme,
      central_theme_code,
      central_question,
      summary,
      main_transformation,
      confidence_score,
      source_engine,
      source_version,
      source_payload_json,
      first_detected_at,
      last_detected_at,
      accepted_at,
      discarded_at,
      snoozed_until,
      converted_to_chapter_at,
      converted_chapter_id,
      created_at,
      updated_at
    FROM dbo.identity_narrative_story
    WHERE story_id = @story_id
      AND author_id = @author_id;
  `);

  const story = normalizeStoryRow(result?.recordset?.[0] || null);

  return {
    ok: Boolean(story),
    story,
  };
}
