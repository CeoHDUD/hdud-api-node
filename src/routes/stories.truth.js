import express from 'express';
import { getPool, sql } from '../db.js';
import auth from '../middleware/auth.js';
import {
  buildStoryTruthUseCase,
  validateStoryUseCase,
  AuthorSovereigntyPolicy,
} from '../domain/truth/index.js';

const router = express.Router();

async function loadStoryMemories(pool, authorId, storyId) {
  const result = await pool.request()
    .input('author_id', sql.Int, authorId)
    .input('story_id', sql.Int, storyId)
    .query(`
      SELECT
        m.memory_id,
        m.title,
        m.content,
        m.created_at,
        m.published_at,
        m.phase_id
      FROM identity_memory m
      INNER JOIN identity_story_memory sm
        ON sm.memory_id = m.memory_id
      WHERE sm.story_id = @story_id
        AND m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY m.created_at ASC
    `);

  return result.recordset;
}

async function loadStoryCandidate(pool, authorId, storyId) {
  const result = await pool.request()
    .input('author_id', sql.Int, authorId)
    .input('story_id', sql.Int, storyId)
    .query(`
      SELECT TOP 1
        s.story_id,
        s.title,
        s.summary,
        s.status,
        s.created_at
      FROM identity_story s
      WHERE s.story_id = @story_id
        AND s.author_id = @author_id
    `);

  return result.recordset[0] || null;
}

async function persistTruthReport(pool, authorId, storyId, report) {
  const payload = JSON.stringify(report);

  await pool.request()
    .input('story_id', sql.Int, storyId)
    .input('author_id', sql.Int, authorId)
    .input('truth_score', sql.Int, report.truth_score)
    .input('evidence_quality', sql.VarChar(20), report.evidence_quality)
    .input('hallucination_risk', sql.VarChar(20), report.hallucination_risk)
    .input('payload_json', sql.NVarChar(sql.MAX), payload)
    .query(`
      INSERT INTO identity_story_truth
      (
        story_id,
        author_id,
        truth_score,
        evidence_quality,
        hallucination_risk,
        payload_json,
        created_at
      )
      VALUES
      (
        @story_id,
        @author_id,
        @truth_score,
        @evidence_quality,
        @hallucination_risk,
        @payload_json,
        SYSUTCDATETIME()
      )
    `);
}

router.get('/stories/:storyId/truth', auth, async (req, res, next) => {
  try {
    const pool = await getPool();
    const authorId = req.user.author_id;
    const storyId = Number(req.params.storyId);

    const result = await pool.request()
      .input('story_id', sql.Int, storyId)
      .input('author_id', sql.Int, authorId)
      .query(`
        SELECT TOP 1
          story_truth_id,
          truth_score,
          evidence_quality,
          hallucination_risk,
          payload_json,
          created_at
        FROM identity_story_truth
        WHERE story_id = @story_id
          AND author_id = @author_id
        ORDER BY story_truth_id DESC
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ error: 'TRUTH_REPORT_NOT_FOUND' });
    }

    const row = result.recordset[0];
    return res.json({
      story_truth_id: row.story_truth_id,
      truth_score: row.truth_score,
      evidence_quality: row.evidence_quality,
      hallucination_risk: row.hallucination_risk,
      created_at: row.created_at,
      report: JSON.parse(row.payload_json || '{}'),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/stories/:storyId/evidence', auth, async (req, res, next) => {
  try {
    const pool = await getPool();
    const authorId = req.user.author_id;
    const storyId = Number(req.params.storyId);

    const result = await pool.request()
      .input('story_id', sql.Int, storyId)
      .input('author_id', sql.Int, authorId)
      .query(`
        SELECT TOP 1 payload_json
        FROM identity_story_truth
        WHERE story_id = @story_id
          AND author_id = @author_id
        ORDER BY story_truth_id DESC
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ error: 'EVIDENCE_MAP_NOT_FOUND' });
    }

    const report = JSON.parse(result.recordset[0].payload_json || '{}');
    return res.json(report.evidence_map || { paragraphs: [] });
  } catch (err) {
    next(err);
  }
});

router.get('/stories/:storyId/lineage', auth, async (req, res, next) => {
  try {
    const pool = await getPool();
    const authorId = req.user.author_id;
    const storyId = Number(req.params.storyId);

    const result = await pool.request()
      .input('story_id', sql.Int, storyId)
      .input('author_id', sql.Int, authorId)
      .query(`
        SELECT
          story_lineage_id,
          story_id,
          version_id,
          previous_version_id,
          lineage_json,
          created_at
        FROM identity_story_lineage
        WHERE story_id = @story_id
          AND author_id = @author_id
        ORDER BY story_lineage_id DESC
      `);

    return res.json({
      story_id: storyId,
      lineage: result.recordset.map((row) => ({
        ...row,
        lineage: JSON.parse(row.lineage_json || '{}'),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/stories/:storyId/validate', auth, async (req, res, next) => {
  try {
    const pool = await getPool();
    const authorId = req.user.author_id;
    const storyId = Number(req.params.storyId);

    const memories = await loadStoryMemories(pool, authorId, storyId);
    const validation = validateStoryUseCase({
      storyId,
      aiResponse: req.body.ai_response || req.body.story || {},
      memories,
    });

    const policy = AuthorSovereigntyPolicy.validateTruthReport({
      truth_score: validation.validation.truth_score,
      hallucination_risk: validation.validation.hallucination_risk,
      evidence_map: validation.evidence_map,
    });

    return res.json({ ...validation, author_sovereignty: policy });
  } catch (err) {
    next(err);
  }
});

router.post('/stories/:storyId/truth/build', auth, async (req, res, next) => {
  try {
    const pool = await getPool();
    const authorId = req.user.author_id;
    const storyId = Number(req.params.storyId);

    const candidate = await loadStoryCandidate(pool, authorId, storyId);
    if (!candidate) return res.status(404).json({ error: 'STORY_NOT_FOUND' });

    const memories = await loadStoryMemories(pool, authorId, storyId);

    const report = await buildStoryTruthUseCase({
      candidate,
      memories,
      previousVersions: req.body.previous_versions || [],
      generateWithAI: req.app.locals.generateStoryWithOpenAI || null,
      language: req.body.language || 'pt-BR',
    });

    await persistTruthReport(pool, authorId, storyId, report);

    return res.json(report);
  } catch (err) {
    next(err);
  }
});

export default router;
