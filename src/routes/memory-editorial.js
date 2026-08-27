// C:\HDUD_DATA\hdud-api-node\src\routes\memory-editorial.js

import express from "express";
import { authenticate } from "../middleware/auth.js";
import { getPool, sql } from "../db.js";
import {
  getEditorial,
  updateEditorial,
  regenerateEditorial,
  listEditorialHistory,
  getAffinity,
  recalculateAffinity,
  resolveNarrativeContextForMemory,
} from "../services/memory-editorial-intelligence.service.js";

const router = express.Router();

function parseMemoryId(req) {
  const raw = req.params?.memoryId ?? req.params?.id;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function pickFirstPositiveInt(obj, keys) {
  for (const key of keys) {
    const raw = obj?.[key];
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function pickFirstString(obj, keys) {
  for (const key of keys) {
    const raw = obj?.[key];
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (s) return s;
  }
  return null;
}

async function resolveAuthorId(req) {
  const direct = pickFirstPositiveInt(req.user, [
    "author_id",
    "authorId",
    "author",
    "aid",
  ]);

  if (direct) return direct;

  const userId = pickFirstPositiveInt(req.user, [
    "user_id",
    "userId",
    "id",
    "uid",
    "sub",
  ]);

  const email = pickFirstString(req.user, [
    "email",
    "mail",
    "upn",
    "preferred_username",
  ]);

  if (!userId && !email) return null;

  const pool = await getPool();
  const request = pool.request();

  request.input("user_id", sql.BigInt, userId || null);
  request.input("email", sql.NVarChar(510), email || null);

  const result = await request.query(`
    SELECT TOP 1
      u.author_id
    FROM dbo.identity_user u
    WHERE
      (@user_id IS NOT NULL AND u.user_id = @user_id)
      OR
      (@email IS NOT NULL AND u.email = @email)
    ORDER BY u.user_id DESC;
  `);

  const authorId = Number(result.recordset?.[0]?.author_id);
  return Number.isInteger(authorId) && authorId > 0 ? authorId : null;
}

function getActor(req) {
  return (
    req.user?.author_code ||
    req.user?.email ||
    req.user?.username ||
    req.user?.sub ||
    req.user?.id ||
    "hdud_author"
  );
}

function sendError(res, err) {
  const status = Number(err?.status || err?.statusCode || 500);

  return res.status(status >= 400 && status <= 599 ? status : 500).json({
    ok: false,
    error: status >= 500 ? "Internal Server Error" : "Bad Request",
    detail: err?.message || "Erro inesperado.",
  });
}


async function handleTaxonomy(req, res) {
  try {
    const localeRaw = String(req.query?.locale || req.query?.language || "pt-BR").trim();
    const locale = localeRaw || "pt-BR";
    const domainRaw = req.query?.domain == null ? null : String(req.query.domain).trim().toUpperCase();
    const domain = domainRaw || null;

    const pool = await getPool();
    const result = await pool.request()
      .input("locale", sql.VarChar(20), locale)
      .input("domain", sql.VarChar(60), domain)
      .execute("dbo.p_MeiTaxonomy_List");

    const rows = result.recordset || [];
    const byDomain = rows.reduce((acc, row) => {
      const key = String(row.domain || "").trim();
      if (!key) return acc;
      if (!acc[key]) acc[key] = [];
      acc[key].push({
        code: row.code,
        label: row.label || row.code,
        description: row.description || null,
        locale: row.locale || locale,
        sort_order: Number(row.sort_order || 0),
      });
      return acc;
    }, {});

    return res.json({
      ok: true,
      locale,
      items: rows,
      domains: byDomain,
      life_periods: byDomain.LIFE_PERIOD || [],
      editorial_contexts: byDomain.EDITORIAL_CONTEXT || [],
      narrative_roles: byDomain.NARRATIVE_ROLE || [],
      editorial_certainty: byDomain.CERTAINTY || [],
    });
  } catch (err) {
    return sendError(res, err);
  }
}

async function handleGetEditorial(req, res) {
  try {
    const memoryId = parseMemoryId(req);
    if (!memoryId) return res.status(400).json({ ok: false, error: "memoryId inválido." });

    const authorId = await resolveAuthorId(req);
    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Autor não identificado.",
        detail: "Token autenticado, porém sem author_id resolvível.",
      });
    }

    const result = await getEditorial({
      memoryId,
      authorId,
      createIfMissing: true,
      changedBy: getActor(req),
    });

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}

async function handlePutEditorial(req, res) {
  try {
    const memoryId = parseMemoryId(req);
    if (!memoryId) return res.status(400).json({ ok: false, error: "memoryId inválido." });

    const authorId = await resolveAuthorId(req);
    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Autor não identificado.",
        detail: "Token autenticado, porém sem author_id resolvível.",
      });
    }

    const result = await updateEditorial({
      memoryId,
      authorId,
      payload: req.body || {},
      changedBy: getActor(req),
      changeReason: req.body?.change_reason || req.body?.changeReason || "Curadoria editorial autoral",
    });

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}

