// C:\HDUD_DATA\hdud-api-node\src\services\sessionService.js
// gerenciamento de sessões/refresh token

import { getPool, sql } from "../db.js";
import crypto from "crypto";

/**
 * Gera um GUID/UUID para usar como refresh token.
 * Aqui usamos token opaco simples.
 */
export function generateRefreshToken() {
  const buf = crypto.randomBytes(16);
  const hex = buf.toString("hex");

  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20),
  ].join("-");
}

function normalizeDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Cria uma nova sessão de refresh token para um author.
 */
export async function createSession({
  authorId,
  expiresAt,
  createdIp,
  userAgent,
}) {
  if (!authorId) {
    throw new Error("createSession requer authorId válido.");
  }

  const normalizedExpiresAt = normalizeDate(expiresAt);
  if (!normalizedExpiresAt) {
    throw new Error("createSession requer expiresAt válido.");
  }

  const pool = await getPool();
  const refreshToken = generateRefreshToken();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, Number(authorId))
    .input("refresh_token", sql.UniqueIdentifier, refreshToken)
    .input("expires_at", sql.DateTime2, normalizedExpiresAt)
    .input("created_ip", sql.VarChar(45), createdIp || null)
    .input("user_agent", sql.NVarChar(255), userAgent || null)
    .query(`
      INSERT INTO dbo.identity_session (
          author_id,
          refresh_token,
          expires_at,
          created_ip,
          user_agent
      )
      OUTPUT
          INSERTED.session_id,
          INSERTED.author_id,
          INSERTED.refresh_token,
          INSERTED.expires_at,
          INSERTED.is_revoked,
          INSERTED.created_at,
          INSERTED.created_ip,
          INSERTED.user_agent
      VALUES (
          @author_id,
          @refresh_token,
          @expires_at,
          @created_ip,
          @user_agent
      );
    `);

  return result.recordset[0] || null;
}

/**
 * Busca uma sessão ativa pelo refresh token.
 */
export async function getActiveSessionByRefreshToken(refreshToken) {
  if (!refreshToken) return null;

  const pool = await getPool();

  const result = await pool
    .request()
    .input("refresh_token", sql.UniqueIdentifier, refreshToken)
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

  if (!result.recordset.length) return null;

  const session = result.recordset[0];
  const now = new Date();
  const expiresAt = normalizeDate(session.expires_at);

  if (!expiresAt) return null;
  if (session.is_revoked) return null;
  if (expiresAt.getTime() <= now.getTime()) return null;

  return {
    ...session,
    expires_at: expiresAt,
  };
}

/**
 * Revoga uma sessão (logout).
 */
export async function revokeSessionByRefreshToken(refreshToken) {
  if (!refreshToken) return;

  const pool = await getPool();

  await pool
    .request()
    .input("refresh_token", sql.UniqueIdentifier, refreshToken)
    .query(`
      UPDATE dbo.identity_session
      SET is_revoked = 1
      WHERE refresh_token = @refresh_token;
    `);
}