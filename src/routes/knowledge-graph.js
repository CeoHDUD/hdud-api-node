import express from 'express';
import { authRequired } from '../middleware/auth.js';
import { AuthorKnowledgeGraphService } from '../services/knowledge-graph/AuthorKnowledgeGraphService.js';

const router = express.Router();

function authorId(req, res) {
  const id = Number(req.user?.author_id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(401).json({ error: 'Não autenticado.' });
    return null;
  }
  return id;
}

router.post('/knowledge-graph/build', authRequired, async (req, res, next) => {
  try {
    const id = authorId(req, res);
    if (!id) return;
    const result = await new AuthorKnowledgeGraphService().buildForAuthor(id);
    return res.json({ experience: 'AUTHOR_KNOWLEDGE_GRAPH_BUILD', ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/knowledge-graph', authRequired, async (req, res, next) => {
  try {
    const id = authorId(req, res);
    if (!id) return;
    const latest = await new AuthorKnowledgeGraphService().latest(id);
    if (!latest) return res.status(404).json({ ok: false, error: 'KNOWLEDGE_GRAPH_NOT_FOUND' });
    return res.json({ ok: true, ...latest });
  } catch (err) {
    next(err);
  }
});

router.get('/knowledge-graph/query', authRequired, async (req, res, next) => {
  try {
    const id = authorId(req, res);
    if (!id) return;
    const result = await new AuthorKnowledgeGraphService().query(id, {
      text: req.query.q || req.query.text || '',
      type: req.query.type || null,
    });
    if (!result.ok) return res.status(404).json(result);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
