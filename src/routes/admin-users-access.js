// HDUD Admin — Implementação 05 | Admin APIs — Users & Access
// Primeiro domínio administrativo real sobre o Authorization Engine homologado.
// Identidade humana = identity_user. Autor, plano e ownership editorial não participam da autoridade.

import { Router } from "express";
import bcrypt from "bcryptjs";
import { authRequired } from "../middleware/auth.js";
import { requireAdminPermission } from "../middleware/adminAuthorization.js";
import { getPool, sql } from "../db.js";
import { writeAdminAuditSafe } from "../services/adminAuditService.js";

const router = Router();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const CORPORATE_OPERATOR_DOMAIN = "@hdud.ai";
const ASSIGNABLE_OPERATOR_ROLE_CODES = new Set([
  "COMMERCIAL_ADMIN",
  "CAMPAIGN_ADMIN",
  "AI_ADMIN",
  "METRICS_VIEWER",
  "ADS_ADMIN",
  "OPERATOR_ADMIN",
]);

function asPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeRoleCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return code || null;
}

function normalizeReason(value) {
  const reason = String(value || "").trim();
  return reason ? reason.slice(0, 500) : null;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 255) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function isCorporateOperatorEmail(email) {
  return String(email || "").trim().toLowerCase().endsWith(CORPORATE_OPERATOR_DOMAIN);
}

function normalizeFullName(value) {
  const fullName = String(value || "").trim();
  return fullName ? fullName.slice(0, 200) : null;
}

function normalizeDepartmentName(value) {
  const departmentName = String(value || "").trim();
  return departmentName ? departmentName.slice(0, 120) : null;
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 10 && value.length <= 200;
}

function actorUserId(req) {
  return asPositiveInt(req.user?.sub ?? req.user?.user_id ?? req.user?.id);
}

function actorLabel(req) {
  return req.user?.email || null;
}

function isUniqueViolation(err) {
  const number = Number(err?.number ?? err?.originalError?.info?.number);
  return number === 2601 || number === 2627;
}

async function auditDomain(pool, req, {
  eventCode,
  actionCode = "READ",
  resultCode = "SUCCESS",
  targetType = null,
  targetId = null,
  before = null,
  after = null,
  metadata = null,
  resourceCode = null,
}) {
  return writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: actorLabel(req),
    eventCode,
    resourceCode: resourceCode || (actionCode === "READ" && eventCode.startsWith("ADMIN_USER_") && !eventCode.includes("ROLE") && !eventCode.includes("ACCESS")
      ? "USER"
      : "RBAC"),
    actionCode,
    resultCode,
    targetType,
    targetId: targetId == null ? null : String(targetId),
    before,
    after,
    metadata,
  });
}

async function fetchUser(pool, userId) {
  const result = await pool.request()
    .input("user_id", sql.Int, userId)
    .input("operator_domain", sql.NVarChar(20), `%${CORPORATE_OPERATOR_DOMAIN}`)
    .query(`
      SELECT TOP (1)
        u.user_id,
        u.email,
        u.full_name,
        u.auth_provider,
        u.is_active,
        u.created_at,
        u.last_login_at,
        u.author_id,
        op.department_name
      FROM dbo.identity_user u
      LEFT JOIN dbo.admin_operator_profile op ON op.user_id = u.user_id
      WHERE u.user_id = @user_id
        AND u.author_id IS NULL
        AND LOWER(u.email) LIKE @operator_domain;
    `);
  return result.recordset?.[0] || null;
}

async function fetchRole(pool, roleCode) {
  const result = await pool.request()
    .input("role_code", sql.VarChar(60), roleCode)
    .query(`
      SELECT TOP (1)
        r.role_id,
        r.role_code,
        r.role_name,
        r.description,
        r.is_active,
        r.created_at,
        r.updated_at
      FROM dbo.admin_role r
      WHERE r.role_code = @role_code;
    `);
  return result.recordset?.[0] || null;
}

async function actorIsSuperAdmin(pool, userId) {
  if (!userId) return false;
  const result = await pool.request()
    .input("user_id", sql.Int, userId)
    .query(`
      SELECT TOP (1) 1 AS ok
      FROM dbo.admin_user_role ur
      INNER JOIN dbo.admin_role r ON r.role_id = ur.role_id
      WHERE ur.user_id = @user_id
        AND ur.revoked_at IS NULL
        AND r.is_active = 1
        AND r.role_code = 'SUPER_ADMIN';
    `);
  return Boolean(result.recordset?.length);
}

