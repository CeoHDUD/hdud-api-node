// C:\HDUD_DATA\hdud-api-node\src\routes\memories.js
// Rotas deste arquivo:
// - POST /memories                      -> (contrato) payload { content: string }
// - GET  /memories                      -> (alias) lista memórias do author do token (para /api/memories)
// - GET  /authors/:authorId/memories
// - POST /authors/:authorId/memories     -> dbo.p_CreateMemory_WithVersion
// - GET  /memories/:id
// - GET  /memories/:id/versions
// - PUT  /memories/:id                   -> dbo.p_UpdateMemory_WithVersion

import express from "express";
import { authenticate } from "../middleware/auth.js";
import { requireMemoryOwnership } from "../middleware/ownership.js";
import { getPool, sql } from "../db.js";
import { ROLES, userHasRole } from "../middleware/roles.js";

const router = express.Router();

function canEditFromReq(req, authorId) {
  const tokenAuthorId = req.user?.author_id ?? null;
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
  return (
    req.user?.email ??
    req.user?.username ??
    (typeof req.user?.sub === "string" ? req.user.sub : null) ??
    "hdud_api"
  )
    .toString()
    .slice(0, 100);
}

async function trySetSessionContext(pool, userCode) {
  try {
    const ctx = pool.request();
    await ctx.query`
      EXEC sys.sp_set_session_context
        @key=N'hdud_user',
        @value=${userCode};
    `;
  } catch {
    // silencioso
  }
}

function hasOnlyAllowedKeys(obj, allowedKeys) {
  const keys = Object.keys(obj || {});
  for (const k of keys) {
    if (!allowedKeys.includes(k)) return false;
  }
  return true;
}

function parseChapterId(val) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

async function updateMemoryChapterLink(pool, memoryId, authorId, chapterIdOrNull) {
  const req = pool.request();
  req.input("memory_id", sql.Int, memoryId);
  req.input("author_id", sql.Int, authorId);

  await req.query(`
    DELETE mc
    FROM dbo.identity_memory_chapter mc
    INNER JOIN dbo.identity_memory m
      ON m.memory_id = mc.memory_id
    WHERE mc.memory_id = @memory_id
      AND m.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0;
  `);

  if (chapterIdOrNull != null) {
    const req2 = pool.request();
    req2.input("memory_id", sql.Int, memoryId);
    req2.input("author_id", sql.Int, authorId);
    req2.input("chapter_id", sql.Int, chapterIdOrNull);

    await req2.query(`
      INSERT INTO dbo.identity_memory_chapter (memory_id, chapter_id)
      SELECT @memory_id, @chapter_id
      WHERE EXISTS (
        SELECT 1
        FROM dbo.identity_memory m
        WHERE m.memory_id = @memory_id
          AND m.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0
      )
      AND EXISTS (
        SELECT 1
        FROM dbo.identity_chapter c
        WHERE c.chapter_id = @chapter_id
          AND c.author_id = @author_id
          AND ISNULL(c.is_deleted, 0) = 0
      );
    `);
  }
}

// ------------------------------
// ✅ Fases (domínio) — helpers
// ------------------------------
function parseLifePhaseCode(val) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  const s = String(val).trim();
  if (!s) return null;
  return s.toUpperCase();
}

async function resolvePhaseIdByCode(pool, phaseCodeOrNull) {
  if (phaseCodeOrNull == null) return null;

  const r = await pool
    .request()
    .input("code", sql.NVarChar(50), phaseCodeOrNull)
    .query(`
      SELECT TOP 1 phase_id
      FROM dbo.identity_phase
      WHERE phase_code = @code
        AND ISNULL(is_active,1) = 1;
    `);

  const id = r.recordset?.[0]?.phase_id ?? null;
  return id != null ? Number(id) : null;
}

function parsePhaseIdDirect(body) {
  if (body?.phase_id !== undefined) return body.phase_id;
  if (body?.phaseId !== undefined) return body.phaseId;
  return undefined;
}

function parseLifePhaseFlexible(body) {
  return parseLifePhaseCode(
    body?.life_phase ??
      body?.lifePhase ??
      body?.phase ??
      body?.phase_code ??
      body?.life_phase_code
  );
}

