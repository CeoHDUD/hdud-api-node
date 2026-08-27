// HDUD Admin — Implementação 04 | Authorization Engine
// Fonte de autoridade: RBAC administrativo ativo no SQL Server.
// Não usa roles do JWT, plano, author_id, AUTHOR_ADMIN ou SYSTEM_KERNEL.

import { getPool, sql } from "../db.js";
import { writeAdminAuditSafe } from "../services/adminAuditService.js";

const ADMIN_FORBIDDEN = Object.freeze({
  error: "Acesso administrativo negado.",
  code: "ADMIN_FORBIDDEN",
});

function asPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizePermissionCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return code || null;
}

async function auditDenied(pool, req, userId, permissionCode, reason) {
  await writeAdminAuditSafe(pool, req, {
    actorUserId: userId,
    actorLabel: req.user?.email || null,
    eventCode: "ADMIN_AUTHORIZATION_DENIED",
    resultCode: "DENIED",
    metadata: {
      permission_code: permissionCode,
      session_context: req.user?.session_context || null,
      reason,
    },
  });
}

async function auditAllowed(pool, req, userId, permissionCode, matchedRoleCode) {
  await writeAdminAuditSafe(pool, req, {
    actorUserId: userId,
    actorLabel: req.user?.email || null,
    eventCode: "ADMIN_AUTHORIZATION_ALLOWED",
    resultCode: "SUCCESS",
    metadata: {
      permission_code: permissionCode,
      session_context: "OPERATOR",
      matched_role_code: matchedRoleCode || null,
    },
  });
}

export function requireAdminPermission(requiredPermissionCode) {
  const permissionCode = normalizePermissionCode(requiredPermissionCode);
  if (!permissionCode) {
    throw new Error("requireAdminPermission exige permission_code explícita.");
  }

  return async function adminAuthorization(req, res, next) {
    let pool = null;
    const sessionContext = String(req.user?.session_context || "").trim().toUpperCase();
    const userId = asPositiveInt(req.user?.sub ?? req.user?.user_id ?? req.user?.id);

    try {
      pool = await getPool();

      if (sessionContext !== "OPERATOR") {
        await auditDenied(pool, req, userId, permissionCode, "INVALID_SESSION_CONTEXT");
        return res.status(403).json(ADMIN_FORBIDDEN);
      }

      if (!userId) {
        await auditDenied(pool, req, null, permissionCode, "MISSING_USER_ID");
        return res.status(403).json(ADMIN_FORBIDDEN);
      }

      const permissionResult = await pool.request()
        .input("permission_code", sql.VarChar(100), permissionCode)
        .query(`
          SELECT TOP (1)
            p.permission_id,
            p.permission_code,
            p.is_active
          FROM dbo.admin_permission p
          WHERE p.permission_code = @permission_code;
        `);

      const permission = permissionResult.recordset?.[0] || null;
      if (!permission || Number(permission.is_active) !== 1) {
        await auditDenied(pool, req, userId, permissionCode, "PERMISSION_NOT_FOUND_OR_INACTIVE");
        return res.status(403).json(ADMIN_FORBIDDEN);
      }

      const effectiveResult = await pool.request()
        .input("user_id", sql.Int, userId)
        .input("permission_id", sql.Int, Number(permission.permission_id))
        .query(`
          SELECT TOP (1)
            r.role_id,
            r.role_code,
            p.permission_id,
            p.permission_code
          FROM dbo.admin_user_role ur
          INNER JOIN dbo.admin_role r
            ON r.role_id = ur.role_id
          INNER JOIN dbo.admin_role_permission rp
            ON rp.role_id = r.role_id
          INNER JOIN dbo.admin_permission p
            ON p.permission_id = rp.permission_id
          WHERE ur.user_id = @user_id
            AND ur.revoked_at IS NULL
            AND r.is_active = 1
            AND rp.revoked_at IS NULL
            AND p.is_active = 1
            AND p.permission_id = @permission_id
          ORDER BY r.role_id;
        `);

      const effective = effectiveResult.recordset?.[0] || null;
      if (!effective) {
        await auditDenied(pool, req, userId, permissionCode, "NO_EFFECTIVE_PERMISSION");
        return res.status(403).json(ADMIN_FORBIDDEN);
      }

      req.adminAuthorization = {
        user_id: userId,
        permission_id: Number(effective.permission_id),
        permission_code: effective.permission_code,
        matched_role_id: Number(effective.role_id),
        matched_role_code: effective.role_code,
      };

      await auditAllowed(pool, req, userId, permissionCode, effective.role_code);
      return next();
    } catch (err) {
      console.error("[ADMIN AUTHORIZATION] Erro operacional:", err);

      if (pool) {
        await writeAdminAuditSafe(pool, req, {
          actorUserId: userId,
          actorLabel: req.user?.email || null,
          eventCode: "ADMIN_AUTHORIZATION_FAILED",
          resultCode: "FAILED",
          metadata: {
            permission_code: permissionCode,
            session_context: req.user?.session_context || null,
            reason: "INTERNAL_ERROR",
          },
        });
      }

      return res.status(500).json({
        error: "Falha interna ao avaliar autorização administrativa.",
        code: "ADMIN_AUTHORIZATION_ERROR",
      });
    }
  };
}
