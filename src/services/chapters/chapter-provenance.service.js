// C:\HDUD_DATA\hdud-api-node\src\services\chapters\chapter-provenance.service.js

import { getPool, sql } from "../../db.js";
import { ensureVersionProvenanceFromContext } from "./chapter-provenance-spans.service.js";

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
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

function normalizeProvider(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isVerifiedExternalGeneration(provenance) {
  if (!provenance || typeof provenance !== "object") return false;

  const evidenceStatus = String(provenance.evidence_status ?? "").trim().toUpperCase();
  const provider = normalizeProvider(provenance.provider);
  const operationCode = String(provenance.operation_code ?? "").trim().toUpperCase();
  const aiUsageId = toPositiveInt(provenance.ai_usage_id);

  if (evidenceStatus !== "VERIFIED" || !aiUsageId || !provider || !operationCode) return false;

  // Processamentos locais/determinísticos jamais devem virar autoria IA visual.
  if (["DETERMINISTIC", "LOCAL", "HDUD", "HDUD_LOCAL"].includes(provider)) return false;

  return true;
}

export async function getChapterProvenance({ authorId, chapterId }) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeChapterId = toPositiveInt(chapterId);

  if (!safeAuthorId) {
    const err = new Error("author_id inválido.");
    err.statusCode = 401;
    throw err;
  }

  if (!safeChapterId) {
    const err = new Error("chapter_id inválido.");
    err.statusCode = 400;
    throw err;
  }

  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.Int, safeAuthorId)
    .input("chapter_id", sql.Int, safeChapterId)
    .query(`
      ;WITH current_version AS
      (
        SELECT TOP (1)
          v.chapter_version_id,
          v.body,
          v.created_at,
          c.chapter_lineage
        FROM dbo.identity_chapter_versions v
        INNER JOIN dbo.identity_chapter c
          ON c.chapter_id = v.chapter_id
         AND c.author_id = v.author_id
        WHERE v.chapter_id = @chapter_id
          AND v.author_id = @author_id
          AND ISNULL(c.is_deleted, 0) = 0
        ORDER BY v.created_at DESC, v.chapter_version_id DESC
      ),
      ai_lineage AS
      (
        SELECT TOP (1)
          e.chapter_evolution_id,
          e.source_version_id,
          COALESCE(g.chapter_version_id, e.target_version_id) AS target_version_id,
          e.metadata_json,
          e.created_at AS evolution_created_at,
          TRY_CONVERT(bigint, JSON_VALUE(e.metadata_json, '$.generation_id')) AS generation_id
        FROM dbo.identity_chapter_evolution e
        CROSS JOIN current_version cv
        INNER JOIN dbo.identity_chapter_generation g
          ON g.generation_id = TRY_CONVERT(bigint, JSON_VALUE(e.metadata_json, '$.generation_id'))
         AND g.author_id = @author_id
        WHERE e.author_id = @author_id
          AND e.chapter_id = @chapter_id
          AND e.event_type IN ('CHAPTER_REGENERATION_ACCEPTED', 'CHAPTER_REGENERATED')
          AND ISJSON(e.metadata_json) = 1
          AND TRY_CONVERT(bigint, JSON_VALUE(e.metadata_json, '$.generation_id')) IS NOT NULL
          AND g.chapter_version_id IS NOT NULL
          AND g.chapter_version_id <= cv.chapter_version_id
        ORDER BY
          CASE WHEN g.chapter_version_id = cv.chapter_version_id THEN 0 ELSE 1 END,
          g.chapter_version_id DESC,
          e.created_at DESC,
          e.chapter_evolution_id DESC
      )
      SELECT
        cv.chapter_version_id AS current_version_id,
        cv.body AS current_content,
        cv.created_at AS current_version_created_at,
        cv.chapter_lineage,
        al.chapter_evolution_id,
        al.source_version_id,
        al.target_version_id AS ai_target_version_id,
        al.metadata_json,
        al.evolution_created_at,
        al.generation_id,
        g.generated_content AS ai_source_content,
        g.generated_title AS ai_generated_title,
        g.source_memory_ids_json,
        g.source_snapshot_json,
        g.llm_provider,
        g.llm_model,
        g.prompt_version,
        g.ai_usage_id AS direct_ai_usage_id,
        g.created_at AS generation_created_at
      FROM current_version cv
      LEFT JOIN ai_lineage al ON 1 = 1
      LEFT JOIN dbo.identity_chapter_generation g
        ON g.generation_id = al.generation_id
       AND g.author_id = @author_id;
    `);

  const row = result?.recordset?.[0] || null;
  if (!row) {
    const err = new Error("Capítulo não encontrado.");
    err.statusCode = 404;
    throw err;
  }

  const chapterLineage = safeJsonParse(row.chapter_lineage, {}) || {};
  const inheritedGenerationProvenance = safeJsonParse(
    chapterLineage?.generation_provenance,
    chapterLineage?.generation_provenance || null
  );
  const hasVerifiedInheritedAi = isVerifiedExternalGeneration(inheritedGenerationProvenance);

  const generationId = toPositiveInt(row.generation_id);
  const directProvider = normalizeProvider(row.llm_provider ?? safeJsonParse(row.metadata_json, {})?.provider);
  const hasVerifiedDirectAi = Boolean(
    generationId &&
    row.ai_source_content != null &&
    String(row.ai_source_content).trim() &&
    directProvider &&
    !["DETERMINISTIC", "LOCAL", "HDUD", "HDUD_LOCAL"].includes(directProvider)
  );

  let sourceContent = row.ai_source_content != null ? String(row.ai_source_content) : "";
  const currentVersionId = toPositiveInt(row.current_version_id);
  const aiTargetVersionId = toPositiveInt(row.ai_target_version_id);
  const metadata = safeJsonParse(row.metadata_json, {});
  const sourceMemoryIds = Array.isArray(safeJsonParse(row.source_memory_ids_json, []))
    ? safeJsonParse(row.source_memory_ids_json, [])
        .map((value) => toPositiveInt(value))
        .filter(Boolean)
    : [];
  const sourceSnapshot = Array.isArray(safeJsonParse(row.source_snapshot_json, []))
    ? safeJsonParse(row.source_snapshot_json, [])
    : [];

  let inheritedStory = null;
  let inheritedSourceMemoryIds = [];
  let inheritedGeneratedAt = null;
  const sourceStoryId = toPositiveInt(chapterLineage?.source_story_id ?? chapterLineage?.story_id);
  const sourceStoryVersionId = toPositiveInt(
    chapterLineage?.source_story_version_id ?? chapterLineage?.story_version_id
  );
  const inheritedChapterVersionId = toPositiveInt(chapterLineage?.chapter?.chapter_version_id) || 1;

  // Se existe uma geração direta do capítulo, ela governa a proveniência da versão atual.
  // A linhagem herdada da Story continua preservada no chapter_lineage, mas não pode
  // sobrescrever generated_content da geração direta.
  if (!hasVerifiedDirectAi && hasVerifiedInheritedAi && sourceStoryId && sourceStoryVersionId) {
    const storyResult = await pool
      .request()
      .input("author_id", sql.Int, safeAuthorId)
      .input("story_id", sql.Int, sourceStoryId)
      .input("story_version_id", sql.Int, sourceStoryVersionId)
      .query(`
        SELECT TOP (1)
          sv.story_version_id,
          sv.story_id,
          sv.content,
          sv.payload_json,
          sv.created_at
        FROM dbo.identity_story_version sv
        INNER JOIN dbo.identity_story s
          ON s.story_id = sv.story_id
         AND s.author_id = sv.author_id
        WHERE sv.author_id = @author_id
          AND sv.story_id = @story_id
          AND sv.story_version_id = @story_version_id;
      `);

    inheritedStory = storyResult?.recordset?.[0] || null;
    const storyPayload = safeJsonParse(inheritedStory?.payload_json, {}) || {};
    const rawIds = safeJsonParse(storyPayload?.selected_memory_ids, storyPayload?.selected_memory_ids || []);
    inheritedSourceMemoryIds = Array.isArray(rawIds)
      ? rawIds.map((value) => toPositiveInt(value)).filter(Boolean)
      : [];
    inheritedGeneratedAt = storyPayload?.generated_at || inheritedStory?.created_at || null;

    if (inheritedStory?.content != null && String(inheritedStory.content).trim()) {
      sourceContent = String(inheritedStory.content);
    }

    if (!inheritedSourceMemoryIds.length) {
      const storyMemoryResult = await pool
        .request()
        .input("author_id", sql.Int, safeAuthorId)
        .input("story_id", sql.Int, sourceStoryId)
        .query(`
          SELECT sm.memory_id
          FROM dbo.identity_story_memory sm
          WHERE sm.author_id = @author_id
            AND sm.story_id = @story_id
          ORDER BY sm.sort_order, sm.story_memory_id;
        `);
      inheritedSourceMemoryIds = (storyMemoryResult?.recordset || [])
        .map((item) => toPositiveInt(item.memory_id))
        .filter(Boolean);
    }
  }

  let authorSources = [];
  if (generationId && sourceMemoryIds.length) {
    const sourceIdsJson = JSON.stringify(sourceMemoryIds);
    const sourceResult = await pool
      .request()
      .input("author_id", sql.Int, safeAuthorId)
      .input("source_ids_json", sql.NVarChar(sql.MAX), sourceIdsJson)
      .input("source_snapshot_json", sql.NVarChar(sql.MAX), JSON.stringify(sourceSnapshot))
      .input("generated_at", sql.DateTime2, row.generation_created_at ?? row.evolution_created_at ?? new Date())
      .query(`
        ;WITH source_ids AS
        (
          SELECT
            TRY_CONVERT(int, [value]) AS memory_id,
            TRY_CONVERT(int, [key]) + 1 AS source_order
          FROM OPENJSON(@source_ids_json)
          WHERE TRY_CONVERT(int, [value]) IS NOT NULL
        ),
        snapshots AS
        (
          SELECT
            TRY_CONVERT(int, JSON_VALUE([value], '$.memory_id')) AS memory_id,
            CASE
              WHEN RIGHT(COALESCE(JSON_VALUE([value], '$.content_preview'), ''), 1) = N'…'
                THEN LEFT(JSON_VALUE([value], '$.content_preview'), LEN(JSON_VALUE([value], '$.content_preview')) - 1)
              ELSE COALESCE(JSON_VALUE([value], '$.content_preview'), '')
            END AS content_prefix
          FROM OPENJSON(@source_snapshot_json)
        )
        SELECT
          s.source_order,
          s.memory_id,
          COALESCE(v.title, m.title) AS title,
          v.content AS version_content,
          v.version_number,
          v.created_at AS version_created_at
        FROM source_ids s
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = s.memory_id
         AND m.author_id = @author_id
         AND ISNULL(m.is_deleted, 0) = 0
        LEFT JOIN snapshots snap
          ON snap.memory_id = s.memory_id
        OUTER APPLY
        (
          SELECT TOP (1)
            mv.title,
            mv.content,
            mv.version_number,
            mv.created_at
          FROM dbo.identity_memory_versions mv
          WHERE mv.memory_id = s.memory_id
          ORDER BY
            CASE
              WHEN mv.created_at <= @generated_at
               AND NULLIF(snap.content_prefix, '') IS NOT NULL
               AND LEFT(mv.content, LEN(snap.content_prefix)) = snap.content_prefix THEN 0
              WHEN NULLIF(snap.content_prefix, '') IS NOT NULL
               AND LEFT(mv.content, LEN(snap.content_prefix)) = snap.content_prefix THEN 1
              WHEN mv.created_at <= @generated_at THEN 2
              ELSE 3
            END,
            mv.version_number DESC,
            mv.version_id DESC
        ) v
        ORDER BY s.source_order;
      `);

    const snapshotByMemoryId = new Map(
      sourceSnapshot
        .map((item) => [toPositiveInt(item?.memory_id), item])
        .filter(([memoryId]) => Boolean(memoryId))
    );

    authorSources = (sourceResult?.recordset || []).map((item) => {
      const snapshot = snapshotByMemoryId.get(toPositiveInt(item.memory_id));
      const content = item.version_content != null
        ? String(item.version_content)
        : String(snapshot?.content ?? snapshot?.content_preview ?? "");

      return {
        order: Number(item.source_order || 0),
        memory_id: toPositiveInt(item.memory_id),
        title: item.title ?? snapshot?.title ?? null,
        content,
        memory_version_number: item.version_number != null ? Number(item.version_number) : null,
        memory_version_created_at: item.version_created_at ?? null,
      };
    });
  }

  // Story -> Chapter: quando o capítulo herdou um manuscrito de uma Story
  // cuja geração externa já está VERIFIED, reconstruímos as memórias-fonte
  // no instante daquela geração. Nenhuma nova IA é executada aqui.
  if (!authorSources.length && hasVerifiedInheritedAi && inheritedSourceMemoryIds.length) {
    const inheritedIdsJson = JSON.stringify(inheritedSourceMemoryIds);
    const inheritedSourcesResult = await pool
      .request()
      .input("author_id", sql.Int, safeAuthorId)
      .input("source_ids_json", sql.NVarChar(sql.MAX), inheritedIdsJson)
      .input("generated_at", sql.DateTime2, inheritedGeneratedAt ? new Date(inheritedGeneratedAt) : new Date())
      .query(`
        ;WITH source_ids AS
        (
          SELECT
            TRY_CONVERT(int, [value]) AS memory_id,
            TRY_CONVERT(int, [key]) + 1 AS source_order
          FROM OPENJSON(@source_ids_json)
          WHERE TRY_CONVERT(int, [value]) IS NOT NULL
        )
        SELECT
          s.source_order,
          s.memory_id,
          COALESCE(v.title, m.title) AS title,
          COALESCE(v.content, m.content) AS version_content,
          v.version_number,
          v.created_at AS version_created_at
        FROM source_ids s
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = s.memory_id
         AND m.author_id = @author_id
         AND ISNULL(m.is_deleted, 0) = 0
        OUTER APPLY
        (
          SELECT TOP (1)
            mv.title,
            mv.content,
            mv.version_number,
            mv.created_at
          FROM dbo.identity_memory_versions mv
          WHERE mv.memory_id = s.memory_id
          ORDER BY
            CASE WHEN mv.created_at <= @generated_at THEN 0 ELSE 1 END,
            mv.version_number DESC,
            mv.version_id DESC
        ) v
        ORDER BY s.source_order;
      `);

    authorSources = (inheritedSourcesResult?.recordset || []).map((item) => ({
      order: Number(item.source_order || 0),
      memory_id: toPositiveInt(item.memory_id),
      title: item.title ?? null,
      content: item.version_content != null ? String(item.version_content) : "",
      memory_version_number: item.version_number != null ? Number(item.version_number) : null,
      memory_version_created_at: item.version_created_at ?? null,
    }));
  }

  // Fallback para gerações históricas em que a versão integral da memória não
  // pôde ser reconstruída. O snapshot persistido continua sendo preferível a
  // usar o estado atual da memória, pois preserva o contexto da geração.
  if (!authorSources.length && sourceSnapshot.length) {
    authorSources = sourceSnapshot.map((item, index) => ({
      order: Number(item?.order || index + 1),
      memory_id: toPositiveInt(item?.memory_id),
      title: item?.title ?? null,
      content: String(item?.content ?? item?.content_preview ?? ""),
      memory_version_number: null,
      memory_version_created_at: null,
    }));
  }

  const provenanceMode = hasVerifiedDirectAi
    ? "CHAPTER_GENERATION"
    : hasVerifiedInheritedAi && sourceContent.trim()
      ? "STORY_INHERITED"
      : null;
  const hasAiProvenance = Boolean(provenanceMode);
  const effectiveAiTargetVersionId = provenanceMode === "CHAPTER_GENERATION"
    ? aiTargetVersionId
    : inheritedChapterVersionId;

  // GAP #16 — a tela editorial não infere mais autoria por aparência lexical.
  // Para versões históricas, a primeira leitura congela um backfill determinístico.
  // A partir desta entrega, novas gerações/edições persistem a proveniência no nascimento
  // de cada identity_chapter_version.
  let granularSegments = [];
  if (hasAiProvenance && currentVersionId && row.current_content != null) {
    try {
      granularSegments = await ensureVersionProvenanceFromContext(pool, {
        authorId: safeAuthorId,
        chapterId: safeChapterId,
        chapterVersionId: currentVersionId,
        currentText: String(row.current_content),
        aiSourceText: sourceContent,
        authorSources,
        generationId: provenanceMode === "CHAPTER_GENERATION" ? generationId : null,
        legacyBackfill: currentVersionId !== effectiveAiTargetVersionId,
      });
    } catch (error) {
      console.warn("Chapter provenance granular backfill failed:", error?.message);
    }
  }

  return {
    ok: true,
    chapter_id: safeChapterId,
    current_version_id: currentVersionId,
    provenance: hasAiProvenance ? "AI_LINEAGE" : "AUTHOR_ONLY",
    provenance_mode: provenanceMode,
    has_ai_provenance: hasAiProvenance,
    provenance_granularity: granularSegments.length ? "PERSISTED_SEGMENTS_V1" : null,
    segments: granularSegments.map((segment) => ({
      segment_id: Number(segment.segment_id),
      order: Number(segment.segment_order),
      start: Number(segment.segment_start),
      end: Number(segment.segment_end),
      origin: segment.origin_code,
      source_memory_id: toPositiveInt(segment.source_memory_id),
      generation_id: toPositiveInt(segment.generation_id),
      evidence_code: segment.evidence_code ?? null,
      text: String(segment.content ?? ""),
    })),
    author_edited_after_ai:
      Boolean(
        hasAiProvenance &&
        currentVersionId &&
        effectiveAiTargetVersionId &&
        currentVersionId > effectiveAiTargetVersionId
      ),
    ai: hasAiProvenance
      ? {
          provenance_mode: provenanceMode,
          generation_id: provenanceMode === "CHAPTER_GENERATION" ? generationId : null,
          ai_usage_id: provenanceMode === "STORY_INHERITED"
            ? toPositiveInt(inheritedGenerationProvenance?.ai_usage_id)
            : toPositiveInt(row.direct_ai_usage_id),
          source_story_id: provenanceMode === "STORY_INHERITED" ? sourceStoryId : null,
          source_story_version_id: provenanceMode === "STORY_INHERITED" ? sourceStoryVersionId : null,
          source_version_id: provenanceMode === "CHAPTER_GENERATION"
            ? toPositiveInt(row.source_version_id)
            : null,
          target_version_id: effectiveAiTargetVersionId,
          source_content: sourceContent,
          author_sources: authorSources,
          generated_title: provenanceMode === "CHAPTER_GENERATION"
            ? row.ai_generated_title ?? null
            : null,
          provider: provenanceMode === "STORY_INHERITED"
            ? inheritedGenerationProvenance?.provider ?? chapterLineage?.provider ?? null
            : row.llm_provider ?? metadata?.provider ?? null,
          model: provenanceMode === "STORY_INHERITED"
            ? inheritedGenerationProvenance?.model ?? chapterLineage?.model ?? null
            : row.llm_model ?? metadata?.model ?? null,
          operation_code: provenanceMode === "STORY_INHERITED"
            ? inheritedGenerationProvenance?.operation_code ?? chapterLineage?.operation_code ?? null
            : "CHAPTER_EDITORIAL_GENERATION",
          evidence_status: provenanceMode === "STORY_INHERITED"
            ? inheritedGenerationProvenance?.evidence_status ?? null
            : (toPositiveInt(row.direct_ai_usage_id) ? "VERIFIED" : null),
          evidence_source: provenanceMode === "STORY_INHERITED"
            ? inheritedGenerationProvenance?.evidence_source ?? null
            : (toPositiveInt(row.direct_ai_usage_id) ? "AI_USAGE_LEDGER" : null),
          prompt_version: provenanceMode === "CHAPTER_GENERATION"
            ? row.prompt_version ?? metadata?.prompt_version ?? null
            : null,
          generated_at: provenanceMode === "STORY_INHERITED"
            ? inheritedGeneratedAt
            : row.generation_created_at ?? null,
          evolution_created_at: provenanceMode === "CHAPTER_GENERATION"
            ? row.evolution_created_at ?? null
            : null,
        }
      : null,
  };
}