function isAssignableOperatorRole(roleCode) {
  return ASSIGNABLE_OPERATOR_ROLE_CODES.has(String(roleCode || "").toUpperCase());
}

function mapRowsByRole(rows) {
  const byRole = new Map();
  for (const row of rows || []) {
    const roleId = Number(row.role_id);
    let role = byRole.get(roleId);
    if (!role) {
      role = {
        role_id: roleId,
        role_code: row.role_code,
        role_name: row.role_name,
        is_active: Boolean(row.role_is_active),
        granted_at: row.granted_at,
        permissions: [],
      };
      byRole.set(roleId, role);
    }
    if (row.permission_id != null) {
      role.permissions.push({
        permission_id: Number(row.permission_id),
        permission_code: row.permission_code,
        permission_name: row.permission_name,
        resource_code: row.resource_code,
        action_code: row.action_code,
      });
    }
  }
  return [...byRole.values()];
}

// POST /api/admin/users
// Cria identidade corporativa interna da HDUD. Não cria author, assinatura ou role.
router.post(
  "/users",
  authRequired,
  requireAdminPermission("USER_CREATE"),
  async (req, res) => {
    const pool = await getPool();
    const email = normalizeEmail(req.body?.email);
    const fullName = normalizeFullName(req.body?.full_name);
    const departmentName = normalizeDepartmentName(req.body?.department_name);
    const password = req.body?.password;
    const reason = normalizeReason(req.body?.reason);

    if (!email) return res.status(400).json({ error: "email inválido.", code: "INVALID_EMAIL" });
    if (!isCorporateOperatorEmail(email)) return res.status(400).json({ error: "Operadores devem utilizar e-mail corporativo @hdud.ai.", code: "OPERATOR_EMAIL_DOMAIN_REQUIRED" });
    if (!fullName) return res.status(400).json({ error: "full_name é obrigatório.", code: "FULL_NAME_REQUIRED" });
    if (!departmentName) return res.status(400).json({ error: "Área / Setor é obrigatório.", code: "DEPARTMENT_REQUIRED" });
    if (!validPassword(password)) return res.status(400).json({ error: "password deve possuir entre 10 e 200 caracteres.", code: "INVALID_PASSWORD" });
    if (!reason) return res.status(400).json({ error: "reason é obrigatório.", code: "CREATE_REASON_REQUIRED" });

    let transaction = null;
    try {
      const exists = await pool.request()
        .input("email", sql.NVarChar(255), email)
        .query(`
          SELECT TOP (1) user_id
          FROM dbo.identity_user
          WHERE LOWER(email) = LOWER(@email);
        `);

      if (exists.recordset?.length) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_INTERNAL_USER_CREATED",
          actionCode: "CREATE",
          resultCode: "DENIED",
          targetType: "IDENTITY_USER",
          resourceCode: "USER",
          metadata: { email, reason: "EMAIL_ALREADY_EXISTS" },
        });
        return res.status(409).json({ error: "Já existe usuário com este e-mail.", code: "EMAIL_ALREADY_EXISTS" });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

      const createdResult = await transaction.request()
        .input("email", sql.NVarChar(255), email)
        .input("password_hash", sql.VarChar(255), passwordHash)
        .input("full_name", sql.NVarChar(200), fullName)
        .query(`
          INSERT INTO dbo.identity_user
          (
            email,
            password_hash,
            auth_provider,
            is_active,
            created_at,
            full_name,
            author_id
          )
          OUTPUT
            inserted.user_id,
            inserted.email,
            inserted.full_name,
            inserted.auth_provider,
            inserted.is_active,
            inserted.created_at,
            inserted.author_id
          VALUES
          (
            @email,
            @password_hash,
            N'LOCAL',
            1,
            SYSUTCDATETIME(),
            @full_name,
            NULL
          );
        `);

      const created = createdResult.recordset?.[0];

      await transaction.request()
        .input("user_id", sql.Int, Number(created.user_id))
        .input("department_name", sql.NVarChar(120), departmentName)
        .input("updated_by_user_id", sql.Int, actorUserId(req))
        .query(`
          INSERT INTO dbo.admin_operator_profile
          (user_id, department_name, created_at, updated_at, updated_by_user_id)
          VALUES
          (@user_id, @department_name, SYSUTCDATETIME(), SYSUTCDATETIME(), @updated_by_user_id);
        `);

      await transaction.commit();
      transaction = null;

      const after = {
        user_id: Number(created.user_id),
        email: created.email,
        full_name: created.full_name,
        auth_provider: created.auth_provider,
        is_active: Boolean(created.is_active),
        created_at: created.created_at,
        author_id: null,
        department_name: departmentName,
      };

      await auditDomain(pool, req, {
        eventCode: "ADMIN_INTERNAL_USER_CREATED",
        actionCode: "CREATE",
        targetType: "IDENTITY_USER",
        targetId: created.user_id,
        before: null,
        after,
        resourceCode: "USER",
        metadata: { reason },
      });

      return res.status(201).json({ ok: true, user: after });
    } catch (err) {
      if (transaction) {
        try { await transaction.rollback(); } catch {}
      }

      if (isUniqueViolation(err)) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_INTERNAL_USER_CREATED",
          actionCode: "CREATE",
          resultCode: "DENIED",
          targetType: "IDENTITY_USER",
          resourceCode: "USER",
          metadata: { email, reason: "EMAIL_ALREADY_EXISTS" },
        });
        return res.status(409).json({ error: "Já existe usuário com este e-mail.", code: "EMAIL_ALREADY_EXISTS" });
      }

      console.error("[ADMIN USERS] Falha ao criar usuário interno:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_INTERNAL_USER_CREATED",
        actionCode: "CREATE",
        resultCode: "FAILED",
        targetType: "IDENTITY_USER",
        resourceCode: "USER",
        metadata: { email, reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao criar usuário interno.", code: "ADMIN_INTERNAL_USER_CREATE_ERROR" });
    }
  }
);