async function updateMemoryPhase(pool, memoryId, authorId, phaseIdOrNull) {
  const req = pool.request();
  req.input("memory_id", sql.Int, memoryId);
  req.input("author_id", sql.Int, authorId);
  req.input("phase_id", sql.Int, phaseIdOrNull);

  await req.query(`
    UPDATE m
    SET m.phase_id = @phase_id
    FROM dbo.identity_memory m
    WHERE m.memory_id = @memory_id
      AND m.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0;
  `);
}

// ✅ select com phase meta
// ⚠️ IMPORTANTE: não usar LEFT JOIN direto em identity_memory_chapter,
// porque múltiplas linhas por memory_id multiplicam o resultado (duplicidade).
// Usamos OUTER APPLY TOP 1 para garantir 1 chapter_id por memória.
async function selectMemoryById(pool, memoryId) {
  const r = await pool
    .request()
    .input("id", sql.Int, memoryId)
    .query(`
      SELECT
        m.memory_id,
        m.author_id,
        mc.chapter_id,
        m.phase_id,
        p.phase_code AS life_phase,
        p.name       AS phase_name,
        m.title,
        m.content,
        m.created_at,
        m.version_number,
        m.is_deleted
      FROM dbo.identity_memory m
      OUTER APPLY (
        SELECT TOP 1 chapter_id
        FROM dbo.identity_memory_chapter
        WHERE memory_id = m.memory_id
        ORDER BY chapter_id ASC
      ) mc
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.memory_id = @id;
    `);

  return r.recordset?.[0] ?? null;
}

async function listMemoriesByAuthor(pool, authorId, req) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .query(`
      SELECT
        m.memory_id,
        m.author_id,
        mc.chapter_id,
        m.phase_id,
        p.phase_code AS life_phase,
        p.name       AS phase_name,
        m.title,
        m.content,
        m.created_at,
        m.version_number,
        m.is_deleted
      FROM dbo.identity_memory m
      OUTER APPLY (
        SELECT TOP 1 chapter_id
        FROM dbo.identity_memory_chapter
        WHERE memory_id = m.memory_id
        ORDER BY chapter_id ASC
      ) mc
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY m.created_at DESC, m.memory_id DESC;
    `);

  // ✅ Dedupe defensivo por memory_id (caso o banco esteja “sujo”)
  const seen = new Set();
  const out = [];
  for (const r of result.recordset || []) {
    const id = r?.memory_id;
    if (id == null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(attachMeta(r, req, authorId));
  }
  return out;
}

// POST /memories (contrato mínimo)
router.post("/memories", authenticate, async (req, res) => {
  try {
    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(422).json({ error: "Payload inválido." });
    }

    if (!hasOnlyAllowedKeys(body, ["content"])) {
      return res.status(400).json({ error: "Violação de contrato." });
    }

    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) return res.status(422).json({ error: "Payload inválido." });

    const authorId = Number(req.user?.author_id);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(403).json({ error: "Autoria inválida." });
    }

    const userId = getUserId(req);
    if (!userId) return res.status(403).json({ error: "Autoria inválida." });

    const userCode = getUserCode(req);

    const pool = await getPool();
    await trySetSessionContext(pool, userCode);

    const request = pool.request();
    request.input("AuthorId", sql.Int, authorId);
    request.input("Title", sql.NVarChar(500), null);
    request.input("Content", sql.NVarChar(sql.MAX), content);
    request.input("UserId", sql.Int, userId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    // create legado não aceita fase aqui (contrato fechado)
    const result = await request.execute("dbo.p_CreateMemory_WithVersion");
    const row = result?.recordset?.[0];
    if (!row) return res.status(500).json({ error: "Erro ao criar memória." });

    const fresh = await selectMemoryById(pool, Number(row.memory_id));
    return res.status(201).json(attachMeta(fresh || row, req, authorId));
  } catch (err) {
    console.error("[POST /memories] erro:", err);
    return res.status(500).json({
      error: "Erro ao criar memória.",
      detail: err?.originalError?.info?.message || err?.message,
    });
  }
});

