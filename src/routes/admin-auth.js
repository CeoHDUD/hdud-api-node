// HDUD Admin — Implementação 03 | Admin Auth
// Porta administrativa explícita. Não cria/vincula identity_author.

import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import {
  createSession,
  getActiveSessionByRefreshToken,
  revokeSessionByRefreshToken,
} from "../services/sessionService.js";
import { loginRateLimiter } from "../middleware/rateLimit.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "hdud_dev_secret";
const isStrictProd = String(process.env.JWT_STRICT_PROD || "false").toLowerCase() === "true";
const isProd = process.env.NODE_ENV === "production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || (isProd && isStrictProd ? "15m" : "24h");
const ADMIN_LOGIN_ERROR = "Credenciais administrativas inválidas ou acesso não autorizado.";
const CORPORATE_OPERATOR_DOMAIN = "@hdud.ai";

function isCorporateOperatorIdentity(user) {
  return Boolean(
    user &&
    Number(user.is_active) === 1 &&
    user.author_id == null &&
    String(user.email || "").trim().toLowerCase().endsWith(CORPORATE_OPERATOR_DOMAIN)
  );
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 45);
  }
  return String(req.ip || req.socket?.remoteAddress || "").slice(0, 45) || null;
}

function generateOperatorToken(user, roles) {
  return jwt.sign(
    {
      sub: user.user_id,
      email: user.email,
      session_context: "OPERATOR",
      roles,
    },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: JWT_EXPIRES_IN }
  );
}

async function writeAdminAuditSafe(pool, req, {
  actorUserId = null,
  actorLabel = null,
  eventCode,
  actionCode = "LOGIN",
  resultCode,
  metadata = null,
}) {
  try {
    await pool.request()
      .input("actor_type", sql.VarChar(20), actorUserId ? "USER" : "ANONYMOUS")
      .input("actor_user_id", sql.Int, actorUserId ? Number(actorUserId) : null)
      .input("actor_label", sql.NVarChar(320), actorLabel || null)
      .input("event_code", sql.VarChar(100), eventCode)
      .input("resource_code", sql.VarChar(60), "ADMIN_AUTH")
      .input("action_code", sql.VarChar(40), actionCode)
      .input("result_code", sql.VarChar(20), resultCode)
      .input("ip_address", sql.VarChar(45), clientIp(req))
      .input("user_agent", sql.NVarChar(1024), req.headers["user-agent"] || null)
      .input("metadata_json", sql.NVarChar(sql.MAX), metadata ? JSON.stringify(metadata) : null)
      .query(`
        INSERT INTO dbo.admin_audit_event (
          actor_type, actor_user_id, actor_label,
          event_code, resource_code, action_code, result_code,
          ip_address, user_agent, metadata_json
        )
        VALUES (
          @actor_type, @actor_user_id, @actor_label,
          @event_code, @resource_code, @action_code, @result_code,
          @ip_address, @user_agent, @metadata_json
        );
      `);
  } catch (auditErr) {
    console.error("[ADMIN AUTH AUDIT] Falha ao registrar evento:", eventCode, auditErr);
  }
}

async function getUserByEmail(pool, email) {
  const result = await pool.request()
    .input("email", sql.VarChar(255), email)
    .query(`
      SELECT TOP 1 user_id, email, full_name, password_hash, created_at, is_active, author_id
      FROM dbo.identity_user
      WHERE LOWER(email) = LOWER(@email);
    `);
  return result.recordset[0] || null;
}


async function getEffectiveAdminAccess(pool, userId) {
  const result = await pool.request()
    .input("user_id", sql.Int, Number(userId))
    .query(`
      SELECT DISTINCT
        r.role_code,
        r.role_name,
        p.permission_code,
        p.resource_code,
        p.action_code
      FROM dbo.admin_user_role ur
      INNER JOIN dbo.admin_role r
        ON r.role_id = ur.role_id
      LEFT JOIN dbo.admin_role_permission rp
        ON rp.role_id = r.role_id
       AND rp.revoked_at IS NULL
      LEFT JOIN dbo.admin_permission p
        ON p.permission_id = rp.permission_id
       AND p.is_active = 1
      WHERE ur.user_id = @user_id
        AND ur.revoked_at IS NULL
        AND r.is_active = 1
      ORDER BY r.role_code, p.permission_code;
    `);

  const roles = new Map();
  const permissions = new Set();

  for (const row of result.recordset || []) {
    if (!roles.has(row.role_code)) {
      roles.set(row.role_code, {
        role_code: row.role_code,
        role_name: row.role_name,
      });
    }
    if (row.permission_code) permissions.add(row.permission_code);
  }

  return {
    roles: [...roles.values()],
    permissions: [...permissions].sort(),
  };
}

