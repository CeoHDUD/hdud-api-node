// src/middleware/auth.js — middleware JWT (v0.6 compatível com server.js)

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'hdud_dev_secret';

/**
 * Extrai token do header Authorization: Bearer <token>
 */
function extractToken(req) {
  const header =
    req.headers['authorization'] || req.headers['Authorization'];

  if (!header) return null;

  const parts = header.split(' ');
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;

  if (!/^Bearer$/i.test(scheme)) return null;

  return token;
}

/**
 * Middleware obrigatório — bloqueia acesso se não houver token
 */
export function authenticate(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const roles =
      Array.isArray(decoded.roles) && decoded.roles.length > 0
        ? decoded.roles
        : ['AUTHOR_SELF'];

    req.user = { ...decoded, roles };

    return next();
  } catch (err) {
    console.error('[AUTH] Token inválido:', err);
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

/**
 * Middleware opcional — NÃO BLOQUEIA a rota se token ausente
 */
export function optionalAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    // usuário anônimo
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const roles =
      Array.isArray(decoded.roles) && decoded.roles.length > 0
        ? decoded.roles
        : ['AUTHOR_SELF'];

    req.user = { ...decoded, roles };

    return next();
  } catch (err) {
    console.warn('[AUTH OPTIONAL] Token inválido — tratando como anônimo');
    req.user = null; // segue como anônimo
    return next();
  }
}
