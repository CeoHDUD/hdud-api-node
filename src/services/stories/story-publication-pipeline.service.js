// C:\HDUD_DATA\hdud-api-node\src\services\stories\story-publication-pipeline.service.js
//
// GO LIVE 005.0 — Living Story Platform
// Lote 1 — Story Publication Pipeline
//
// Responsabilidade:
// - Validar se uma Story editorialmente gerada possui lastro suficiente para avançar
//   para a camada Livro Vivo.
// - Consolidar status de publicação narrativa sem quebrar contratos existentes.
// - Persistir de forma aditiva quando as colunas/tabelas já existirem.
// - Nunca inventar readiness: o status deriva de Truth Finalization, Evidence Map e Timeline.

import { getPool, sql } from '../../db.js';
import { buildStoryTruthFinalization } from './story-truth-finalization.service.js';
import { getStoryTruthTimeline } from './story-truth-timeline.service.js';

const DEFAULT_THRESHOLDS = Object.freeze({
  truthHealthScore: Number(process.env.STORY_PUBLICATION_MIN_TRUTH_HEALTH || 80),
  auditabilityScore: Number(process.env.STORY_PUBLICATION_MIN_AUDITABILITY || 80),
  evidenceCoverage: Number(process.env.STORY_PUBLICATION_MIN_EVIDENCE_COVERAGE || 90),
  timelineCoverage: Number(process.env.STORY_PUBLICATION_MIN_TIMELINE_COVERAGE || 60),
  chronologyScore: Number(process.env.STORY_PUBLICATION_MIN_CHRONOLOGY || 60),
  maxHallucinationRisk: Number(process.env.STORY_PUBLICATION_MAX_HALLUCINATION_RISK || 35),
});

function clampNumber(value, min = 0, max = 100, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeReadinessStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (!status) return 'UNKNOWN';
  return status;
}

function isPositiveReadiness(status) {
  return [
    'READY',
    'READY_FOR_EDITORIAL',
    'READY_FOR_PUBLICATION',
    'READY_FOR_BOOK',
    'APPROVED',
    'HEALTHY',
  ].includes(normalizeReadinessStatus(status));
}

function buildChecklist({ finalization, timeline, thresholds = DEFAULT_THRESHOLDS }) {
  const health = finalization?.health || finalization?.editorial_summary || {};

  const truthHealthScore = clampNumber(
    health.truth_health_score ?? finalization?.truth_health_score,
    0,
    100,
    0
  );

  const auditabilityScore = clampNumber(
    health.auditability_score ?? finalization?.auditability_score,
    0,
    100,
    0
  );

  const evidenceCoverage = clampNumber(
    health.evidence_coverage ?? finalization?.evidence_coverage,
    0,
    100,
    0
  );

  const timelineCoverage = clampNumber(
    health.timeline_coverage ?? finalization?.timeline_coverage,
    0,
    100,
    0
  );

  const hallucinationRisk = clampNumber(
    health.hallucination_risk ?? finalization?.hallucination_risk,
    0,
    100,
    100
  );

  const missingEvidenceCount = Number(
    health.missing_evidence_count ?? finalization?.missing_evidence_count ?? 0
  ) || 0;

  const chronologyScore = clampNumber(
    timeline?.chronology_score,
    0,
    100,
    0
  );

  const temporalConfidenceRaw = Number(timeline?.temporal_confidence);
  const temporalConfidence = Number.isFinite(temporalConfidenceRaw)
    ? temporalConfidenceRaw
    : 0;

  const readinessStatus = normalizeReadinessStatus(
    health.readiness_status || finalization?.readiness_status || finalization?.editorial_summary?.status
  );

  const checks = [
    {
      code: 'TRUTH_HEALTH',
      label: 'Truth Health suficiente',
      ok: truthHealthScore >= thresholds.truthHealthScore,
      value: truthHealthScore,
      expected: `>= ${thresholds.truthHealthScore}`,
    },
    {
      code: 'AUDITABILITY',
      label: 'Auditabilidade suficiente',
      ok: auditabilityScore >= thresholds.auditabilityScore,
      value: auditabilityScore,
      expected: `>= ${thresholds.auditabilityScore}`,
    },
    {
      code: 'EVIDENCE_COVERAGE',
      label: 'Cobertura de evidências suficiente',
      ok: evidenceCoverage >= thresholds.evidenceCoverage,
      value: evidenceCoverage,
      expected: `>= ${thresholds.evidenceCoverage}`,
    },
    {
      code: 'NO_MISSING_EVIDENCE',
      label: 'Nenhum parágrafo sem evidência',
      ok: missingEvidenceCount <= 0,
      value: missingEvidenceCount,
      expected: '0',
    },
    {
      code: 'TIMELINE_COVERAGE',
      label: 'Cobertura temporal suficiente',
      ok: timelineCoverage >= thresholds.timelineCoverage,
      value: timelineCoverage,
      expected: `>= ${thresholds.timelineCoverage}`,
    },
    {
      code: 'CHRONOLOGY',
      label: 'Chronology Score suficiente',
      ok: chronologyScore >= thresholds.chronologyScore,
      value: chronologyScore,
      expected: `>= ${thresholds.chronologyScore}`,
    },
    {
      code: 'HALLUCINATION_RISK',
      label: 'Risco de alucinação controlado',
      ok: hallucinationRisk <= thresholds.maxHallucinationRisk,
      value: hallucinationRisk,
      expected: `<= ${thresholds.maxHallucinationRisk}`,
    },
    {
      code: 'READINESS_STATUS',
      label: 'Readiness editorial compatível',
      ok: isPositiveReadiness(readinessStatus),
      value: readinessStatus,
      expected: 'READY / APPROVED / HEALTHY',
    },
  ];

  const blockers = checks.filter((check) => !check.ok);
  const publicationStatus = blockers.length === 0 ? 'READY_FOR_BOOK' : 'NEEDS_TRUTH_REVIEW';

  return {
    publication_status: publicationStatus,
    can_publish_to_book: blockers.length === 0,
    checks,
    blockers,
    metrics: {
      truth_health_score: truthHealthScore,
      auditability_score: auditabilityScore,
      evidence_coverage: evidenceCoverage,
      timeline_coverage: timelineCoverage,
      hallucination_risk: hallucinationRisk,
      missing_evidence_count: missingEvidenceCount,
      chronology_score: chronologyScore,
      temporal_confidence: temporalConfidence,
      readiness_status: readinessStatus,
    },
    thresholds,
  };
}

