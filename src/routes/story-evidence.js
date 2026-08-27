// C:\HDUD_DATA\hdud-api-node\src\routes\story-evidence.js

import express from 'express';
import sql from 'mssql';
import { getPool } from '../db.js';
import auth from '../middleware/auth.js';
import { buildStoryEvidenceMap } from '../services/story/story-evidence-map.service.js';
import { getLatestStoryEvidenceMap, saveStoryEvidenceMap } from '../services/story/story-evidence-repository.sql.service.js';

const router = express.Router();

function getAuthorId(req) {
  return req.user?.author_id || req.user?.authorId || req.author?.author_id || req.authorId || null;
}

async function loadStoryMemories(storyId, authorId) {
  const pool = await getPool();
  const request = pool.request();
  request.input('story_id', sql.BigInt, storyId);
  request.input('author_id', sql.BigInt, authorId);

  const result = await request.query(`
    SELECT
      m.memory_id,
      m.title,
      m.content,
      m.created_at,
      sm.evidence_weight,
      sm.evidence_reason
    FROM dbo.identity_narrative_story_memory sm
    INNER JOIN dbo.identity_memory m
      ON m.memory_id = sm.memory_id
    WHERE sm.story_id = @story_id
      AND sm.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0
    ORDER BY sm.evidence_weight DESC, m.created_at ASC;
  `);

  return result.recordset || [];
}

router.get('/stories/:storyId/evidence', auth, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    const storyId = Number(req.params.storyId);
    if (!authorId) return res.status(401).json({ ok: false, error: 'AUTHOR_NOT_FOUND' });
    if (!Number.isFinite(storyId)) return res.status(400).json({ ok: false, error: 'INVALID_STORY_ID' });

    const evidence = await getLatestStoryEvidenceMap({ storyId, authorId });
    if (!evidence) return res.status(404).json({ ok: false, error: 'EVIDENCE_MAP_NOT_FOUND' });

    return res.json({ ok: true, evidence });
  } catch (error) {
    console.error('[story-evidence] GET failed', error);
    return res.status(500).json({ ok: false, error: 'STORY_EVIDENCE_GET_FAILED' });
  }
});

router.post('/stories/:storyId/evidence/build', auth, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    const storyId = Number(req.params.storyId);
    const manuscript = String(req.body?.manuscript || req.body?.refined_content || req.body?.content || '').trim();

    if (!authorId) return res.status(401).json({ ok: false, error: 'AUTHOR_NOT_FOUND' });
    if (!Number.isFinite(storyId)) return res.status(400).json({ ok: false, error: 'INVALID_STORY_ID' });
    if (!manuscript) return res.status(400).json({ ok: false, error: 'MANUSCRIPT_REQUIRED' });

    const memories = Array.isArray(req.body?.memories) && req.body.memories.length
      ? req.body.memories
      : await loadStoryMemories(storyId, authorId);

    const evidence = buildStoryEvidenceMap({
      storyId,
      manuscript,
      memories,
      generationContext: {
        stage: 'story_generation',
        truth_prompt_version: req.body?.truth_prompt_version || null,
        truth_memory_selection_id: req.body?.truth_memory_selection_id || null,
      },
    });

    if (!evidence.ok) {
      return res.status(422).json({
        ok: false,
        error: 'UNSUPPORTED_PARAGRAPHS_FOUND',
        evidence,
      });
    }

    const saved = await saveStoryEvidenceMap({
      storyId,
      authorId,
      manuscript,
      evidenceMap: evidence.evidence_map,
      evidenceQuality: evidence.evidence_quality,
      lineage: evidence.lineage,
      paragraphScores: evidence.paragraph_scores,
    });

    return res.json({ ok: true, saved, evidence });
  } catch (error) {
    console.error('[story-evidence] build failed', error);
    return res.status(500).json({ ok: false, error: 'STORY_EVIDENCE_BUILD_FAILED' });
  }
});

export default router;
