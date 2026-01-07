// src/routes/memories.js — HDUD API v0.6 (FIX: no extra params leaking into execute)
// - GET  /authors/:authorId/memories
// - POST /authors/:authorId/memories        -> calls dbo.p_CreateMemory_WithVersion (5 params)
// - GET  /memories/:id
// - GET  /memories/:id/versions

import express from "express";
import { authRequired } from "../middleware/auth.js";
import { getPool, sql } from "../db.js";

const router = express.Router();

/**
 * Token helpers
 * Esperado (dev):
 * - req.user.author_id (opcional)
 * - req.user.user_id|id|sub (obrigatório para criar)
 * - req.user.email|username|sub (para userCode)
 */
function getUserId(req) {
  const v = Number(req.user?.user_id ?? req.user?.id ?? req.user?.sub);
  return Number.isFinite(v) ? v : null;
}

function getUserCode(req) {
  return (req.user?.email ?? req.user?.username ?? req.user?.sub ?? "hdud_api")
    .toString()
    .slice(0, 100);
}

/**
 * Controle simples:
 * - Se token NÃO tem author_id => libera (dev/system)
 * - Se tem author_id => só permite acessar o próprio author_id
 */
function canAccessAuthor(req, authorId) {
  const tokenAuthorId = req.user?.author_id ?? null;
  if (tokenAuthorId == null) return true;
  return Number(tokenAuthorId) === Number(authorId);
}

function deny(res) {
  return res.status(403).json({ error: "Permissão negada." });
}

/**
 * Session context: IMPORTANTÍSSIMO
 * - NÃO reutilizar o mesmo request que vai executar a procedure
 * - senão o param @hdud_user “vaza” e vira argumento extra (SQL 8144)
 */
async function trySetSessionContext(pool, userCode) {
  try {
    const ctx = pool.request();
    await ctx.query`
      EXEC sys.sp_set_session_context
        @key=N'hdud_user',
        @value=${userCode};
    `;
  } catch {
    // silencioso (não pode quebrar a request)
  }
}

/**
 * GET /authors/:authorId/memories
 */
router.get("/authors/:authorId/memories", authRequired, async (req, res) => {
  try {
    const authorId = Number(req.params.authorId);
    if (!authorId || authorId <= 0) {
      return res.status(400).json({ error: "authorId inválido." });
    }

    if (!canAccessAuthor(req, authorId)) return deny(res);

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          memory_id,
          author_id,
          title,
          content,
          created_at,
          version_number,
          is_deleted
        FROM dbo.identity_memory
        WHERE author_id = @author_id
        ORDER BY created_at DESC, memory_id DESC;
      `);

    return res.json({
      author_id: authorId,
      memories: result.recordset || [],
    });
  } catch (err) {
    console.error("[GET /authors/:authorId/memories]", err);
    return res.status(500).json({ error: "Erro ao listar memórias." });
  }
});

/**
 * POST /authors/:authorId/memories
 * Body: { title?: string|null, content: string }
 */
router.post("/authors/:authorId/memories", authRequired, async (req, res) => {
  try {
    const authorId = Number(req.params.authorId);
    if (!authorId || authorId <= 0) {
      return res.status(400).json({ error: "authorId inválido." });
    }

    if (!canAccessAuthor(req, authorId)) return deny(res);

    const title =
      typeof req.body?.title === "string"
        ? req.body.title.trim().slice(0, 500)
        : null;

    const content =
      typeof req.body?.content === "string" ? req.body.content.trim() : "";

    if (!content) {
      return res.status(400).json({ error: "content é obrigatório." });
    }

    const userId = getUserId(req);
    if (!userId || userId <= 0) {
      return res.status(401).json({ error: "userId não encontrado no token" });
    }

    const userCode = getUserCode(req);

    const pool = await getPool();

    // session_context em request separado (não “vaza” parâmetros)
    await trySetSessionContext(pool, userCode);

    // EXECUTE em request novo e limpo
    const request = pool.request();

    // Inputs EXATOS da dbo.p_CreateMemory_WithVersion
    request.input("AuthorId", sql.Int, authorId);
    request.input("Title", sql.NVarChar(500), title);
    request.input("Content", sql.NVarChar(sql.MAX), content);
    request.input("UserId", sql.Int, userId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    const result = await request.execute("dbo.p_CreateMemory_WithVersion");
    const row = result?.recordset?.[0];

    if (!row) {
      return res.status(500).json({ error: "Falha ao criar memória." });
    }

    return res.status(201).json(row);
  } catch (err) {
    console.error("[POST /authors/:authorId/memories]", err);
    return res.status(500).json({
      error: "Falha ao criar memória",
      detail: err?.originalError?.info?.message || err?.message || "Erro interno",
    });
  }
});

/**
 * GET /memories/:id
 */
router.get("/memories/:id", authRequired, async (req, res) => {
  try {
    const memoryId = Number(req.params.id);
    if (!memoryId || memoryId <= 0) {
      return res.status(400).json({ error: "id inválido." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.Int, memoryId)
      .query(`
        SELECT
          memory_id,
          author_id,
          title,
          content,
          created_at,
          version_number,
          is_deleted
        FROM dbo.identity_memory
        WHERE memory_id = @id;
      `);

    const row = result.recordset?.[0];
    if (!row || row.is_deleted) {
      return res.status(404).json({ error: "Memória não encontrada." });
    }

    if (!canAccessAuthor(req, row.author_id)) return deny(res);

    return res.json(row);
  } catch (err) {
    console.error("[GET /memories/:id]", err);
    return res.status(500).json({ error: "Erro ao carregar memória." });
  }
});

/**
 * GET /memories/:id/versions
 */
router.get("/memories/:id/versions", authRequired, async (req, res) => {
  try {
    const memoryId = Number(req.params.id);
    if (!memoryId || memoryId <= 0) {
      return res.status(400).json({ error: "id inválido." });
    }

    const pool = await getPool();

    const mem = await pool
      .request()
      .input("id", sql.Int, memoryId)
      .query(`SELECT memory_id, author_id, is_deleted FROM dbo.identity_memory WHERE memory_id=@id;`);

    const mrow = mem.recordset?.[0];
    if (!mrow || mrow.is_deleted) {
      return res.status(404).json({ error: "Memória não encontrada." });
    }

    if (!canAccessAuthor(req, mrow.author_id)) return deny(res);

    const result = await pool
      .request()
      .input("memory_id", sql.Int, memoryId)
      .query(`
        SELECT
          memory_id,
          version_number,
          title,
          content,
          created_at,
          created_by
        FROM dbo.identity_memory_versions
        WHERE memory_id = @memory_id
        ORDER BY version_number DESC;
      `);

    return res.json({
      memory_id: memoryId,
      versions: result.recordset || [],
    });
  } catch (err) {
    console.error("[GET /memories/:id/versions]", err);
    return res.status(500).json({ error: "Erro ao carregar versões." });
  }
});

export default router;