async function fetchLatestStoryVersion(pool, storyId, authorId) {
  const result = await pool.request()
    .input('story_id', sql.Int, Number(storyId))
    .input('author_id', sql.Int, Number(authorId))
    .query(`
      SELECT TOP 1
        sv.*
      FROM dbo.identity_story_version sv
      WHERE sv.story_id = @story_id
        AND (sv.author_id = @author_id OR @author_id IS NULL)
      ORDER BY sv.version_number DESC, sv.story_version_id DESC;
    `);

  return result.recordset?.[0] || null;
}

async function persistPublicationState({
  pool,
  storyId,
  authorId,
  storyVersionId,
  publicationStatus,
  publicationPayload,
  metrics,
  persist = true,
}) {
  if (!persist) return;

  await pool.request()
    .input('story_id', sql.Int, Number(storyId))
    .input('author_id', sql.Int, Number(authorId))
    .input('story_version_id', sql.Int, storyVersionId ? Number(storyVersionId) : null)
    .input('story_publication_status', sql.VarChar(40), publicationStatus)
    .input('story_publication_payload', sql.NVarChar(sql.MAX), JSON.stringify(publicationPayload))
    .input('truth_health_score', sql.Decimal(5, 2), metrics.truth_health_score)
    .input('auditability_score', sql.Decimal(5, 2), metrics.auditability_score)
    .input('chronology_score', sql.Decimal(5, 2), metrics.chronology_score)
    .query(`
      IF OBJECT_ID('dbo.identity_story', 'U') IS NOT NULL
      BEGIN
        IF COL_LENGTH('dbo.identity_story', 'story_publication_status') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story
          SET story_publication_status = @story_publication_status
          WHERE story_id = @story_id
            AND author_id = @author_id;
        END

        IF COL_LENGTH('dbo.identity_story', 'story_publication_date') IS NOT NULL
           AND @story_publication_status = 'READY_FOR_BOOK'
        BEGIN
          UPDATE dbo.identity_story
          SET story_publication_date = COALESCE(story_publication_date, SYSUTCDATETIME())
          WHERE story_id = @story_id
            AND author_id = @author_id;
        END

        IF COL_LENGTH('dbo.identity_story', 'updated_at') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story
          SET updated_at = SYSUTCDATETIME()
          WHERE story_id = @story_id
            AND author_id = @author_id;
        END
      END

      IF OBJECT_ID('dbo.identity_story_version', 'U') IS NOT NULL
         AND @story_version_id IS NOT NULL
      BEGIN
        IF COL_LENGTH('dbo.identity_story_version', 'story_publication_status') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story_version
          SET story_publication_status = @story_publication_status
          WHERE story_version_id = @story_version_id;
        END

        IF COL_LENGTH('dbo.identity_story_version', 'story_publication_date') IS NOT NULL
           AND @story_publication_status = 'READY_FOR_BOOK'
        BEGIN
          UPDATE dbo.identity_story_version
          SET story_publication_date = COALESCE(story_publication_date, SYSUTCDATETIME())
          WHERE story_version_id = @story_version_id;
        END

        IF COL_LENGTH('dbo.identity_story_version', 'story_publication_payload') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story_version
          SET story_publication_payload = @story_publication_payload
          WHERE story_version_id = @story_version_id;
        END

        IF COL_LENGTH('dbo.identity_story_version', 'truth_health_score') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story_version
          SET truth_health_score = @truth_health_score
          WHERE story_version_id = @story_version_id;
        END

        IF COL_LENGTH('dbo.identity_story_version', 'auditability_score') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story_version
          SET auditability_score = @auditability_score
          WHERE story_version_id = @story_version_id;
        END

        IF COL_LENGTH('dbo.identity_story_version', 'chronology_score') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story_version
          SET chronology_score = @chronology_score
          WHERE story_version_id = @story_version_id;
        END

        IF COL_LENGTH('dbo.identity_story_version', 'updated_at') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story_version
          SET updated_at = SYSUTCDATETIME()
          WHERE story_version_id = @story_version_id;
        END
      END

      IF OBJECT_ID('dbo.identity_story_publication_audit', 'U') IS NOT NULL
      BEGIN
        INSERT INTO dbo.identity_story_publication_audit (
          story_id,
          story_version_id,
          author_id,
          story_publication_status,
          truth_health_score,
          auditability_score,
          chronology_score,
          publication_payload
        )
        VALUES (
          @story_id,
          @story_version_id,
          @author_id,
          @story_publication_status,
          @truth_health_score,
          @auditability_score,
          @chronology_score,
          @story_publication_payload
        );
      END
    `);
}