async function handleRegenerateEditorial(req, res) {
  try {
    const memoryId = parseMemoryId(req);
    if (!memoryId) return res.status(400).json({ ok: false, error: "memoryId inválido." });

    const authorId = await resolveAuthorId(req);
    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Autor não identificado.",
        detail: "Token autenticado, porém sem author_id resolvível.",
      });
    }

    const result = await regenerateEditorial({
      memoryId,
      authorId,
      changedBy: getActor(req),
      forceLocal: req.body?.forceLocal === true || req.body?.force_local === true,
    });

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}


async function handleNarrativePath(req, res) {
  try {
    const memoryId = parseMemoryId(req);
    if (!memoryId) return res.status(400).json({ ok: false, error: "memoryId inválido." });

    const authorId = await resolveAuthorId(req);
    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Autor não identificado.",
        detail: "Token autenticado, porém sem author_id resolvível.",
      });
    }

    const result = await resolveNarrativeContextForMemory({
      memoryId,
      authorId,
      requireValidPath: false,
    });

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}

async function handleHistory(req, res) {
  try {
    const memoryId = parseMemoryId(req);
    if (!memoryId) return res.status(400).json({ ok: false, error: "memoryId inválido." });

    const authorId = await resolveAuthorId(req);
    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Autor não identificado.",
        detail: "Token autenticado, porém sem author_id resolvível.",
      });
    }

    const result = await listEditorialHistory({
      memoryId,
      authorId,
    });

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}

async function handleGetAffinity(req, res) {
  try {
    const memoryId = parseMemoryId(req);
    if (!memoryId) return res.status(400).json({ ok: false, error: "memoryId inválido." });

    const authorId = await resolveAuthorId(req);
    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Autor não identificado.",
        detail: "Token autenticado, porém sem author_id resolvível.",
      });
    }

    const result = await getAffinity({
      memoryId,
      authorId,
      recalculateIfMissing: true,
    });

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}

async function handleRecalculateAffinity(req, res) {
  try {
    const memoryId = parseMemoryId(req);
    if (!memoryId) return res.status(400).json({ ok: false, error: "memoryId inválido." });

    const authorId = await resolveAuthorId(req);
    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Autor não identificado.",
        detail: "Token autenticado, porém sem author_id resolvível.",
      });
    }

    const result = await recalculateAffinity({
      memoryId,
      authorId,
    });

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}

router.get("/taxonomy", authenticate, handleTaxonomy);
router.get("/memories/editorial/taxonomy", authenticate, handleTaxonomy);
router.get("/memory/editorial/taxonomy", authenticate, handleTaxonomy);
router.get("/memories/:memoryId/editorial", authenticate, handleGetEditorial);
router.put("/memories/:memoryId/editorial", authenticate, handlePutEditorial);
router.post("/memories/:memoryId/editorial/regenerate", authenticate, handleRegenerateEditorial);
router.get("/memories/:memoryId/editorial/narrative-path", authenticate, handleNarrativePath);
router.get("/memories/:memoryId/editorial/history", authenticate, handleHistory);
router.get("/memories/:memoryId/affinity", authenticate, handleGetAffinity);
router.post("/memories/:memoryId/affinity/recalculate", authenticate, handleRecalculateAffinity);

router.get("/memory/:memoryId/editorial", authenticate, handleGetEditorial);
router.put("/memory/:memoryId/editorial", authenticate, handlePutEditorial);
router.post("/memory/:memoryId/editorial/regenerate", authenticate, handleRegenerateEditorial);
router.get("/memory/:memoryId/editorial/narrative-path", authenticate, handleNarrativePath);
router.get("/memory/:memoryId/editorial/history", authenticate, handleHistory);
router.get("/memory/:memoryId/affinity", authenticate, handleGetAffinity);
router.post("/memory/:memoryId/affinity/recalculate", authenticate, handleRecalculateAffinity);

export default router;