// GET /api/admin/users?search=&limit=&offset=
router.get(
  "/users",
  authRequired,
  requireAdminPermission("USER_READ"),
  async (req, res) => {
    const pool = await getPool();
    try {
      const search = String(req.query?.search || "").trim().slice(0, 200);
      const requestedLimit = asPositiveInt(req.query?.limit) || DEFAULT_PAGE_SIZE;
      const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
      const offsetRaw = Number(req.query?.offset ?? 0);
      const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

      const request = pool.request()
        .input("search", sql.NVarChar(200), search || null)
        .input("limit", sql.Int, limit)
        .input("offset", sql.Int, offset);

      const result = await request.query(`
        SELECT COUNT_BIG(1) AS total
        FROM dbo.identity_user u
        LEFT JOIN dbo.admin_operator_profile op ON op.user_id = u.user_id
        WHERE u.author_id IS NULL
          AND LOWER(u.email) LIKE N'%@hdud.ai'
          AND (
            @search IS NULL
            OR u.email LIKE N'%' + @search + N'%'
            OR u.full_name LIKE N'%' + @search + N'%'
            OR op.department_name LIKE N'%' + @search + N'%'
          );

        SELECT
          u.user_id,
          u.email,
          u.full_name,
          u.auth_provider,
          u.is_active,
          u.created_at,
          u.last_login_at,
          u.author_id,
          op.department_name
        FROM dbo.identity_user u
        LEFT JOIN dbo.admin_operator_profile op ON op.user_id = u.user_id
        WHERE u.author_id IS NULL
          AND LOWER(u.email) LIKE N'%@hdud.ai'
          AND (
            @search IS NULL
            OR u.email LIKE N'%' + @search + N'%'
            OR u.full_name LIKE N'%' + @search + N'%'
            OR op.department_name LIKE N'%' + @search + N'%'
          )
        ORDER BY u.is_active DESC, COALESCE(op.department_name, N''), COALESCE(u.full_name, u.email), u.user_id
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
      `);
      const total = Number(result.recordsets?.[0]?.[0]?.total || 0);
      const users = result.recordsets?.[1] || [];

      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_LIST_READ",
        metadata: { search: search || null, limit, offset, returned: users.length, total },
      });

      return res.json({ ok: true, total, limit, offset, users });
    } catch (err) {
      console.error("[ADMIN USERS] Falha ao listar usuários:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_LIST_READ",
        resultCode: "FAILED",
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao consultar usuários.", code: "ADMIN_USERS_READ_ERROR" });
    }
  }
);