async function getActiveAdminRoles(pool, userId) {
  const result = await pool.request()
    .input("user_id", sql.Int, Number(userId))
    .query(`
      SELECT DISTINCT r.role_id, r.role_code, r.role_name
      FROM dbo.admin_user_role ur
      INNER JOIN dbo.admin_role r ON r.role_id = ur.role_id
      WHERE ur.user_id = @user_id
        AND ur.revoked_at IS NULL
        AND r.is_active = 1
      ORDER BY r.role_code;
    `);
  return result.recordset;
}

router.post("/login", loginRateLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Campos obrigatórios: email, password." });
  }

  let pool;
  let userDb = null;

  try {
    pool = await getPool();
    userDb = await getUserByEmail(pool, String(email).trim());

    if (!userDb) {
      await writeAdminAuditSafe(pool, req, {
        actorLabel: String(email).trim().slice(0, 320),
        eventCode: "ADMIN_AUTH_LOGIN_DENIED",
        resultCode: "DENIED",
        metadata: { reason: "USER_NOT_FOUND" },
      });
      return res.status(401).json({ error: ADMIN_LOGIN_ERROR });
    }

    if (!isCorporateOperatorIdentity(userDb)) {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: userDb.user_id,
        actorLabel: userDb.email,
        eventCode: "ADMIN_AUTH_LOGIN_DENIED",
        resultCode: "DENIED",
        metadata: { reason: "NOT_CORPORATE_OPERATOR_IDENTITY" },
      });
      return res.status(401).json({ error: ADMIN_LOGIN_ERROR });
    }

    const passwordOk = await bcrypt.compare(password, userDb.password_hash);
    if (!passwordOk) {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: userDb.user_id,
        actorLabel: userDb.email,
        eventCode: "ADMIN_AUTH_LOGIN_DENIED",
        resultCode: "DENIED",
        metadata: { reason: "INVALID_PASSWORD" },
      });
      return res.status(401).json({ error: ADMIN_LOGIN_ERROR });
    }

    const activeRoles = await getActiveAdminRoles(pool, userDb.user_id);
    if (!activeRoles.length) {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: userDb.user_id,
        actorLabel: userDb.email,
        eventCode: "ADMIN_AUTH_LOGIN_DENIED",
        resultCode: "DENIED",
        metadata: { reason: "NO_ACTIVE_ADMIN_ROLE" },
      });
      return res.status(401).json({ error: ADMIN_LOGIN_ERROR });
    }

    const roles = activeRoles.map((r) => r.role_code);
    const accessToken = generateOperatorToken(userDb, roles);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const session = await createSession({
      userId: userDb.user_id,
      authorId: null,
      sessionContext: "OPERATOR",
      expiresAt,
      createdIp: clientIp(req),
      userAgent: req.headers["user-agent"] || null,
    });

    await writeAdminAuditSafe(pool, req, {
      actorUserId: userDb.user_id,
      actorLabel: userDb.email,
      eventCode: "ADMIN_AUTH_LOGIN_SUCCESS",
      resultCode: "SUCCESS",
      metadata: {
        session_id: session.session_id,
        session_context: "OPERATOR",
        roles,
      },
    });

    return res.json({
      user: {
        user_id: userDb.user_id,
        email: userDb.email,
        session_context: "OPERATOR",
        roles,
      },
      token: accessToken,
      access_token: accessToken,
      refresh_token: session.refresh_token,
    });
  } catch (err) {
    console.error("[POST /api/admin/auth/login] Erro SQL/geral:", err);
    if (pool) {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: userDb?.user_id || null,
        actorLabel: userDb?.email || String(email || "").slice(0, 320) || null,
        eventCode: "ADMIN_AUTH_LOGIN_FAILED",
        resultCode: "FAILED",
        metadata: { reason: "INTERNAL_ERROR" },
      });
    }
    return res.status(500).json({ error: "Erro ao realizar login administrativo." });
  }
});



