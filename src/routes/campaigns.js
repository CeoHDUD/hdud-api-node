// HDUD Admin — Implementação 09.04 | Delivery de Campanhas Institucionais
// Leitura para usuários autenticados da plataforma.
// Não é Admin API: não exige CAMPAIGN_READ/CAMPAIGN_WRITE e não expõe metadados administrativos.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { getPool, sql } from "../db.js";

const router = Router();

const PLACEMENTS = new Set(["DASHBOARD", "PLANS", "GLOBAL_BANNER"]);

function normalizePlacement(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function mapDeliveryCampaign(row) {
  return {
    campaign_id: Number(row.campaign_id),
    headline: row.headline,
    body: row.body,
    asset_path: row.asset_path,
    cta_label: row.cta_label,
    cta_url: row.cta_url,
    placement_code: row.placement_code,
  };
}

// GET /api/campaigns/active?placement=DASHBOARD
// Retorna apenas campanhas elegíveis para exibição no instante da consulta.
router.get("/active", authRequired, async (req, res) => {
  const placement = normalizePlacement(req.query?.placement);

  if (!PLACEMENTS.has(placement)) {
    return res.status(400).json({
      error: "placement inválido.",
      code: "INVALID_CAMPAIGN_PLACEMENT",
      allowed_placements: Array.from(PLACEMENTS),
    });
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("placement_code", sql.VarChar(40), placement)
      .query(`
        SELECT
          campaign_id,
          headline,
          body,
          asset_path,
          cta_label,
          cta_url,
          placement_code
        FROM dbo.v_platform_campaign_delivery
        WHERE placement_code = @placement_code
          AND is_visible = 1
        ORDER BY starts_at DESC, campaign_id DESC;
      `);

    return res.json({
      ok: true,
      placement_code: placement,
      campaigns: (result.recordset || []).map(mapDeliveryCampaign),
    });
  } catch (err) {
    console.error("[CAMPAIGN_DELIVERY_09_04] GET /active failed", err);
    return res.status(500).json({
      error: "Falha ao consultar campanhas ativas.",
      code: "CAMPAIGN_DELIVERY_READ_FAILED",
    });
  }
});

export default router;
