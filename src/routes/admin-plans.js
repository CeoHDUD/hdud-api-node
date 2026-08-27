// HDUD Admin — Implementação 06.2 | Admin Plans — Read + Write
// Leitura administrativa do catálogo de planos.
// PLAN_READ autoriza consulta do domínio PLAN; assinatura/quota individual não participam deste módulo.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireAdminPermission } from "../middleware/adminAuthorization.js";
import { getPool, sql } from "../db.js";
import { writeAdminAuditSafe } from "../services/adminAuditService.js";

const router = Router();

function asPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function actorUserId(req) {
  return asPositiveInt(req.user?.sub ?? req.user?.user_id ?? req.user?.id);
}

function actorLabel(req) {
  return req.user?.email || null;
}

async function auditPlan(pool, req, {
  eventCode,
  resultCode = "SUCCESS",
  targetId = null,
  metadata = null,
}) {
  return writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: actorLabel(req),
    eventCode,
    resourceCode: "PLAN",
    actionCode: "READ",
    resultCode,
    targetType: targetId == null ? null : "SUBSCRIPTION_PLAN",
    targetId: targetId == null ? null : String(targetId),
    metadata,
  });
}

function mapPlans(planRows, featureRows, policyRows) {
  const byPlan = new Map();

  for (const row of planRows || []) {
    byPlan.set(Number(row.plan_id), {
      plan_id: Number(row.plan_id),
      code: row.code,
      name: row.name,
      max_audio_seconds: Number(row.max_audio_seconds),
      monthly_seconds: Number(row.monthly_seconds),
      is_active: Boolean(row.is_active),
      sort_order: Number(row.sort_order),
      price_cents: row.price_cents == null ? null : Number(row.price_cents),
      currency_code: row.currency_code,
      marketing_label: row.marketing_label,
      is_featured: Boolean(row.is_featured),
      description_short: row.description_short,
      is_public: Boolean(row.is_public),
      created_at: row.created_at,
      updated_at: row.updated_at,
      features: [],
      ai_policy: null,
    });
  }

  for (const row of featureRows || []) {
    const plan = byPlan.get(Number(row.plan_id));
    if (!plan) continue;
    plan.features.push({
      feature_id: Number(row.feature_id),
      feature_code: row.feature_code,
      feature_name: row.feature_name,
      value_type: row.value_type,
      unit_code: row.unit_code,
      reset_policy: row.reset_policy,
      enforcement_mode: row.enforcement_mode,
      ledger_operation_code: row.ledger_operation_code,
      feature_is_active: Boolean(row.feature_is_active),
      is_enabled: Boolean(row.is_enabled),
      bool_value: row.bool_value == null ? null : Boolean(row.bool_value),
      int_value: row.int_value == null ? null : Number(row.int_value),
      string_value: row.string_value,
      created_at: row.feature_created_at,
      updated_at: row.feature_updated_at,
    });
  }

  for (const row of policyRows || []) {
    const plan = byPlan.get(Number(row.plan_id));
    if (!plan) continue;
    plan.ai_policy = {
      monthly_external_ai_budget_usd:
        row.monthly_external_ai_budget_usd == null
          ? null
          : Number(row.monthly_external_ai_budget_usd),
      hard_stop: Boolean(row.hard_stop),
      warning_pct: Number(row.warning_pct),
      critical_pct: Number(row.critical_pct),
      block_pct: Number(row.block_pct),
      allow_overage: Boolean(row.allow_overage),
      overage_mode: row.overage_mode,
      updated_at: row.ai_policy_updated_at,
    };
  }

  return [...byPlan.values()];
}


function isOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function asRequiredReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  return reason && reason.length <= 1000 ? reason : null;
}

