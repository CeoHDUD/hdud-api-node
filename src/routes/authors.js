// C:\HDUD_DATA\hdud-api-node\src\routes\authors.js
// HDUD API Node v0.6 — Authors routes
// Montado em: app.use("/authors", authorsRoutes)
// Portanto aqui as rotas NÃO começam com "/authors" de novo.

import express from "express";
import sql from "mssql";

import { getPool } from "../db.js";
import { authRequired } from "../middleware/auth.js";

const router = express.Router();

/**
 * Helper: extrai userId e userCode do req.user (JWT)
 * Ajuste se o seu payload tiver campos diferentes.
 */
function getUserIdentity(req) {
  const rawId = req.user?.user_id ?? req.user?.id ?? req.user?.sub;
  const userId = Number(rawId);

  const userCode =
    (req.user?.email ??
      req.user?.user_code ??
      req.user?.username ??
      (typeof req.user?.sub === "string" ? req.user.sub : null) ??
      "hdud_api_v0.6")
      .toString()
      .slice(0, 100);

  return { userId, userCode };
}

/**
 * GET /authors/:authorId/memories
 * - ownership: authorId do path DEVE ser o mesmo do token (req.user.author_id)
 * - payload conforme contrato (conceitual): { "content": "string" }
 * - sem paginação
 * - sem ordenação customizada
 *
 * Response: Array<{ content: string }>
 */
