// authMiddleware.js — HDUD API v0.6
import jwt from 'jsonwebtoken';

/**
 * Middleware padrão de autenticação JWT
 * - Lê Authorization: Bearer <token>
 * - Valida o token
 * - Injeta req.user = { user_id, email, author_id }
 */

export function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2) {
    return res.status(401).json({ error: 'Token malformado.' });
  }

  const [scheme, token] = parts;

  if (!/^Bearer$/i.test(scheme)) {
    return res.status(401).json({ error: 'Token malformado.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Converte valores para número garantindo padronização
    req.user = {
      user_id: Number(decoded.sub),      // "subject" = user_id
      email: decoded.email,
      author_id: Number(decoded.author_id)
    };

    return next();
  } catch (err) {
    console.error('[authMiddleware] Token inválido:', err.message);
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}
