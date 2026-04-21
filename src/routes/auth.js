// C:\HDUD_DATA\hdud-api-node\src\routes\auth.js

import { Router } from "express";
import { getPool, sql } from "../db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  createSession,
  getActiveSessionByRefreshToken,
  revokeSessionByRefreshToken,
} from "../services/sessionService.js";
import { authenticate } from "../middleware/auth.js";
import {
  loginRateLimiter,
  signupRateLimiter,
} from "../middleware/rateLimit.js";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || "hdud_dev_secret";

// =======================
// JWT TTL (controle de demo vs produção)
// =======================
const DEFAULT_DEV_EXPIRES_IN = "24h";
const DEFAULT_PROD_EXPIRES_IN = "24h";
const STRICT_PROD_EXPIRES_IN = "15m";

const isStrictProd =
  String(process.env.JWT_STRICT_PROD || "false").toLowerCase() === "true";

const isProd = process.env.NODE_ENV === "production";

const JWT_EXPIRES_IN =
  process.env.JWT_EXPIRES_IN ||
  (isProd
    ? isStrictProd
      ? STRICT_PROD_EXPIRES_IN
      : DEFAULT_PROD_EXPIRES_IN
    : DEFAULT_DEV_EXPIRES_IN);

function generateToken(user) {
  const payload = {
    sub: user.user_id,
    email: user.email,
  };

  if (user.author_id) {
    payload.author_id = user.author_id;
  }

  if (Array.isArray(user.roles) && user.roles.length > 0) {
    payload.roles = user.roles;
  } else {
    payload.roles = ["AUTHOR_SELF"];
  }

  return jwt.sign(payload, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: JWT_EXPIRES_IN,
  });
}

function buildAuthorCodeFromIdentity({ email, fullName, userId }) {
  const emailBase = String(email || "")
    .split("@")[0]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  const nameBase = String(fullName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  const base = emailBase || nameBase || `author_${userId || "user"}`;
  const suffix = userId ? String(userId) : String(Date.now());

  return `${base}_${suffix}`.slice(0, 50);
}

async function registerIdentityEventSafe(pool, params) {
  try {
    await pool
      .request()
      .input("event_type", sql.VarChar(50), params.event_type)
      .input("entity_type", sql.VarChar(50), params.entity_type)
      .input("entity_id", sql.BigInt, params.entity_id)
      .input("version_number", sql.Int, params.version_number ?? 1)
      .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify(params.payload_json || {}))
      .input("created_by", sql.VarChar(100), params.created_by || "hdud_api_v0.6")
      .execute("dbo.p_RegisterIdentityEvent");
  } catch (err) {
    console.error("[LEDGER] Falha ao registrar evento:", params.event_type, err);
  }
}

async function getAuthorById(pool, authorId) {
  if (!authorId) return null;

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .query(`
      SELECT TOP 1
        author_id,
        author_code,
        full_name,
        created_at
      FROM dbo.identity_author
      WHERE author_id = @author_id;
    `);

  return result.recordset[0] || null;
}

async function getUserById(pool, userId) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, userId)
    .query(`
      SELECT TOP 1
        user_id,
        email,
        password_hash,
        created_at,
        author_id
      FROM dbo.identity_user
      WHERE user_id = @user_id;
    `);

  return result.recordset[0] || null;
}

async function getUserByEmail(pool, email) {
  const result = await pool
    .request()
    .input("email", sql.VarChar(255), email)
    .query(`
      SELECT TOP 1
        user_id,
        email,
        password_hash,
        created_at,
        author_id
      FROM dbo.identity_user
      WHERE email = @email;
    `);

  return result.recordset[0] || null;
}

async function getUserByAuthorId(pool, authorId) {
  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .query(`
      SELECT TOP 1
        user_id,
        email,
        password_hash,
        created_at,
        author_id
      FROM dbo.identity_user
      WHERE author_id = @author_id
      ORDER BY user_id DESC;
    `);

  return result.recordset[0] || null;
}

