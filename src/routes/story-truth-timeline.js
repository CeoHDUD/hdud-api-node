// C:\HDUD_DATA\hdud-api-node\src\routes\story-truth-timeline.js

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getStoryTruthTimeline } from '../services/stories/story-truth-timeline.service.js';

const router = express.Router();

function resolveAuthorId(req) {
  return req.user?.author_id || req.user?.authorId || req.author?.author_id || req.authorId;
}

router.get('/stories/:id/timeline', requireAuth, async (req, res) => {
  try {
    const authorId = resolveAuthorId(req);
    const storyId = Number(req.params.id);
    const rebuild = String(req.query.rebuild || '').toLowerCase() === 'true';

    if (!storyId) {
      return res.status(400).json({ ok: false, error: 'story_id inválido.' });
    }

    if (!authorId) {
      return res.status(401).json({ ok: false, error: 'Autor não identificado.' });
    }

    const timeline = await getStoryTruthTimeline({ storyId, authorId, rebuild });
    return res.json({ ok: true, ...timeline });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: error.message || 'Erro ao carregar Story Truth Timeline.'
    });
  }
});

export default router;