// GET /api/admin/users/:userId
router.get(
  "/users/:userId",
  authRequired,
  requireAdminPermission("USER_READ"),
  async (req, res) => {
    const pool = await getPool();
    const userId = asPositiveInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: "userId inválido.", code: "INVALID_USER_ID" });

    try {
      const user = await fetchUser(pool, userId);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_DETAIL_READ",
        resultCode: user ? "SUCCESS" : "DENIED",
        targetType: "USER",
        targetId: userId,
        metadata: user ? null : { reason: "USER_NOT_FOUND" },
      });
      if (!user) return res.status(404).json({ error: "Usuário não encontrado.", code: "USER_NOT_FOUND" });
      return res.json({ ok: true, user });
    } catch (err) {
      console.error("[ADMIN USERS] Falha ao consultar usuário:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_DETAIL_READ",
        resultCode: "FAILED",
        targetType: "USER",
        targetId: userId,
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao consultar usuário.", code: "ADMIN_USER_READ_ERROR" });
    }
  }
);

// GET /api/admin/users/:userId/access
router.get(
  "/users/:userId/access",
  authRequired,
  requireAdminPermission("RBAC_READ"),
  async (req, res) => {
    const pool = await getPool();
    const userId = asPositiveInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: "userId inválido.", code: "INVALID_USER_ID" });

    try {
      const user = await fetchUser(pool, userId);
      if (!user) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ACCESS_READ",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { reason: "USER_NOT_FOUND" },
        });
        return res.status(404).json({ error: "Usuário não encontrado.", code: "USER_NOT_FOUND" });
      }

      const result = await pool.request()
        .input("user_id", sql.Int, userId)
        .query(`
          SELECT
            r.role_id,
            r.role_code,
            r.role_name,
            r.is_active AS role_is_active,
            ur.granted_at,
            p.permission_id,
            p.permission_code,
            p.permission_name,
            p.resource_code,
            p.action_code
          FROM dbo.admin_user_role ur
          INNER JOIN dbo.admin_role r
            ON r.role_id = ur.role_id
          LEFT JOIN dbo.admin_role_permission rp
            ON rp.role_id = r.role_id
           AND rp.revoked_at IS NULL
          LEFT JOIN dbo.admin_permission p
            ON p.permission_id = rp.permission_id
           AND p.is_active = 1
          WHERE ur.user_id = @user_id
            AND ur.revoked_at IS NULL
            AND r.is_active = 1
          ORDER BY r.role_code, p.permission_code;
        `);

      const roles = mapRowsByRole(result.recordset || []);
      const effectivePermissionMap = new Map();
      for (const role of roles) {
        for (const permission of role.permissions) {
          if (!effectivePermissionMap.has(permission.permission_code)) {
            effectivePermissionMap.set(permission.permission_code, permission);
          }
        }
      }
      const effective_permissions = [...effectivePermissionMap.values()]
        .sort((a, b) => a.permission_code.localeCompare(b.permission_code));

      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ACCESS_READ",
        targetType: "USER",
        targetId: userId,
        metadata: { active_roles: roles.length, effective_permissions: effective_permissions.length },
      });

      return res.json({ ok: true, user, roles, effective_permissions });
    } catch (err) {
      console.error("[ADMIN USERS] Falha ao consultar acesso:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ACCESS_READ",
        resultCode: "FAILED",
        targetType: "USER",
        targetId: userId,
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao consultar acesso administrativo.", code: "ADMIN_ACCESS_READ_ERROR" });
    }
  }
);

