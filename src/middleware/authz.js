/**
 * authz.js — Compatibility Layer
 * Mantido apenas para compatibilidade com imports antigos.
 * TODO: remover quando todos os imports forem migrados.
 */

export { authenticate, optionalAuth } from "./auth.js";
export { requireRoles, ROLES } from "./roles.js";
