export const ROLES = {
  AUTHOR_SELF: 'AUTHOR_SELF',
  AUTHOR_ADMIN: 'AUTHOR_ADMIN',
  SYSTEM_KERNEL: 'SYSTEM_KERNEL',
};

export function userHasRole(user, ...requiredRoles) {
  if (!user) return false;

  const roles = Array.isArray(user.roles) ? user.roles : [];

  if (roles.includes(ROLES.SYSTEM_KERNEL)) return true;

  return requiredRoles.some(r => roles.includes(r));
}

export function requireRoles(...requiredRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }

    if (userHasRole(req.user, ...requiredRoles)) {
      return next();
    }

    return res.status(403).json({ error: 'Permissão negada.' });
  };
}
