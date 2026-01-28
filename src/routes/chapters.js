// C:\HDUD_DATA\hdud-api-node\src\routes\chapters.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";

const router = express.Router();

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function ensureAuthorId(req, res) {
  const authorId = req?.user?.author_id;
  if (!authorId) {
    res.status(401).json({ error: "Não autenticado." });
    return null;
  }
  return Number(authorId);
}

function normalizeChapterRow(r) {
  if (!r) return null;
  return {
    chapter_id: r.chapter_id,
    author_id: r.author_id,
    title: r.title,
    description: r.description,
    status: r.status,
    current_version_id: r.current_version_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published_at: r.published_at,
  };
}

function normalizeChapterVersionRow(r) {
  if (!r) return null;
  return {
    chapter_version_id: r.chapter_version_id,
    chapter_id: r.chapter_id,
    author_id: r.author_id,
    title_snapshot: r.title_snapshot,
    body: r.body,
    created_at: r.created_at,
  };
}

/**
 * GET /chapters
 * Lista capítulos do autor autenticado
 */
router.get("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .execute("dbo.p_Chapter_List_ByAuthor");

    const rows = result?.recordset || [];
    return res.json({ items: rows.map(normalizeChapterRow) });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /chapters
 * Cria capítulo + versão inicial
 * body: { title, description?, body?, status? }
 *
 * OBS: author_id vem SEMPRE do token (req.user.author_id).
 * Ignoramos qualquer author_id enviado no body.
 */
router.post("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const title = String(req.body?.title ?? "").trim();
    const description =
      req.body?.description != null ? String(req.body.description).trim() : null;
    const body = req.body?.body != null ? String(req.body.body) : "";
    const status = req.body?.status != null ? String(req.body.status).toUpperCase() : "DRAFT";

    if (!title) {
      return res.status(400).json({ error: "title é obrigatório." });
    }

    const safeStatus = ["DRAFT", "PUBLIC", "SHARED"].includes(status) ? status : "DRAFT";

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("title", sql.NVarChar(200), title)
      .input("description", sql.NVarChar(400), description)
      .input("body", sql.NVarChar(sql.MAX), body)
      .input("status", sql.VarChar(20), safeStatus)
      .output("chapter_id", sql.Int)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Create_WithVersion");

    const out = result?.output || {};
    const firstRow = result?.recordset?.[0] || null;

    return res.status(201).json({
      chapter_id: out.chapter_id ?? firstRow?.chapter_id ?? null,
      chapter_version_id: out.chapter_version_id ?? firstRow?.chapter_version_id ?? null,
      status: safeStatus,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /chapters/:id
 * Retorna capítulo + versão atual (2 recordsets)
 */
router.get("/:id", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Get_ById");

    const recordsets = result?.recordsets || [];
    const chapterRows = recordsets[0] || [];
    const versionRows = recordsets[1] || [];

    if (!chapterRows.length) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    return res.json({
      chapter: normalizeChapterRow(chapterRows[0]),
      current_version: versionRows.length ? normalizeChapterVersionRow(versionRows[0]) : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /chapters/:id
 * Atualiza (gera nova versão e atualiza current_version_id)
 * body: { title, description?, body }
 */
router.put("/:id", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const title = String(req.body?.title ?? "").trim();
    const description =
      req.body?.description != null ? String(req.body.description).trim() : null;
    const body = req.body?.body != null ? String(req.body.body) : null;

    if (!title) return res.status(400).json({ error: "title é obrigatório." });
    if (body === null) return res.status(400).json({ error: "body é obrigatório." });

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("title", sql.NVarChar(200), title)
      .input("description", sql.NVarChar(400), description)
      .input("body", sql.NVarChar(sql.MAX), body)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Update_WithVersion");

    const out = result?.output || {};
    const firstRow = result?.recordset?.[0] || null;

    return res.json({
      chapter_id: chapterId,
      chapter_version_id: out.chapter_version_id ?? firstRow?.chapter_version_id ?? null,
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

/**
 * POST /chapters/:id/publish
 */
router.post("/:id/publish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Publish");

    const row = result?.recordset?.[0] || null;
    return res.json({ chapter_id: chapterId, status: row?.status || "PUBLIC" });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

/**
 * POST /chapters/:id/unpublish
 */
router.post("/:id/unpublish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Unpublish");

    const row = result?.recordset?.[0] || null;
    return res.json({ chapter_id: chapterId, status: row?.status || "DRAFT" });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

export default router;
