// C:\HDUD_DATA\hdud-api-node\src\routes\plans.js

import express from "express";
import { getPool } from "../db.js";

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT
        plan_id,
        code,
        name,
        max_audio_seconds,
        monthly_seconds,
        price_cents,
        currency_code,
        marketing_label,
        is_featured,
        description_short,
        is_active,
        sort_order
      FROM dbo.subscription_plan
      WHERE ISNULL(is_active, 1) = 1
      ORDER BY
        CASE WHEN sort_order IS NULL THEN 999999 ELSE sort_order END ASC,
        plan_id ASC;
    `);

    const items = (result.recordset || []).map((row) => ({
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