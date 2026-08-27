// HDUD Admin — Implementação 12 | Métricas & Observabilidade — Read Only
// Torre de Controle | Ads Reporting real sobre Delivery / Impression / Click.
// Fontes da verdade: subscriptions, AI Ledger, enforcement, Campanhas e HDUD Ads.
// Não expõe conteúdo editorial, não cria segunda fonte da verdade e não calcula spend/billing inexistentes.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireAdminPermission } from "../middleware/adminAuthorization.js";
import { getPool, sql } from "../db.js";
import { writeAdminAuditSafe } from "../services/adminAuditService.js";

const router = Router();
const ALLOWED_WINDOWS = new Set([7, 30, 90]);

function actorUserId(req) {
  const n = Number(req.user?.sub ?? req.user?.user_id ?? req.user?.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pct(numerator, denominator) {
  const n = asNumber(numerator);
  const d = asNumber(denominator);
  return d > 0 ? Number(((n / d) * 100).toFixed(4)) : 0;
}

function parseDays(value) {
  if (value == null || value === "") return 30;
  const days = Number(value);
  return Number.isInteger(days) && ALLOWED_WINDOWS.has(days) ? days : null;
}

function performanceRow(row = {}) {
  const deliveries = asNumber(row.deliveries);
  const impressions = asNumber(row.impressions);
  const clicks = asNumber(row.clicks);
  const qualifiedClicks = asNumber(row.qualified_clicks);
  return {
    ...row,
    deliveries,
    impressions,
    clicks,
    qualified_clicks: qualifiedClicks,
    qualified_impression_rate_pct: pct(impressions, deliveries),
    click_rate_per_delivery_pct: pct(clicks, deliveries),
    qualified_ctr_pct: pct(qualifiedClicks, impressions),
  };
}

async function auditOverview(pool, req, days, resultCode, metadata = {}) {
  await writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: req.user?.email || null,
    eventCode: "ADMIN_METRICS_OVERVIEW_READ",
    resourceCode: "PLATFORM_METRICS",
    actionCode: "READ",
    resultCode,
    targetType: "METRICS_OVERVIEW",
    targetId: `DAYS_${days}`,
    metadata: { days, ...metadata },
  });
}