// GET /api/admin/auth/me
// Contexto administrativo efetivo para o frontend. A autoridade continua
// sendo reavaliada nas APIs protegidas; este endpoint serve apenas para UX.
router.get("/me", authRequired, async (req, res) => {
  const sessionContext = String(req.user?.session_context || "").trim().toUpperCase();
  const userId = Number(req.user?.sub ?? req.user?.user_id ?? req.user?.id);

  if (sessionContext !== "OPERATOR" || !Number.isInteger(userId) || userId <= 0) {
    return res.status(403).json({
      error: "Acesso administrativo negado.",
      code: "ADMIN_FORBIDDEN",
    });
  }

  try {
    const pool = await getPool();
    const userResult = await pool.request()
      .input("user_id", sql.Int, userId)
      .query(`
        SELECT TOP 1 user_id, email, full_name, is_active, author_id
        FROM dbo.identity_user
        WHERE user_id = @user_id;
      `);

    const user = userResult.recordset?.[0] || null;
    if (!isCorporateOperatorIdentity(user)) {
      return res.status(403).json({
        error: "Acesso administrativo negado.",
        code: "ADMIN_FORBIDDEN",
      });
    }

    const access = await getEffectiveAdminAccess(pool, userId);
    if (!access.roles.length) {
      return res.status(403).json({
        error: "Acesso administrativo negado.",
        code: "ADMIN_FORBIDDEN",
      });
    }

    return res.json({
      ok: true,
      user: {
        user_id: user.user_id,
        email: user.email,
        full_name: user.full_name,
        // Operador corporativo é identidade exclusivamente administrativa.
        author_id: null,
        session_context: "OPERATOR",
      },
      roles: access.roles,
      permissions: access.permissions,
    });
  } catch (err) {
    console.error("[GET /api/admin/auth/me] Erro:", err);
    return res.status(500).json({
      error: "Falha ao consultar contexto administrativo.",
      code: "ADMIN_CONTEXT_ERROR",
    });
  }
});

router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body || {};

  if (!refresh_token) {
    return res.status(400).json({ error: "refresh_token é obrigatório." });
  }

  let pool;
  let session = null;
  let userDb = null;

  try {
    session = await getActiveSessionByRefreshToken(refresh_token);

    if (!session) {
      pool = await getPool();
      await writeAdminAuditSafe(pool, req, {
        eventCode: "ADMIN_AUTH_REFRESH_DENIED",
        actionCode: "REFRESH",
        resultCode: "DENIED",
        metadata: { reason: "INVALID_EXPIRED_OR_REVOKED_REFRESH_TOKEN" },
      });
      return res.status(401).json({
        error: "Refresh administrativo inválido, expirado ou revogado.",
      });
    }

    pool = await getPool();

    if (String(session.session_context || "").toUpperCase() !== "OPERATOR") {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: session.user_id,
        eventCode: "ADMIN_AUTH_REFRESH_DENIED",
        actionCode: "REFRESH",
        resultCode: "DENIED",
        metadata: {
          reason: "INVALID_SESSION_CONTEXT",
          session_id: session.session_id,
          session_context: session.session_context || null,
        },
      });
      return res.status(401).json({
        error: "Refresh administrativo inválido, expirado ou revogado.",
      });
    }

    const userResult = await pool.request()
      .input("user_id", sql.Int, Number(session.user_id))
      .query(`
        SELECT TOP 1 user_id, email, full_name, password_hash, created_at, is_active, author_id
        FROM dbo.identity_user
        WHERE user_id = @user_id;
      `);

    userDb = userResult.recordset[0] || null;

    if (!isCorporateOperatorIdentity(userDb)) {
      await revokeSessionByRefreshToken(refresh_token);
      await writeAdminAuditSafe(pool, req, {
        actorUserId: session.user_id,
        eventCode: "ADMIN_AUTH_REFRESH_DENIED",
        actionCode: "REFRESH",
        resultCode: "DENIED",
        metadata: { reason: "USER_NOT_FOUND_OR_NOT_CORPORATE_OPERATOR", session_id: session.session_id },
      });
      return res.status(401).json({
        error: "Refresh administrativo inválido, expirado ou revogado.",
      });
    }

    const activeRoles = await getActiveAdminRoles(pool, userDb.user_id);

    if (!activeRoles.length) {
      await revokeSessionByRefreshToken(refresh_token);
      await writeAdminAuditSafe(pool, req, {
        actorUserId: userDb.user_id,
        actorLabel: userDb.email,
        eventCode: "ADMIN_AUTH_REFRESH_DENIED",
        actionCode: "REFRESH",
        resultCode: "DENIED",
        metadata: {
          reason: "NO_ACTIVE_ADMIN_ROLE",
          session_id: session.session_id,
          session_revoked: true,
        },
      });
      return res.status(401).json({
        error: "Refresh administrativo inválido, expirado ou revogado.",
      });
    }

    const roles = activeRoles.map((r) => r.role_code);
    const accessToken = generateOperatorToken(userDb, roles);

    await writeAdminAuditSafe(pool, req, {
      actorUserId: userDb.user_id,
      actorLabel: userDb.email,
      eventCode: "ADMIN_AUTH_REFRESH_SUCCESS",
      actionCode: "REFRESH",
      resultCode: "SUCCESS",
      metadata: {
        session_id: session.session_id,
        session_context: "OPERATOR",
        roles,
      },
    });

    return res.json({
      user: {
        user_id: userDb.user_id,
        email: userDb.email,
        session_context: "OPERATOR",
        roles,
      },
      token: accessToken,
      access_token: accessToken,
      refresh_token,
    });
  } catch (err) {
    console.error("[POST /api/admin/auth/refresh] Erro SQL/geral:", err);
    if (pool) {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: userDb?.user_id || session?.user_id || null,
        actorLabel: userDb?.email || null,
        eventCode: "ADMIN_AUTH_REFRESH_FAILED",
        actionCode: "REFRESH",
        resultCode: "FAILED",
        metadata: {
          reason: "INTERNAL_ERROR",
          session_id: session?.session_id || null,
        },
      });
    }
    return res.status(500).json({ error: "Erro ao renovar sessão administrativa." });
  }
});