// GET /api/admin/users/:userId/role-history
router.get(
  "/users/:userId/role-history",
  authRequired,
  requireAdminPermission("RBAC_READ"),
  async (req, res) => {
    const pool = await getPool();
    const userId = asPositiveInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: "userId inválido.", code: "INVALID_USER_ID" });

    try {
      const user = await fetchUser(pool, userId);
      if (!user) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_HISTORY_READ",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { reason: "USER_NOT_FOUND" },
        });
        return res.status(404).json({ error: "Usuário não encontrado.", code: "USER_NOT_FOUND" });
      }

      const result = await pool.request()
        .input("user_id", sql.Int, userId)
        .query(`
          SELECT
            ur.user_role_id,
            ur.user_id,
            ur.role_id,
            r.role_code,
            r.role_name,
            ur.granted_at,
            ur.granted_by_user_id,
            gu.email AS granted_by_email,
            ur.grant_reason,
            ur.revoked_at,
            ur.revoked_by_user_id,
            ru.email AS revoked_by_email,
            ur.revoke_reason,
            CASE WHEN ur.revoked_at IS NULL AND r.is_active = 1 THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS is_effective
          FROM dbo.admin_user_role ur
          INNER JOIN dbo.admin_role r
            ON r.role_id = ur.role_id
          LEFT JOIN dbo.identity_user gu
            ON gu.user_id = ur.granted_by_user_id
          LEFT JOIN dbo.identity_user ru
            ON ru.user_id = ur.revoked_by_user_id
          WHERE ur.user_id = @user_id
          ORDER BY ur.granted_at DESC, ur.user_role_id DESC;
        `);

      const history = result.recordset || [];
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ROLE_HISTORY_READ",
        targetType: "USER",
        targetId: userId,
        metadata: { entries: history.length },
      });
      return res.json({ ok: true, user, history });
    } catch (err) {
      console.error("[ADMIN USERS] Falha ao consultar histórico de roles:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ROLE_HISTORY_READ",
        resultCode: "FAILED",
        targetType: "USER",
        targetId: userId,
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao consultar histórico administrativo.", code: "ADMIN_ROLE_HISTORY_ERROR" });
    }
  }
);

