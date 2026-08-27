// C:\HDUD_DATA\hdud-api-node\src\services\chapters\story-chapter-lineage.service.js
//
// GO LIVE 005.0 — LOTE 3 — Story → Chapter Lineage
// Camada aditiva e defensiva para ligar Stories aprovadas a Capítulos Vivos.
// Não duplica texto. Não cria narrativa nova. Apenas registra origem, confiança e motivo.

import { getPool, sql } from '../../db.js';
import {
  buildChapterCandidatesForAuthor,
  listPersistedChapterCandidates,
} from '../stories/chapter-candidate-engine.service.js';

const ENGINE_VERSION = 'GO_LIVE_005_0_LOTE_3';
const DEFAULT_CONFIDENCE = 72;
const MAX_REASON_LEN = 1000;

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clampScore(value, fallback = DEFAULT_CONFIDENCE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 1) return Math.max(0, Math.min(100, Math.round(n * 100)));
  return Math.max(0, Math.min(100, Math.round(n)));
}

function safeText(value, fallback = '') {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length ? s : fallback;
}

function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function stringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value) {
  const stop = new Set([
    'a', 'o', 'e', 'de', 'do', 'da', 'dos', 'das', 'um', 'uma', 'os', 'as',
    'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'sem', 'sobre',
    'capitulo', 'capítulo', 'historia', 'história', 'vida', 'minha', 'meu',
  ]);

  return new Set(
    normalizeForMatch(value)
      .split(' ')
      .map((x) => x.trim())
      .filter((x) => x.length >= 3 && !stop.has(x))
  );
}

function lexicalSimilarity(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;

  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection += 1;
  }

  const union = new Set([...ta, ...tb]).size || 1;
  return intersection / union;
}

function pickBestCandidate(chapter, candidates) {
  const normalized = Array.isArray(candidates) ? candidates : [];
  if (!normalized.length) return null;

  const chapterText = `${chapter?.title || ''} ${chapter?.description || ''}`;

  return normalized
    .map((candidate) => {
      const candidateText = `${candidate?.suggested_title || ''} ${candidate?.central_theme || ''} ${candidate?.summary || ''}`;
      const lexical = lexicalSimilarity(chapterText, candidateText);
      const score = Number(candidate?.chapter_candidate_score || candidate?.confidence || 0);
      const storyCount = Number(candidate?.story_count || (Array.isArray(candidate?.story_ids) ? candidate.story_ids.length : 0));

      return {
        candidate,
        rank: lexical * 100 + Math.min(score, 100) * 0.35 + Math.min(storyCount, 10) * 2,
      };
    })
    .sort((a, b) => b.rank - a.rank)[0]?.candidate || null;
}

async function tableExists(pool, tableName) {
  const result = await pool.request()
    .input('table_name', sql.VarChar(128), tableName)
    .query(`
      SELECT 1 AS ok
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'dbo'
        AND t.name = @table_name;
    `);

  return Boolean(result.recordset?.[0]);
}

async function getTableColumns(pool, tableName) {
  const result = await pool.request()
    .input('table_name', sql.VarChar(128), tableName)
    .query(`
      SELECT c.name
      FROM sys.columns c
      INNER JOIN sys.tables t ON t.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'dbo'
        AND t.name = @table_name;
    `);

  return new Set((result.recordset || []).map((row) => String(row.name || '').toLowerCase()));
}

function hasColumn(columns, name) {
  return columns.has(String(name || '').toLowerCase());
}

function selectColumn(alias, columns, columnName, outputName = columnName) {
  return hasColumn(columns, columnName)
    ? `${alias}.${columnName} AS ${outputName}`
    : `NULL AS ${outputName}`;
}

async function columnExists(pool, tableName, columnName) {
  const result = await pool.request()
    .input('table_name', sql.VarChar(128), tableName)
    .input('column_name', sql.VarChar(128), columnName)
    .query(`
      SELECT 1 AS ok
      FROM sys.columns c
      INNER JOIN sys.tables t ON t.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'dbo'
        AND t.name = @table_name
        AND c.name = @column_name;
    `);

  return Boolean(result.recordset?.[0]);
}

