// C:\HDUD_DATA\hdud-api-node\src\routes\plans.js

import express from "express";
import { getPool } from "../db.js";

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const pool = await getPool();

    const [plansResult, featuresResult] = await Promise.all([
      pool.request().query(`
        SELECT
          sp.plan_id,
          sp.code,
          sp.name,
          sp.max_audio_seconds,
          sp.monthly_seconds,
          sp.price_cents,
          sp.currency_code,
          sp.marketing_label,
          sp.is_featured,
          sp.description_short,
          sp.is_active,
          sp.sort_order,
          p.monthly_external_ai_budget_usd,
          COALESCE(p.warning_pct, 80) AS ai_warning_pct,
          COALESCE(p.critical_pct, 90) AS ai_critical_pct,
          COALESCE(p.block_pct, 100) AS ai_block_pct,
          COALESCE(p.hard_stop, 0) AS ai_hard_stop,
          COALESCE(p.allow_overage, 0) AS ai_allow_overage,
          COALESCE(p.overage_mode, 'BLOCK') AS ai_overage_mode
        FROM dbo.subscription_plan sp
        LEFT JOIN dbo.subscription_plan_ai_policy p ON p.plan_id = sp.plan_id
        WHERE ISNULL(sp.is_active, 1) = 1
          AND UPPER(LTRIM(RTRIM(ISNULL(sp.code, '')))) NOT IN ('INTERNAL', 'INTERNAL_PLAN')
          AND UPPER(LTRIM(RTRIM(ISNULL(sp.name, '')))) <> 'INTERNAL PLAN'
        ORDER BY
          CASE WHEN sp.sort_order IS NULL THEN 999999 ELSE sp.sort_order END ASC,
          sp.plan_id ASC;
      `),
      pool.request().query(`
        SELECT
          pf.plan_id,
          f.code AS feature_code,
          f.name AS feature_name,
          f.value_type,
          f.unit_code,
          f.reset_policy,
          f.enforcement_mode,
          f.ledger_operation_code,
          pf.bool_value,
          pf.int_value,
          pf.string_value
        FROM dbo.subscription_plan_feature pf
        INNER JOIN dbo.subscription_feature f
          ON f.feature_id = pf.feature_id
        WHERE pf.is_enabled = 1
          AND f.is_active = 1
        ORDER BY pf.plan_id, f.feature_id;
      `),
    ]);

    const featuresByPlan = new Map();

    for (const row of featuresResult.recordset || []) {
      const planId = Number(row.plan_id);
      if (!featuresByPlan.has(planId)) featuresByPlan.set(planId, []);

      featuresByPlan.get(planId).push({
        code: row.feature_code ? String(row.feature_code) : null,
        name: row.feature_name ? String(row.feature_name) : null,
        value_type: row.value_type ? String(row.value_type) : null,
        unit_code: row.unit_code == null ? null : String(row.unit_code),
        reset_policy: row.reset_policy ? String(row.reset_policy) : null,
        enforcement_mode: row.enforcement_mode
          ? String(row.enforcement_mode)
          : null,
        ledger_operation_code:
          row.ledger_operation_code == null
            ? null
            : String(row.ledger_operation_code),
        bool_value: row.bool_value == null ? null : !!row.bool_value,
        int_value: row.int_value == null ? null : Number(row.int_value),
        string_value: row.string_value == null ? null : String(row.string_value),
      });
    }

    const items = (plansResult.recordset || []).map((row) => ({
      plan_id: Number(row.plan_id),
      code: row.code ? String(row.code) : null,
      name: row.name ? String(row.name) : null,
      max_audio_seconds:
        row.max_audio_seconds != null ? Number(row.max_audio_seconds) : 0,
      monthly_seconds:
        row.monthly_seconds != null ? Number(row.monthly_seconds) : 0,
      price_cents: row.price_cents != null ? Number(row.price_cents) : 0,
      currency_code: row.currency_code ? String(row.currency_code) : "BRL",
      marketing_label: row.marketing_label ? String(row.marketing_label) : null,
      is_featured: !!row.is_featured,
      description_short: row.description_short
        ? String(row.description_short)
        : null,
      features: featuresByPlan.get(Number(row.plan_id)) || [],
      ai_policy: {
        monthly_external_ai_budget_usd:
          row.monthly_external_ai_budget_usd != null
            ? Number(row.monthly_external_ai_budget_usd)
            : null,
        warning_pct: Number(row.ai_warning_pct ?? 80),
        critical_pct: Number(row.ai_critical_pct ?? 90),
        block_pct: Number(row.ai_block_pct ?? 100),
        hard_stop: !!row.ai_hard_stop,
        allow_overage: !!row.ai_allow_overage,
        overage_mode: String(row.ai_overage_mode || "BLOCK"),
      },
    }));

    return res.json({
      ok: true,
      items,
    });
  } catch (err) {
    console.error("[GET /plans] erro:", err);
    return res.status(500).json({
      error: "Erro ao carregar catálogo de planos.",
      detail: err?.message || null,
    });
  }
});

export default router;