// GET /api/admin/roles
router.get(
  "/roles",
  authRequired,
  requireAdminPermission("RBAC_READ"),
  async (req, res) => {
    const pool = await getPool();
    try {
      const result = await pool.request().query(`
        SELECT
          r.role_id,
          r.role_code,
          r.role_name,
          r.description,
          r.is_active,
          r.created_at,
          r.updated_at,
          p.permission_id,
          p.permission_code,
          p.permission_name,
          p.resource_code,
          p.action_code
        FROM dbo.admin_role r
        LEFT JOIN dbo.admin_role_permission rp
          ON rp.role_id = r.role_id
         AND rp.revoked_at IS NULL
        LEFT JOIN dbo.admin_permission p
          ON p.permission_id = rp.permission_id
         AND p.is_active = 1
        ORDER BY r.role_code, p.permission_code;
      `);

      const roles = [];
      const byRole = new Map();
      for (const row of result.recordset || []) {
        let role = byRole.get(Number(row.role_id));
        if (!role) {
          role = {
            role_id: Number(row.role_id),
            role_code: row.role_code,
            role_name: row.role_name,
            description: row.description,
            is_active: Boolean(row.is_active),
            created_at: row.created_at,
            updated_at: row.updated_at,
            permissions: [],
          };
          byRole.set(Number(row.role_id), role);
          roles.push(role);
        }
        if (row.permission_id != null) {
          role.permissions.push({
            permission_id: Number(row.permission_id),
            permission_code: row.permission_code,
            permission_name: row.permission_name,
            resource_code: row.resource_code,
            action_code: row.action_code,
          });
        }
      }

      await auditDomain(pool, req, {
        eventCode: "ADMIN_ROLE_LIST_READ",
        metadata: { roles: roles.length },
      });
      return res.json({ ok: true, roles });
    } catch (err) {
      console.error("[ADMIN RBAC] Falha ao listar roles:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_ROLE_LIST_READ",
        resultCode: "FAILED",
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao consultar roles administrativas.", code: "ADMIN_ROLES_READ_ERROR" });
    }
  }
);

// POST /api/admin/users/:userId/roles
router.post(
  "/users/:userId/roles",
  authRequired,
  requireAdminPermission("RBAC_WRITE"),
  async (req, res) => {
    const pool = await getPool();
    const userId = asPositiveInt(req.params.userId);
    const roleCode = normalizeRoleCode(req.body?.role_code);
    const reason = normalizeReason(req.body?.reason);
    const actorId = actorUserId(req);

    if (!userId) return res.status(400).json({ error: "userId inválido.", code: "INVALID_USER_ID" });
    if (!roleCode) return res.status(400).json({ error: "role_code é obrigatório.", code: "ROLE_CODE_REQUIRED" });
    if (!reason) return res.status(400).json({ error: "reason é obrigatório.", code: "GRANT_REASON_REQUIRED" });

    let transaction = null;
    try {
      const user = await fetchUser(pool, userId);
      if (!user) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_GRANTED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "USER_NOT_FOUND" },
        });
        return res.status(404).json({ error: "Usuário não encontrado.", code: "USER_NOT_FOUND" });
      }

      const role = await fetchRole(pool, roleCode);
      if (!role || Number(role.is_active) !== 1) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_GRANTED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "ROLE_NOT_FOUND_OR_INACTIVE" },
        });
        return res.status(404).json({ error: "Role inexistente ou inativa.", code: "ROLE_NOT_FOUND_OR_INACTIVE" });
      }

      const isSuperAdmin = await actorIsSuperAdmin(pool, actorId);
      if (!isSuperAdmin && !isAssignableOperatorRole(roleCode)) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_GRANTED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "ROLE_NOT_ASSIGNABLE_BY_OPERATOR_ADMIN" },
        });
        return res.status(403).json({ error: "Esta role não pode ser concedida pela administração comum de Operadores.", code: "ROLE_NOT_ASSIGNABLE_BY_OPERATOR_ADMIN" });
      }

      transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

      const grantResult = await transaction.request()
        .input("user_id", sql.Int, userId)
        .input("role_id", sql.Int, Number(role.role_id))
        .input("granted_by_user_id", sql.Int, actorId)
        .input("grant_reason", sql.NVarChar(500), reason)
        .query(`
          INSERT INTO dbo.admin_user_role (
            user_id, role_id, granted_by_user_id, grant_reason
          )
          OUTPUT
            inserted.user_role_id,
            inserted.user_id,
            inserted.role_id,
            inserted.granted_at,
            inserted.granted_by_user_id,
            inserted.grant_reason,
            inserted.revoked_at
          VALUES (
            @user_id, @role_id, @granted_by_user_id, @grant_reason
          );
        `);

      await transaction.commit();
      transaction = null;

      const grant = grantResult.recordset?.[0];
      const after = {
        user_role_id: Number(grant.user_role_id),
        user_id: userId,
        role_id: Number(role.role_id),
        role_code: role.role_code,
        granted_at: grant.granted_at,
        granted_by_user_id: actorId,
        grant_reason: reason,
        revoked_at: null,
      };

      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ROLE_GRANTED",
        actionCode: "WRITE",
        targetType: "USER",
        targetId: userId,
        before: null,
        after,
        metadata: { role_code: role.role_code },
      });

      return res.status(201).json({ ok: true, grant: after });
    } catch (err) {
      if (transaction) {
        try { await transaction.rollback(); } catch {}
      }

      if (isUniqueViolation(err)) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_GRANTED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "ACTIVE_GRANT_EXISTS" },
        });
        return res.status(409).json({ error: "Usuário já possui grant ativo para esta role.", code: "ACTIVE_GRANT_EXISTS" });
      }

      console.error("[ADMIN RBAC] Falha ao conceder role:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ROLE_GRANTED",
        actionCode: "WRITE",
        resultCode: "FAILED",
        targetType: "USER",
        targetId: userId,
        metadata: { role_code: roleCode, reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao conceder role administrativa.", code: "ADMIN_ROLE_GRANT_ERROR" });
    }
  }
);