// GET /api/admin/metrics/overview?days=7|30|90
router.get(
  "/metrics/overview",
  authRequired,
  requireAdminPermission("METRICS_READ"),
  async (req, res) => {
    const days = parseDays(req.query?.days);
    if (!days) {
      return res.status(400).json({
        error: "Janela de métricas inválida.",
        code: "INVALID_METRICS_WINDOW",
        details: [{ field: "days", issue: "allowed_values_7_30_90" }],
      });
    }

    const pool = await getPool();
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    try {
      const request = pool.request()
        .input("from", sql.DateTime2, from)
        .input("to", sql.DateTime2, to);

      const result = await request.query(`
        SELECT COUNT(DISTINCT user_id) AS active_users
        FROM dbo.user_subscription
        WHERE status = 'ACTIVE';

        SELECT sp.code AS plan_code, COUNT(DISTINCT us.user_id) AS users
        FROM dbo.user_subscription us
        INNER JOIN dbo.subscription_plan sp ON sp.plan_id = us.plan_id
        WHERE us.status = 'ACTIVE'
        GROUP BY sp.code
        ORDER BY sp.code;

        SELECT
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM dbo.ai_usage_ledger
        WHERE occurred_at >= @from AND occurred_at < @to;

        SELECT
          sf.code AS feature_code,
          sf.name AS feature_name,
          sf.unit_code,
          COUNT_BIG(*) AS consume_events,
          COALESCE(SUM(see.requested_value), 0) AS consumed_value
        FROM dbo.subscription_enforcement_event see
        INNER JOIN dbo.subscription_feature sf ON sf.feature_id = see.feature_id
        WHERE see.action_code = 'CONSUME'
          AND see.allowed = 1
          AND see.occurred_at >= @from AND see.occurred_at < @to
        GROUP BY sf.code, sf.name, sf.unit_code
        ORDER BY sf.code;

        SELECT
          reason_code,
          COUNT_BIG(*) AS denied_events,
          COUNT(DISTINCT user_id) AS affected_users
        FROM dbo.subscription_enforcement_event
        WHERE action_code = 'DENY'
          AND allowed = 0
          AND occurred_at >= @from AND occurred_at < @to
        GROUP BY reason_code
        ORDER BY denied_events DESC, reason_code;

        SELECT status_code, COUNT_BIG(*) AS qty
        FROM dbo.platform_campaign
        GROUP BY status_code
        ORDER BY status_code;

        SELECT entity_type, status_code, qty
        FROM (
          SELECT 'ADVERTISER' AS entity_type, status_code, COUNT_BIG(*) AS qty FROM dbo.ads_advertiser GROUP BY status_code
          UNION ALL
          SELECT 'CAMPAIGN', status_code, COUNT_BIG(*) FROM dbo.ads_campaign GROUP BY status_code
          UNION ALL
          SELECT 'FLIGHT', status_code, COUNT_BIG(*) FROM dbo.ads_flight GROUP BY status_code
          UNION ALL
          SELECT 'CREATIVE', status_code, COUNT_BIG(*) FROM dbo.ads_creative GROUP BY status_code
        ) x
        ORDER BY entity_type, status_code;

        SELECT currency_code, COALESCE(SUM(total_budget), 0) AS configured_budget
        FROM dbo.ads_budget
        WHERE status_code = 'ACTIVE'
        GROUP BY currency_code
        ORDER BY currency_code;

        /* Ads Reporting — coorte ancorada no momento do delivery. */
        WITH delivery_window AS
        (
          SELECT d.delivery_id, d.campaign_id, d.creative_id, d.placement_id, d.flight_id,
                 d.advertiser_id, d.user_id, d.author_id, d.surface_code, d.delivered_at
          FROM dbo.ads_delivery_ledger d
          WHERE d.delivered_at >= @from AND d.delivered_at < @to
        )
        SELECT
          COUNT_BIG(*) AS deliveries,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS impressions,
          COALESCE(SUM(CASE WHEN c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS clicks,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL AND c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS qualified_clicks,
          COUNT(DISTINCT dw.user_id) AS unique_users,
          COUNT(DISTINCT dw.campaign_id) AS campaigns_with_delivery,
          COUNT(DISTINCT dw.placement_id) AS placements_with_delivery
        FROM delivery_window dw
        LEFT JOIN dbo.ads_impression_event i ON i.delivery_id = dw.delivery_id
        LEFT JOIN dbo.ads_click_event c ON c.delivery_id = dw.delivery_id;

        WITH delivery_window AS
        (
          SELECT d.delivery_id, d.campaign_id
          FROM dbo.ads_delivery_ledger d
          WHERE d.delivered_at >= @from AND d.delivered_at < @to
        )
        SELECT
          ac.campaign_id,
          ac.campaign_code,
          ac.campaign_name,
          COUNT_BIG(*) AS deliveries,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS impressions,
          COALESCE(SUM(CASE WHEN c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS clicks,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL AND c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS qualified_clicks
        FROM delivery_window dw
        INNER JOIN dbo.ads_campaign ac ON ac.campaign_id = dw.campaign_id
        LEFT JOIN dbo.ads_impression_event i ON i.delivery_id = dw.delivery_id
        LEFT JOIN dbo.ads_click_event c ON c.delivery_id = dw.delivery_id
        GROUP BY ac.campaign_id, ac.campaign_code, ac.campaign_name
        ORDER BY deliveries DESC, ac.campaign_id;

        WITH delivery_window AS
        (
          SELECT d.delivery_id, d.placement_id
          FROM dbo.ads_delivery_ledger d
          WHERE d.delivered_at >= @from AND d.delivered_at < @to
        )
        SELECT
          ap.placement_id,
          ap.placement_code,
          ap.placement_name,
          ap.surface_code,
          COUNT_BIG(*) AS deliveries,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS impressions,
          COALESCE(SUM(CASE WHEN c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS clicks,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL AND c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS qualified_clicks
        FROM delivery_window dw
        INNER JOIN dbo.ads_placement ap ON ap.placement_id = dw.placement_id
        LEFT JOIN dbo.ads_impression_event i ON i.delivery_id = dw.delivery_id
        LEFT JOIN dbo.ads_click_event c ON c.delivery_id = dw.delivery_id
        GROUP BY ap.placement_id, ap.placement_code, ap.placement_name, ap.surface_code
        ORDER BY deliveries DESC, ap.placement_id;

        WITH delivery_window AS
        (
          SELECT d.delivery_id, CONVERT(date, d.delivered_at) AS delivery_date
          FROM dbo.ads_delivery_ledger d
          WHERE d.delivered_at >= @from AND d.delivered_at < @to
        )
        SELECT
          dw.delivery_date,
          COUNT_BIG(*) AS deliveries,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS impressions,
          COALESCE(SUM(CASE WHEN c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS clicks,
          COALESCE(SUM(CASE WHEN i.delivery_id IS NOT NULL AND c.delivery_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS qualified_clicks
        FROM delivery_window dw
        LEFT JOIN dbo.ads_impression_event i ON i.delivery_id = dw.delivery_id
        LEFT JOIN dbo.ads_click_event c ON c.delivery_id = dw.delivery_id
        GROUP BY dw.delivery_date
        ORDER BY dw.delivery_date ASC;
      `);

      const sets = result.recordsets || [];
      const activeUsers = asNumber(sets[0]?.[0]?.active_users);
      const byPlan = (sets[1] || []).map((r) => ({ plan_code: r.plan_code, users: asNumber(r.users) }));
      const aiRow = sets[2]?.[0] || {};
      const features = (sets[3] || []).map((r) => ({
        feature_code: r.feature_code,
        feature_name: r.feature_name,
        unit_code: r.unit_code,
        consume_events: asNumber(r.consume_events),
        consumed_value: asNumber(r.consumed_value),
      }));
      const enforcement = (sets[4] || []).map((r) => ({
        reason_code: r.reason_code,
        denied_events: asNumber(r.denied_events),
        affected_users: asNumber(r.affected_users),
      }));
      const campaigns = (sets[5] || []).map((r) => ({ status_code: r.status_code, qty: asNumber(r.qty) }));
      const adEntities = (sets[6] || []).map((r) => ({
        entity_type: r.entity_type,
        status_code: r.status_code,
        qty: asNumber(r.qty),
      }));
      const configuredBudget = (sets[7] || []).map((r) => ({
        currency_code: r.currency_code,
        configured_budget: asNumber(r.configured_budget),
      }));

      const performanceSummary = performanceRow(sets[8]?.[0] || {});
      performanceSummary.unique_users = asNumber(sets[8]?.[0]?.unique_users);
      performanceSummary.campaigns_with_delivery = asNumber(sets[8]?.[0]?.campaigns_with_delivery);
      performanceSummary.placements_with_delivery = asNumber(sets[8]?.[0]?.placements_with_delivery);

      const byCampaign = (sets[9] || []).map((r) => performanceRow({
        campaign_id: String(r.campaign_id),
        campaign_code: r.campaign_code,
        campaign_name: r.campaign_name,
        deliveries: r.deliveries,
        impressions: r.impressions,
        clicks: r.clicks,
        qualified_clicks: r.qualified_clicks,
      }));

      const byPlacement = (sets[10] || []).map((r) => performanceRow({
        placement_id: String(r.placement_id),
        placement_code: r.placement_code,
        placement_name: r.placement_name,
        surface_code: r.surface_code,
        deliveries: r.deliveries,
        impressions: r.impressions,
        clicks: r.clicks,
        qualified_clicks: r.qualified_clicks,
      }));

      const daily = (sets[11] || []).map((r) => performanceRow({
        date: r.delivery_date instanceof Date
          ? r.delivery_date.toISOString().slice(0, 10)
          : String(r.delivery_date || "").slice(0, 10),
        deliveries: r.deliveries,
        impressions: r.impressions,
        clicks: r.clicks,
        qualified_clicks: r.qualified_clicks,
      }));

      await auditOverview(pool, req, days, "SUCCESS", {
        ads_reporting: true,
        ads_reporting_basis: "DELIVERED_AT",
      });

      return res.json({
        ok: true,
        window: { days, from: from.toISOString(), to: to.toISOString() },
        subscriptions: { active_users: activeUsers, by_plan: byPlan },
        ai: {
          calls: asNumber(aiRow.calls),
          total_tokens: asNumber(aiRow.total_tokens),
          cost_usd: asNumber(aiRow.cost_usd),
        },
        features,
        enforcement,
        campaigns,
        ads: {
          entities: adEntities,
          configured_budget: configuredBudget,
          performance: {
            basis: "DELIVERED_AT",
            summary: performanceSummary,
            by_campaign: byCampaign,
            by_placement: byPlacement,
            daily,
            semantics: {
              delivery: "Creative efetivamente devolvido pelo runtime e persistido em ads_delivery_ledger.",
              impression: "Delivery com impressão qualificada persistida em ads_impression_event.",
              click: "Delivery com clique explícito persistido em ads_click_event.",
              qualified_ctr: "Cliques em deliveries que também possuem impressão qualificada / impressões qualificadas.",
              click_rate_per_delivery: "Cliques / deliveries.",
            },
          },
        },
      });
    } catch (err) {
      console.error("[ADMIN METRICS] Falha ao consultar overview:", err);
      await auditOverview(pool, req, days, "FAILED", { reason: "QUERY_FAILED" });
      return res.status(500).json({
        error: "Falha interna ao consultar métricas administrativas.",
        code: "ADMIN_METRICS_ERROR",
      });
    }
  }
);

export default router;
