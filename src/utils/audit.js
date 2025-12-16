// src/utils/audit.js

// Vamos centralizar a lógica de "quem está criando o evento".
export function getAuditContext(req) {
  const API_TAG = 'hdud_api_v0.1';
  const SYSTEM_USER_ID = 2; // SYSTEM_KERNEL

  // Se veio token válido
  if (req?.auth?.isAuthenticated) {
    return {
      created_by: API_TAG,
      created_by_user_id: req.auth.userId ?? SYSTEM_USER_ID,
      created_by_author_id: req.auth.authorId ?? null,
    };
  }

  // Anônimo / sem token → SYSTEM_KERNEL
  return {
    created_by: API_TAG,
    created_by_user_id: SYSTEM_USER_ID,
    created_by_author_id: null,
  };
}