async function ensureAuthorForUser(pool, user, fullNameFallback = null, preferredAuthorCode = null) {
  if (!user?.user_id) {
    throw new Error("ensureAuthorForUser requer user válido.");
  }

  if (user.author_id) {
    const existingAuthor = await getAuthorById(pool, user.author_id);
    if (existingAuthor) return existingAuthor;
  }

  let author = null;

  if (preferredAuthorCode) {
    const found = await pool
      .request()
      .input("author_code", sql.VarChar(50), preferredAuthorCode)
      .query(`
        SELECT TOP 1
          author_id,
          author_code,
          full_name,
          created_at
        FROM dbo.identity_author
        WHERE author_code = @author_code;
      `);

    if (found.recordset.length > 0) {
      author = found.recordset[0];
    }
  }

  if (!author) {
    const generatedAuthorCode = buildAuthorCodeFromIdentity({
      email: user.email,
      fullName: fullNameFallback,
      userId: user.user_id,
    });

    const authorCode = preferredAuthorCode || generatedAuthorCode;
    const authorFullName =
      fullNameFallback ||
      user.full_name ||
      user.email ||
      `Usuário ${user.user_id}`;

    const insertAuthor = await pool
      .request()
      .input("author_code", sql.VarChar(50), authorCode)
      .input("full_name", sql.NVarChar(200), authorFullName)
      .query(`
        INSERT INTO dbo.identity_author (author_code, full_name)
        OUTPUT
          INSERTED.author_id,
          INSERTED.author_code,
          INSERTED.full_name,
          INSERTED.created_at
        VALUES (@author_code, @full_name);
      `);

    author = insertAuthor.recordset[0];

    await registerIdentityEventSafe(pool, {
      event_type: "AUTHOR_CREATED",
      entity_type: "AUTHOR",
      entity_id: author.author_id,
      payload_json: {
        author_id: author.author_id,
        author_code: author.author_code,
        full_name: author.full_name,
      },
    });
  }

  await pool
    .request()
    .input("user_id", sql.BigInt, user.user_id)
    .input("author_id", sql.BigInt, author.author_id)
    .query(`
      UPDATE dbo.identity_user
      SET author_id = @author_id
      WHERE user_id = @user_id;
    `);

  return author;
}

function buildUserPayload(userDb) {
  return {
    user_id: userDb.user_id,
    email: userDb.email,
    created_at: userDb.created_at,
    full_name: userDb.full_name || null,
    author_id: userDb.author_id,
    roles: ["AUTHOR_SELF"],
  };
}

/**
 * POST /auth/signup
 */
router.post("/signup", signupRateLimiter, async (req, res) => {
  const { email, password, full_name, author_code } = req.body || {};

  if (!email || !password || !full_name) {
    return res.status(400).json({
      error:
        "Campos obrigatórios: email, password, full_name (e opcionalmente author_code).",
    });
  }

  try {
    const pool = await getPool();

    const existingUser = await getUserByEmail(pool, email);
    if (existingUser) {
      return res.status(409).json({ error: "Já existe um usuário com este e-mail." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const insertUser = await pool
      .request()
      .input("email", sql.VarChar(255), email)
      .input("password_hash", sql.VarChar(255), passwordHash)
      .input("author_id", sql.BigInt, null)
      .query(`
        INSERT INTO dbo.identity_user (email, password_hash, author_id)
        OUTPUT
          INSERTED.user_id,
          INSERTED.email,
          INSERTED.author_id,
          INSERTED.created_at
        VALUES (@email, @password_hash, @author_id);
      `);

    const userDbInserted = insertUser.recordset[0];

    const author = await ensureAuthorForUser(
      pool,
      {
        ...userDbInserted,
        full_name,
      },
      full_name,
      author_code || null
    );

    const userDb = await getUserById(pool, userDbInserted.user_id);

    const user = buildUserPayload({
      ...userDb,
      full_name,
    });

    const accessToken = generateToken(user);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const createdIp = req.ip || null;
    const userAgent = req.headers["user-agent"] || null;

    const session = await createSession({
      authorId: user.author_id,
      expiresAt,
      createdIp,
      userAgent,
    });

    await registerIdentityEventSafe(pool, {
      event_type: "USER_CREATED",
      entity_type: "USER",
      entity_id: user.user_id,
      payload_json: {
        user_id: user.user_id,
        email: user.email,
        full_name,
        author_id: user.author_id,
      },
    });

    return res.status(201).json({
      user,
      author,
      token: accessToken,
      access_token: accessToken,
      refresh_token: session.refresh_token,
    });
  } catch (err) {
    console.error("[POST /auth/signup] Erro SQL/geral:", err);
    return res.status(500).json({ error: "Erro ao realizar signup." });
  }
});

/**
 * POST /auth/login
 */
router.post("/login", loginRateLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      error: "Campos obrigatórios: email, password.",
    });
  }

  try {
    const pool = await getPool();

    const userDb = await getUserByEmail(pool, email);

    if (!userDb) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    const ok = await bcrypt.compare(password, userDb.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    let author = null;

    if (!userDb.author_id) {
      author = await ensureAuthorForUser(pool, userDb, null, null);
      userDb.author_id = author.author_id;
    } else {
      author = await getAuthorById(pool, userDb.author_id);
    }

    const user = buildUserPayload(userDb);
    const accessToken = generateToken(user);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const createdIp = req.ip || null;
    const userAgent = req.headers["user-agent"] || null;

    const session = await createSession({
      authorId: user.author_id,
      expiresAt,
      createdIp,
      userAgent,
    });

    return res.json({
      user,
      author,
      token: accessToken,
      access_token: accessToken,
      refresh_token: session.refresh_token,
    });
  } catch (err) {
    console.error("[POST /auth/login] Erro SQL/geral:", err);
    return res.status(500).json({ error: "Erro ao realizar login." });
  }
});

