import { getPool, sql } from '../db.js';

export function requireMemoryOwnership({ paramName = 'id' } = {}) {
  return async (req, res, next) => {
    const memoryId = Number(req.params[paramName]);
    const authorId = Number(req.user?.author_id);

    if (!memoryId || !authorId) {
      return res.status(401).json({ error: 'Contexto inválido.' });
    }

    const pool = await getPool();
    const r = await pool.request()
      .input('memory_id', sql.Int, memoryId)
      .query(`
        SELECT author_id, is_deleted
        FROM dbo.identity_memory
        WHERE memory_id = @memory_id
      `);

    const row = r.recordset[0];
    if (!row || row.is_deleted) {
      return res.status(404).json({ error: 'Memória não encontrada.' });
    }

    if (row.author_id !== authorId) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    next();
  };
}
