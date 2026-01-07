// src/routes/memory.js — HDUD API v0.6 (fixed)
// Contrato estável:
//   POST /memory
//   PUT  /memory/:id
//   GET  /memory/:id
//   GET  /memory/:id/versions
//
// FIX:
// - Respostas incluem meta.can_edit + meta.current_version (para liberar edição na WEB).
// - POST valida author_id do token (exceto admin/kernel).

import express from "express";
import { authenticate } from "../middleware/auth.js";
import { requireMemoryOwnership } from "../middleware/ownership.js";
import { getPool, sql } from "../db.js";
import { ROLES, userHasRole } from "../middleware/roles.js";

const router = express.Router();

function canEditFromReq(req, authorId) {
  const tokenAuthorId = req.user?.author_id ?? null;

  // token sem author_id -> assume true (ambiente dev / system)
  if (tokenAuthorId == null) return true;

  if (Number(tokenAuthorId) === Number(authorId)) return true;

  return userHasRole(req.user, ROLES.SYSTEM_KERNEL, ROLES.AUTHOR_ADMIN);
}

function assertAuthorAccess(req, res, authorId) {
  if (canEditFromReq(req, authorId)) return true;
  res.status(403).json({ error: "Permissão negada." });
  return false;
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

/**
 * POST /memory
 * Body: { author_id: number, title?: string|null, content: string, visibility?: string }
 */
router.post("/", authenticate, async (req, res) => {
  try {
    const { author_id, title = null, content, visibility = "PRIVATE" } = req.body || {};

    if (!author_id || Number.isNaN(parseInt(author_id, 10))) {
      return res.status(400).json({ error: "author_id é obrigatório e deve ser número." });
    }

    const authorId = parseInt(author_id, 10);

    if (!assertAuthorAccess(req, res, authorId)) return;

    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "content é obrigatório." });
    }

    const createdBy =
      req.user?.email ||
      req.user?.username ||
      req.user?.sub ||
      "hdud_api_v0.6";

    const pool = await getPool();

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("title", sql.NVarChar(200), title ? String(title) : null)
      .input("content", sql.NVarChar(sql.MAX), String(content))
      .input("visibility", sql.NVarChar(32), String(visibility || "PRIVATE"))
      .input("created_by", sql.NVarChar(200), String(createdBy))
      .execute("dbo.p_CreateMemory_WithVersion");

    const row = result?.recordset?.[0];
    if (!row) {
      return res.status(500).json({ error: "Falha ao criar memória." });
    }

    return res.status(201).json(attachMeta(row, req, authorId));
  } catch (err) {
    console.error("[POST /memory] erro:", err);
    return res.status(500).json({ error: "Erro ao criar memória." });
  }
});

/**
 * GET /memory/:id
 * Exige auth e ownership.
 */
router.get(
  "/:id",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (Number.isNaN(memoryId)) {
        return res.status(400).json({ error: "id inválido." });
      }

      const pool = await getPool();
      const result = await pool
        .request()
        .input("id", sql.Int, memoryId)
        .query(`
          SELECT *
          FROM dbo.identity_memory
          WHERE memory_id = @id;
        `);

      const row = result.recordset?.[0];
      if (!row || row.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      return res.json(attachMeta(row, req, row.author_id));
    } catch (err) {
      console.error("[GET /memory/:id] erro:", err);
      return res.status(500).json({ error: "Erro ao carregar memória." });
    }
  }
);

/**
 * PUT /memory/:id
 * Body: { title?: string|null, content?: string|null, visibility?: string|null }
 */
router.put(
  "/:id",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (Number.isNaN(memoryId)) {
        return res.status(400).json({ error: "id inválido." });
      }

      const { title = null, content = null, visibility = null } = req.body || {};

      const updatedBy =
        req.user?.email ||
        req.user?.username ||
        req.user?.sub ||
        "hdud_api_v0.6";

      const pool = await getPool();

      const result = await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .input("title", sql.NVarChar(200), title === null ? null : String(title))
        .input("content", sql.NVarChar(sql.MAX), content === null ? null : String(content))
        .input("visibility", sql.NVarChar(32), visibility === null ? null : String(visibility))
        .input("updated_by", sql.NVarChar(200), String(updatedBy))
        .execute("dbo.p_UpdateMemory_WithVersion");

      const row = result?.recordset?.[0];
      if (!row) {
        return res.status(500).json({ error: "Falha ao atualizar memória." });
      }

      return res.json(attachMeta(row, req, row.author_id ?? req.user?.author_id));
    } catch (err) {
      console.error("[PUT /memory/:id] erro:", err);
      return res.status(500).json({ error: "Erro ao atualizar memória." });
    }
  }
);

/**
 * GET /memory/:id/versions
 */
router.get(
  "/:id/versions",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (Number.isNaN(memoryId)) {
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
      console.error("[GET /memory/:id/versions] erro:", err);
      return res.status(500).json({ error: "Erro ao carregar versões." });
    }
  }
);

export default router;
