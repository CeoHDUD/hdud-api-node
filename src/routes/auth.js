// C:\HDUD_DATA\hdud-api-node\src\routes\auth.js
// login + refresh token + logout + author_id + /auth/me + rate limit em login/signup

import { Router } from 'express';
import { getPool, sql } from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  createSession,
  getActiveSessionByRefreshToken,
  revokeSessionByRefreshToken,
} from '../services/sessionService.js';
import { authenticate } from '../middleware/auth.js';
import {
  loginRateLimiter,
  signupRateLimiter,
} from '../middleware/rateLimit.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'hdud_dev_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';

/**
 * Gera um JWT simples com:
 *  - sub (user_id)
 *  - email
 *  - (opcional) author_id
 *  - (opcional) roles
 */
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
    payload.roles = ['AUTHOR_SELF'];
  }

  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * POST /auth/signup
 */
router.post('/signup', signupRateLimiter, async (req, res) => {
  const { email, password, full_name, author_code } = req.body || {};

  if (!email || !password || !full_name) {
    return res.status(400).json({
      error:
        'Campos obrigatórios: email, password, full_name (e opcionalmente author_code).',
    });
  }

  try {
    const pool = await getPool();

    const existingUser = await pool
      .request()
      .input('email', sql.VarChar(255), email)
      .query(`
        SELECT TOP 1 user_id, email
        FROM dbo.identity_user
        WHERE email = @email;
      `);

    if (existingUser.recordset.length > 0) {
      return res.status(409).json({ error: 'Já existe um usuário com este e-mail.' });
    }

    let author = null;
    let authorId = null;

    if (author_code) {
      const existingAuthor = await pool
        .request()
        .input('author_code', sql.VarChar(50), author_code)
        .query(`
          SELECT TOP 1 author_id, author_code, full_name, created_at
          FROM dbo.identity_author
          WHERE author_code = @author_code;
        `);

      if (existingAuthor.recordset.length > 0) {
        author = existingAuthor.recordset[0];
        authorId = author.author_id;
      } else {
        const insertAuthor = await pool
          .request()
          .input('author_code', sql.VarChar(50), author_code)
          .input('full_name', sql.NVarChar(200), full_name)
          .query(`
            INSERT INTO dbo.identity_author (author_code, full_name)
            OUTPUT INSERTED.author_id,
                   INSERTED.author_code,
                   INSERTED.full_name,
                   INSERTED.created_at
            VALUES (@author_code, @full_name);
          `);

        author = insertAuthor.recordset[0];
        authorId = author.author_id;

        const authorPayload = {
          author_id: author.author_id,
          author_code: author.author_code,
          full_name: author.full_name,
        };

        try {
          await pool
            .request()
            .input('event_type', sql.VarChar(50), 'AUTHOR_CREATED')
            .input('entity_type', sql.VarChar(50), 'AUTHOR')
            .input('entity_id', sql.BigInt, author.author_id)
            .input('version_number', sql.Int, 1)
            .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(authorPayload))
            .input('created_by', sql.VarChar(100), 'hdud_api_v0.6')
            .execute('dbo.p_RegisterIdentityEvent');
        } catch (ledgerErr) {
          console.error(
            '[LEDGER] Erro ao registrar AUTHOR_CREATED via signup:',
            ledgerErr
          );
        }
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const insertUser = await pool
      .request()
      .input('email', sql.VarChar(255), email)
      .input('password_hash', sql.VarChar(255), passwordHash)
      .input('author_id', sql.BigInt, authorId ?? null)
      .query(`
        INSERT INTO dbo.identity_user (email, password_hash, author_id)
        OUTPUT INSERTED.user_id,
               INSERTED.email,
               INSERTED.author_id,
               INSERTED.created_at
        VALUES (@email, @password_hash, @author_id);
      `);

    const userDb = insertUser.recordset[0];

    const user = {
      user_id: userDb.user_id,
      email: userDb.email,
      created_at: userDb.created_at,
      full_name,
      author_id: userDb.author_id,
      roles: ['AUTHOR_SELF'],
    };

    const accessToken = generateToken(user);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const createdIp = req.ip || null;
    const userAgent = req.headers['user-agent'] || null;

    const session = await createSession({
      authorId: user.user_id,
      expiresAt,
      createdIp,
      userAgent,
    });

    const refreshToken = session.refresh_token;

    const userPayload = {
      user_id: user.user_id,
      email: user.email,
      full_name: user.full_name,
      author_id: user.author_id,
    };

    try {
      await pool
        .request()
        .input('event_type', sql.VarChar(50), 'USER_CREATED')
        .input('entity_type', sql.VarChar(50), 'USER')
        .input('entity_id', sql.BigInt, user.user_id)
        .input('version_number', sql.Int, 1)
        .input('payload_json', sql.NVarChar(sql.MAX), JSON.stringify(userPayload))
        .input('created_by', sql.VarChar(100), 'hdud_api_v0.6')
        .execute('dbo.p_RegisterIdentityEvent');
    } catch (ledgerErr) {
      console.error('[LEDGER] Erro ao registrar USER_CREATED:', ledgerErr);
    }

    return res.status(201).json({
      user,
      author,
      token: accessToken,
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (err) {
    console.error('[POST /auth/signup] Erro SQL/geral:', err);
    return res.status(500).json({ error: 'Erro ao realizar signup.' });
  }
});

/**
 * POST /auth/login
 */
router.post('/login', loginRateLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      error: 'Campos obrigatórios: email, password.',
    });
  }

  try {
    const pool = await getPool();

    const result = await pool
      .request()
      .input('email', sql.VarChar(255), email)
      .query(`
        SELECT
          user_id,
          email,
          password_hash,
          created_at,
          author_id
        FROM dbo.identity_user
        WHERE email = @email;
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const userDb = result.recordset[0];

    const ok = await bcrypt.compare(password, userDb.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const user = {
      user_id: userDb.user_id,
      email: userDb.email,
      created_at: userDb.created_at,
      full_name: null,
      author_id: userDb.author_id,
      roles: ['AUTHOR_SELF'],
    };

    const accessToken = generateToken(user);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const createdIp = req.ip || null;
    const userAgent = req.headers['user-agent'] || null;

    const session = await createSession({
      authorId: user.user_id,
      expiresAt,
      createdIp,
      userAgent,
    });

    const refreshToken = session.refresh_token;

    delete userDb.password_hash;

    return res.json({
      user,
      token: accessToken,
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (err) {
    console.error('[POST /auth/login] Erro SQL/geral:', err);
    return res.status(500).json({ error: 'Erro ao realizar login.' });
  }
});

/**
 * POST /auth/refresh
 */
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body || {};

  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token é obrigatório.' });
  }

  try {
    const session = await getActiveSessionByRefreshToken(refresh_token);

    if (!session) {
      return res
        .status(401)
        .json({ error: 'Refresh token inválido, expirado ou revogado.' });
    }

    const pool = await getPool();

    const userResult = await pool
      .request()
      .input('user_id', sql.BigInt, session.author_id)
      .query(`
        SELECT TOP 1
          user_id,
          email,
          created_at,
          author_id
        FROM dbo.identity_user
        WHERE user_id = @user_id;
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado para este token.' });
    }

    const userDb = userResult.recordset[0];

    const user = {
      user_id: userDb.user_id,
      email: userDb.email,
      created_at: userDb.created_at,
      full_name: null,
      author_id: userDb.author_id,
      roles: ['AUTHOR_SELF'],
    };

    const accessToken = generateToken(user);

    return res.json({
      user,
      access_token: accessToken,
      refresh_token,
      token: accessToken,
    });
  } catch (err) {
    console.error('[POST /auth/refresh] Erro:', err);
    return res.status(500).json({ error: 'Erro ao renovar token.' });
  }
});