// ✅ GET /memories (alias para inventário e listas simples)
// - quando montado em /api, vira /api/memories e elimina o 404 do frontend
router.get("/memories", authenticate, async (req, res) => {
  try {
    const authorId = Number(req.user?.author_id);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(403).json({ error: "Autoria inválida." });
    }
    if (!canEditFromReq(req, authorId)) {
      return res.status(403).json({ error: "Permissão negada." });
    }

    const pool = await getPool();
    const rows = await listMemoriesByAuthor(pool, authorId, req);
    return res.json({ author_id: authorId, memories: rows });
  } catch (err) {
    console.error("[GET /memories] erro:", err);
    return res.status(500).json({ error: "Erro ao listar memórias." });
  }
});

// GET /authors/:authorId/memories
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
    const rows = await listMemoriesByAuthor(pool, authorId, req);
    return res.json({ author_id: authorId, memories: rows });
  } catch (err) {
    console.error("[GET /authors/:authorId/memories] erro:", err);
    return res.status(500).json({ error: "Erro ao listar memórias." });
  }
});

// POST /authors/:authorId/memories (aceita chapter + fase)
// IMPORTANTE: NÃO passa PhaseId para proc (contrato estável). Aplica fase em UPDATE separado.
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
      typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 500) : null;

    const content =
      typeof req.body?.content === "string" ? req.body.content.trim() : "";

    if (!content) return res.status(400).json({ error: "content é obrigatório." });

    const chapterIdParsed = parseChapterId(req.body?.chapter_id);

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "userId não encontrado no token." });

    const userCode = getUserCode(req);

    const pool = await getPool();
    await trySetSessionContext(pool, userCode);

    // fase: aceita phase_id direto OU life_phase flexível
    const phaseIdDirectRaw = parsePhaseIdDirect(req.body || {});
    const lifePhaseCodeParsed = parseLifePhaseFlexible(req.body || {});

    const request = pool.request();
    request.input("AuthorId", sql.Int, authorId);
    request.input("Title", sql.NVarChar(500), title);
    request.input("Content", sql.NVarChar(sql.MAX), content);
    request.input("UserId", sql.Int, userId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    // NÃO envia PhaseId na proc (contrato estável)
    const result = await request.execute("dbo.p_CreateMemory_WithVersion");
    const row = result?.recordset?.[0];
    if (!row) return res.status(500).json({ error: "Falha ao criar memória." });

    const createdId = Number(row.memory_id);

    // aplica chapter link (opcional)
    if (Number.isInteger(createdId) && createdId > 0 && chapterIdParsed !== undefined) {
      await updateMemoryChapterLink(pool, createdId, authorId, chapterIdParsed);
    }

    // aplica fase (opcional) — UPDATE separado
    if (Number.isInteger(createdId) && createdId > 0) {
      if (phaseIdDirectRaw !== undefined) {
        if (phaseIdDirectRaw === null) {
          await updateMemoryPhase(pool, createdId, authorId, null);
        } else {
          const n = Number(phaseIdDirectRaw);
          if (!Number.isInteger(n) || n <= 0) {
            return res.status(422).json({ error: "phase_id inválido." });
          }
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
          await updateMemoryPhase(pool, createdId, authorId, n);
        }
      } else if (lifePhaseCodeParsed !== undefined) {
        const phaseIdResolved = await resolvePhaseIdByCode(pool, lifePhaseCodeParsed);
        if (lifePhaseCodeParsed != null && phaseIdResolved == null) {
          return res.status(422).json({ error: `life_phase inválida: ${lifePhaseCodeParsed}` });
        }
        await updateMemoryPhase(pool, createdId, authorId, phaseIdResolved);
      }
    }

    const fresh = await selectMemoryById(pool, createdId);
    return res.status(201).json(attachMeta(fresh || row, req, authorId));
  } catch (err) {
    console.error("[POST /authors/:authorId/memories] erro:", err);
    return res.status(500).json({
      error: "Erro ao criar memória.",
      detail: err?.originalError?.info?.message || err?.message,
    });
  }
});