async function fetchChapter(pool, authorId, chapterId) {
  const result = await pool.request()
    .input('author_id', sql.Int, authorId)
    .input('chapter_id', sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        chapter_id,
        author_id,
        title,
        description,
        current_version_id,
        created_at,
        updated_at
      FROM dbo.identity_chapter
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND ISNULL(is_deleted, 0) = 0;
    `);

  return result.recordset?.[0] || null;
}

async function fetchStorySnapshots(pool, authorId, storyIds) {
  const ids = [...new Set((Array.isArray(storyIds) ? storyIds : []).map(toPositiveInt).filter(Boolean))];
  if (!ids.length) return new Map();

  const hasStory = await tableExists(pool, 'identity_story');
  if (!hasStory) return new Map();

  const storyColumns = await getTableColumns(pool, 'identity_story');
  const versionColumns = await getTableColumns(pool, 'identity_story_version');

  const request = pool.request().input('author_id', sql.Int, authorId);
  const inList = ids.map((id, index) => {
    const key = `story_id_${index}`;
    request.input(key, sql.Int, id);
    return `@${key}`;
  }).join(', ');

  const titleExpr = hasColumn(storyColumns, 'title')
    ? 's.title AS story_title'
    : hasColumn(storyColumns, 'suggested_title')
      ? 's.suggested_title AS story_title'
      : 'NULL AS story_title';

  const versionNumberOrder = hasColumn(versionColumns, 'version_number')
    ? 'TRY_CONVERT(int, sv2.version_number) DESC,'
    : '';

  const versionAuthorPredicate = hasColumn(versionColumns, 'author_id')
    ? 'AND sv2.author_id = s.author_id'
    : '';

  const result = await request.query(`
    SELECT
      s.story_id,
      s.author_id,
      ${titleExpr},
      ${selectColumn('s', storyColumns, 'central_theme')},
      ${selectColumn('s', storyColumns, 'story_publication_status')},
      ${selectColumn('s', storyColumns, 'chapter_candidate_score')},
      sv.story_version_id,
      ${selectColumn('sv', versionColumns, 'version_number')},
      ${selectColumn('sv', versionColumns, 'truth_health_score')},
      ${selectColumn('sv', versionColumns, 'auditability_score')},
      ${selectColumn('sv', versionColumns, 'chronology_score')},
      ${selectColumn('sv', versionColumns, 'readiness_status')},
      ${selectColumn('sv', versionColumns, 'story_timeline')},
      ${selectColumn('sv', versionColumns, 'evidence_map')},
      ${selectColumn('sv', versionColumns, 'payload_json')}
    FROM dbo.identity_story s
    OUTER APPLY (
      SELECT TOP 1 sv2.*
      FROM dbo.identity_story_version sv2
      WHERE sv2.story_id = s.story_id
        ${versionAuthorPredicate}
      ORDER BY
        ${versionNumberOrder}
        sv2.story_version_id DESC
    ) sv
    WHERE s.author_id = @author_id
      AND s.story_id IN (${inList});
  `);

  return new Map((result.recordset || []).map((row) => [Number(row.story_id), normalizeStorySnapshot(row)]));
}

function normalizeStorySnapshot(row) {
  const evidenceMap = safeJsonParse(row?.evidence_map, null);
  const storyTimeline = safeJsonParse(row?.story_timeline, null);
  const payload = safeJsonParse(row?.payload_json, null);
  const payloadProvenance = payload && typeof payload === 'object'
    ? safeJsonParse(payload.generation_provenance, payload.generation_provenance || null)
    : null;

  const aiUsageId = toPositiveInt(
    payloadProvenance?.ai_usage_id ?? payload?.ai_usage_id
  );
  const provider = safeText(
    payloadProvenance?.provider ?? payload?.provider ?? payload?.llm_provider,
    ''
  ) || null;
  const model = safeText(
    payloadProvenance?.model ?? payload?.llm_model ?? payload?.model,
    ''
  ) || null;
  const operationCode = safeText(
    payloadProvenance?.operation_code ?? payload?.operation_code,
    ''
  ) || null;
  const evidenceStatus = safeText(payloadProvenance?.evidence_status, '') || null;

  // Só transportamos como proveniência IA comprovada quando a Story Version
  // já possui evidência VERIFIED e identidade concreta da execução externa.
  // Isso evita transformar "DISCOVERED_BY_AI" ou qualquer generation genérica
  // em autoria textual por IA.
  const verifiedGenerationProvenance =
    evidenceStatus === 'VERIFIED' && aiUsageId && provider && model && operationCode
      ? {
          ...payloadProvenance,
          evidence_status: 'VERIFIED',
          ai_usage_id: aiUsageId,
          provider,
          model,
          operation_code: operationCode,
        }
      : null;

  return {
    story_id: Number(row.story_id),
    story_version_id: row.story_version_id == null ? null : Number(row.story_version_id),
    version_number: row.version_number == null ? null : Number(row.version_number),
    title: safeText(row.story_title, `Story ${row.story_id}`),
    central_theme: row.central_theme == null ? null : safeText(row.central_theme, null),
    story_publication_status: row.story_publication_status == null ? null : safeText(row.story_publication_status, null),
    chapter_candidate_score: row.chapter_candidate_score == null ? null : Number(row.chapter_candidate_score),
    truth_health_score: row.truth_health_score == null ? null : Number(row.truth_health_score),
    auditability_score: row.auditability_score == null ? null : Number(row.auditability_score),
    chronology_score: row.chronology_score == null ? null : Number(row.chronology_score),
    readiness_status: row.readiness_status == null ? null : safeText(row.readiness_status, null),
    evidence_summary: evidenceMap ? summarizeEvidenceMap(evidenceMap) : null,
    timeline_summary: storyTimeline ? summarizeStoryTimeline(storyTimeline) : null,
    ai_usage_id: verifiedGenerationProvenance?.ai_usage_id ?? null,
    provider: verifiedGenerationProvenance?.provider ?? null,
    model: verifiedGenerationProvenance?.model ?? null,
    operation_code: verifiedGenerationProvenance?.operation_code ?? null,
    generation_provenance: verifiedGenerationProvenance,
  };
}

function summarizeEvidenceMap(evidenceMap) {
  const paragraphs = Array.isArray(evidenceMap?.paragraphs)
    ? evidenceMap.paragraphs
    : Array.isArray(evidenceMap?.items)
      ? evidenceMap.items
      : [];

  return {
    paragraph_count: paragraphs.length,
    supported_paragraphs: paragraphs.filter((p) => Array.isArray(p?.source_memories) && p.source_memories.length > 0).length,
  };
}

function summarizeStoryTimeline(storyTimeline) {
  const events = Array.isArray(storyTimeline?.ordered_events)
    ? storyTimeline.ordered_events
    : Array.isArray(storyTimeline?.events)
      ? storyTimeline.events
      : [];

  return {
    event_count: events.length,
    chronology_score: Number(storyTimeline?.chronology_score || 0) || null,
    temporal_confidence: Number(storyTimeline?.temporal_confidence || 0) || null,
  };
}

function normalizeLineageRow(row, storyMap) {
  const storyId = Number(row.story_id);
  const story = storyMap?.get(storyId) || null;

  return {
    story_chapter_id: Number(row.story_chapter_id),
    story_id: storyId,
    chapter_id: Number(row.chapter_id),
    author_id: Number(row.author_id),
    confidence: Number(row.confidence || 0),
    reason: row.reason == null ? null : String(row.reason),
    source: row.source == null ? null : String(row.source),
    status: row.status == null ? 'ACTIVE' : String(row.status),
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
    story,
  };
}

function buildChapterLineageSnapshot({ chapter, links }) {
  const normalizedLinks = Array.isArray(links) ? links : [];
  const scores = normalizedLinks.map((link) => Number(link.confidence || 0)).filter((n) => n > 0);
  const avgConfidence = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  // Para capítulos criados diretamente de uma única Story, expomos no topo
  // a versão-fonte e a identidade da geração comprovada. Em cenários com
  // múltiplas Stories, a proveniência permanece individualizada em stories[].
  const singleSource = normalizedLinks.length === 1 ? normalizedLinks[0] : null;
  const sourceStory = singleSource?.story || null;
  const sourceGenerationProvenance = sourceStory?.generation_provenance || null;

  return {
    version: ENGINE_VERSION,
    generated_at: new Date().toISOString(),
    chapter: {
      chapter_id: Number(chapter.chapter_id),
      title: chapter.title || null,
      description: chapter.description || null,
      chapter_version_id: chapter.current_version_id == null ? null : Number(chapter.current_version_id),
    },
    source_story_id: singleSource ? Number(singleSource.story_id) : null,
    story_id: singleSource ? Number(singleSource.story_id) : null,
    source_story_version_id: sourceStory?.story_version_id ?? null,
    story_version_id: sourceStory?.story_version_id ?? null,
    ai_usage_id: sourceGenerationProvenance?.ai_usage_id ?? null,
    provider: sourceGenerationProvenance?.provider ?? null,
    model: sourceGenerationProvenance?.model ?? null,
    operation_code: sourceGenerationProvenance?.operation_code ?? null,
    generation_provenance: sourceGenerationProvenance,
    story_count: normalizedLinks.length,
    confidence: avgConfidence,
    stories: normalizedLinks.map((link, index) => ({
      order: index + 1,
      story_id: link.story_id,
      title: link.story?.title || `Story ${link.story_id}`,
      confidence: link.confidence,
      reason: link.reason,
      truth_health_score: link.story?.truth_health_score ?? null,
      auditability_score: link.story?.auditability_score ?? null,
      chronology_score: link.story?.chronology_score ?? null,
      evidence_summary: link.story?.evidence_summary ?? null,
      timeline_summary: link.story?.timeline_summary ?? null,
      story_version_id: link.story?.story_version_id ?? null,
      ai_usage_id: link.story?.ai_usage_id ?? null,
      provider: link.story?.provider ?? null,
      model: link.story?.model ?? null,
      operation_code: link.story?.operation_code ?? null,
      generation_provenance: link.story?.generation_provenance ?? null,
    })),
    source_policy: 'Capítulo derivado de Stories auditáveis, preservando origem narrativa até memórias e evidências.',
  };
}

async function persistChapterLineageSnapshot(pool, chapterId, snapshot) {
  const hasColumn = await columnExists(pool, 'identity_chapter', 'chapter_lineage');
  if (!hasColumn) return { persisted: false, reason: 'Coluna identity_chapter.chapter_lineage inexistente.' };

  await pool.request()
    .input('chapter_id', sql.Int, Number(chapterId))
    .input('chapter_lineage', sql.NVarChar(sql.MAX), stringify(snapshot))
    .query(`
      UPDATE dbo.identity_chapter
      SET chapter_lineage = @chapter_lineage,
          updated_at = CASE WHEN COL_LENGTH('dbo.identity_chapter', 'updated_at') IS NOT NULL THEN SYSUTCDATETIME() ELSE updated_at END
      WHERE chapter_id = @chapter_id;
    `);

  return { persisted: true };
}

export async function getChapterStoryLineage({ authorId, chapterId } = {}) {
  const aid = toPositiveInt(authorId);
  const cid = toPositiveInt(chapterId);

  if (!aid) {
    const error = new Error('author_id inválido.');
    error.status = 401;
    throw error;
  }

  if (!cid) {
    const error = new Error('chapter_id inválido.');
    error.status = 400;
    throw error;
  }

  const pool = await getPool();
  const hasLineage = await tableExists(pool, 'identity_story_chapter');
  const chapter = await fetchChapter(pool, aid, cid);

  if (!chapter) {
    const error = new Error('Capítulo não encontrado.');
    error.status = 404;
    throw error;
  }

  if (!hasLineage) {
    return {
      ok: true,
      engine: 'STORY_CHAPTER_LINEAGE',
      version: ENGINE_VERSION,
      author_id: aid,
      chapter_id: cid,
      links: [],
      lineage: buildChapterLineageSnapshot({ chapter, links: [] }),
      meta: {
        source: 'empty',
        warning: 'Tabela identity_story_chapter inexistente. Execute a migration do Lote 3.',
      },
    };
  }

  const result = await pool.request()
    .input('author_id', sql.Int, aid)
    .input('chapter_id', sql.Int, cid)
    .query(`
      SELECT
        story_chapter_id,
        story_id,
        chapter_id,
        author_id,
        confidence,
        reason,
        source,
        status,
        created_at,
        updated_at
      FROM dbo.identity_story_chapter
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND status = 'ACTIVE'
      ORDER BY confidence DESC, created_at ASC, story_chapter_id ASC;
    `);

  const raw = result.recordset || [];
  const storyMap = await fetchStorySnapshots(pool, aid, raw.map((row) => row.story_id));
  const links = raw.map((row) => normalizeLineageRow(row, storyMap));
  const lineage = buildChapterLineageSnapshot({ chapter, links });
  const persistence = await persistChapterLineageSnapshot(pool, cid, lineage);

  return {
    ok: true,
    engine: 'STORY_CHAPTER_LINEAGE',
    version: ENGINE_VERSION,
    author_id: aid,
    chapter_id: cid,
    links,
    lineage,
    persistence,
    meta: {
      generated_at: new Date().toISOString(),
      source: 'persisted',
    },
  };
}

export async function linkStoryToChapter({ authorId, chapterId, storyId, confidence, reason, source } = {}) {
  const aid = toPositiveInt(authorId);
  const cid = toPositiveInt(chapterId);
  const sid = toPositiveInt(storyId);

  if (!aid) {
    const error = new Error('author_id inválido.');
    error.status = 401;
    throw error;
  }

  if (!cid) {
    const error = new Error('chapter_id inválido.');
    error.status = 400;
    throw error;
  }

  if (!sid) {
    const error = new Error('story_id inválido.');
    error.status = 400;
    throw error;
  }

  const pool = await getPool();
  const hasLineage = await tableExists(pool, 'identity_story_chapter');
  if (!hasLineage) {
    const error = new Error('Tabela identity_story_chapter inexistente. Execute a migration do Lote 3.');
    error.status = 500;
    throw error;
  }

  const chapter = await fetchChapter(pool, aid, cid);
  if (!chapter) {
    const error = new Error('Capítulo não encontrado.');
    error.status = 404;
    throw error;
  }

  const finalConfidence = clampScore(confidence);
  const finalReason = safeText(reason, 'Story vinculada ao capítulo como origem narrativa auditável.').slice(0, MAX_REASON_LEN);
  const finalSource = safeText(source, 'chapter.story_lineage');

  await pool.request()
    .input('author_id', sql.Int, aid)
    .input('chapter_id', sql.Int, cid)
    .input('story_id', sql.Int, sid)
    .input('confidence', sql.Decimal(5, 2), finalConfidence)
    .input('reason', sql.NVarChar(1000), finalReason)
    .input('source', sql.VarChar(80), finalSource)
    .query(`
      MERGE dbo.identity_story_chapter AS target
      USING (
        SELECT
          @author_id AS author_id,
          @chapter_id AS chapter_id,
          @story_id AS story_id
      ) AS src
      ON target.author_id = src.author_id
         AND target.chapter_id = src.chapter_id
         AND target.story_id = src.story_id
      WHEN MATCHED THEN
        UPDATE SET
          confidence = @confidence,
          reason = @reason,
          source = @source,
          status = 'ACTIVE',
          updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (
          author_id,
          chapter_id,
          story_id,
          confidence,
          reason,
          source,
          status,
          created_at,
          updated_at
        )
        VALUES (
          @author_id,
          @chapter_id,
          @story_id,
          @confidence,
          @reason,
          @source,
          'ACTIVE',
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
        );
    `);

  return getChapterStoryLineage({ authorId: aid, chapterId: cid });
}

export async function unlinkStoryFromChapter({ authorId, chapterId, storyId } = {}) {
  const aid = toPositiveInt(authorId);
  const cid = toPositiveInt(chapterId);
  const sid = toPositiveInt(storyId);

  if (!aid) {
    const error = new Error('author_id inválido.');
    error.status = 401;
    throw error;
  }

  if (!cid || !sid) {
    const error = new Error('chapter_id/story_id inválido.');
    error.status = 400;
    throw error;
  }

  const pool = await getPool();
  const hasLineage = await tableExists(pool, 'identity_story_chapter');
  if (!hasLineage) {
    return { ok: true, removed: false, reason: 'Tabela identity_story_chapter inexistente.' };
  }

  await pool.request()
    .input('author_id', sql.Int, aid)
    .input('chapter_id', sql.Int, cid)
    .input('story_id', sql.Int, sid)
    .query(`
      UPDATE dbo.identity_story_chapter
      SET status = 'REMOVED',
          updated_at = SYSUTCDATETIME()
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND story_id = @story_id;
    `);

  return getChapterStoryLineage({ authorId: aid, chapterId: cid });
}

export async function rebuildChapterStoryLineage({ authorId, chapterId, limit = 8, minConfidence = 55 } = {}) {
  const aid = toPositiveInt(authorId);
  const cid = toPositiveInt(chapterId);

  if (!aid) {
    const error = new Error('author_id inválido.');
    error.status = 401;
    throw error;
  }

  if (!cid) {
    const error = new Error('chapter_id inválido.');
    error.status = 400;
    throw error;
  }

  const pool = await getPool();
  const chapter = await fetchChapter(pool, aid, cid);
  if (!chapter) {
    const error = new Error('Capítulo não encontrado.');
    error.status = 404;
    throw error;
  }

  let candidatePayload = await listPersistedChapterCandidates({ authorId: aid, limit: Math.max(12, Number(limit || 8) * 4) });
  let candidates = Array.isArray(candidatePayload?.candidates) ? candidatePayload.candidates : [];

  if (!candidates.length) {
    candidatePayload = await buildChapterCandidatesForAuthor({ authorId: aid, limit: Math.max(12, Number(limit || 8) * 4), persist: true });
    candidates = Array.isArray(candidatePayload?.candidates) ? candidatePayload.candidates : [];
  }

  const candidate = pickBestCandidate(chapter, candidates);
  if (!candidate) {
    return {
      ok: true,
      engine: 'STORY_CHAPTER_LINEAGE',
      version: ENGINE_VERSION,
      author_id: aid,
      chapter_id: cid,
      linked: 0,
      links: [],
      lineage: buildChapterLineageSnapshot({ chapter, links: [] }),
      meta: {
        source: 'empty',
        warning: 'Nenhum Chapter Candidate encontrado para reconstruir lineage.',
      },
    };
  }

  const storyIds = (Array.isArray(candidate.story_ids) ? candidate.story_ids : safeJsonParse(candidate.story_ids, []))
    .map(toPositiveInt)
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit || 8)));

  const confidence = Math.max(clampScore(candidate.confidence || candidate.chapter_candidate_score, DEFAULT_CONFIDENCE), clampScore(minConfidence, 55));
  const reason = safeText(
    Array.isArray(candidate.reasons) ? candidate.reasons.join(' ') : candidate.summary,
    `Story vinculada por semelhança narrativa com o candidato de capítulo "${candidate.suggested_title || chapter.title}".`
  ).slice(0, MAX_REASON_LEN);

  for (const sid of storyIds) {
    await linkStoryToChapter({
      authorId: aid,
      chapterId: cid,
      storyId: sid,
      confidence,
      reason,
      source: 'chapter.lineage.rebuild_from_candidate',
    });
  }

  const lineage = await getChapterStoryLineage({ authorId: aid, chapterId: cid });
  return {
    ...lineage,
    linked: storyIds.length,
    selected_candidate: candidate,
    meta: {
      ...(lineage.meta || {}),
      source: 'rebuilt_from_chapter_candidate',
      selected_candidate_id: candidate.candidate_id ?? null,
    },
  };
}

export default {
  getChapterStoryLineage,
  linkStoryToChapter,
  unlinkStoryFromChapter,
  rebuildChapterStoryLineage,
};