export async function buildStoryPublicationStatus({ storyId, authorId, persist = false, rebuild = false } = {}) {
  const id = toPositiveInt(storyId);
  const aid = toPositiveInt(authorId);

  if (!id) {
    const err = new Error('story_id inválido.');
    err.status = 400;
    throw err;
  }

  if (!aid) {
    const err = new Error('author_id inválido.');
    err.status = 401;
    throw err;
  }

  const pool = await getPool();
  const version = await fetchLatestStoryVersion(pool, id, aid);

  if (!version) {
    const err = new Error('Story/version não encontrada.');
    err.status = 404;
    throw err;
  }

  const finalization = await buildStoryTruthFinalization({
    storyId: id,
    authorId: aid,
    persist: true,
  });

  const timeline = await getStoryTruthTimeline({
    storyId: id,
    authorId: aid,
    rebuild,
  });

  const checklist = buildChecklist({ finalization, timeline });

  const payload = {
    story_id: id,
    story_version_id: Number(version.story_version_id || finalization.story_version_id || 0) || null,
    author_id: aid,
    generated_at: new Date().toISOString(),
    source: 'story-publication-pipeline',
    publication_status: checklist.publication_status,
    can_publish_to_book: checklist.can_publish_to_book,
    metrics: checklist.metrics,
    thresholds: checklist.thresholds,
    checks: checklist.checks,
    blockers: checklist.blockers,
    truth_finalization: {
      truth_health_score: checklist.metrics.truth_health_score,
      auditability_score: checklist.metrics.auditability_score,
      readiness_status: checklist.metrics.readiness_status,
    },
    truth_timeline: {
      chronology_score: checklist.metrics.chronology_score,
      temporal_confidence: checklist.metrics.temporal_confidence,
      event_count: Array.isArray(timeline?.ordered_events || timeline?.events)
        ? (timeline.ordered_events || timeline.events).length
        : 0,
      gap_count: Array.isArray(timeline?.narrative_gaps || timeline?.gaps)
        ? (timeline.narrative_gaps || timeline.gaps).length
        : 0,
    },
    editorial_summary: {
      title: checklist.can_publish_to_book
        ? 'História pronta para integrar o Livro Vivo'
        : 'História ainda precisa de revisão de verdade',
      status: checklist.publication_status,
      message: checklist.can_publish_to_book
        ? 'A história possui evidência, timeline e auditabilidade suficientes para avançar ao Livro Vivo.'
        : 'A história permanece protegida até que os bloqueios de verdade sejam resolvidos.',
    },
  };

  await persistPublicationState({
    pool,
    storyId: id,
    authorId: aid,
    storyVersionId: payload.story_version_id,
    publicationStatus: payload.publication_status,
    publicationPayload: payload,
    metrics: checklist.metrics,
    persist,
  });

  return payload;
}

export async function publishStoryIfReady({ storyId, authorId, rebuild = false } = {}) {
  const result = await buildStoryPublicationStatus({
    storyId,
    authorId,
    persist: true,
    rebuild,
  });

  return {
    ok: result.can_publish_to_book,
    ...result,
  };
}

export default {
  buildStoryPublicationStatus,
  publishStoryIfReady,
};
