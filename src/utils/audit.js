export function getAuditContext(req) {
  // headers opcionais (se você usar no futuro)
  const created_by =
    req.headers['x-user-code'] ||
    req.headers['x-created-by'] ||
    req.user?.email ||
    'unknown';

  const created_by_user_id =
    req.user?.sub ??
    req.user?.user_id ??
    req.user?.id ??
    null;

  const created_by_author_id =
    req.user?.author_id ??
    req.user?.authorId ??
    req.user?.author ??
    null;

  return {
    created_by: String(created_by),
    created_by_user_id: created_by_user_id != null ? Number(created_by_user_id) : null,
    created_by_author_id: created_by_author_id != null ? Number(created_by_author_id) : null
  };
}