router.post("/logout", async (req, res) => {
  const { refresh_token } = req.body || {};

  if (!refresh_token) {
    return res.status(400).json({ error: "refresh_token é obrigatório." });
  }

  let pool;
  let session = null;

  try {
    session = await getActiveSessionByRefreshToken(refresh_token);
    pool = await getPool();

    if (!session) {
      await writeAdminAuditSafe(pool, req, {
        eventCode: "ADMIN_AUTH_LOGOUT_DENIED",
        actionCode: "LOGOUT",
        resultCode: "DENIED",
        metadata: { reason: "INVALID_EXPIRED_OR_REVOKED_REFRESH_TOKEN" },
      });
      return res.status(401).json({
        error: "Sessão administrativa inválida, expirada ou revogada.",
      });
    }

    if (String(session.session_context || "").toUpperCase() !== "OPERATOR") {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: session.user_id,
        eventCode: "ADMIN_AUTH_LOGOUT_DENIED",
        actionCode: "LOGOUT",
        resultCode: "DENIED",
        metadata: {
          reason: "INVALID_SESSION_CONTEXT",
          session_id: session.session_id,
          session_context: session.session_context || null,
        },
      });
      return res.status(401).json({
        error: "Sessão administrativa inválida, expirada ou revogada.",
      });
    }

    await revokeSessionByRefreshToken(refresh_token);

    const userResult = await pool.request()
      .input("user_id", sql.Int, Number(session.user_id))
      .query(`
        SELECT TOP 1 user_id, email
        FROM dbo.identity_user
        WHERE user_id = @user_id;
      `);
    const userDb = userResult.recordset[0] || null;

    await writeAdminAuditSafe(pool, req, {
      actorUserId: session.user_id,
      actorLabel: userDb?.email || null,
      eventCode: "ADMIN_AUTH_LOGOUT_SUCCESS",
      actionCode: "LOGOUT",
      resultCode: "SUCCESS",
      metadata: {
        session_id: session.session_id,
        session_context: "OPERATOR",
        session_revoked: true,
      },
    });

    return res.json({
      message: "Sessão administrativa encerrada com sucesso.",
    });
  } catch (err) {
    console.error("[POST /api/admin/auth/logout] Erro SQL/geral:", err);
    if (pool) {
      await writeAdminAuditSafe(pool, req, {
        actorUserId: session?.user_id || null,
        eventCode: "ADMIN_AUTH_LOGOUT_FAILED",
        actionCode: "LOGOUT",
        resultCode: "FAILED",
        metadata: {
          reason: "INTERNAL_ERROR",
          session_id: session?.session_id || null,
        },
      });
    }
    return res.status(500).json({ error: "Erro ao encerrar sessão administrativa." });
  }
});

export default router;