router.get("/:authorId/memories", authRequired, async (req, res) => {
  try {
    const authorId = Number(req.params.authorId);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(400).json({ error: "authorId inválido" });
    }

    const tokenAuthorId = Number(req.user?.author_id);
    if (!Number.isInteger(tokenAuthorId) || tokenAuthorId <= 0) {
      return res.status(401).json({ error: "Contexto inválido." });
    }

    // Ownership (contrato: 403 = autoria inválida)
    if (tokenAuthorId !== authorId) {
      return res.status(403).json({ error: "Autoria inválida" });
    }

    const pool = await getPool();
    const request = pool.request();

    const r = await request
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT content
        FROM dbo.identity_memory
        WHERE author_id = @author_id
          AND is_deleted = 0
      `);

    // Payload conceitual do contrato: apenas "content"
    const items = (r.recordset ?? []).map((row) => ({
      content: row.content ?? "",
    }));

    return res.status(200).json(items);
  } catch (err) {
    console.error("[GET /authors/:authorId/memories] erro:", err);

    const detail =
      err?.originalError?.info?.message || err?.message || "Erro interno";

    return res.status(500).json({
      error: "Falha ao listar memórias",
      detail,
    });
  }
});

/**
 * POST /authors/:authorId/memories
 * Body: { title?: string, content: string }
 *
 * SQL:
 * dbo.p_CreateMemory_WithVersion(
 *   @AuthorId INT,
 *   @Title NVARCHAR(500),
 *   @Content NVARCHAR(MAX),
 *   @UserId INT,
 *   @UserCode NVARCHAR(100) = NULL
 * )
 */
router.post("/:authorId/memories", authRequired, async (req, res) => {
  try {
    const authorId = Number(req.params.authorId);
    const { title: titleRaw = null, content: contentRaw = null } = req.body ?? {};

    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(400).json({ error: "authorId inválido" });
    }

    const content = typeof contentRaw === "string" ? contentRaw.trim() : "";
    if (!content) {
      return res.status(400).json({ error: "content é obrigatório" });
    }

    let title = null;
    if (typeof titleRaw === "string") {
      const t = titleRaw.trim();
      title = t.length ? t.slice(0, 500) : null;
    }

    const { userId, userCode } = getUserIdentity(req);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({
        error:
          "Token autenticado, mas userId não encontrado no req.user (esperado: user_id ou id).",
      });
    }

    // ✅ Reuso de pool (padrão do projeto v0.6)
    const pool = await getPool();
    const request = pool.request();

    // Session context (mesma request)
    request.input("hdud_user", sql.NVarChar(100), userCode);
    await request.query(
      "EXEC sys.sp_set_session_context @key=N'hdud_user', @value=@hdud_user;"
    );

    // Inputs EXACTOS exigidos pela procedure
    request.input("AuthorId", sql.Int, authorId);
    request.input("Title", sql.NVarChar(500), title);
    request.input("Content", sql.NVarChar(sql.MAX), content);
    request.input("UserId", sql.Int, userId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    const result = await request.execute("dbo.p_CreateMemory_WithVersion");
    const row = result.recordset?.[0];

    // Se não retornar nada, ainda é sucesso.
    if (!row) return res.status(201).json({ ok: true });

    return res.status(201).json(row);
  } catch (err) {
    console.error("[POST /authors/:authorId/memories] erro:", err);

    const detail =
      err?.originalError?.info?.message || err?.message || "Erro interno";

    // Se for erro de validação do SQL (ex: param faltando), devolve 400
    // Senão, 500.
    const isSqlParamError =
      (err?.number === 201 || detail?.includes("expects parameter")) ?? false;

    return res.status(isSqlParamError ? 400 : 500).json({
      error: "Falha ao criar memória",
      detail,
    });
  }
});


function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

async function listPublicAuthorRelations(req, res, mode) {
  try {
    const profileAuthorId = Number(req.params.authorId);
    const viewerAuthorId = Number(req.user?.author_id);

    if (!Number.isInteger(profileAuthorId) || profileAuthorId <= 0) {
      return res.status(400).json({ error: "authorId inválido" });
    }
    if (!Number.isInteger(viewerAuthorId) || viewerAuthorId <= 0) {
      return res.status(401).json({ error: "Contexto inválido." });
    }

    const q = normalizeText(req.query?.q).slice(0, 120);
    const sort = normalizeText(req.query?.sort).toLowerCase();
    const limit = clampInt(req.query?.limit, 1, 100, 50);
    const offset = clampInt(req.query?.offset, 0, 100000, 0);

    const allowedSort = new Set(["recent", "oldest", "name", "mutual"]);
    const normalizedSort = allowedSort.has(sort) ? sort : "recent";

    const pool = await getPool();

    const exists = await pool.request()
      .input("profile_author_id", sql.Int, profileAuthorId)
      .query(`SELECT TOP 1 author_id FROM dbo.identity_author WHERE author_id = @profile_author_id;`);

    if (!exists.recordset?.[0]) {
      return res.status(404).json({ error: "Autor não encontrado." });
    }

    const directionJoin = mode === "followers"
      ? "f.followed_id = @profile_author_id AND a.author_id = f.follower_id"
      : "f.follower_id = @profile_author_id AND a.author_id = f.followed_id";

    const orderBy = normalizedSort === "oldest"
      ? "relation_created_at ASC, author_id ASC"
      : normalizedSort === "name"
        ? "display_name ASC, author_id ASC"
        : normalizedSort === "mutual"
          ? "mutual_connections DESC, relation_created_at DESC, author_id DESC"
          : "relation_created_at DESC, author_id DESC";

    const result = await pool.request()
      .input("profile_author_id", sql.Int, profileAuthorId)
      .input("viewer_author_id", sql.Int, viewerAuthorId)
      .input("q", sql.NVarChar(120), q)
      .input("limit", sql.Int, limit)
      .input("offset", sql.Int, offset)
      .query(`
        WITH relation_rows AS (
          SELECT
            a.author_id,
            a.author_code,
            a.full_name,
            a.name_public,
            a.bio_short,
            a.location,
            a.avatar_url,
            f.created_at AS relation_created_at,
            COALESCE(NULLIF(LTRIM(RTRIM(a.name_public)), ''), NULLIF(LTRIM(RTRIM(a.full_name)), ''), NULLIF(LTRIM(RTRIM(a.author_code)), ''), 'Autor') AS display_name,
            CASE WHEN a.author_id = @viewer_author_id THEN 1 ELSE 0 END AS is_me,
            CASE WHEN EXISTS (
              SELECT 1 FROM dbo.identity_follow vf
              WHERE vf.follower_id = @viewer_author_id AND vf.followed_id = a.author_id
            ) THEN 1 ELSE 0 END AS is_following,
            CASE WHEN EXISTS (
              SELECT 1 FROM dbo.identity_follow vf
              WHERE vf.follower_id = a.author_id AND vf.followed_id = @viewer_author_id
            ) THEN 1 ELSE 0 END AS follows_me,
            (
              SELECT TOP 1 i.invite_id
              FROM dbo.identity_network_invite i
              WHERE i.from_author_id = @viewer_author_id
                AND i.to_author_id = a.author_id
                AND i.status = 'pending'
              ORDER BY i.created_at DESC, i.invite_id DESC
            ) AS pending_invite_from_me_id,
            (
              SELECT TOP 1 i.invite_id
              FROM dbo.identity_network_invite i
              WHERE i.from_author_id = a.author_id
                AND i.to_author_id = @viewer_author_id
                AND i.status = 'pending'
              ORDER BY i.created_at DESC, i.invite_id DESC
            ) AS pending_invite_to_me_id,
            (
              SELECT COUNT(*)
              FROM dbo.identity_author mutual
              WHERE mutual.author_id <> @viewer_author_id
                AND mutual.author_id <> a.author_id
                AND EXISTS (SELECT 1 FROM dbo.identity_follow x1 WHERE x1.follower_id = @viewer_author_id AND x1.followed_id = mutual.author_id)
                AND EXISTS (SELECT 1 FROM dbo.identity_follow x2 WHERE x2.follower_id = mutual.author_id AND x2.followed_id = @viewer_author_id)
                AND EXISTS (SELECT 1 FROM dbo.identity_follow y1 WHERE y1.follower_id = a.author_id AND y1.followed_id = mutual.author_id)
                AND EXISTS (SELECT 1 FROM dbo.identity_follow y2 WHERE y2.follower_id = mutual.author_id AND y2.followed_id = a.author_id)
            ) AS mutual_connections,
            (
              SELECT COUNT(*)
              FROM dbo.identity_memory m
              WHERE m.author_id = a.author_id
                AND ISNULL(m.is_deleted, 0) = 0
                AND UPPER(LTRIM(RTRIM(ISNULL(m.publication_status, '')))) IN ('PUBLISHED','PUBLIC','SHARED')
            ) AS public_memories
          FROM dbo.identity_follow f
          INNER JOIN dbo.identity_author a ON ${directionJoin}
          WHERE (
            @q = ''
            OR COALESCE(a.name_public, '') LIKE '%' + @q + '%'
            OR COALESCE(a.full_name, '') LIKE '%' + @q + '%'
            OR COALESCE(a.author_code, '') LIKE '%' + @q + '%'
            OR COALESCE(a.location, '') LIKE '%' + @q + '%'
          )
        )
        SELECT *, COUNT(*) OVER() AS total_count
        FROM relation_rows
        ORDER BY ${orderBy}
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
      `);

    const items = (result.recordset || []).map((row) => ({
      author_id: Number(row.author_id),
      author_code: row.author_code ?? null,
      name_public: row.display_name ?? "Autor",
      bio_short: row.bio_short ?? null,
      location: row.location ?? null,
      avatar_url: row.avatar_url ?? null,
      relation_created_at: row.relation_created_at ?? null,
      is_me: Number(row.is_me || 0) === 1,
      is_following: Number(row.is_following || 0) === 1,
      follows_me: Number(row.follows_me || 0) === 1,
      connected: Number(row.is_following || 0) === 1 && Number(row.follows_me || 0) === 1,
      pending_invite_from_me_id: row.pending_invite_from_me_id ? Number(row.pending_invite_from_me_id) : null,
      pending_invite_to_me_id: row.pending_invite_to_me_id ? Number(row.pending_invite_to_me_id) : null,
      mutual_connections: Number(row.mutual_connections || 0),
      public_memories: Number(row.public_memories || 0),
    }));

    const total = Number(result.recordset?.[0]?.total_count || 0);

    return res.json({
      ok: true,
      author_id: profileAuthorId,
      relation: mode,
      items,
      total,
      limit,
      offset,
      has_more: offset + items.length < total,
    });
  } catch (err) {
    console.error(`[authors.${mode}]`, err);
    return res.status(500).json({ error: `Falha ao listar ${mode === "followers" ? "seguidores" : "autores seguidos"}.` });
  }
}

router.get("/:authorId/followers", authRequired, async (req, res) => {
  return listPublicAuthorRelations(req, res, "followers");
});

router.get("/:authorId/following", authRequired, async (req, res) => {
  return listPublicAuthorRelations(req, res, "following");
});

export default router;
