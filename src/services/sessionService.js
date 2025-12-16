// src/services/sessionService.js — gerenciamento de sessões/refresh token

import { getPool, sql } from '../db.js';
import crypto from 'crypto';

/**
 * Gera um GUID/UUID para usar como refresh token.
 * (poderia ser JWT, mas aqui usamos token opaco simples)
 */
export function generateRefreshToken() {
  // GUID (formato padrão) usando crypto
  const buf = crypto.randomBytes(16);
  const hex = buf.toString('hex');

  // Formato 8-4-4-4-12
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20)
  ].join('-');
}

/**
 * Cria uma nova sessão de refresh token para um autor.
 */
export async function createSession({
  authorId,
  expiresAt,
  createdIp,
  userAgent
}) {
  const pool = await getPool();
  const refreshToken = generateRefreshToken();

  const result = await pool.request()
    .input('author_id', sql.BigInt, authorId)
    .input('refresh_token', sql.UniqueIdentifier, refreshToken)
    .input('expires_at', sql.DateTime2, expiresAt)
    .input('created_ip', sql.VarChar(45), createdIp || null)
    .input('user_agent', sql.NVarChar(255), userAgent || null)
    .query(`
      INSERT INTO dbo.identity_session (
          author_id,
          refresh_token,
          expires_at,
          created_ip,
          user_agent
      )
      OUTPUT INSERTED.session_id,
             INSERTED.author_id,
             INSERTED.refresh_token,
             INSERTED.expires_at,
             INSERTED.is_revoked,
             INSERTED.created_at,
             INSERTED.created_ip,
             INSERTED.user_agent
      VALUES (@author_id, @refresh_token, @expires_at, @created_ip, @user_agent);
    `);

  return result.recordset[0];
}

/**
 * Busca uma sessão ativa pelo refresh token.
 */
export async function getActiveSessionByRefreshToken(refreshToken) {
  const pool = await getPool();

  const result = await pool.request()
    .input('refresh_token', sql.UniqueIdentifier, refreshToken)
    .query(`
      SELECT TOP 1
        session_id,
        author_id,
        refresh_token,
        expires_at,
        is_revoked,
        created_at,
        created_ip,
        user_agent
      FROM dbo.identity_session
      WHERE refresh_token = @refresh_token;
    `);

  if (result.recordset.length === 0) return null;

  const session = result.recordset[0];

  // valida expiração e revogação
  const now = new Date();
  if (session.is_revoked || session.expires_at < now) {
    return null;
  }

  return session;
}

/**
 * Revoga uma sessão (logout).
 */
export async function revokeSessionByRefreshToken(refreshToken) {
  const pool = await getPool();

  await pool.request()
    .input('refresh_token', sql.UniqueIdentifier, refreshToken)
    .query(`
      UPDATE dbo.identity_session
      SET is_revoked = 1
      WHERE refresh_token = @refresh_token;
    `);
}