function validatePlanPatch(body) {
  const allowed = new Set([
    "name",
    "is_active",
    "sort_order",
    "price_cents",
    "currency_code",
    "marketing_label",
    "is_featured",
    "description_short",
    "is_public",
  ]);

  const ignored = new Set(["reason"]);
  const unknown = Object.keys(body || {}).filter((k) => !allowed.has(k) && !ignored.has(k));
  if (unknown.length) {
    return { error: `Campos não permitidos: ${unknown.join(", ")}.`, code: "PLAN_FIELDS_NOT_ALLOWED" };
  }

  const changes = {};

  if (isOwn(body, "name")) {
    const value = typeof body.name === "string" ? body.name.trim() : "";
    if (!value || value.length > 100) return { error: "name inválido.", code: "INVALID_PLAN_NAME" };
    changes.name = value;
  }

  for (const key of ["is_active", "is_featured", "is_public"]) {
    if (isOwn(body, key)) {
      if (typeof body[key] !== "boolean") return { error: `${key} deve ser boolean.`, code: "INVALID_PLAN_BOOLEAN" };
      changes[key] = body[key];
    }
  }

  if (isOwn(body, "sort_order")) {
    const value = Number(body.sort_order);
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
      return { error: "sort_order inválido.", code: "INVALID_PLAN_SORT_ORDER" };
    }
    changes.sort_order = value;
  }

  if (isOwn(body, "price_cents")) {
    const value = Number(body.price_cents);
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
      return { error: "price_cents inválido.", code: "INVALID_PLAN_PRICE" };
    }
    changes.price_cents = value;
  }

  if (isOwn(body, "currency_code")) {
    const value = typeof body.currency_code === "string" ? body.currency_code.trim().toUpperCase() : "";
    if (!/^[A-Z]{3,10}$/.test(value)) {
      return { error: "currency_code inválido.", code: "INVALID_PLAN_CURRENCY" };
    }
    changes.currency_code = value;
  }

  if (isOwn(body, "marketing_label")) {
    if (body.marketing_label !== null && typeof body.marketing_label !== "string") {
      return { error: "marketing_label inválido.", code: "INVALID_MARKETING_LABEL" };
    }
    const value = body.marketing_label == null ? null : body.marketing_label.trim();
    if (value != null && value.length > 80) return { error: "marketing_label excede 80 caracteres.", code: "INVALID_MARKETING_LABEL" };
    changes.marketing_label = value || null;
  }

  if (isOwn(body, "description_short")) {
    if (body.description_short !== null && typeof body.description_short !== "string") {
      return { error: "description_short inválido.", code: "INVALID_PLAN_DESCRIPTION" };
    }
    const value = body.description_short == null ? null : body.description_short.trim();
    if (value != null && value.length > 255) return { error: "description_short excede 255 caracteres.", code: "INVALID_PLAN_DESCRIPTION" };
    changes.description_short = value || null;
  }

  if (!Object.keys(changes).length) {
    return { error: "Nenhum campo administrável informado.", code: "NO_PLAN_CHANGES" };
  }

  return { changes };
}

async function auditPlanWrite(pool, req, {
  resultCode = "SUCCESS",
  targetId,
  before = null,
  after = null,
  metadata = null,
}) {
  return writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: actorLabel(req),
    eventCode: "ADMIN_PLAN_UPDATED",
    resourceCode: "PLAN",
    actionCode: "WRITE",
    resultCode,
    targetType: "SUBSCRIPTION_PLAN",
    targetId: String(targetId),
    before,
    after,
    metadata,
  });
}



