// HDUD Ads — Runtime Delivery + Delivery Ledger + Impression + Click Tracking
// Delivery, impressão e clique são fatos distintos.
// Impression qualificada: >=50% visível por >=1000ms.
// Click: 0..1 por delivery, idempotente e pertencente ao mesmo usuário do delivery.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { getPool, sql } from "../db.js";

const router = Router();

function normalizeSurface(value) {
  const s = typeof value === "string" ? value.trim().toUpperCase() : "";
  return s && s.length <= 80 && /^[A-Z0-9][A-Z0-9_-]*$/.test(s) ? s : null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nullablePositiveBigInt(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  return /^\d+$/.test(s) && BigInt(s) > 0n ? s : null;
}

function requestIp(req) {
  // Express resolve req.ip usando a política trust proxy do server.
  // Não lemos X-Forwarded-For diretamente aqui para evitar aceitar um header
  // arbitrário fora da cadeia de proxies confiáveis.
  let raw = String(req?.ip || req?.socket?.remoteAddress || "").trim();
  if (!raw) return null;

  // Normaliza IPv4 mapeado em IPv6 (ex.: ::ffff:192.168.0.10).
  if (raw.toLowerCase().startsWith("::ffff:")) raw = raw.slice(7);
  return raw.slice(0, 45) || null;
}

function mapAd(row) {
  if (!row) return null;
  return {
    campaign_id: String(row.campaign_id),
    campaign_code: row.campaign_code,
    creative_id: String(row.creative_id),
    creative_code: row.creative_code,
    creative_type: row.creative_type,
    headline: row.headline,
    body: row.body,
    asset_path: row.asset_path,
    cta_label: row.cta_label,
    cta_url: row.cta_url,
    placement_id: String(row.placement_id),
    placement_code: row.placement_code,
    surface_code: row.surface_code,
    advertiser_id: String(row.advertiser_id),
    advertiser_name: row.advertiser_name,
    flight_id: String(row.flight_id),
    delivery_token: row.delivery_token || null,
  };
}

// GET /api/ads/active?surface=DASHBOARD
// Seleciona 1 creative elegível e, se houver, grava o delivery no mesmo transaction boundary.
// A seleção permanece aleatória/stateless: não implementa pacing, bidding ou optimization.
router.get("/active", authRequired, async (req, res) => {
  const surface = normalizeSurface(req.query?.surface);

  if (!surface) {
    return res.status(400).json({
      error: "surface inválida.",
      code: "INVALID_ADS_SURFACE",
    });
  }

  const userId = positiveInt(req.user?.sub ?? req.user?.user_id ?? req.user?.id);
  const authorId = nullablePositiveBigInt(req.user?.author_id);
  const sessionContext = String(req.user?.session_context || "AUTHOR").trim().toUpperCase();

  if (!userId || !new Set(["AUTHOR", "OPERATOR"]).has(sessionContext)) {
    return res.status(401).json({
      error: "Contexto de identidade inválido para delivery Ads.",
      code: "INVALID_ADS_DELIVERY_IDENTITY",
    });
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);

  try {
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

    const selected = await tx
      .request()
      .input("surface_code", sql.VarChar(80), surface)
      .query(`
        SELECT TOP (1)
          c.campaign_id,
          c.campaign_code,
          cr.creative_id,
          cr.creative_code,
          cr.creative_type,
          cr.headline,
          cr.body,
          cr.asset_path,
          cr.cta_label,
          cr.cta_url,
          p.placement_id,
          p.placement_code,
          p.surface_code,
          a.advertiser_id,
          a.advertiser_name,
          f.flight_id
        FROM dbo.ads_campaign c
        JOIN dbo.ads_advertiser a
          ON a.advertiser_id = c.advertiser_id
         AND a.status_code = 'ACTIVE'
        JOIN dbo.ads_campaign_placement cp
          ON cp.campaign_id = c.campaign_id
         AND cp.status_code = 'ACTIVE'
        JOIN dbo.ads_placement p
          ON p.placement_id = cp.placement_id
         AND p.status_code = 'ACTIVE'
         AND p.surface_code = @surface_code
        JOIN dbo.ads_creative cr
          ON cr.campaign_id = c.campaign_id
         AND cr.status_code = 'ACTIVE'
        JOIN dbo.ads_flight f
          ON f.campaign_id = c.campaign_id
         AND f.status_code = 'ACTIVE'
         AND f.starts_at <= SYSUTCDATETIME()
         AND f.ends_at > SYSUTCDATETIME()
        JOIN dbo.ads_budget b
          ON b.campaign_id = c.campaign_id
         AND b.status_code = 'ACTIVE'
        WHERE c.status_code = 'ACTIVE'
          AND (c.starts_at IS NULL OR c.starts_at <= SYSUTCDATETIME())
          AND (c.ends_at IS NULL OR c.ends_at > SYSUTCDATETIME())
        ORDER BY NEWID();
      `);

    const row = selected.recordset?.[0] || null;

    if (!row) {
      await tx.commit();
      return res.json({
        ok: true,
        surface_code: surface,
        ad: null,
      });
    }

    const inserted = await tx
      .request()
      .input("advertiser_id", sql.BigInt, String(row.advertiser_id))
      .input("campaign_id", sql.BigInt, String(row.campaign_id))
      .input("creative_id", sql.BigInt, String(row.creative_id))
      .input("placement_id", sql.BigInt, String(row.placement_id))
      .input("flight_id", sql.BigInt, String(row.flight_id))
      .input("surface_code", sql.VarChar(80), surface)
      .input("user_id", sql.Int, userId)
      .input("author_id", sql.BigInt, authorId)
      .input("session_context", sql.VarChar(20), sessionContext)
      .input("request_ip", sql.VarChar(45), requestIp(req))
      .input("user_agent", sql.NVarChar(512), String(req.headers?.["user-agent"] || "").slice(0, 512) || null)
      .query(`
        INSERT dbo.ads_delivery_ledger
        (
          advertiser_id,
          campaign_id,
          creative_id,
          placement_id,
          flight_id,
          surface_code,
          user_id,
          author_id,
          session_context,
          request_ip,
          user_agent
        )
        OUTPUT CONVERT(varchar(36), inserted.delivery_token) AS delivery_token
        VALUES
        (
          @advertiser_id,
          @campaign_id,
          @creative_id,
          @placement_id,
          @flight_id,
          @surface_code,
          @user_id,
          @author_id,
          @session_context,
          @request_ip,
          @user_agent
        );
      `);

    row.delivery_token = inserted.recordset?.[0]?.delivery_token || null;

    await tx.commit();

    return res.json({
      ok: true,
      surface_code: surface,
      ad: mapAd(row),
    });
  } catch (err) {
    try {
      if (tx._aborted !== true) await tx.rollback();
    } catch {}

    console.error("[ADS_DELIVERY_LEDGER] GET /active failed", err);
    return res.status(500).json({
      error: "Falha ao registrar e entregar publicidade elegível.",
      code: "ADS_DELIVERY_LEDGER_WRITE_FAILED",
    });
  }
});


// POST /api/ads/impressions
// Registra 0..1 impressão qualificada por delivery.
// O delivery_token é opaco e só pode ser consumido pelo mesmo usuário que recebeu o delivery.
router.post("/impressions", authRequired, async (req, res) => {
  const deliveryToken = String(req.body?.delivery_token || "").trim();
  const visibilityRatio = Number(req.body?.visibility_ratio);
  const visibleMs = Number(req.body?.visible_ms);
  const userId = positiveInt(req.user?.sub ?? req.user?.user_id ?? req.user?.id);

  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryToken)) {
    return res.status(400).json({ error: "delivery_token inválido.", code: "INVALID_ADS_DELIVERY_TOKEN" });
  }
  if (!Number.isFinite(visibilityRatio) || visibilityRatio < 0.5 || visibilityRatio > 1) {
    return res.status(400).json({ error: "visibility_ratio deve estar entre 0.5 e 1.0.", code: "INVALID_ADS_VISIBILITY_RATIO" });
  }
  if (!Number.isInteger(visibleMs) || visibleMs < 1000 || visibleMs > 600000) {
    return res.status(400).json({ error: "visible_ms inválido.", code: "INVALID_ADS_VISIBLE_MS" });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input("delivery_token", sql.UniqueIdentifier, deliveryToken)
      .input("user_id", sql.Int, userId)
      .input("visibility_ratio", sql.Decimal(5, 4), Math.min(1, Math.max(0.5, visibilityRatio)))
      .input("visible_ms", sql.Int, visibleMs)
      .input("request_ip", sql.VarChar(45), requestIp(req))
      .input("user_agent", sql.NVarChar(512), String(req.headers?.["user-agent"] || "").slice(0, 512) || null)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;

        DECLARE @delivery_id BIGINT;
        SELECT @delivery_id = d.delivery_id
        FROM dbo.ads_delivery_ledger d WITH (UPDLOCK, HOLDLOCK)
        WHERE d.delivery_token = @delivery_token
          AND d.user_id = @user_id;

        IF @delivery_id IS NULL
        BEGIN
          ROLLBACK TRAN;
          THROW 51074, 'DELIVERY_NOT_FOUND_OR_NOT_OWNED', 1;
        END;

        DECLARE @impression_id BIGINT, @impression_token UNIQUEIDENTIFIER, @impressed_at DATETIME2(3), @created BIT = 0;

        SELECT
          @impression_id = i.impression_id,
          @impression_token = i.impression_token,
          @impressed_at = i.impressed_at
        FROM dbo.ads_impression_event i WITH (UPDLOCK, HOLDLOCK)
        WHERE i.delivery_id = @delivery_id;

        IF @impression_id IS NULL
        BEGIN
          DECLARE @out TABLE(impression_id BIGINT, impression_token UNIQUEIDENTIFIER, impressed_at DATETIME2(3));
          INSERT dbo.ads_impression_event
          (delivery_id, visibility_ratio, visible_ms, request_ip, user_agent)
          OUTPUT inserted.impression_id, inserted.impression_token, inserted.impressed_at
          INTO @out(impression_id, impression_token, impressed_at)
          VALUES (@delivery_id, @visibility_ratio, @visible_ms, @request_ip, @user_agent);

          SELECT TOP (1)
            @impression_id = impression_id,
            @impression_token = impression_token,
            @impressed_at = impressed_at
          FROM @out;
          SET @created = 1;
        END;

        COMMIT TRAN;

        SELECT
          @created AS created,
          @delivery_id AS delivery_id,
          @impression_id AS impression_id,
          CONVERT(varchar(36), @impression_token) AS impression_token,
          @impressed_at AS impressed_at;
      `);

    const row = result.recordset?.[0];
    return res.status(row?.created ? 201 : 200).json({
      ok: true,
      created: !!row?.created,
      delivery_id: row?.delivery_id != null ? String(row.delivery_id) : null,
      impression_id: row?.impression_id != null ? String(row.impression_id) : null,
      impression_token: row?.impression_token || null,
      impressed_at: row?.impressed_at || null,
    });
  } catch (err) {
    if (String(err?.message || "").includes("DELIVERY_NOT_FOUND_OR_NOT_OWNED")) {
      return res.status(404).json({ error: "Delivery não encontrado para este usuário.", code: "ADS_DELIVERY_NOT_FOUND" });
    }
    console.error("[ADS_IMPRESSION_TRACKING] POST /impressions failed", err);
    return res.status(500).json({ error: "Falha ao registrar impressão Ads.", code: "ADS_IMPRESSION_WRITE_FAILED" });
  }
});


// POST /api/ads/clicks
// Registra 0..1 clique por delivery.
// O delivery_token é opaco e só pode ser consumido pelo mesmo usuário que recebeu o delivery.
// Click é independente de impression: um usuário pode clicar antes de completar a janela de 1000ms.
router.post("/clicks", authRequired, async (req, res) => {
  const deliveryToken = String(req.body?.delivery_token || "").trim();
  const userId = positiveInt(req.user?.sub ?? req.user?.user_id ?? req.user?.id);

  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryToken)) {
    return res.status(400).json({ error: "delivery_token inválido.", code: "INVALID_ADS_DELIVERY_TOKEN" });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input("delivery_token", sql.UniqueIdentifier, deliveryToken)
      .input("user_id", sql.Int, userId)
      .input("request_ip", sql.VarChar(45), requestIp(req))
      .input("user_agent", sql.NVarChar(512), String(req.headers?.["user-agent"] || "").slice(0, 512) || null)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;

        DECLARE @delivery_id BIGINT;
        SELECT @delivery_id = d.delivery_id
        FROM dbo.ads_delivery_ledger d WITH (UPDLOCK, HOLDLOCK)
        WHERE d.delivery_token = @delivery_token
          AND d.user_id = @user_id;

        IF @delivery_id IS NULL
        BEGIN
          ROLLBACK TRAN;
          THROW 51084, 'DELIVERY_NOT_FOUND_OR_NOT_OWNED', 1;
        END;

        DECLARE @click_id BIGINT, @click_token UNIQUEIDENTIFIER, @clicked_at DATETIME2(3), @created BIT = 0;

        SELECT
          @click_id = c.click_id,
          @click_token = c.click_token,
          @clicked_at = c.clicked_at
        FROM dbo.ads_click_event c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.delivery_id = @delivery_id;

        IF @click_id IS NULL
        BEGIN
          DECLARE @out TABLE(click_id BIGINT, click_token UNIQUEIDENTIFIER, clicked_at DATETIME2(3));
          INSERT dbo.ads_click_event
          (delivery_id, request_ip, user_agent)
          OUTPUT inserted.click_id, inserted.click_token, inserted.clicked_at
          INTO @out(click_id, click_token, clicked_at)
          VALUES (@delivery_id, @request_ip, @user_agent);

          SELECT TOP (1)
            @click_id = click_id,
            @click_token = click_token,
            @clicked_at = clicked_at
          FROM @out;
          SET @created = 1;
        END;

        COMMIT TRAN;

        SELECT
          @created AS created,
          @delivery_id AS delivery_id,
          @click_id AS click_id,
          CONVERT(varchar(36), @click_token) AS click_token,
          @clicked_at AS clicked_at;
      `);

    const row = result.recordset?.[0];
    return res.status(row?.created ? 201 : 200).json({
      ok: true,
      created: !!row?.created,
      delivery_id: row?.delivery_id != null ? String(row.delivery_id) : null,
      click_id: row?.click_id != null ? String(row.click_id) : null,
      click_token: row?.click_token || null,
      clicked_at: row?.clicked_at || null,
    });
  } catch (err) {
    if (String(err?.message || "").includes("DELIVERY_NOT_FOUND_OR_NOT_OWNED")) {
      return res.status(404).json({ error: "Delivery não encontrado para este usuário.", code: "ADS_DELIVERY_NOT_FOUND" });
    }
    console.error("[ADS_CLICK_TRACKING] POST /clicks failed", err);
    return res.status(500).json({ error: "Falha ao registrar clique Ads.", code: "ADS_CLICK_WRITE_FAILED" });
  }
});

export default router;
