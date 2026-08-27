// C:\HDUD_DATA\hdud-api-node\src\services\stories\story-truth-finalization.service.js

import { getPool, sql } from '../../db.js';
import { buildStoryTruthHealth } from './story-truth-health.service.js';

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function stringify(value) {
  return JSON.stringify(value ?? null);
}

async function fetchLatestStoryVersion(pool, storyId, authorId) {
  const result = await pool.request()
    .input('story_id', sql.Int, storyId)
    .input('author_id', sql.Int, authorId)
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

export async function buildStoryTruthFinalization({ storyId, authorId, persist = false }) {
  const id = Number(storyId);
  const aid = Number(authorId);

  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('story_id inválido.');
    err.status = 400;
    throw err;
  }

  if (!Number.isInteger(aid) || aid <= 0) {
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

  const evidenceMap = safeJsonParse(version.evidence_map, { paragraphs: [] });
  const paragraphScores = safeJsonParse(version.paragraph_scores, { paragraphs: [] });
  const lineage = safeJsonParse(version.lineage, { nodes: [], edges: [] });
  const storyTimeline = safeJsonParse(version.story_timeline, { events: [], gaps: [] });

  const health = buildStoryTruthHealth({ evidenceMap, paragraphScores, storyTimeline });

  const finalization = {
    story_id: id,
    story_version_id: Number(version.story_version_id || 0) || null,
    version_number: Number(version.version_number || 0) || null,
    generated_at: new Date().toISOString(),
    health,
    evidence_map: evidenceMap,
    paragraph_scores: paragraphScores,
    lineage,
    story_timeline: storyTimeline,
    editorial_summary: {
      title: 'Mapa final de verdade da história',
      status: health.readiness_status,
      truth_health_score: health.truth_health_score,
      auditability_score: health.auditability_score,
      evidence_coverage: health.evidence_coverage,
      timeline_coverage: health.timeline_coverage,
      hallucination_risk: health.hallucination_risk,
      missing_evidence_count: health.missing_evidence_count,
      temporal_gap_count: health.temporal_gap_count,
    },
  };

  if (persist) {
    await pool.request()
      .input('story_version_id', sql.Int, Number(version.story_version_id))
      .input('truth_finalization', sql.NVarChar(sql.MAX), stringify(finalization))
      .input('truth_health_score', sql.Decimal(5, 2), health.truth_health_score)
      .input('auditability_score', sql.Decimal(5, 2), health.auditability_score)
      .input('readiness_status', sql.VarChar(30), health.readiness_status)
      .query(`
        IF COL_LENGTH('dbo.identity_story_version', 'truth_finalization') IS NOT NULL
        BEGIN
          UPDATE dbo.identity_story_version
          SET truth_finalization = @truth_finalization,
              truth_health_score = @truth_health_score,
              auditability_score = @auditability_score,
              readiness_status = @readiness_status,
              truth_finalized_at = SYSUTCDATETIME()
          WHERE story_version_id = @story_version_id;
        END
      `);

    await pool.request()
      .input('story_id', sql.Int, id)
      .input('story_version_id', sql.Int, Number(version.story_version_id))
      .input('author_id', sql.Int, aid)
      .input('truth_health_score', sql.Decimal(5, 2), health.truth_health_score)
      .input('auditability_score', sql.Decimal(5, 2), health.auditability_score)
      .input('evidence_coverage', sql.Decimal(5, 2), health.evidence_coverage)
      .input('timeline_coverage', sql.Decimal(5, 2), health.timeline_coverage)
      .input('hallucination_risk', sql.Decimal(5, 2), health.hallucination_risk)
      .input('readiness_status', sql.VarChar(30), health.readiness_status)
      .input('truth_finalization', sql.NVarChar(sql.MAX), stringify(finalization))
      .query(`
        IF OBJECT_ID('dbo.identity_story_truth_audit', 'U') IS NOT NULL
        BEGIN
          INSERT INTO dbo.identity_story_truth_audit (
            story_id,
            story_version_id,
            author_id,
            truth_health_score,
            auditability_score,
            evidence_coverage,
            timeline_coverage,
            hallucination_risk,
            readiness_status,
            truth_finalization
          )
          VALUES (
            @story_id,
            @story_version_id,
            @author_id,
            @truth_health_score,
            @auditability_score,
            @evidence_coverage,
            @timeline_coverage,
            @hallucination_risk,
            @readiness_status,
            @truth_finalization
          );
        END
      `);
  }

  return finalization;
}
