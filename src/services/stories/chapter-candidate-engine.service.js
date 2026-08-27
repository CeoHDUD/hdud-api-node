// C:\HDUD_DATA\hdud-api-node\src\services\stories\chapter-candidate-engine.service.js
//
// GO LIVE 005.0 — LOTE 2 — Chapter Candidate Engine
//
// Motor aditivo e defensivo: consome Stories aprovadas pelo Story Publication Pipeline
// e propõe candidatos a Capítulo sem duplicar texto, preservando lineage e auditabilidade.

import { getPool, sql } from '../../db.js';

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const READY_STATUSES = [
  'READY_FOR_BOOK',
  'READY_FOR_CHAPTER',
  'READY_FOR_CHAPTER_DISCOVERY',
  'PUBLISHED',
];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length ? text : fallback;
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

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 1) return Math.max(0, Math.min(100, n * 100));
  return Math.max(0, Math.min(100, n));
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function extractYear(value) {
  const iso = normalizeDate(value);
  if (iso) return new Date(iso).getUTCFullYear();
  const text = String(value || '');
  const match = text.match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2}|2200)\b/);
  return match ? Number(match[1]) : null;
}

function decadeFromYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return null;
  return Math.floor(y / 10) * 10;
}

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function slugKey(value, fallback = 'continuidade-narrativa') {
  const text = stripAccents(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return text || fallback;
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

function col(columns, name) {
  return columns.has(String(name || '').toLowerCase());
}

function selectExpr(alias, columns, columnName, outputName = columnName) {
  return col(columns, columnName)
    ? `${alias}.${columnName} AS ${outputName}`
    : `NULL AS ${outputName}`;
}

function buildTimelineSummary(storyTimeline) {
  const timeline = safeJsonParse(storyTimeline, {});
  const events = Array.isArray(timeline?.ordered_events)
    ? timeline.ordered_events
    : Array.isArray(timeline?.events)
      ? timeline.events
      : [];

  const years = events
    .map((event) => extractYear(event?.memory_date || event?.date || event?.created_at || event?.published_at))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const startYear = years[0] || null;
  const endYear = years[years.length - 1] || null;
  const decade = decadeFromYear(startYear || endYear);

  return {
    event_count: events.length,
    start_year: startYear,
    end_year: endYear,
    decade,
    label: startYear && endYear && startYear !== endYear
      ? `${startYear}–${endYear}`
      : startYear
        ? String(startYear)
        : null,
  };
}

function normalizeStoryRow(row) {
  const timeline = buildTimelineSummary(row.story_timeline);
  const centralTheme = safeText(
    row.central_theme || row.theme || row.dominant_theme || row.story_title || row.version_title,
    'Continuidade narrativa'
  );
  const publicationStatus = safeText(row.story_publication_status || row.version_publication_status, 'READY_FOR_CHAPTER_DISCOVERY');
  const truthHealthScore = normalizeScore(row.truth_health_score, 0);
  const auditabilityScore = normalizeScore(row.auditability_score, 0);
  const chronologyScore = normalizeScore(row.chronology_score, 0);
  const evidenceCoverage = normalizeScore(row.evidence_coverage, 0);
  const timelineCoverage = normalizeScore(row.timeline_coverage, 0);

  const readinessSignals = [truthHealthScore, auditabilityScore, chronologyScore, evidenceCoverage, timelineCoverage]
    .filter((score) => Number(score) > 0);

  const readinessScore = readinessSignals.length
    ? readinessSignals.reduce((sum, score) => sum + score, 0) / readinessSignals.length
    : normalizeScore(row.confidence || row.confidence_score, 65);

  return {
    story_id: Number(row.story_id),
    story_version_id: Number(row.story_version_id || 0) || null,
    author_id: Number(row.author_id),
    title: safeText(row.story_title || row.version_title, `Story ${row.story_id}`),
    central_theme: centralTheme,
    summary: safeText(row.summary || row.description || row.generation_notes, ''),
    story_publication_status: publicationStatus,
    readiness_status: safeText(row.readiness_status, null),
    truth_health_score: round2(truthHealthScore),
    auditability_score: round2(auditabilityScore),
    chronology_score: round2(chronologyScore),
    evidence_coverage: round2(evidenceCoverage),
    timeline_coverage: round2(timelineCoverage),
    readiness_score: round2(readinessScore),
    timeline,
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
  };
}

function deriveCandidateKey(story) {
  const themeKey = slugKey(story.central_theme);
  const decade = story.timeline?.decade;
  return decade ? `${themeKey}-${decade}` : themeKey;
}

function candidateTitleFor(stories) {
  const themes = stories
    .map((story) => safeText(story.central_theme, ''))
    .filter(Boolean);
  const dominant = themes[0] || 'Continuidade narrativa';

  const years = stories
    .flatMap((story) => [story.timeline?.start_year, story.timeline?.end_year])
    .filter(Boolean)
    .sort((a, b) => a - b);

  const start = years[0] || null;
  const end = years[years.length - 1] || null;
  const period = start && end && start !== end ? ` (${start}–${end})` : start ? ` (${start})` : '';

  return `Capítulo sobre ${dominant}${period}`;
}

function buildCandidateFromStories(key, stories) {
  const orderedStories = [...stories].sort((a, b) => {
    const ay = a.timeline?.start_year || 9999;
    const by = b.timeline?.start_year || 9999;
    if (ay !== by) return ay - by;
    return a.story_id - b.story_id;
  });

  const scores = orderedStories.map((story) => story.readiness_score).filter((score) => Number(score) > 0);
  const chronology = orderedStories.map((story) => story.chronology_score).filter((score) => Number(score) > 0);
  const evidence = orderedStories.map((story) => story.evidence_coverage).filter((score) => Number(score) > 0);

  const average = (items, fallback = 0) => items.length
    ? items.reduce((sum, item) => sum + Number(item || 0), 0) / items.length
    : fallback;

  const candidateScore = round2(
    average(scores, 65) * 0.55 +
    average(evidence, 65) * 0.25 +
    average(chronology, 65) * 0.20
  );

  const themes = [...new Set(orderedStories.map((story) => story.central_theme).filter(Boolean))];
  const years = orderedStories
    .flatMap((story) => [story.timeline?.start_year, story.timeline?.end_year])
    .filter(Boolean)
    .sort((a, b) => a - b);

  const startYear = years[0] || null;
  const endYear = years[years.length - 1] || null;

  const lineage = {
    type: 'story_to_chapter_candidate',
    generated_at: new Date().toISOString(),
    source_policy: 'Capítulo candidato derivado apenas de Stories aprovadas pelo Story Publication Pipeline.',
    story_ids: orderedStories.map((story) => story.story_id),
    story_version_ids: orderedStories.map((story) => story.story_version_id).filter(Boolean),
    evidence: orderedStories.map((story, index) => ({
      order: index + 1,
      story_id: story.story_id,
      story_version_id: story.story_version_id,
      title: story.title,
      central_theme: story.central_theme,
      truth_health_score: story.truth_health_score,
      auditability_score: story.auditability_score,
      chronology_score: story.chronology_score,
      evidence_coverage: story.evidence_coverage,
      timeline: story.timeline,
    })),
  };

  const reasons = [
    `${orderedStories.length} Story(s) aprovada(s) compartilham tema ou período narrativo.`,
    `Score médio de prontidão: ${candidateScore}.`,
    startYear ? `Período narrativo identificado: ${startYear}${endYear && endYear !== startYear ? `–${endYear}` : ''}.` : 'Período narrativo ainda parcial.',
    'A composição preserva lineage Story → Capítulo sem copiar o manuscrito.',
  ];

  return {
    candidate_key: key,
    suggested_title: candidateTitleFor(orderedStories),
    central_theme: themes[0] || 'Continuidade narrativa',
    summary: `Candidato a capítulo formado a partir de ${orderedStories.length} Story(s) auditável(is).`,
    story_count: orderedStories.length,
    story_ids: orderedStories.map((story) => story.story_id),
    story_version_ids: orderedStories.map((story) => story.story_version_id).filter(Boolean),
    chapter_candidate_score: candidateScore,
    confidence: candidateScore,
    start_year: startYear,
    end_year: endYear,
    status: candidateScore >= 80 ? 'STRONG_CANDIDATE' : candidateScore >= 65 ? 'CANDIDATE' : 'WEAK_CANDIDATE',
    reasons,
    lineage,
    stories: orderedStories,
  };
}

function buildCandidatesFromStories(stories, limit = DEFAULT_LIMIT) {
  const groups = new Map();

  for (const story of stories) {
    const key = deriveCandidateKey(story);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(story);
  }

  const candidates = [...groups.entries()]
    .map(([key, items]) => buildCandidateFromStories(key, items))
    .sort((a, b) => {
      if (b.chapter_candidate_score !== a.chapter_candidate_score) {
        return b.chapter_candidate_score - a.chapter_candidate_score;
      }
      if (b.story_count !== a.story_count) return b.story_count - a.story_count;
      return a.suggested_title.localeCompare(b.suggested_title, 'pt-BR');
    });

  return candidates.slice(0, limit);
}

async function fetchApprovedStories(pool, authorId, limit = 200) {
  const hasStory = await tableExists(pool, 'identity_story');
  const hasVersion = await tableExists(pool, 'identity_story_version');

  if (!hasStory || !hasVersion) {
    return [];
  }

  const sCols = await getTableColumns(pool, 'identity_story');
  const svCols = await getTableColumns(pool, 'identity_story_version');

  const sTitle = selectExpr('s', sCols, 'title', 'story_title');
  const sCentralTheme = col(sCols, 'central_theme')
    ? 's.central_theme AS central_theme'
    : col(sCols, 'theme')
      ? 's.theme AS central_theme'
      : 'NULL AS central_theme';
  const sSummary = col(sCols, 'summary')
    ? 's.summary AS summary'
    : col(sCols, 'description')
      ? 's.description AS summary'
      : 'NULL AS summary';
  const sPublicationStatus = selectExpr('s', sCols, 'story_publication_status', 'story_publication_status');
  const sCreatedAt = selectExpr('s', sCols, 'created_at', 'created_at');
  const sUpdatedAt = selectExpr('s', sCols, 'updated_at', 'updated_at');

  const svTitle = selectExpr('sv', svCols, 'title', 'version_title');
  const svPublicationStatus = selectExpr('sv', svCols, 'story_publication_status', 'version_publication_status');
  const svReadiness = selectExpr('sv', svCols, 'readiness_status', 'readiness_status');
  const svTruthHealth = selectExpr('sv', svCols, 'truth_health_score', 'truth_health_score');
  const svAuditability = selectExpr('sv', svCols, 'auditability_score', 'auditability_score');
  const svChronology = selectExpr('sv', svCols, 'chronology_score', 'chronology_score');
  const svEvidenceCoverage = selectExpr('sv', svCols, 'evidence_coverage', 'evidence_coverage');
  const svTimelineCoverage = selectExpr('sv', svCols, 'timeline_coverage', 'timeline_coverage');
  const svTimeline = selectExpr('sv', svCols, 'story_timeline', 'story_timeline');
  const svGenerationNotes = selectExpr('sv', svCols, 'generation_notes', 'generation_notes');

  const conditions = [];
  if (col(sCols, 'story_publication_status')) {
    conditions.push("s.story_publication_status IN ('READY_FOR_BOOK','READY_FOR_CHAPTER','READY_FOR_CHAPTER_DISCOVERY','PUBLISHED')");
  }
  if (col(svCols, 'story_publication_status')) {
    conditions.push("sv.story_publication_status IN ('READY_FOR_BOOK','READY_FOR_CHAPTER','READY_FOR_CHAPTER_DISCOVERY','PUBLISHED')");
  }
  if (col(svCols, 'readiness_status')) {
    conditions.push("sv.readiness_status IN ('READY','READY_FOR_BOOK','READY_FOR_CHAPTER','PUBLISHABLE')");
  }
  if (col(svCols, 'truth_health_score')) {
    conditions.push('TRY_CONVERT(decimal(10,2), sv.truth_health_score) >= 70');
  }

  const readinessWhere = conditions.length ? `AND (${conditions.join(' OR ')})` : '';

  const query = `
    SELECT TOP (@limit)
      s.story_id,
      s.author_id,
      ${sTitle},
      ${sCentralTheme},
      ${sSummary},
      ${sPublicationStatus},
      ${sCreatedAt},
      ${sUpdatedAt},
      sv.story_version_id,
      ${svTitle},
      ${svPublicationStatus},
      ${svReadiness},
      ${svTruthHealth},
      ${svAuditability},
      ${svChronology},
      ${svEvidenceCoverage},
      ${svTimelineCoverage},
      ${svTimeline},
      ${svGenerationNotes}
    FROM dbo.identity_story s
    OUTER APPLY (
      SELECT TOP 1 sv2.*
      FROM dbo.identity_story_version sv2
      WHERE sv2.story_id = s.story_id
        AND (sv2.author_id = s.author_id OR COL_LENGTH('dbo.identity_story_version', 'author_id') IS NULL)
      ORDER BY
        CASE WHEN COL_LENGTH('dbo.identity_story_version', 'version_number') IS NOT NULL THEN TRY_CONVERT(int, sv2.version_number) ELSE 0 END DESC,
        sv2.story_version_id DESC
    ) sv
    WHERE s.author_id = @author_id
      ${col(sCols, 'is_deleted') ? 'AND ISNULL(s.is_deleted, 0) = 0' : ''}
      ${readinessWhere}
    ORDER BY
      COALESCE(TRY_CONVERT(decimal(10,2), ${col(svCols, 'truth_health_score') ? 'sv.truth_health_score' : 'NULL'}), 0) DESC,
      s.story_id DESC;
  `;

  const result = await pool.request()
    .input('author_id', sql.Int, Number(authorId))
    .input('limit', sql.Int, clampInt(limit, 1, 500, 200))
    .query(query);

  return (result.recordset || []).map(normalizeStoryRow).filter((story) => story.story_id);
}

async function persistCandidates(pool, authorId, candidates) {
  const hasCandidateTable = await tableExists(pool, 'identity_story_chapter_candidate');

  if (!hasCandidateTable) {
    return { persisted: false, reason: 'Tabela identity_story_chapter_candidate inexistente. Execute a migration do Lote 2.' };
  }

  await pool.request()
    .input('author_id', sql.Int, Number(authorId))
    .query(`
      UPDATE dbo.identity_story_chapter_candidate
      SET status = 'SUPERSEDED', updated_at = SYSUTCDATETIME()
      WHERE author_id = @author_id
        AND status IN ('STRONG_CANDIDATE', 'CANDIDATE', 'WEAK_CANDIDATE');
    `);

  for (const candidate of candidates) {
    await pool.request()
      .input('author_id', sql.Int, Number(authorId))
      .input('candidate_key', sql.VarChar(160), candidate.candidate_key)
      .input('suggested_title', sql.NVarChar(500), candidate.suggested_title)
      .input('central_theme', sql.NVarChar(300), candidate.central_theme)
      .input('summary', sql.NVarChar(sql.MAX), candidate.summary)
      .input('story_ids', sql.NVarChar(sql.MAX), JSON.stringify(candidate.story_ids || []))
      .input('story_version_ids', sql.NVarChar(sql.MAX), JSON.stringify(candidate.story_version_ids || []))
      .input('story_count', sql.Int, Number(candidate.story_count || 0))
      .input('chapter_candidate_score', sql.Decimal(5, 2), Number(candidate.chapter_candidate_score || 0))
      .input('confidence', sql.Decimal(5, 2), Number(candidate.confidence || 0))
      .input('start_year', sql.Int, candidate.start_year || null)
      .input('end_year', sql.Int, candidate.end_year || null)
      .input('status', sql.VarChar(40), candidate.status)
      .input('reasons', sql.NVarChar(sql.MAX), JSON.stringify(candidate.reasons || []))
      .input('lineage', sql.NVarChar(sql.MAX), JSON.stringify(candidate.lineage || {}))
      .query(`
        INSERT INTO dbo.identity_story_chapter_candidate (
          author_id,
          candidate_key,
          suggested_title,
          central_theme,
          summary,
          story_ids,
          story_version_ids,
          story_count,
          chapter_candidate_score,
          confidence,
          start_year,
          end_year,
          status,
          reasons,
          lineage
        )
        VALUES (
          @author_id,
          @candidate_key,
          @suggested_title,
          @central_theme,
          @summary,
          @story_ids,
          @story_version_ids,
          @story_count,
          @chapter_candidate_score,
          @confidence,
          @start_year,
          @end_year,
          @status,
          @reasons,
          @lineage
        );
      `);

    await persistCandidateLineageOnStories(pool, authorId, candidate);
  }

  return { persisted: true, count: candidates.length };
}

async function persistCandidateLineageOnStories(pool, authorId, candidate) {
  const hasStory = await tableExists(pool, 'identity_story');
  if (!hasStory) return;

  for (const storyId of candidate.story_ids || []) {
    await pool.request()
      .input('author_id', sql.Int, Number(authorId))
      .input('story_id', sql.Int, Number(storyId))
      .input('chapter_candidate_score', sql.Decimal(5, 2), Number(candidate.chapter_candidate_score || 0))
      .input('chapter_lineage', sql.NVarChar(sql.MAX), JSON.stringify({
        candidate_key: candidate.candidate_key,
        suggested_title: candidate.suggested_title,
        score: candidate.chapter_candidate_score,
        generated_at: new Date().toISOString(),
        source_policy: 'Story marcada como participante de um candidato a capítulo.',
      }))
      .query(`
        IF COL_LENGTH('dbo.identity_story', 'chapter_candidate_score') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story
          SET chapter_candidate_score = @chapter_candidate_score
          WHERE story_id = @story_id AND author_id = @author_id;
        END

        IF COL_LENGTH('dbo.identity_story', 'chapter_lineage') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story
          SET chapter_lineage = @chapter_lineage
          WHERE story_id = @story_id AND author_id = @author_id;
        END

        IF COL_LENGTH('dbo.identity_story', 'updated_at') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story
          SET updated_at = SYSUTCDATETIME()
          WHERE story_id = @story_id AND author_id = @author_id;
        END
      `);
  }
}

export async function buildChapterCandidatesForAuthor({ authorId, limit = DEFAULT_LIMIT, persist = false } = {}) {
  const aid = Number(authorId);
  if (!Number.isInteger(aid) || aid <= 0) {
    const error = new Error('author_id inválido.');
    error.status = 401;
    throw error;
  }

  const resolvedLimit = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const pool = await getPool();
  const stories = await fetchApprovedStories(pool, aid, Math.max(resolvedLimit * 8, 80));
  const candidates = buildCandidatesFromStories(stories, resolvedLimit);

  const persistence = persist
    ? await persistCandidates(pool, aid, candidates)
    : { persisted: false, reason: 'persist=false' };

  return {
    ok: true,
    engine: 'CHAPTER_CANDIDATE_ENGINE',
    version: 'GO_LIVE_005_0_LOTE_2',
    author_id: aid,
    total_approved_stories: stories.length,
    total_candidates: candidates.length,
    candidates,
    persistence,
    meta: {
      generated_at: new Date().toISOString(),
      source_policy: 'Capítulos candidatos são derivados apenas de Stories aprovadas e auditáveis.',
      ready_statuses: READY_STATUSES,
    },
  };
}

export async function listPersistedChapterCandidates({ authorId, limit = DEFAULT_LIMIT } = {}) {
  const aid = Number(authorId);
  if (!Number.isInteger(aid) || aid <= 0) {
    const error = new Error('author_id inválido.');
    error.status = 401;
    throw error;
  }

  const pool = await getPool();
  const hasCandidateTable = await tableExists(pool, 'identity_story_chapter_candidate');
  if (!hasCandidateTable) {
    return {
      ok: true,
      engine: 'CHAPTER_CANDIDATE_ENGINE',
      author_id: aid,
      total_candidates: 0,
      candidates: [],
      meta: {
        source: 'empty',
        warning: 'Tabela identity_story_chapter_candidate inexistente. Execute a migration do Lote 2.',
      },
    };
  }

  const result = await pool.request()
    .input('author_id', sql.Int, aid)
    .input('limit', sql.Int, clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT))
    .query(`
      SELECT TOP (@limit)
        candidate_id,
        author_id,
        candidate_key,
        suggested_title,
        central_theme,
        summary,
        story_ids,
        story_version_ids,
        story_count,
        chapter_candidate_score,
        confidence,
        start_year,
        end_year,
        status,
        reasons,
        lineage,
        created_at,
        updated_at
      FROM dbo.identity_story_chapter_candidate
      WHERE author_id = @author_id
        AND status <> 'SUPERSEDED'
      ORDER BY chapter_candidate_score DESC, story_count DESC, candidate_id DESC;
    `);

  const candidates = (result.recordset || []).map((row) => ({
    candidate_id: Number(row.candidate_id),
    author_id: Number(row.author_id),
    candidate_key: row.candidate_key,
    suggested_title: row.suggested_title,
    central_theme: row.central_theme,
    summary: row.summary,
    story_ids: safeJsonParse(row.story_ids, []),
    story_version_ids: safeJsonParse(row.story_version_ids, []),
    story_count: Number(row.story_count || 0),
    chapter_candidate_score: Number(row.chapter_candidate_score || 0),
    confidence: Number(row.confidence || 0),
    start_year: row.start_year == null ? null : Number(row.start_year),
    end_year: row.end_year == null ? null : Number(row.end_year),
    status: row.status,
    reasons: safeJsonParse(row.reasons, []),
    lineage: safeJsonParse(row.lineage, {}),
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
  }));

  return {
    ok: true,
    engine: 'CHAPTER_CANDIDATE_ENGINE',
    author_id: aid,
    total_candidates: candidates.length,
    candidates,
    meta: {
      generated_at: new Date().toISOString(),
      source: 'persisted',
    },
  };
}

export default {
  buildChapterCandidatesForAuthor,
  listPersistedChapterCandidates,
};
