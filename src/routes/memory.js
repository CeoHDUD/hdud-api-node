// C:\HDUD_DATA\hdud-api-node\src\routes\memory.js
// Contrato estável:
//   POST /memory
//   PUT  /memory/:id
//   GET  /memory/:id
//   GET  /memory/:id/versions

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

function extractSqlErrorDetail(err) {
  const msg =
    err?.originalError?.info?.message ||
    err?.originalError?.message ||
    err?.message ||
    null;

  const proc = err?.originalError?.info?.procName || err?.procName || null;
  const number = err?.originalError?.info?.number || err?.number || null;

  return {
    message: msg,
    procName: proc,
    number,
    code: err?.code || null,
  };
}

function pickFirstNonEmptyString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickFirstInt(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * Resolve:
 * - userId: do token (user_id/id/sub) OU lookup identity_user por email
 * - userCode: identity_author.author_code por authorId OU fallback email/hdud_api
 */
async function resolveUserIdAndCode(pool, req, authorId) {
  let userId = pickFirstInt(req.user, ["user_id", "userId", "id", "uid"]);

  if (userId == null) {
    const subAsInt = pickFirstInt(req.user, ["sub"]);
    if (subAsInt != null) userId = subAsInt;
  }

  const email = pickFirstNonEmptyString(req.user, ["email", "mail", "upn"]);

  if (userId == null && email) {
    const r = await pool
      .request()
      .input("email", sql.NVarChar(510), email)
      .query(`
        SELECT TOP 1
          user_id,
          author_id,
          email
        FROM dbo.identity_user
        WHERE email = @email
        ORDER BY user_id DESC;
      `);

    const row = r.recordset?.[0] || null;
    if (row?.user_id != null) userId = Number(row.user_id);
    if (
      (authorId == null || Number.isNaN(Number(authorId))) &&
      row?.author_id != null
    ) {
      authorId = Number(row.author_id);
    }
  }

  let userCode = null;
  if (authorId != null && !Number.isNaN(Number(authorId))) {
    const r2 = await pool
      .request()
      .input("author_id", sql.Int, Number(authorId))
      .query(`
        SELECT TOP 1 author_code
        FROM dbo.identity_author
        WHERE author_id = @author_id;
      `);

    userCode = r2.recordset?.[0]?.author_code
      ? String(r2.recordset[0].author_code)
      : null;
  }

  if (!userCode) userCode = email || "hdud_api";
  userCode = String(userCode).slice(0, 200);

  return { userId, userCode, email, authorId };
}

// ------------------------------
// ✅ Trilho 2.1 — fases (domínio)
// ------------------------------
function parseLifePhaseCode(val) {
  // ausente => não mexe
  if (val === undefined) return undefined;

  // null/"" => remove fase
  if (val === null) return null;
  const s = String(val).trim();
  if (!s) return null;

  // normaliza upper (o front manda codes já em upper)
  return s.toUpperCase();
}

async function resolvePhaseIdByCode(pool, phaseCodeOrNull) {
  if (phaseCodeOrNull == null) return null;

  const r = await pool
    .request()
    .input("phase_code", sql.NVarChar(50), phaseCodeOrNull)
    .query(`
      SELECT TOP 1 phase_id
      FROM dbo.identity_phase
      WHERE phase_code = @phase_code
        AND ISNULL(is_active, 1) = 1;
    `);

  const id = r.recordset?.[0]?.phase_id ?? null;
  return id != null ? Number(id) : null;
}

/**
 * Atualiza phase_id em dbo.identity_memory garantindo:
 * - memória pertence ao author
 * - phase_code existe (quando não for null)
 */
async function updateMemoryPhase(pool, memoryId, authorId, phaseCodeOrNull) {
  const phaseId = await resolvePhaseIdByCode(pool, phaseCodeOrNull);

  // Se veio um code e não existe no domínio -> 422 (payload inválido)
  if (phaseCodeOrNull != null && phaseId == null) {
    const err = new Error(`life_phase inválida: ${phaseCodeOrNull}`);
    err.status = 422;
    throw err;
  }

  const req = pool.request();
  req.input("memory_id", sql.Int, memoryId);
  req.input("author_id", sql.Int, authorId);
  req.input("phase_id", sql.Int, phaseId);

  await req.query(`
    UPDATE m
    SET m.phase_id = @phase_id
    FROM dbo.identity_memory m
    WHERE m.memory_id = @memory_id
      AND m.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0;
  `);
}

/**
 * ✅ SELECT de memória incluindo fase (phase_code/phase_name)
 */
async function selectMemoryById(pool, memoryId) {
  const result = await pool
    .request()
    .input("id", sql.Int, memoryId)
    .query(`
      SELECT
        m.*,
        mc.chapter_id,
        m.phase_id,
        p.phase_code AS life_phase,
        p.name AS phase_name
      FROM dbo.identity_memory m
      LEFT JOIN dbo.identity_memory_chapter mc
        ON mc.memory_id = m.memory_id
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.memory_id = @id;
    `);

  return result.recordset?.[0] ?? null;
}

function parsePhaseIdDirect(body) {
  // aceita phase_id | phaseId
  if (body?.phase_id !== undefined) return body.phase_id;
  if (body?.phaseId !== undefined) return body.phaseId;
  return undefined;
}

function parseLifePhaseFlexible(body) {
  // aceita life_phase e variações comuns do front
  return parseLifePhaseCode(
    body?.life_phase ??
      body?.lifePhase ??
      body?.phase ??
      body?.phase_code ??
      body?.life_phase_code
  );
}

/**
 * POST /memory
 * Body: { author_id: number, title?: string|null, content: string }
 */
router.post("/", authenticate, async (req, res) => {
  try {
    const { author_id, title = null, content } = req.body || {};

    const authorIdCandidate = author_id ?? req.user?.author_id ?? null;

    if (
      authorIdCandidate == null ||
      Number.isNaN(parseInt(authorIdCandidate, 10))
    ) {
      return res
        .status(400)
        .json({ error: "author_id é obrigatório e deve ser número." });
    }

    const authorId = parseInt(authorIdCandidate, 10);
    if (!assertAuthorAccess(req, res, authorId)) return;

    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: "content é obrigatório." });
    }

    const pool = await getPool();
    const { userId, userCode } = await resolveUserIdAndCode(pool, req, authorId);

    if (userId == null || Number.isNaN(Number(userId))) {
      return res.status(400).json({
        error: "Não foi possível resolver UserId (identity_user por email).",
      });
    }

    const result = await pool
      .request()
      .input("AuthorId", sql.Int, Number(authorId))
      .input("Title", sql.NVarChar(500), title ? String(title) : null)
      .input("Content", sql.NVarChar(sql.MAX), String(content))
      .input("UserId", sql.Int, Number(userId))
      .input("UserCode", sql.NVarChar(100), String(userCode).slice(0, 100))
      .execute("dbo.p_CreateMemory_WithVersion");

    const row = result?.recordset?.[0];
    if (!row) return res.status(500).json({ error: "Falha ao criar memória." });

    const fresh = await selectMemoryById(pool, Number(row.memory_id));
    return res.status(201).json(attachMeta(fresh || row, req, authorId));
  } catch (err) {
    console.error("[POST /memory] erro:", err);
    return res.status(500).json({
      error: "Erro ao criar memória.",
      detail: extractSqlErrorDetail(err),
    });
  }
});

