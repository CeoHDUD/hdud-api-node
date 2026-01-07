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

export default router;
