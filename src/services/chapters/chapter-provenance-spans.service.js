// C:\HDUD_DATA\hdud-api-node\src\services\chapters\chapter-provenance-spans.service.js
// GAP #16 — proveniência granular persistida por versão do capítulo.

import { sql } from "../../db.js";

const ORIGIN = Object.freeze({
  AUTHOR_SOURCE: "AUTHOR_SOURCE",
  AI_GENERATED: "AI_GENERATED",
  AUTHOR_EDIT: "AUTHOR_EDIT",
});

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeToken(value) {
  return String(value ?? "").toLocaleLowerCase("pt-BR").normalize("NFC");
}

function tokenize(value) {
  const text = String(value ?? "");
  const regex = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
  const out = [];
  let match;
  while ((match = regex.exec(text))) {
    out.push({
      value: match[0],
      normalized: normalizeToken(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

function mergeSegments(segments) {
  const merged = [];
  for (const raw of segments || []) {
    if (!raw?.content) continue;
    const segment = {
      origin_code: raw.origin_code,
      source_memory_id: toPositiveInt(raw.source_memory_id),
      generation_id: toPositiveInt(raw.generation_id),
      evidence_code: raw.evidence_code || null,
      content: String(raw.content),
    };
    const last = merged[merged.length - 1];
    if (
      last &&
      last.origin_code === segment.origin_code &&
      last.source_memory_id === segment.source_memory_id &&
      last.generation_id === segment.generation_id &&
      last.evidence_code === segment.evidence_code
    ) {
      last.content += segment.content;
    } else {
      merged.push(segment);
    }
  }

  let cursor = 0;
  return merged.map((segment, index) => {
    const start = cursor;
    cursor += segment.content.length;
    return {
      segment_order: index + 1,
      segment_start: start,
      segment_end: cursor,
      ...segment,
    };
  });
}

function buildSegmentsFromTokenOrigins(text, tokens, tokenOrigins, fallbackOrigin) {
  const source = String(text ?? "");
  if (!source) return [];
  if (!tokens.length) {
    return mergeSegments([{ content: source, ...fallbackOrigin }]);
  }

  const pieces = [];
  let cursor = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const origin = tokenOrigins[i] || fallbackOrigin;
    const previousOrigin = i > 0 ? tokenOrigins[i - 1] || fallbackOrigin : origin;

    if (token.start > cursor) {
      pieces.push({ content: source.slice(cursor, token.start), ...previousOrigin });
    }
    pieces.push({ content: source.slice(token.start, token.end), ...origin });
    cursor = token.end;
  }

  if (cursor < source.length) {
    pieces.push({ content: source.slice(cursor), ...(tokenOrigins[tokenOrigins.length - 1] || fallbackOrigin) });
  }

  return mergeSegments(pieces);
}

function markExactWindows(currentTokens, sourceTokens, preferredWindowSize = 4) {
  const matched = new Array(currentTokens.length).fill(false);
  const windowSize = Math.min(preferredWindowSize, sourceTokens.length, currentTokens.length);
  if (windowSize < 2) return matched;

  const windows = new Set();
  for (let i = 0; i <= sourceTokens.length - windowSize; i += 1) {
    windows.add(sourceTokens.slice(i, i + windowSize).map((t) => t.normalized).join("\u001f"));
  }

  for (let i = 0; i <= currentTokens.length - windowSize; i += 1) {
    const key = currentTokens.slice(i, i + windowSize).map((t) => t.normalized).join("\u001f");
    if (!windows.has(key)) continue;
    for (let j = i; j < i + windowSize; j += 1) matched[j] = true;
  }
  return matched;
}

export function buildGeneratedProvenanceSegments({
  currentText,
  aiSourceText,
  authorSources = [],
  generationId = null,
  legacyBackfill = false,
}) {
  const current = String(currentText ?? "");
  if (!current) return [];

  const currentTokens = tokenize(current);
  const aiTokens = tokenize(aiSourceText ?? "");
  const aiMatched = aiTokens.length
    ? markExactWindows(currentTokens, aiTokens, 4)
    : new Array(currentTokens.length).fill(false);

  const authorMatched = new Array(currentTokens.length).fill(false);
  const authorMemoryId = new Array(currentTokens.length).fill(null);

  for (const source of authorSources || []) {
    const sourceText = String(source?.content ?? "").trim();
    if (!sourceText) continue;
    const sourceTokens = tokenize(sourceText);
    if (!sourceTokens.length) continue;
    const matches = markExactWindows(currentTokens, sourceTokens, 4);
    for (let i = 0; i < matches.length; i += 1) {
      if (!matches[i] || authorMatched[i]) continue;
      authorMatched[i] = true;
      authorMemoryId[i] = toPositiveInt(source?.memory_id);
    }
  }

  const tokenOrigins = currentTokens.map((_, index) => {
    if (authorMatched[index]) {
      return {
        origin_code: ORIGIN.AUTHOR_SOURCE,
        source_memory_id: authorMemoryId[index],
        generation_id: toPositiveInt(generationId),
        evidence_code: legacyBackfill ? "LEGACY_MEMORY_EXACT" : "MEMORY_EXACT_TOKEN",
      };
    }
    if (aiMatched[index]) {
      return {
        origin_code: ORIGIN.AI_GENERATED,
        source_memory_id: null,
        generation_id: toPositiveInt(generationId),
        evidence_code: legacyBackfill ? "LEGACY_AI_EXACT" : "GENERATION_EXACT_TOKEN",
      };
    }
    return {
      origin_code: ORIGIN.AUTHOR_EDIT,
      source_memory_id: null,
      generation_id: toPositiveInt(generationId),
      evidence_code: legacyBackfill ? "LEGACY_AUTHOR_AFTER_AI" : "AUTHOR_EDIT_BEFORE_ACCEPT",
    };
  });

  return buildSegmentsFromTokenOrigins(current, currentTokens, tokenOrigins, {
    origin_code: ORIGIN.AUTHOR_EDIT,
    source_memory_id: null,
    generation_id: toPositiveInt(generationId),
    evidence_code: legacyBackfill ? "LEGACY_AUTHOR_AFTER_AI" : "AUTHOR_EDIT_BEFORE_ACCEPT",
  });
}

function segmentForOffset(segments, offset) {
  for (const segment of segments || []) {
    if (offset >= Number(segment.segment_start) && offset < Number(segment.segment_end)) return segment;
  }
  return null;
}

function buildLcsPairs(sourceTokens, targetTokens) {
  const n = sourceTokens.length;
  const m = targetTokens.length;
  if (!n || !m) return [];

  // Cap seguro. Para capítulos usuais cai no LCS exato; para textos excepcionalmente
  // grandes usamos âncoras exatas de 4 tokens, sem atribuir autoria por aproximação.
  if (n * m > 6_000_000) {
    const sourceWindows = new Map();
    const k = Math.min(4, n, m);
    if (k < 2) return [];
    for (let i = 0; i <= n - k; i += 1) {
      const key = sourceTokens.slice(i, i + k).map((t) => t.normalized).join("\u001f");
      if (!sourceWindows.has(key)) sourceWindows.set(key, i);
    }
    const pairs = [];
    let minSource = 0;
    for (let j = 0; j <= m - k; j += 1) {
      const key = targetTokens.slice(j, j + k).map((t) => t.normalized).join("\u001f");
      const i = sourceWindows.get(key);
      if (i == null || i < minSource) continue;
      for (let x = 0; x < k; x += 1) pairs.push([i + x, j + x]);
      minSource = i + k;
      j += k - 1;
    }
    return pairs;
  }

  const rows = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    const row = rows[i];
    const prev = rows[i - 1];
    for (let j = 1; j <= m; j += 1) {
      if (sourceTokens[i - 1].normalized === targetTokens[j - 1].normalized) {
        row[j] = prev[j - 1] + 1;
      } else {
        row[j] = prev[j] >= row[j - 1] ? prev[j] : row[j - 1];
      }
    }
  }

  const reversed = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (sourceTokens[i - 1].normalized === targetTokens[j - 1].normalized) {
      reversed.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (rows[i - 1][j] >= rows[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return reversed.reverse();
}

export function buildEditedProvenanceSegments({ sourceText, targetText, sourceSegments }) {
  const source = String(sourceText ?? "");
  const target = String(targetText ?? "");
  if (!target) return [];

  const sourceTokens = tokenize(source);
  const targetTokens = tokenize(target);
  const tokenOrigins = new Array(targetTokens.length).fill(null);
  const pairs = buildLcsPairs(sourceTokens, targetTokens);

  for (const [sourceIndex, targetIndex] of pairs) {
    const sourceToken = sourceTokens[sourceIndex];
    const persisted = segmentForOffset(sourceSegments, sourceToken.start);
    if (!persisted) continue;
    tokenOrigins[targetIndex] = {
      origin_code: persisted.origin_code,
      source_memory_id: toPositiveInt(persisted.source_memory_id),
      generation_id: toPositiveInt(persisted.generation_id),
      evidence_code: persisted.evidence_code || "INHERITED_FROM_PREVIOUS_VERSION",
    };
  }

  for (let i = 0; i < tokenOrigins.length; i += 1) {
    if (tokenOrigins[i]) continue;
    tokenOrigins[i] = {
      origin_code: ORIGIN.AUTHOR_EDIT,
      source_memory_id: null,
      generation_id: null,
      evidence_code: "AUTHOR_EDIT_DIFF",
    };
  }

  return buildSegmentsFromTokenOrigins(target, targetTokens, tokenOrigins, {
    origin_code: ORIGIN.AUTHOR_EDIT,
    source_memory_id: null,
    generation_id: null,
    evidence_code: "AUTHOR_EDIT_DIFF",
  });
}

export async function loadChapterVersionProvenanceSegments(pool, { authorId, chapterId, chapterVersionId }) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, Number(authorId))
    .input("chapter_id", sql.Int, Number(chapterId))
    .input("chapter_version_id", sql.Int, Number(chapterVersionId))
    .query(`
      SELECT
        segment_id,
        segment_order,
        segment_start,
        segment_end,
        origin_code,
        source_memory_id,
        generation_id,
        evidence_code,
        content,
        created_at
      FROM dbo.identity_chapter_version_provenance_segment
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND chapter_version_id = @chapter_version_id
      ORDER BY segment_order, segment_id;
    `);
  return result?.recordset || [];
}

export async function persistChapterVersionProvenanceSegments(pool, {
  authorId,
  chapterId,
  chapterVersionId,
  text,
  segments,
  provenanceMode = "PERSISTED_V1",
}) {
  const safeAuthorId = toPositiveInt(authorId);
  const safeChapterId = toPositiveInt(chapterId);
  const safeVersionId = toPositiveInt(chapterVersionId);
  if (!safeAuthorId || !safeChapterId || !safeVersionId) return [];

  const normalized = mergeSegments(segments || []);
  const reconstructed = normalized.map((s) => s.content).join("");
  if (reconstructed !== String(text ?? "")) {
    const err = new Error("Falha de integridade ao persistir proveniência granular do capítulo.");
    err.code = "CHAPTER_PROVENANCE_SEGMENT_INTEGRITY";
    throw err;
  }

  const payload = normalized.map((segment) => ({
    segment_order: segment.segment_order,
    segment_start: segment.segment_start,
    segment_end: segment.segment_end,
    origin_code: segment.origin_code,
    source_memory_id: segment.source_memory_id,
    generation_id: segment.generation_id,
    evidence_code: segment.evidence_code,
    content: segment.content,
    provenance_mode: provenanceMode,
  }));

  await pool
    .request()
    .input("author_id", sql.Int, safeAuthorId)
    .input("chapter_id", sql.Int, safeChapterId)
    .input("chapter_version_id", sql.Int, safeVersionId)
    .input("segments_json", sql.NVarChar(sql.MAX), JSON.stringify(payload))
    .query(`
      SET XACT_ABORT ON;
      BEGIN TRAN;

      DELETE FROM dbo.identity_chapter_version_provenance_segment
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND chapter_version_id = @chapter_version_id;

      INSERT INTO dbo.identity_chapter_version_provenance_segment
      (
        author_id,
        chapter_id,
        chapter_version_id,
        segment_order,
        segment_start,
        segment_end,
        origin_code,
        source_memory_id,
        generation_id,
        evidence_code,
        content,
        metadata_json,
        created_at
      )
      SELECT
        @author_id,
        @chapter_id,
        @chapter_version_id,
        j.segment_order,
        j.segment_start,
        j.segment_end,
        j.origin_code,
        j.source_memory_id,
        j.generation_id,
        j.evidence_code,
        j.content,
        JSON_OBJECT('provenance_mode': j.provenance_mode),
        SYSUTCDATETIME()
      FROM OPENJSON(@segments_json)
      WITH
      (
        segment_order int '$.segment_order',
        segment_start int '$.segment_start',
        segment_end int '$.segment_end',
        origin_code varchar(32) '$.origin_code',
        source_memory_id int '$.source_memory_id',
        generation_id bigint '$.generation_id',
        evidence_code varchar(64) '$.evidence_code',
        content nvarchar(max) '$.content',
        provenance_mode varchar(32) '$.provenance_mode'
      ) j;

      COMMIT;
    `);

  return loadChapterVersionProvenanceSegments(pool, {
    authorId: safeAuthorId,
    chapterId: safeChapterId,
    chapterVersionId: safeVersionId,
  });
}

export async function ensureVersionProvenanceFromContext(pool, {
  authorId,
  chapterId,
  chapterVersionId,
  currentText,
  aiSourceText,
  authorSources,
  generationId,
  legacyBackfill = false,
}) {
  const existing = await loadChapterVersionProvenanceSegments(pool, { authorId, chapterId, chapterVersionId });
  if (existing.length) return existing;

  const segments = buildGeneratedProvenanceSegments({
    currentText,
    aiSourceText,
    authorSources,
    generationId,
    legacyBackfill,
  });
  return persistChapterVersionProvenanceSegments(pool, {
    authorId,
    chapterId,
    chapterVersionId,
    text: currentText,
    segments,
    provenanceMode: legacyBackfill ? "LEGACY_BACKFILL_V1" : "PERSISTED_V1",
  });
}

export async function persistEditedVersionProvenance(pool, {
  authorId,
  chapterId,
  sourceVersionId,
  targetVersionId,
  sourceText,
  targetText,
}) {
  const sourceSegments = await loadChapterVersionProvenanceSegments(pool, {
    authorId,
    chapterId,
    chapterVersionId: sourceVersionId,
  });
  if (!sourceSegments.length) {
    const err = new Error("A versão de origem não possui proveniência granular persistida.");
    err.code = "CHAPTER_PROVENANCE_SOURCE_MISSING";
    throw err;
  }

  const segments = buildEditedProvenanceSegments({ sourceText, targetText, sourceSegments });
  return persistChapterVersionProvenanceSegments(pool, {
    authorId,
    chapterId,
    chapterVersionId: targetVersionId,
    text: targetText,
    segments,
    provenanceMode: "PERSISTED_V1",
  });
}

async function generationAuthorSources(pool, authorId, generationId) {
  const generationResult = await pool
    .request()
    .input("author_id", sql.Int, Number(authorId))
    .input("generation_id", sql.BigInt, Number(generationId))
    .query(`
      SELECT TOP (1)
        generation_id,
        generated_content,
        source_memory_ids_json,
        source_snapshot_json,
        created_at
      FROM dbo.identity_chapter_generation
      WHERE generation_id = @generation_id
        AND author_id = @author_id;
    `);
  const row = generationResult?.recordset?.[0];
  if (!row) return null;

  let memoryIds = [];
  let snapshots = [];
  try { memoryIds = JSON.parse(row.source_memory_ids_json || "[]"); } catch { memoryIds = []; }
  try { snapshots = JSON.parse(row.source_snapshot_json || "[]"); } catch { snapshots = []; }
  memoryIds = Array.isArray(memoryIds) ? memoryIds.map(toPositiveInt).filter(Boolean) : [];
  snapshots = Array.isArray(snapshots) ? snapshots : [];

  if (!memoryIds.length) {
    return { generated_content: String(row.generated_content ?? ""), author_sources: [] };
  }

  const sourceResult = await pool
    .request()
    .input("author_id", sql.Int, Number(authorId))
    .input("source_ids_json", sql.NVarChar(sql.MAX), JSON.stringify(memoryIds))
    .input("source_snapshot_json", sql.NVarChar(sql.MAX), JSON.stringify(snapshots))
    .input("generated_at", sql.DateTime2, row.created_at ?? new Date())
    .query(`
      ;WITH source_ids AS
      (
        SELECT TRY_CONVERT(int,[value]) AS memory_id, TRY_CONVERT(int,[key]) + 1 AS source_order
        FROM OPENJSON(@source_ids_json)
        WHERE TRY_CONVERT(int,[value]) IS NOT NULL
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
        COALESCE(v.content, m.content) AS content
      FROM source_ids s
      INNER JOIN dbo.identity_memory m
        ON m.memory_id = s.memory_id
       AND m.author_id = @author_id
       AND ISNULL(m.is_deleted,0)=0
      LEFT JOIN snapshots snap ON snap.memory_id = s.memory_id
      OUTER APPLY
      (
        SELECT TOP (1) mv.title, mv.content
        FROM dbo.identity_memory_versions mv
        WHERE mv.memory_id = s.memory_id
        ORDER BY
          CASE
            WHEN mv.created_at <= @generated_at
             AND NULLIF(snap.content_prefix,'') IS NOT NULL
             AND LEFT(mv.content,LEN(snap.content_prefix)) = snap.content_prefix THEN 0
            WHEN NULLIF(snap.content_prefix,'') IS NOT NULL
             AND LEFT(mv.content,LEN(snap.content_prefix)) = snap.content_prefix THEN 1
            WHEN mv.created_at <= @generated_at THEN 2
            ELSE 3
          END,
          mv.version_number DESC,
          mv.version_id DESC
      ) v
      ORDER BY s.source_order;
    `);

  return {
    generated_content: String(row.generated_content ?? ""),
    author_sources: (sourceResult?.recordset || []).map((item) => ({
      memory_id: toPositiveInt(item.memory_id),
      title: item.title ?? null,
      content: String(item.content ?? ""),
    })),
  };
}

export async function persistAcceptedGenerationProvenance(pool, {
  authorId,
  chapterId,
  chapterVersionId,
  generationId,
  acceptedText,
}) {
  const context = await generationAuthorSources(pool, authorId, generationId);
  if (!context) {
    const err = new Error("Geração não encontrada para proveniência granular.");
    err.code = "CHAPTER_PROVENANCE_GENERATION_MISSING";
    throw err;
  }
  const segments = buildGeneratedProvenanceSegments({
    currentText: acceptedText,
    aiSourceText: context.generated_content,
    authorSources: context.author_sources,
    generationId,
    legacyBackfill: false,
  });
  return persistChapterVersionProvenanceSegments(pool, {
    authorId,
    chapterId,
    chapterVersionId,
    text: acceptedText,
    segments,
    provenanceMode: "PERSISTED_V1",
  });
}

export { ORIGIN as CHAPTER_PROVENANCE_ORIGIN };
