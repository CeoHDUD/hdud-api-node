// middleware/roles.js — RBAC básico para HDUD API

export const ROLES = {
  AUTHOR_SELF: 'AUTHOR_SELF',
  AUTHOR_ADMIN: 'AUTHOR_ADMIN',
  SYSTEM_KERNEL: 'SYSTEM_KERNEL',
};

/**
 * Verifica se o usuário possui um dos papéis informados.
 */
export function userHasRole(user, ...requiredRoles) {
  if (!user) return false;

  const userRoles = Array.isArray(user.roles) ? user.roles : [];

  // SYSTEM_KERNEL sempre tem permissão total
  if (userRoles.includes(ROLES.SYSTEM_KERNEL)) {
    return true;
  }

  return requiredRoles.some((role) => userRoles.includes(role));
}

/**
 * Middleware para exigir um ou mais papéis.
 * Exemplo: requireRoles(ROLES.AUTHOR_ADMIN)
 */
export function requireRoles(...requiredRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }

    if (userHasRole(req.user, ...requiredRoles)) {
      return next();
    }

    return res.status(403).json({
      error: 'Acesso negado. Permissões insuficientes.',
    });
  };
}