/**
 * GET /memory/:id
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
      const row = await selectMemoryById(pool, memoryId);

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
 * Mantém proc estável (6 params) e aplica phase_id em UPDATE separado
 */
router.put(
  "/:id",
  authenticate,
  requireMemoryOwnership({ paramName: "id" }),
  async (req, res) => {
    try {
      const memoryId = parseInt(req.params.id, 10);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "id inválido." });
      }

      const newTitle =
        typeof req.body?.title === "string"
          ? req.body.title.trim().slice(0, 510)
          : null;

      const newContent =
        typeof req.body?.content === "string" ? req.body.content.trim() : "";

      if (!newContent) {
        return res.status(400).json({ error: "content é obrigatório." });
      }

      // ✅ aceita phase_id direto OU life_phase (flexível)
      const phaseIdDirectRaw = parsePhaseIdDirect(req.body || {});
      const lifePhaseCodeParsed = parseLifePhaseFlexible(req.body || {});

      const pool = await getPool();

      // Fonte de verdade do author: a própria memória
      const mem = await pool
        .request()
        .input("id", sql.Int, memoryId)
        .query(
          `SELECT TOP 1 memory_id, author_id, is_deleted FROM dbo.identity_memory WHERE memory_id=@id;`
        );

      const row = mem.recordset?.[0] || null;
      if (!row || row.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const authorId = Number(row.author_id);
      if (!assertAuthorAccess(req, res, authorId)) return;

      const { userId, userCode } = await resolveUserIdAndCode(pool, req, authorId);
      if (!userId) {
        return res.status(401).json({ error: "userId não encontrado no token." });
      }

      // Proc estável (versão + ledger) — NÃO passa PhaseId
      const result = await pool
        .request()
        .input("MemoryId", sql.Int, memoryId)
        .input("NewTitle", sql.NVarChar(510), newTitle)
        .input("NewContent", sql.NVarChar(sql.MAX), newContent)
        .input("UserId", sql.Int, Number(userId))
        .input("AuthorId", sql.Int, authorId)
        .input("UserCode", sql.NVarChar(200), String(userCode).slice(0, 200))
        .execute("dbo.p_UpdateMemory_WithVersion");

      const updated = result?.recordset?.[0] || null;

      // ✅ aplica fase em UPDATE separado
      if (phaseIdDirectRaw !== undefined) {
        // null => remove fase
        if (phaseIdDirectRaw === null) {
          await updateMemoryPhase(pool, memoryId, authorId, null);
        } else {
          const n = Number(phaseIdDirectRaw);
          if (!Number.isInteger(n) || n <= 0) {
            return res.status(422).json({ error: "phase_id inválido." });
          }

          // valida existência no domínio (opcional, mas seguro)
          const chk = await pool
            .request()
            .input("pid", sql.Int, n)
            .query(`
              SELECT TOP 1 phase_id
              FROM dbo.identity_phase
              WHERE phase_id=@pid AND ISNULL(is_active,1)=1;
            `);

          if (!chk.recordset?.[0]?.phase_id) {
            return res.status(422).json({ error: "phase_id não existe ou está inativo." });
          }

          const reqUp = pool.request();
          reqUp.input("memory_id", sql.Int, memoryId);
          reqUp.input("author_id", sql.Int, authorId);
          reqUp.input("phase_id", sql.Int, n);

          await reqUp.query(`
            UPDATE m
            SET m.phase_id = @phase_id
            FROM dbo.identity_memory m
            WHERE m.memory_id = @memory_id
              AND m.author_id = @author_id
              AND ISNULL(m.is_deleted, 0) = 0;
          `);
        }
      } else if (lifePhaseCodeParsed !== undefined) {
        await updateMemoryPhase(pool, memoryId, authorId, lifePhaseCodeParsed);
      }

      const fresh = await selectMemoryById(pool, memoryId);
      return res.json(
        attachMeta(
          fresh || updated || { ok: true, memory_id: memoryId },
          req,
          authorId
        )
      );
    } catch (err) {
      // life_phase inválida => 422
      if (err?.status === 422) {
        return res.status(422).json({ error: err.message });
      }

      console.error("[PUT /memory/:id] erro:", err);
      return res.status(500).json({
        error: "Erro ao atualizar memória.",
        detail: extractSqlErrorDetail(err),
      });
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
