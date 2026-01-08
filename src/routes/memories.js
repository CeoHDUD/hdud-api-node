// src/routes/memories.js — HDUD API v0.6 (stable)
// - GET  /authors/:authorId/memories
// - POST /authors/:authorId/memories        -> dbo.p_CreateMemory_WithVersion (5 params)
// - GET  /memories/:id
// - GET  /memories/:id/versions
// - PUT  /memories/:id                      -> dbo.p_UpdateMemory_WithVersion (6 params)

import express from "express";
import { authenticate } from "../middleware/auth.js";
import { requireMemoryOwnership } from "../middleware/ownership.js";
import { getPool, sql } from "../db.js";
import { ROLES, userHasRole } from "../middleware/roles.js";

const router = express.Router();

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function canEditFromReq(req, authorId) {
  const tokenAuthorId = req.user?.author_id ?? null;

  // token sem author_id -> libera (dev / system)
  if (tokenAuthorId == null) return true;

  if (Number(tokenAuthorId) === Number(authorId)) return true;

  return userHasRole(req.user, ROLES.SYSTEM_KERNEL, ROLES.AUTHOR_ADMIN);
}

function attachMeta(row, req, authorId) {
  const currentVersion =
    row?.version_number ??
    row?.current_version ??
    row?.version ??
    row?.versionNumber ??
    null;

  return {
    ...row,
    meta: {
      can_edit: canEditFromReq(req, authorId),
      current_version: currentVersion,
    },
  };
}

function getUserId(req) {
  const raw = req.user?.user_id ?? req.user?.id ?? req.user?.sub;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : null;
}

function getUserCode(req) {
  return (req.user?.email ??
    req.user?.username ??
    (typeof req.user?.sub === "string" ? req.user.sub : null) ??
    "hdud_api")
    .toString()
    .slice(0, 100);
}

/**
 * IMPORTANTÍSSIMO:
 * - session_context tem que ser em request separado
 * - nunca reutilizar o mesmo request que vai executar a proc
 */
async function trySetSessionContext(pool, userCode) {
  try {
    const ctx = pool.request(); // request LIMPO
    await ctx.query`
      EXEC sys.sp_set_session_context
        @key=N'hdud_user',
        @value=${userCode};
    `;
  } catch {
    // silencioso
  }
}

// -----------------------------------------------------------------------------
// GET /authors/:authorId/memories
// -----------------------------------------------------------------------------
router.get("/authors/:authorId/memories", authenticate, async (req, res) => {
  try {
    const authorId = Number(req.params.authorId);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(400).json({ error: "authorId inválido." });
    }

    if (!canEditFromReq(req, authorId)) {
      return res.status(403).json({ error: "Permissão negada." });
    }

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

    const rows = (result.recordset || []).map((r) => attachMeta(r, req, authorId));
    return res.json({ author_id: authorId, memories: rows });
  } catch (err) {
    console.error("[GET /authors/:authorId/memories] erro:", err);
    return res.status(500).json({ error: "Erro ao listar memórias." });
  }
});

// -----------------------------------------------------------------------------
// POST /authors/:authorId/memories  (proc com 5 params)
// -----------------------------------------------------------------------------
router.post("/authors/:authorId/memories", authenticate, async (req, res) => {
  try {
    const authorId = Number(req.params.authorId);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(400).json({ error: "authorId inválido." });
    }

    if (!canEditFromReq(req, authorId)) {
      return res.status(403).json({ error: "Permissão negada." });
    }

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
    if (!userId) {
      return res.status(401).json({ error: "userId não encontrado no token." });
    }

    const userCode = getUserCode(req);

    const pool = await getPool();
    await trySetSessionContext(pool, userCode);

    const request = pool.request(); // request LIMPO para a proc
    request.input("AuthorId", sql.Int, authorId);
    request.input("Title", sql.NVarChar(500), title);
    request.input("Content", sql.NVarChar(sql.MAX), content);
    request.input("UserId", sql.Int, userId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    const result = await request.execute("dbo.p_CreateMemory_WithVersion");
    const row = result?.recordset?.[0];

    if (!row) return res.status(500).json({ error: "Falha ao criar memória." });
    return res.status(201).json(attachMeta(row, req, authorId));
  } catch (err) {
    console.error("[POST /authors/:authorId/memories] erro:", err);
    return res.status(500).json({
      error: "Erro ao criar memória.",
      detail: err?.originalError?.info?.message || err?.message,
    });
  }
});

// -----------------------------------------------------------------------------
// GET /memories/:id
// -----------------------------------------------------------------------------
router.get(
  "/memories/:id",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = Number(req.params.id);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
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

      return res.json(attachMeta(row, req, row.author_id));
    } catch (err) {
      console.error("[GET /memories/:id] erro:", err);
      return res.status(500).json({ error: "Erro ao carregar memória." });
    }
  }
);

// -----------------------------------------------------------------------------
// GET /memories/:id/versions
// -----------------------------------------------------------------------------
router.get(
  "/memories/:id/versions",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = Number(req.params.id);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "id inválido." });
      }

      const pool = await getPool();
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

      return res.json({ memory_id: memoryId, versions: result.recordset || [] });
    } catch (err) {
      console.error("[GET /memories/:id/versions] erro:", err);
      return res.status(500).json({ error: "Erro ao carregar versões." });
    }
  }
);

// -----------------------------------------------------------------------------
// PUT /memories/:id  (proc com 6 params)
// -----------------------------------------------------------------------------
router.put("/memories/:id", authenticate, async (req, res) => {
  try {
    const memoryId = Number(req.params.id);
    if (!Number.isInteger(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "id inválido." });
    }

    const newContent =
      typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!newContent) {
      return res.status(400).json({ error: "content é obrigatório." });
    }

    const newTitle =
      typeof req.body?.title === "string"
        ? req.body.title.trim().slice(0, 255)
        : null;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "userId não encontrado no token." });
    }

    const userCode = getUserCode(req);

    const pool = await getPool();

    // pega author_id para checar permissão + enviar para proc
    const mem = await pool
      .request()
      .input("id", sql.Int, memoryId)
      .query(
        `SELECT memory_id, author_id, is_deleted FROM dbo.identity_memory WHERE memory_id=@id;`
      );

    const row = mem.recordset?.[0];
    if (!row || row.is_deleted) {
      return res.status(404).json({ error: "Memória não encontrada." });
    }

    const authorId = Number(row.author_id);
    if (!canEditFromReq(req, authorId)) {
      return res.status(403).json({ error: "Permissão negada." });
    }

    // session_context em request separado
    await trySetSessionContext(pool, userCode);

    // request LIMPO para a proc (evita “argumento extra”)
    const request = pool.request();
    request.input("MemoryId", sql.Int, memoryId);
    request.input("NewTitle", sql.NVarChar(255), newTitle);
    request.input("NewContent", sql.NVarChar(sql.MAX), newContent);
    request.input("UserId", sql.Int, userId);
    request.input("AuthorId", sql.Int, authorId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    const result = await request.execute("dbo.p_UpdateMemory_WithVersion");
    const updated = result?.recordset?.[0];

    return res.json(updated || { ok: true, memory_id: memoryId });
  } catch (err) {
    console.error("[PUT /memories/:id] erro:", err);
    return res.status(500).json({
      error: "Falha ao atualizar memória",
      detail: err?.originalError?.info?.message || err?.message,
    });
  }
});

export default router;
