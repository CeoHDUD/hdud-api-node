import express from 'express';
import { authRequired } from '../middleware/auth.js';
import { StoryTruthOrchestrator } from '../services/story-truth/index.js';

const router = express.Router();

router.post('/stories/:storyId/generate-truth', authRequired, async (req, res, next) => {
  try {
    const authorId = Number(req.user?.author_id);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }

    const storyId = Number(req.params.storyId);
    if (!Number.isInteger(storyId) || storyId <= 0) {
      return res.status(400).json({ error: 'storyId inválido.' });
    }

    const orchestrator = new StoryTruthOrchestrator({
      generateWithAI: req.app.locals.generateStoryWithOpenAI || null,
    });

    const result = await orchestrator.generateStory({
      storyId,
      authorId,
      language: req.body?.language || 'pt-BR',
      requestId: req.headers['x-request-id'] || null,
    });

    return res.json({
      ok: true,
      experience: 'STORY_TRUTH_ORCHESTRATOR',
      ...result,
      meta: {
        generated_at: new Date().toISOString(),
        source_policy: 'História gerada exclusivamente pelo Story Truth Orchestrator.',
        truth_policy: 'Story Discovery → Truth Memory Selection → Story Truth Engine. Memórias DROP não são autorizadas para geração.',
        package: 'GO_LIVE_004_5_TRUTH_PROMPT',
        truth_prompt: 'Inferências, causalidade, intenções, emoções, personagens, datas e lugares sem evidência estão proibidos.',
      },
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ ok: false, error: err.message });
    }

    next(err);
  }
});

export default router;