function validateFeaturePatch(body, feature) {
  const allowed = new Set(["reason", "is_enabled", "bool_value", "int_value", "string_value"]);
  const unknown = Object.keys(body || {}).filter((k) => !allowed.has(k));
  if (unknown.length) {
    return { error: `Campos não permitidos: ${unknown.join(", ")}.`, code: "PLAN_FEATURE_FIELDS_NOT_ALLOWED" };
  }

  const changes = {};
  if (isOwn(body, "is_enabled")) {
    if (typeof body.is_enabled !== "boolean") {
      return { error: "is_enabled deve ser boolean.", code: "INVALID_PLAN_FEATURE_ENABLED" };
    }
    changes.is_enabled = body.is_enabled;
  }

  const type = String(feature?.value_type || "").toUpperCase();
  const valueKeys = ["bool_value", "int_value", "string_value"].filter((k) => isOwn(body, k));
  const expected = type === "BOOLEAN" ? "bool_value" : type === "INTEGER" ? "int_value" : type === "STRING" ? "string_value" : null;

  if (!expected) {
    return { error: "Tipo de feature não suportado pela administração.", code: "UNSUPPORTED_PLAN_FEATURE_TYPE" };
  }

  const wrong = valueKeys.filter((k) => k !== expected);
  if (wrong.length) {
    return {
      error: `A feature ${feature.feature_code} é ${type} e só aceita ${expected}.`,
      code: "PLAN_FEATURE_VALUE_TYPE_MISMATCH",
    };
  }

  if (isOwn(body, expected)) {
    if (type === "BOOLEAN") {
      if (typeof body.bool_value !== "boolean") {
        return { error: "bool_value deve ser boolean.", code: "INVALID_PLAN_FEATURE_BOOLEAN" };
      }
      changes.bool_value = body.bool_value;
    } else if (type === "INTEGER") {
      const value = Number(body.int_value);
      if (!Number.isSafeInteger(value) || value < 0) {
        return { error: "int_value deve ser um inteiro maior ou igual a zero.", code: "INVALID_PLAN_FEATURE_INTEGER" };
      }
      changes.int_value = value;
    } else {
      const value = typeof body.string_value === "string" ? body.string_value.trim() : "";
      if (!value || value.length > 80) {
        return { error: "string_value deve conter de 1 a 80 caracteres.", code: "INVALID_PLAN_FEATURE_STRING" };
      }
      changes.string_value = value;
    }
  }

  if (!Object.keys(changes).length) {
    return { error: "Nenhuma alteração de feature informada.", code: "NO_PLAN_FEATURE_CHANGES" };
  }

  return { changes };
}

async function auditPlanFeatureWrite(pool, req, {
  resultCode = "SUCCESS",
  targetId,
  before = null,
  after = null,
  metadata = null,
}) {
  return writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: actorLabel(req),
    eventCode: "ADMIN_PLAN_FEATURE_UPDATED",
    resourceCode: "PLAN",
    actionCode: "WRITE",
    resultCode,
    targetType: "SUBSCRIPTION_PLAN_FEATURE",
    targetId: String(targetId),
    before,
    after,
    metadata,
  });
}

async function readPlans(pool, planId = null) {
  const request = pool.request().input("plan_id", sql.Int, planId);

  const result = await request.query(`
    SELECT
      p.plan_id,
      p.code,
      p.name,
      p.max_audio_seconds,
      p.monthly_seconds,
      p.is_active,
      p.sort_order,
      p.price_cents,
      p.currency_code,
      p.marketing_label,
      p.is_featured,
      p.description_short,
      p.is_public,
      p.created_at,
      p.updated_at
    FROM dbo.subscription_plan p
    WHERE @plan_id IS NULL OR p.plan_id = @plan_id
    ORDER BY p.sort_order, p.plan_id;

    SELECT
      pf.plan_id,
      f.feature_id,
      f.code AS feature_code,
      f.name AS feature_name,
      f.value_type,
      f.unit_code,
      f.reset_policy,
      f.enforcement_mode,
      f.ledger_operation_code,
      f.is_active AS feature_is_active,
      pf.is_enabled,
      pf.bool_value,
      pf.int_value,
      pf.string_value,
      pf.created_at AS feature_created_at,
      pf.updated_at AS feature_updated_at
    FROM dbo.subscription_plan_feature pf
    INNER JOIN dbo.subscription_feature f
      ON f.feature_id = pf.feature_id
    WHERE @plan_id IS NULL OR pf.plan_id = @plan_id
    ORDER BY pf.plan_id, f.feature_id;

    SELECT
      ap.plan_id,
      ap.monthly_external_ai_budget_usd,
      ap.hard_stop,
      ap.warning_pct,
      ap.critical_pct,
      ap.block_pct,
      ap.allow_overage,
      ap.overage_mode,
      ap.updated_at AS ai_policy_updated_at
    FROM dbo.subscription_plan_ai_policy ap
    WHERE @plan_id IS NULL OR ap.plan_id = @plan_id
    ORDER BY ap.plan_id;
  `);

  return mapPlans(
    result.recordsets?.[0] || [],
    result.recordsets?.[1] || [],
    result.recordsets?.[2] || []
  );
}