/**
 * POST /auth/logout
 */
router.post('/logout', async (req, res) => {
  const { refresh_token } = req.body || {};

  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token é obrigatório.' });
  }

  try {
    await revokeSessionByRefreshToken(refresh_token);

    return res.json({
      message: 'Sessão encerrada com sucesso.',
    });
  } catch (err) {
    console.error('[POST /auth/logout] Erro:', err);
    return res.status(500).json({ error: 'Erro ao encerrar sessão.' });
  }
});

/**
 * GET /auth/me
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const pool = await getPool();

    const userId = req.user.sub;
    const authorId = req.user.author_id || null;

    const userResult = await pool
      .request()
      .input('user_id', sql.BigInt, userId)
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
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const userDb = userResult.recordset[0];

    let author = null;
    if (authorId) {
      const authorResult = await pool
        .request()
        .input('author_id', sql.BigInt, authorId)
        .query(`
          SELECT
            author_id,
            author_code,
            full_name,
            created_at
          FROM dbo.identity_author
          WHERE author_id = @author_id;
        `);

      if (authorResult.recordset.length > 0) {
        author = authorResult.recordset[0];
      }
    }

    return res.json({
      user: {
        user_id: userDb.user_id,
        email: userDb.email,
        created_at: userDb.created_at,
        author_id: userDb.author_id,
        roles: req.user.roles || ['AUTHOR_SELF'],
      },
      author,
    });
  } catch (err) {
    console.error('[GET /auth/me] Erro:', err);
    return res.status(500).json({ error: 'Erro ao obter dados do usuário.' });
  }
});

export default router;
