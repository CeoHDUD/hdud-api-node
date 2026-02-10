// C:\HDUD_DATA\hdud-api-node\src\middleware\auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "hdud_dev_secret";

function extractToken(req) {
  const header = req.headers["authorization"] || req.headers["Authorization"];
  if (!header) return null;

  const parts = String(header).split(" ");
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;
  if (!/^Bearer$/i.test(scheme)) return null;

  return token || null;
}

// opcional: se não tiver token, passa
export function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({
      error: "Token inválido ou expirado",
      detail: err?.message || "unauthorized",
    });
  }
}

// obrigatório: sem token = 401
export function authRequired(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Token ausente" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({
      error: "Token inválido ou expirado",
      detail: err?.message || "unauthorized",
    });
  }
}

// ✅ Compat: se algum router antigo importar outro nome, não quebra
export const requireAuth = authRequired;