// GET /memories/:id
router.get("/memories/:id", authenticate, async (req, res) => {
  try {
    const memoryId = Number(req.params.id);
    if (!Number.isInteger(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "Violação de contrato." });
    }

    const pool = await getPool();
    const row = await selectMemoryById(pool, memoryId);
    if (!row || row.is_deleted) return res.status(404).json({ error: "Memória inexistente." });
    if (!canEditFromReq(req, row.author_id)) return res.status(403).json({ error: "Autoria inválida." });

    return res.json(attachMeta(row, req, row.author_id));
  } catch (err) {
    console.error("[GET /memories/:id] erro:", err);
    return res.status(500).json({ error: "Erro ao carregar memória." });
  }
});

// GET /memories/:id/versions
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

// PUT /memories/:id (aceita chapter + fase)
// IMPORTANTE: NÃO passa PhaseId na proc (contrato estável). Aplica fase em UPDATE separado.
router.put("/memories/:id", authenticate, async (req, res) => {
  try {
    const memoryId = Number(req.params.id);
    if (!Number.isInteger(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "id inválido." });
    }

    const newContent =
      typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!newContent) return res.status(400).json({ error: "content é obrigatório." });

    const newTitle =
      typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 255) : null;

    const chapterIdParsed = parseChapterId(req.body?.chapter_id);

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "userId não encontrado no token." });

    const userCode = getUserCode(req);
    const pool = await getPool();

    const mem = await pool
      .request()
      .input("id", sql.Int, memoryId)
      .query(`SELECT memory_id, author_id, is_deleted FROM dbo.identity_memory WHERE memory_id=@id;`);

    const row = mem.recordset?.[0];
    if (!row || row.is_deleted) return res.status(404).json({ error: "Memória não encontrada." });

    const authorId = Number(row.author_id);
    if (!canEditFromReq(req, authorId)) return res.status(403).json({ error: "Permissão negada." });

    await trySetSessionContext(pool, userCode);

    // fase: aceita phase_id direto OU life_phase flexível
    const phaseIdDirectRaw = parsePhaseIdDirect(req.body || {});
    const lifePhaseCodeParsed = parseLifePhaseFlexible(req.body || {});

    const request = pool.request();
    request.input("MemoryId", sql.Int, memoryId);
    request.input("NewTitle", sql.NVarChar(255), newTitle);
    request.input("NewContent", sql.NVarChar(sql.MAX), newContent);
    request.input("UserId", sql.Int, userId);
    request.input("AuthorId", sql.Int, authorId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    // NÃO envia PhaseId na proc (contrato estável)
    await request.execute("dbo.p_UpdateMemory_WithVersion");

    // chapter link
    if (chapterIdParsed !== undefined) {
      await updateMemoryChapterLink(pool, memoryId, authorId, chapterIdParsed);
    }

    // aplica fase (UPDATE separado)
    if (phaseIdDirectRaw !== undefined) {
      if (phaseIdDirectRaw === null) {
        await updateMemoryPhase(pool, memoryId, authorId, null);
      } else {
        const n = Number(phaseIdDirectRaw);
        if (!Number.isInteger(n) || n <= 0) {
          return res.status(422).json({ error: "phase_id inválido." });
        }
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
        await updateMemoryPhase(pool, memoryId, authorId, n);
      }
    } else if (lifePhaseCodeParsed !== undefined) {
      const phaseIdResolved = await resolvePhaseIdByCode(pool, lifePhaseCodeParsed);
      if (lifePhaseCodeParsed != null && phaseIdResolved == null) {
        return res.status(422).json({ error: `life_phase inválida: ${lifePhaseCodeParsed}` });
      }
      await updateMemoryPhase(pool, memoryId, authorId, phaseIdResolved);
    }

    const fresh = await selectMemoryById(pool, memoryId);
    return res.json(fresh ? attachMeta(fresh, req, authorId) : { ok: true, memory_id: memoryId });
  } catch (err) {
    console.error("[PUT /memories/:id] erro:", err);
    return res.status(500).json({
      error: "Falha ao atualizar memória",
      detail: err?.originalError?.info?.message || err?.message,
    });
  }
});

export default router;
