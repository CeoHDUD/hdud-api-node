// C:\HDUD_DATA\hdud-api-node\src\routes\story-truth-finalization.js

import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { buildStoryTruthFinalization } from '../services/stories/story-truth-finalization.service.js';

const router = express.Router();

function getAuthorId(req) {
  const authorId = Number(req.user?.author_id);
  return Number.isInteger(authorId) && authorId > 0 ? authorId : null;
}

router.get('/stories/:id/truth-finalization', authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: 'Não autenticado.' });

    const payload = await buildStoryTruthFinalization({
      storyId: Number(req.params.id),
      authorId,
      persist: false,
    });

    return res.json(payload);
  } catch (err) {
    return res.status(err?.status || 500).json({
      error: err?.message || 'Falha ao carregar finalização de verdade da Story.',
    });
  }
});

router.post('/stories/:id/truth-finalization/rebuild', authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: 'Não autenticado.' });

    const payload = await buildStoryTruthFinalization({
      storyId: Number(req.params.id),
      authorId,
      persist: true,
    });

    return res.json({ ok: true, ...payload });
  } catch (err) {
    return res.status(err?.status || 500).json({
      error: err?.message || 'Falha ao reconstruir finalização de verdade da Story.',
    });
  }
});

export default router;