// GET /api/admin/plans
router.get(
  "/plans",
  authRequired,
  requireAdminPermission("PLAN_READ"),
  async (req, res) => {
    const pool = await getPool();
    try {
      const plans = await readPlans(pool);

      await auditPlan(pool, req, {
        eventCode: "ADMIN_PLAN_LIST_READ",
        metadata: { returned: plans.length },
      });

      return res.json({ ok: true, total: plans.length, plans });
    } catch (err) {
      console.error("[ADMIN PLANS] Falha ao listar planos:", err);
      await auditPlan(pool, req, {
        eventCode: "ADMIN_PLAN_LIST_READ",
        resultCode: "FAILED",
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({
        error: "Falha ao consultar planos.",
        code: "ADMIN_PLANS_READ_ERROR",
      });
    }
  }
);

// GET /api/admin/plans/:planId
router.get(
  "/plans/:planId",
  authRequired,
  requireAdminPermission("PLAN_READ"),
  async (req, res) => {
    const pool = await getPool();
    const planId = asPositiveInt(req.params.planId);

    if (!planId) {
      return res.status(400).json({ error: "planId inválido.", code: "INVALID_PLAN_ID" });
    }

    try {
      const plans = await readPlans(pool, planId);
      const plan = plans[0] || null;

      await auditPlan(pool, req, {
        eventCode: "ADMIN_PLAN_DETAIL_READ",
        resultCode: plan ? "SUCCESS" : "DENIED",
        targetId: planId,
        metadata: plan ? null : { reason: "PLAN_NOT_FOUND" },
      });

      if (!plan) {
        return res.status(404).json({ error: "Plano não encontrado.", code: "PLAN_NOT_FOUND" });
      }

      return res.json({ ok: true, plan });
    } catch (err) {
      console.error("[ADMIN PLANS] Falha ao consultar plano:", err);
      await auditPlan(pool, req, {
        eventCode: "ADMIN_PLAN_DETAIL_READ",
        resultCode: "FAILED",
        targetId: planId,
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({
        error: "Falha ao consultar plano.",
        code: "ADMIN_PLAN_READ_ERROR",
      });
    }
  }
);


// PATCH /api/admin/plans/:planId
// Administração dos atributos comerciais/operacionais do catálogo de planos.
// Não altera features, quotas/usage individuais nem identidade estrutural do plano.
router.patch(
  "/plans/:planId",
  authRequired,
  requireAdminPermission("PLAN_WRITE"),
  async (req, res) => {
    const pool = await getPool();
    const planId = asPositiveInt(req.params.planId);
    const reason = asRequiredReason(req.body?.reason);

    if (!planId) {
      return res.status(400).json({ error: "planId inválido.", code: "INVALID_PLAN_ID" });
    }

    if (!reason) {
      await auditPlanWrite(pool, req, {
        resultCode: "DENIED",
        targetId: planId,
        metadata: { reason: "REASON_REQUIRED" },
      });
      return res.status(400).json({
        error: "Motivo da alteração é obrigatório.",
        code: "REASON_REQUIRED",
      });
    }

    const validation = validatePlanPatch(req.body || {});
    if (validation.error) {
      await auditPlanWrite(pool, req, {
        resultCode: "DENIED",
        targetId: planId,
        metadata: { reason: validation.code },
      });
      return res.status(400).json({ error: validation.error, code: validation.code });
    }

    const transaction = pool.transaction();
    let before = null;
    let transactionOpen = false;

    try {
      await transaction.begin();
      transactionOpen = true;

      const locked = await transaction.request()
        .input("plan_id", sql.Int, planId)
        .query(`
          SELECT
            plan_id, code, name, max_audio_seconds, monthly_seconds,
            is_active, sort_order, price_cents, currency_code,
            marketing_label, is_featured, description_short, is_public,
            created_at, updated_at
          FROM dbo.subscription_plan WITH (UPDLOCK, HOLDLOCK)
          WHERE plan_id = @plan_id;
        `);

      before = locked.recordset?.[0] || null;
      if (!before) {
        await transaction.rollback();
        transactionOpen = false;
        await auditPlanWrite(pool, req, {
          resultCode: "DENIED",
          targetId: planId,
          metadata: { reason: "PLAN_NOT_FOUND", requested_reason: reason },
        });
        return res.status(404).json({ error: "Plano não encontrado.", code: "PLAN_NOT_FOUND" });
      }

      if (String(before.code).toUpperCase() === "INTERNAL") {
        await transaction.rollback();
        transactionOpen = false;
        await auditPlanWrite(pool, req, {
          resultCode: "DENIED",
          targetId: planId,
          before,
          metadata: { reason: "INTERNAL_PLAN_PROTECTED", requested_reason: reason },
        });
        return res.status(409).json({
          error: "O plano INTERNAL é técnico e não pode ser alterado por esta operação comercial.",
          code: "INTERNAL_PLAN_PROTECTED",
        });
      }

      const changes = validation.changes;
      const setters = [];
      const request = transaction.request().input("plan_id", sql.Int, planId);

      const definitions = {
        name: [sql.VarChar(100), "name"],
        is_active: [sql.Bit, "is_active"],
        sort_order: [sql.Int, "sort_order"],
        price_cents: [sql.Int, "price_cents"],
        currency_code: [sql.VarChar(10), "currency_code"],
        marketing_label: [sql.VarChar(80), "marketing_label"],
        is_featured: [sql.Bit, "is_featured"],
        description_short: [sql.VarChar(255), "description_short"],
        is_public: [sql.Bit, "is_public"],
      };

      for (const [key, value] of Object.entries(changes)) {
        const [type, column] = definitions[key];
        request.input(`v_${key}`, type, value);
        setters.push(`${column} = @v_${key}`);
      }

      setters.push("updated_at = SYSUTCDATETIME()");

      await request.query(`
        UPDATE dbo.subscription_plan
        SET ${setters.join(", ")}
        WHERE plan_id = @plan_id;
      `);

      const afterResult = await transaction.request()
        .input("plan_id", sql.Int, planId)
        .query(`
          SELECT
            plan_id, code, name, max_audio_seconds, monthly_seconds,
            is_active, sort_order, price_cents, currency_code,
            marketing_label, is_featured, description_short, is_public,
            created_at, updated_at
          FROM dbo.subscription_plan
          WHERE plan_id = @plan_id;
        `);

      const after = afterResult.recordset?.[0] || null;
      await transaction.commit();
      transactionOpen = false;

      await auditPlanWrite(pool, req, {
        targetId: planId,
        before,
        after,
        metadata: {
          reason,
          plan_code: before.code,
          changed_fields: Object.keys(changes),
        },
      });

      return res.json({ ok: true, plan: after });
    } catch (err) {
      try {
        if (transactionOpen) await transaction.rollback();
      } catch {}

      console.error("[ADMIN PLANS] Falha ao atualizar plano:", err);
      await auditPlanWrite(pool, req, {
        resultCode: "FAILED",
        targetId: planId,
        before,
        metadata: { reason: "INTERNAL_ERROR", requested_reason: reason },
      });
      return res.status(500).json({
        error: "Falha ao atualizar plano.",
        code: "ADMIN_PLAN_WRITE_ERROR",
      });
    }
  }
);


// PATCH /api/admin/plans/:planId/features/:featureCode
// Administração do contrato do plano. A definição estrutural da feature
// (code/value_type/reset_policy/enforcement_mode) permanece somente leitura.
router.patch(
  "/plans/:planId/features/:featureCode",
  authRequired,
  requireAdminPermission("PLAN_WRITE"),
  async (req, res) => {
    const pool = await getPool();
    const planId = asPositiveInt(req.params.planId);
    const featureCode = String(req.params.featureCode || "").trim().toUpperCase();
    const reason = asRequiredReason(req.body?.reason);

    if (!planId) {
      return res.status(400).json({ error: "planId inválido.", code: "INVALID_PLAN_ID" });
    }
    if (!featureCode || featureCode.length > 80) {
      return res.status(400).json({ error: "featureCode inválido.", code: "INVALID_FEATURE_CODE" });
    }

    let targetAuditId = `${planId}:${featureCode}`;
    if (!reason) {
      await auditPlanFeatureWrite(pool, req, {
        resultCode: "DENIED",
        targetId: targetAuditId,
        metadata: { reason: "REASON_REQUIRED", plan_id: planId, feature_code: featureCode },
      });
      return res.status(400).json({ error: "Motivo da alteração é obrigatório.", code: "REASON_REQUIRED" });
    }

    const transaction = pool.transaction();
    let transactionOpen = false;
    let before = null;

    try {
      await transaction.begin();
      transactionOpen = true;

      const locked = await transaction.request()
        .input("plan_id", sql.Int, planId)
        .input("feature_code", sql.VarChar(80), featureCode)
        .query(`
          SELECT
            p.plan_id,
            p.code AS plan_code,
            f.feature_id,
            f.code AS feature_code,
            f.name AS feature_name,
            f.value_type,
            f.unit_code,
            f.reset_policy,
            f.enforcement_mode,
            f.ledger_operation_code,
            f.is_active AS feature_is_active,
            pf.is_enabled,
            pf.bool_value,
            pf.int_value,
            pf.string_value,
            pf.created_at,
            pf.updated_at
          FROM dbo.subscription_plan p WITH (HOLDLOCK)
          INNER JOIN dbo.subscription_plan_feature pf WITH (UPDLOCK, HOLDLOCK)
            ON pf.plan_id = p.plan_id
          INNER JOIN dbo.subscription_feature f
            ON f.feature_id = pf.feature_id
          WHERE p.plan_id = @plan_id
            AND f.code = @feature_code;
        `);

      before = locked.recordset?.[0] || null;
      if (!before) {
        await transaction.rollback();
        transactionOpen = false;
        await auditPlanFeatureWrite(pool, req, {
          resultCode: "DENIED",
          targetId: targetAuditId,
          metadata: { reason: "PLAN_FEATURE_NOT_FOUND", requested_reason: reason, plan_id: planId, feature_code: featureCode },
        });
        return res.status(404).json({ error: "Feature do plano não encontrada.", code: "PLAN_FEATURE_NOT_FOUND" });
      }

      targetAuditId = `${before.plan_id}:${before.feature_id}`;

      if (String(before.plan_code).toUpperCase() === "INTERNAL") {
        await transaction.rollback();
        transactionOpen = false;
        await auditPlanFeatureWrite(pool, req, {
          resultCode: "DENIED",
          targetId: targetAuditId,
          before,
          metadata: { reason: "INTERNAL_PLAN_PROTECTED", requested_reason: reason, plan_code: before.plan_code, feature_code: featureCode },
        });
        return res.status(409).json({
          error: "O plano INTERNAL é técnico e suas features não podem ser alteradas por esta operação comercial.",
          code: "INTERNAL_PLAN_PROTECTED",
        });
      }

      const validation = validateFeaturePatch(req.body || {}, before);
      if (validation.error) {
        await transaction.rollback();
        transactionOpen = false;
        await auditPlanFeatureWrite(pool, req, {
          resultCode: "DENIED",
          targetId: targetAuditId,
          before,
          metadata: { reason: validation.code, requested_reason: reason, plan_code: before.plan_code, feature_code: featureCode },
        });
        return res.status(400).json({ error: validation.error, code: validation.code });
      }

      const changes = validation.changes;
      const request = transaction.request()
        .input("plan_id", sql.Int, planId)
        .input("feature_id", sql.Int, Number(before.feature_id));
      const setters = [];

      if (isOwn(changes, "is_enabled")) {
        request.input("is_enabled", sql.Bit, changes.is_enabled);
        setters.push("is_enabled = @is_enabled");
      }
      if (isOwn(changes, "bool_value")) {
        request.input("bool_value", sql.Bit, changes.bool_value);
        setters.push("bool_value = @bool_value");
      }
      if (isOwn(changes, "int_value")) {
        request.input("int_value", sql.BigInt, changes.int_value);
        setters.push("int_value = @int_value");
      }
      if (isOwn(changes, "string_value")) {
        request.input("string_value", sql.VarChar(80), changes.string_value);
        setters.push("string_value = @string_value");
      }
      setters.push("updated_at = SYSUTCDATETIME()");

      await request.query(`
        UPDATE dbo.subscription_plan_feature
        SET ${setters.join(", ")}
        WHERE plan_id = @plan_id AND feature_id = @feature_id;
      `);

      const afterResult = await transaction.request()
        .input("plan_id", sql.Int, planId)
        .input("feature_id", sql.Int, Number(before.feature_id))
        .query(`
          SELECT
            p.plan_id,
            p.code AS plan_code,
            f.feature_id,
            f.code AS feature_code,
            f.name AS feature_name,
            f.value_type,
            f.unit_code,
            f.reset_policy,
            f.enforcement_mode,
            f.ledger_operation_code,
            f.is_active AS feature_is_active,
            pf.is_enabled,
            pf.bool_value,
            pf.int_value,
            pf.string_value,
            pf.created_at,
            pf.updated_at
          FROM dbo.subscription_plan p
          INNER JOIN dbo.subscription_plan_feature pf ON pf.plan_id = p.plan_id
          INNER JOIN dbo.subscription_feature f ON f.feature_id = pf.feature_id
          WHERE p.plan_id = @plan_id AND f.feature_id = @feature_id;
        `);
      const after = afterResult.recordset?.[0] || null;

      await transaction.commit();
      transactionOpen = false;

      await auditPlanFeatureWrite(pool, req, {
        targetId: targetAuditId,
        before,
        after,
        metadata: {
          reason,
          plan_code: before.plan_code,
          feature_code: featureCode,
          value_type: before.value_type,
          changed_fields: Object.keys(changes),
        },
      });

      return res.json({ ok: true, feature: after });
    } catch (err) {
      try { if (transactionOpen) await transaction.rollback(); } catch {}
      console.error("[ADMIN PLANS] Falha ao atualizar feature do plano:", err);
      await auditPlanFeatureWrite(pool, req, {
        resultCode: "FAILED",
        targetId: targetAuditId,
        before,
        metadata: { reason: "INTERNAL_ERROR", requested_reason: reason, plan_id: planId, feature_code: featureCode },
      });
      return res.status(500).json({
        error: "Falha ao atualizar feature do plano.",
        code: "ADMIN_PLAN_FEATURE_WRITE_ERROR",
      });
    }
  }
);


export default router;