/**
 * POST /auth/refresh
 */
router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body || {};

  if (!refresh_token) {
    return res.status(400).json({ error: "refresh_token é obrigatório." });
  }

  try {
    const session = await getActiveSessionByRefreshToken(refresh_token);

    if (!session) {
      return res
        .status(401)
        .json({ error: "Refresh token inválido, expirado ou revogado." });
    }

    const pool = await getPool();

    const userDb = await getUserByAuthorId(pool, session.author_id);

    if (!userDb) {
      return res.status(404).json({
        error: "Usuário não encontrado para este token.",
      });
    }

    const author = userDb.author_id ? await getAuthorById(pool, userDb.author_id) : null;
    const user = buildUserPayload(userDb);
    const accessToken = generateToken(user);

    return res.json({
      user,
      author,
      access_token: accessToken,
      refresh_token,
      token: accessToken,
    });
  } catch (err) {
    console.error("[POST /auth/refresh] Erro:", err);
    return res.status(500).json({ error: "Erro ao renovar token." });
  }
});

/**
 * POST /auth/logout
 */
router.post("/logout", async (req, res) => {
  const { refresh_token } = req.body || {};

  if (!refresh_token) {
    return res.status(400).json({ error: "refresh_token é obrigatório." });
  }

  try {
    await revokeSessionByRefreshToken(refresh_token);

    return res.json({
      message: "Sessão encerrada com sucesso.",
    });
  } catch (err) {
    console.error("[POST /auth/logout] Erro:", err);
    return res.status(500).json({ error: "Erro ao encerrar sessão." });
  }
});

/**
 * GET /auth/me
 */
router.get("/me", authenticate, async (req, res) => {
  try {
    if (!req.user?.sub) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const pool = await getPool();

    const userId = req.user.sub;
    const authorId = req.user.author_id || null;

    const userResult = await pool
      .request()
      .input("user_id", sql.BigInt, userId)
      .query(`
        SELECT
          user_id,
          email,
          created_at,
          author_id
        FROM dbo.identity_user
        WHERE user_id = @user_id;
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    const userDb = userResult.recordset[0];

    let author = null;
    if (authorId) {
      author = await getAuthorById(pool, authorId);
    }

    return res.json({
      user: {
        user_id: userDb.user_id,
        email: userDb.email,
        created_at: userDb.created_at,
        author_id: userDb.author_id,
        roles: req.user.roles || ["AUTHOR_SELF"],
      },
      author,
    });
  } catch (err) {
    console.error("[GET /auth/me] Erro:", err);
    return res.status(500).json({ error: "Erro ao obter dados do usuário." });
  }
});

export default router;