// DELETE /api/admin/users/:userId/roles/:roleCode
// Revogação lógica: nenhuma exclusão física de grant.
router.delete(
  "/users/:userId/roles/:roleCode",
  authRequired,
  requireAdminPermission("RBAC_WRITE"),
  async (req, res) => {
    const pool = await getPool();
    const userId = asPositiveInt(req.params.userId);
    const roleCode = normalizeRoleCode(req.params.roleCode);
    const reason = normalizeReason(req.body?.reason);
    const actorId = actorUserId(req);

    if (!userId) return res.status(400).json({ error: "userId inválido.", code: "INVALID_USER_ID" });
    if (!roleCode) return res.status(400).json({ error: "roleCode inválido.", code: "INVALID_ROLE_CODE" });
    if (!reason) return res.status(400).json({ error: "reason é obrigatório.", code: "REVOKE_REASON_REQUIRED" });

    let transaction = null;
    try {
      const user = await fetchUser(pool, userId);
      if (!user) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_REVOKED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "USER_NOT_FOUND" },
        });
        return res.status(404).json({ error: "Usuário não encontrado.", code: "USER_NOT_FOUND" });
      }

      const role = await fetchRole(pool, roleCode);
      if (!role) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_REVOKED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "ROLE_NOT_FOUND" },
        });
        return res.status(404).json({ error: "Role não encontrada.", code: "ROLE_NOT_FOUND" });
      }

      const isSuperAdmin = await actorIsSuperAdmin(pool, actorId);
      if (!isSuperAdmin && !isAssignableOperatorRole(roleCode)) {
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_REVOKED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "ROLE_NOT_ASSIGNABLE_BY_OPERATOR_ADMIN" },
        });
        return res.status(403).json({ error: "Esta role não pode ser revogada pela administração comum de Operadores.", code: "ROLE_NOT_ASSIGNABLE_BY_OPERATOR_ADMIN" });
      }

      transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

      const currentResult = await transaction.request()
        .input("user_id", sql.Int, userId)
        .input("role_id", sql.Int, Number(role.role_id))
        .query(`
          SELECT TOP (1)
            ur.user_role_id,
            ur.user_id,
            ur.role_id,
            ur.granted_at,
            ur.granted_by_user_id,
            ur.grant_reason,
            ur.revoked_at,
            ur.revoked_by_user_id,
            ur.revoke_reason
          FROM dbo.admin_user_role ur WITH (UPDLOCK, HOLDLOCK)
          WHERE ur.user_id = @user_id
            AND ur.role_id = @role_id
            AND ur.revoked_at IS NULL
          ORDER BY ur.user_role_id DESC;
        `);

      const current = currentResult.recordset?.[0] || null;
      if (!current) {
        await transaction.rollback();
        transaction = null;
        await auditDomain(pool, req, {
          eventCode: "ADMIN_USER_ROLE_REVOKED",
          actionCode: "WRITE",
          resultCode: "DENIED",
          targetType: "USER",
          targetId: userId,
          metadata: { role_code: roleCode, reason: "ACTIVE_GRANT_NOT_FOUND" },
        });
        return res.status(409).json({ error: "Não existe grant ativo desta role para o usuário.", code: "ACTIVE_GRANT_NOT_FOUND" });
      }

      const revokeResult = await transaction.request()
        .input("user_role_id", sql.BigInt, current.user_role_id)
        .input("revoked_by_user_id", sql.Int, actorId)
        .input("revoke_reason", sql.NVarChar(500), reason)
        .query(`
          UPDATE dbo.admin_user_role
          SET
            revoked_at = SYSUTCDATETIME(),
            revoked_by_user_id = @revoked_by_user_id,
            revoke_reason = @revoke_reason
          OUTPUT
            inserted.user_role_id,
            inserted.user_id,
            inserted.role_id,
            inserted.granted_at,
            inserted.granted_by_user_id,
            inserted.grant_reason,
            inserted.revoked_at,
            inserted.revoked_by_user_id,
            inserted.revoke_reason
          WHERE user_role_id = @user_role_id
            AND revoked_at IS NULL;
        `);

      const revoked = revokeResult.recordset?.[0] || null;
      if (!revoked) throw new Error("ACTIVE_GRANT_CHANGED_DURING_REVOKE");

      await transaction.commit();
      transaction = null;

      const before = {
        user_role_id: Number(current.user_role_id),
        user_id: userId,
        role_id: Number(role.role_id),
        role_code: role.role_code,
        granted_at: current.granted_at,
        granted_by_user_id: current.granted_by_user_id == null ? null : Number(current.granted_by_user_id),
        grant_reason: current.grant_reason,
        revoked_at: null,
      };
      const after = {
        ...before,
        revoked_at: revoked.revoked_at,
        revoked_by_user_id: actorId,
        revoke_reason: reason,
      };

      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ROLE_REVOKED",
        actionCode: "WRITE",
        targetType: "USER",
        targetId: userId,
        before,
        after,
        metadata: { role_code: role.role_code },
      });

      return res.json({ ok: true, grant: after });
    } catch (err) {
      if (transaction) {
        try { await transaction.rollback(); } catch {}
      }
      console.error("[ADMIN RBAC] Falha ao revogar role:", err);
      await auditDomain(pool, req, {
        eventCode: "ADMIN_USER_ROLE_REVOKED",
        actionCode: "WRITE",
        resultCode: "FAILED",
        targetType: "USER",
        targetId: userId,
        metadata: { role_code: roleCode, reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao revogar role administrativa.", code: "ADMIN_ROLE_REVOKE_ERROR" });
    }
  }
);

export default router;
