// HDUD Admin — Implementação 09.02 | Campanhas & Conteúdo Institucional
// Backoffice institucional/comercial próprio da HDUD.
// Fronteira absoluta: não administra conteúdo editorial de Autor e não pertence ao domínio HDUD Ads.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireAdminPermission } from "../middleware/adminAuthorization.js";
import { getPool, sql } from "../db.js";
import { writeAdminAuditSafe } from "../services/adminAuditService.js";

const router = Router();

const PLACEMENTS = new Set(["DASHBOARD", "PLANS", "GLOBAL_BANNER"]);
const PERSISTED_STATUSES = new Set(["DRAFT", "SCHEDULED", "PAUSED", "CANCELLED"]);

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

function isOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value, maxLength) {
  if (value == null) return { value: null };
  if (typeof value !== "string") return { error: "INVALID_STRING" };
  const v = value.trim();
  if (!v) return { value: null };
  if (v.length > maxLength) return { error: "STRING_TOO_LONG" };
  return { value: v };
}

function parseNullableDate(value) {
  if (value == null || value === "") return { value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: "INVALID_DATE" };
  return { value: d };
}

function asReason(value, required = false) {
  if (value == null || value === "") return required ? null : "";
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (!reason || reason.length > 1000) return null;
  return reason;
}

function mapCampaign(row) {
  if (!row) return null;
  return {
    campaign_id: Number(row.campaign_id),
    campaign_code: row.campaign_code,
    campaign_name: row.campaign_name,
    headline: row.headline,
    body: row.body,
    asset_path: row.asset_path,
    cta_label: row.cta_label,
    cta_url: row.cta_url,
    placement_code: row.placement_code,
    status_code: row.status_code ?? row.persisted_status,
    effective_status: row.effective_status ?? row.status_code ?? row.persisted_status,
    is_visible: row.is_visible == null ? null : Boolean(row.is_visible),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_by_user_id: Number(row.created_by_user_id),
    updated_by_user_id: Number(row.updated_by_user_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    row_version: row.row_version,
  };
}

function campaignSelect(alias = "c") {
  return `
    ${alias}.campaign_id,
    ${alias}.campaign_code,
    ${alias}.campaign_name,
    ${alias}.headline,
    ${alias}.body,
    ${alias}.asset_path,
    ${alias}.cta_label,
    ${alias}.cta_url,
    ${alias}.placement_code,
    ${alias}.status_code,
    ${alias}.starts_at,
    ${alias}.ends_at,
    ${alias}.created_by_user_id,
    ${alias}.updated_by_user_id,
    ${alias}.created_at,
    ${alias}.updated_at,
    CONVERT(varchar(18), ${alias}.row_version, 1) AS row_version
  `;
}

async function auditCampaign(pool, req, {
  eventCode,
  actionCode,
  resultCode = "SUCCESS",
  targetId = null,
  before = null,
  after = null,
  metadata = null,
}) {
  return writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: actorLabel(req),
    eventCode,
    resourceCode: "CAMPAIGN",
    actionCode,
    resultCode,
    targetType: targetId == null ? null : "PLATFORM_CAMPAIGN",
    targetId: targetId == null ? null : String(targetId),
    before,
    after,
    metadata,
  });
}

function validateWindow(startsAt, endsAt) {
  if (endsAt && !startsAt) {
    return { error: "ends_at exige starts_at.", code: "CAMPAIGN_START_REQUIRED" };
  }
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    return { error: "ends_at deve ser posterior a starts_at.", code: "INVALID_CAMPAIGN_WINDOW" };
  }
  return null;
}

function validateCreate(body) {
  const allowed = new Set([
    "campaign_code", "campaign_name", "headline", "body", "asset_path",
    "cta_label", "cta_url", "placement_code", "starts_at", "ends_at", "reason",
  ]);
  const unknown = Object.keys(body || {}).filter((k) => !allowed.has(k));
  if (unknown.length) {
    return { error: `Campos não permitidos: ${unknown.join(", ")}.`, code: "CAMPAIGN_FIELDS_NOT_ALLOWED" };
  }

  const campaignCode = trimString(body?.campaign_code).toUpperCase();
  const campaignName = trimString(body?.campaign_name);
  const headline = trimString(body?.headline);
  const placementCode = trimString(body?.placement_code).toUpperCase();

  if (!campaignCode || campaignCode.length > 100 || !/^[A-Z0-9][A-Z0-9_-]*$/.test(campaignCode)) {
    return { error: "campaign_code inválido.", code: "INVALID_CAMPAIGN_CODE" };
  }
  if (!campaignName || campaignName.length > 160) {
    return { error: "campaign_name inválido.", code: "INVALID_CAMPAIGN_NAME" };
  }
  if (!headline || headline.length > 200) {
    return { error: "headline inválido.", code: "INVALID_CAMPAIGN_HEADLINE" };
  }
  if (!PLACEMENTS.has(placementCode)) {
    return { error: "placement_code inválido.", code: "INVALID_CAMPAIGN_PLACEMENT" };
  }

  const bodyValue = optionalString(body?.body, 2000);
  const assetPath = optionalString(body?.asset_path, 1000);
  const ctaLabel = optionalString(body?.cta_label, 80);
  const ctaUrl = optionalString(body?.cta_url, 1000);
  if (bodyValue.error || assetPath.error || ctaLabel.error || ctaUrl.error) {
    return { error: "Campo textual inválido ou excede o tamanho permitido.", code: "INVALID_CAMPAIGN_TEXT" };
  }

  if ((ctaLabel.value == null) !== (ctaUrl.value == null)) {
    return { error: "cta_label e cta_url devem ser informados em conjunto.", code: "INVALID_CAMPAIGN_CTA" };
  }

  const startsAt = parseNullableDate(body?.starts_at);
  const endsAt = parseNullableDate(body?.ends_at);
  if (startsAt.error || endsAt.error) {
    return { error: "Data de campanha inválida.", code: "INVALID_CAMPAIGN_DATE" };
  }
  const windowError = validateWindow(startsAt.value, endsAt.value);
  if (windowError) return windowError;

  return {
    values: {
      campaign_code: campaignCode,
      campaign_name: campaignName,
      headline,
      body: bodyValue.value,
      asset_path: assetPath.value,
      cta_label: ctaLabel.value,
      cta_url: ctaUrl.value,
      placement_code: placementCode,
      starts_at: startsAt.value,
      ends_at: endsAt.value,
    },
  };
}

function validatePatch(body, before) {
  const allowed = new Set([
    "campaign_code", "campaign_name", "headline", "body", "asset_path",
    "cta_label", "cta_url", "placement_code", "starts_at", "ends_at", "reason",
  ]);
  const forbidden = ["status_code", "campaign_id", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at", "row_version"]
    .filter((k) => isOwn(body, k));
  if (forbidden.length) {
    return { error: `Campos controlados pelo sistema: ${forbidden.join(", ")}.`, code: "CAMPAIGN_SYSTEM_FIELDS_FORBIDDEN" };
  }
  const unknown = Object.keys(body || {}).filter((k) => !allowed.has(k));
  if (unknown.length) {
    return { error: `Campos não permitidos: ${unknown.join(", ")}.`, code: "CAMPAIGN_FIELDS_NOT_ALLOWED" };
  }

  const changes = {};

  if (isOwn(body, "campaign_code")) {
    const v = trimString(body.campaign_code).toUpperCase();
    if (!v || v.length > 100 || !/^[A-Z0-9][A-Z0-9_-]*$/.test(v)) {
      return { error: "campaign_code inválido.", code: "INVALID_CAMPAIGN_CODE" };
    }
    changes.campaign_code = v;
  }
  if (isOwn(body, "campaign_name")) {
    const v = trimString(body.campaign_name);
    if (!v || v.length > 160) return { error: "campaign_name inválido.", code: "INVALID_CAMPAIGN_NAME" };
    changes.campaign_name = v;
  }
  if (isOwn(body, "headline")) {
    const v = trimString(body.headline);
    if (!v || v.length > 200) return { error: "headline inválido.", code: "INVALID_CAMPAIGN_HEADLINE" };
    changes.headline = v;
  }
  for (const [key, max] of [["body", 2000], ["asset_path", 1000], ["cta_label", 80], ["cta_url", 1000]]) {
    if (isOwn(body, key)) {
      const parsed = optionalString(body[key], max);
      if (parsed.error) return { error: `${key} inválido.`, code: "INVALID_CAMPAIGN_TEXT" };
      changes[key] = parsed.value;
    }
  }
  if (isOwn(body, "placement_code")) {
    const v = trimString(body.placement_code).toUpperCase();
    if (!PLACEMENTS.has(v)) return { error: "placement_code inválido.", code: "INVALID_CAMPAIGN_PLACEMENT" };
    changes.placement_code = v;
  }
  for (const key of ["starts_at", "ends_at"]) {
    if (isOwn(body, key)) {
      const parsed = parseNullableDate(body[key]);
      if (parsed.error) return { error: `${key} inválido.`, code: "INVALID_CAMPAIGN_DATE" };
      changes[key] = parsed.value;
    }
  }

  if (!Object.keys(changes).length) {
    return { error: "Nenhum campo administrável informado.", code: "NO_CAMPAIGN_CHANGES" };
  }

  const effectiveStarts = isOwn(changes, "starts_at") ? changes.starts_at : (before.starts_at ? new Date(before.starts_at) : null);
  const effectiveEnds = isOwn(changes, "ends_at") ? changes.ends_at : (before.ends_at ? new Date(before.ends_at) : null);
  const windowError = validateWindow(effectiveStarts, effectiveEnds);
  if (windowError) return windowError;

  const effectiveCtaLabel = isOwn(changes, "cta_label") ? changes.cta_label : before.cta_label;
  const effectiveCtaUrl = isOwn(changes, "cta_url") ? changes.cta_url : before.cta_url;
  if ((effectiveCtaLabel == null) !== (effectiveCtaUrl == null)) {
    return { error: "cta_label e cta_url devem ser informados em conjunto.", code: "INVALID_CAMPAIGN_CTA" };
  }

  return { changes };
}

async function loadCampaign(poolOrTransaction, campaignId, lock = false) {
  // Quando solicitado, primeiro trava a linha física. O snapshot retornado,
  // porém, SEMPRE vem da view oficial de delivery. Assim before_json,
  // after_json e respostas da API compartilham a mesma verdade derivada
  // para effective_status/is_visible, sem abrir mão de UPDLOCK/HOLDLOCK.
  if (lock) {
    const lockResult = await poolOrTransaction.request()
      .input("campaign_id", sql.Int, campaignId)
      .query(`
        SELECT c.campaign_id
        FROM dbo.platform_campaign c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.campaign_id = @campaign_id;
      `);
    if (!lockResult.recordset?.[0]) return null;
  }

  const result = await poolOrTransaction.request()
    .input("campaign_id", sql.Int, campaignId)
    .query(`
      SELECT
        v.campaign_id, v.campaign_code, v.campaign_name, v.headline, v.body,
        v.asset_path, v.cta_label, v.cta_url, v.placement_code,
        v.persisted_status, v.effective_status, v.is_visible,
        v.starts_at, v.ends_at, v.created_by_user_id, v.updated_by_user_id,
        v.created_at, v.updated_at,
        CONVERT(varchar(18), v.row_version, 1) AS row_version
      FROM dbo.v_platform_campaign_delivery v
      WHERE v.campaign_id = @campaign_id;
    `);
  return mapCampaign(result.recordset?.[0] || null);
}

// GET /api/admin/campaigns
router.get(
  "/campaigns",
  authRequired,
  requireAdminPermission("CAMPAIGN_READ"),
  async (req, res) => {
    const pool = await getPool();
    try {
      const placement = trimString(req.query?.placement).toUpperCase();
      const status = trimString(req.query?.status).toUpperCase();
      if (placement && !PLACEMENTS.has(placement)) {
        return res.status(400).json({ error: "placement inválido.", code: "INVALID_CAMPAIGN_PLACEMENT" });
      }
      if (status && !new Set([...PERSISTED_STATUSES, "ACTIVE", "ENDED"]).has(status)) {
        return res.status(400).json({ error: "status inválido.", code: "INVALID_CAMPAIGN_STATUS" });
      }

      const request = pool.request();
      const filters = [];
      if (placement) {
        request.input("placement_code", sql.VarChar(40), placement);
        filters.push("v.placement_code = @placement_code");
      }
      if (status) {
        request.input("effective_status", sql.VarChar(20), status);
        filters.push("v.effective_status = @effective_status");
      }

      const result = await request.query(`
        SELECT
          v.campaign_id, v.campaign_code, v.campaign_name, v.headline, v.body,
          v.asset_path, v.cta_label, v.cta_url, v.placement_code,
          v.persisted_status, v.effective_status, v.is_visible,
          v.starts_at, v.ends_at, v.created_by_user_id, v.updated_by_user_id,
          v.created_at, v.updated_at,
          CONVERT(varchar(18), v.row_version, 1) AS row_version
        FROM dbo.v_platform_campaign_delivery v
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY COALESCE(v.updated_at, v.created_at) DESC, v.campaign_id DESC;
      `);

      const campaigns = (result.recordset || []).map(mapCampaign);
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_LIST_READ",
        actionCode: "READ",
        metadata: { count: campaigns.length, placement: placement || null, status: status || null },
      });
      return res.json({ ok: true, campaigns });
    } catch (err) {
      console.error("[ADMIN CAMPAIGNS] Falha ao listar campanhas:", err);
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_LIST_READ",
        actionCode: "READ",
        resultCode: "FAILED",
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao consultar campanhas.", code: "ADMIN_CAMPAIGN_READ_ERROR" });
    }
  }
);

// GET /api/admin/campaigns/:campaignId
router.get(
  "/campaigns/:campaignId",
  authRequired,
  requireAdminPermission("CAMPAIGN_READ"),
  async (req, res) => {
    const pool = await getPool();
    const campaignId = asPositiveInt(req.params.campaignId);
    if (!campaignId) return res.status(400).json({ error: "campaignId inválido.", code: "INVALID_CAMPAIGN_ID" });

    try {
      const result = await pool.request().input("campaign_id", sql.Int, campaignId).query(`
        SELECT
          v.campaign_id, v.campaign_code, v.campaign_name, v.headline, v.body,
          v.asset_path, v.cta_label, v.cta_url, v.placement_code,
          v.persisted_status, v.effective_status, v.is_visible,
          v.starts_at, v.ends_at, v.created_by_user_id, v.updated_by_user_id,
          v.created_at, v.updated_at,
          CONVERT(varchar(18), v.row_version, 1) AS row_version
        FROM dbo.v_platform_campaign_delivery v
        WHERE v.campaign_id = @campaign_id;
      `);
      const campaign = mapCampaign(result.recordset?.[0] || null);
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_DETAIL_READ",
        actionCode: "READ",
        resultCode: campaign ? "SUCCESS" : "DENIED",
        targetId: campaignId,
        metadata: campaign ? null : { reason: "CAMPAIGN_NOT_FOUND" },
      });
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada.", code: "CAMPAIGN_NOT_FOUND" });
      return res.json({ ok: true, campaign });
    } catch (err) {
      console.error("[ADMIN CAMPAIGNS] Falha ao consultar campanha:", err);
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_DETAIL_READ",
        actionCode: "READ",
        resultCode: "FAILED",
        targetId: campaignId,
        metadata: { reason: "INTERNAL_ERROR" },
      });
      return res.status(500).json({ error: "Falha ao consultar campanha.", code: "ADMIN_CAMPAIGN_READ_ERROR" });
    }
  }
);

// POST /api/admin/campaigns
router.post(
  "/campaigns",
  authRequired,
  requireAdminPermission("CAMPAIGN_WRITE"),
  async (req, res) => {
    const pool = await getPool();
    const userId = actorUserId(req);
    const reason = asReason(req.body?.reason, false);
    if (req.body?.reason != null && reason === null) {
      return res.status(400).json({ error: "reason inválido ou excede 1000 caracteres.", code: "INVALID_REASON" });
    }

    const validation = validateCreate(req.body || {});
    if (validation.error) {
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_CREATED",
        actionCode: "WRITE",
        resultCode: "DENIED",
        metadata: { reason: validation.code },
      });
      return res.status(400).json({ error: validation.error, code: validation.code });
    }

    try {
      const v = validation.values;
      const result = await pool.request()
        .input("campaign_code", sql.VarChar(100), v.campaign_code)
        .input("campaign_name", sql.NVarChar(160), v.campaign_name)
        .input("headline", sql.NVarChar(200), v.headline)
        .input("body", sql.NVarChar(2000), v.body)
        .input("asset_path", sql.NVarChar(1000), v.asset_path)
        .input("cta_label", sql.NVarChar(80), v.cta_label)
        .input("cta_url", sql.NVarChar(1000), v.cta_url)
        .input("placement_code", sql.VarChar(40), v.placement_code)
        .input("starts_at", sql.DateTime2(3), v.starts_at)
        .input("ends_at", sql.DateTime2(3), v.ends_at)
        .input("actor_user_id", sql.Int, userId)
        .query(`
          INSERT dbo.platform_campaign (
            campaign_code, campaign_name, headline, body, asset_path,
            cta_label, cta_url, placement_code, status_code,
            starts_at, ends_at, created_by_user_id, updated_by_user_id
          )
          VALUES (
            @campaign_code, @campaign_name, @headline, @body, @asset_path,
            @cta_label, @cta_url, @placement_code, 'DRAFT',
            @starts_at, @ends_at, @actor_user_id, @actor_user_id
          );

          SELECT CAST(SCOPE_IDENTITY() AS int) AS campaign_id;
        `);

      const campaignId = asPositiveInt(result.recordset?.[0]?.campaign_id);
      const campaign = campaignId ? await loadCampaign(pool, campaignId, false) : null;
      if (!campaign) {
        throw new Error("CAMPAIGN_CREATED_BUT_RELOAD_FAILED");
      }
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_CREATED",
        actionCode: "WRITE",
        targetId: campaign?.campaign_id,
        after: campaign,
        metadata: { reason: reason || null },
      });
      return res.status(201).json({ ok: true, campaign });
    } catch (err) {
      const duplicate = Number(err?.number) === 2627 || Number(err?.number) === 2601;
      console.error("[ADMIN CAMPAIGNS] Falha ao criar campanha:", err);
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_CREATED",
        actionCode: "WRITE",
        resultCode: duplicate ? "DENIED" : "FAILED",
        metadata: { reason: duplicate ? "CAMPAIGN_CODE_ALREADY_EXISTS" : "INTERNAL_ERROR", requested_reason: reason || null },
      });
      if (duplicate) return res.status(409).json({ error: "campaign_code já existe.", code: "CAMPAIGN_CODE_ALREADY_EXISTS" });
      return res.status(500).json({ error: "Falha ao criar campanha.", code: "ADMIN_CAMPAIGN_WRITE_ERROR" });
    }
  }
);

// PATCH /api/admin/campaigns/:campaignId
router.patch(
  "/campaigns/:campaignId",
  authRequired,
  requireAdminPermission("CAMPAIGN_WRITE"),
  async (req, res) => {
    const pool = await getPool();
    const campaignId = asPositiveInt(req.params.campaignId);
    if (!campaignId) return res.status(400).json({ error: "campaignId inválido.", code: "INVALID_CAMPAIGN_ID" });

    const transaction = pool.transaction();
    let transactionOpen = false;
    let before = null;
    let reason = null;

    try {
      await transaction.begin();
      transactionOpen = true;
      before = await loadCampaign(transaction, campaignId, true);
      if (!before) {
        await transaction.rollback(); transactionOpen = false;
        await auditCampaign(pool, req, { eventCode: "ADMIN_CAMPAIGN_UPDATED", actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, metadata: { reason: "CAMPAIGN_NOT_FOUND" } });
        return res.status(404).json({ error: "Campanha não encontrada.", code: "CAMPAIGN_NOT_FOUND" });
      }
      if (before.status_code === "CANCELLED") {
        await transaction.rollback(); transactionOpen = false;
        await auditCampaign(pool, req, { eventCode: "ADMIN_CAMPAIGN_UPDATED", actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, before, metadata: { reason: "CAMPAIGN_CANCELLED_IMMUTABLE" } });
        return res.status(409).json({ error: "Campanha cancelada não pode ser editada.", code: "CAMPAIGN_CANCELLED_IMMUTABLE" });
      }

      const alreadyStarted = before.starts_at && new Date(before.starts_at).getTime() <= Date.now();
      reason = asReason(req.body?.reason, Boolean(alreadyStarted));
      if ((alreadyStarted && !reason) || (req.body?.reason != null && reason === null)) {
        await transaction.rollback(); transactionOpen = false;
        await auditCampaign(pool, req, { eventCode: "ADMIN_CAMPAIGN_UPDATED", actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, before, metadata: { reason: alreadyStarted ? "REASON_REQUIRED" : "INVALID_REASON" } });
        return res.status(400).json({ error: alreadyStarted ? "Motivo da alteração é obrigatório após o início da campanha." : "reason inválido.", code: alreadyStarted ? "REASON_REQUIRED" : "INVALID_REASON" });
      }

      const validation = validatePatch(req.body || {}, before);
      if (validation.error) {
        await transaction.rollback(); transactionOpen = false;
        await auditCampaign(pool, req, { eventCode: "ADMIN_CAMPAIGN_UPDATED", actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, before, metadata: { reason: validation.code, requested_reason: reason || null } });
        return res.status(400).json({ error: validation.error, code: validation.code });
      }

      const changes = validation.changes;
      const request = transaction.request().input("campaign_id", sql.Int, campaignId).input("actor_user_id", sql.Int, actorUserId(req));
      const setters = [];
      const defs = {
        campaign_code: sql.VarChar(100), campaign_name: sql.NVarChar(160), headline: sql.NVarChar(200),
        body: sql.NVarChar(2000), asset_path: sql.NVarChar(1000), cta_label: sql.NVarChar(80),
        cta_url: sql.NVarChar(1000), placement_code: sql.VarChar(40), starts_at: sql.DateTime2(3), ends_at: sql.DateTime2(3),
      };
      for (const [key, value] of Object.entries(changes)) {
        request.input(`v_${key}`, defs[key], value);
        setters.push(`${key} = @v_${key}`);
      }
      setters.push("updated_by_user_id = @actor_user_id", "updated_at = SYSUTCDATETIME()");
      await request.query(`UPDATE dbo.platform_campaign SET ${setters.join(", ")} WHERE campaign_id = @campaign_id;`);
      const after = await loadCampaign(transaction, campaignId, false);
      await transaction.commit(); transactionOpen = false;

      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_UPDATED", actionCode: "WRITE", targetId: campaignId,
        before, after, metadata: { reason: reason || null, changed_fields: Object.keys(changes) },
      });
      return res.json({ ok: true, campaign: after });
    } catch (err) {
      try { if (transactionOpen) await transaction.rollback(); } catch {}
      const duplicate = Number(err?.number) === 2627 || Number(err?.number) === 2601;
      console.error("[ADMIN CAMPAIGNS] Falha ao atualizar campanha:", err);
      await auditCampaign(pool, req, {
        eventCode: "ADMIN_CAMPAIGN_UPDATED", actionCode: "WRITE", resultCode: duplicate ? "DENIED" : "FAILED",
        targetId: campaignId, before, metadata: { reason: duplicate ? "CAMPAIGN_CODE_ALREADY_EXISTS" : "INTERNAL_ERROR", requested_reason: reason || null },
      });
      if (duplicate) return res.status(409).json({ error: "campaign_code já existe.", code: "CAMPAIGN_CODE_ALREADY_EXISTS" });
      return res.status(500).json({ error: "Falha ao atualizar campanha.", code: "ADMIN_CAMPAIGN_WRITE_ERROR" });
    }
  }
);

async function lifecycle(req, res, operation) {
  const pool = await getPool();
  const campaignId = asPositiveInt(req.params.campaignId);
  if (!campaignId) return res.status(400).json({ error: "campaignId inválido.", code: "INVALID_CAMPAIGN_ID" });

  const reason = asReason(req.body?.reason, true);
  if (!reason) {
    await auditCampaign(pool, req, {
      eventCode: `ADMIN_CAMPAIGN_${operation.eventSuffix}`,
      actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId,
      metadata: { reason: "REASON_REQUIRED" },
    });
    return res.status(400).json({ error: "Motivo da operação é obrigatório.", code: "REASON_REQUIRED" });
  }

  const transaction = pool.transaction();
  let transactionOpen = false;
  let before = null;
  try {
    await transaction.begin(); transactionOpen = true;
    before = await loadCampaign(transaction, campaignId, true);
    if (!before) {
      await transaction.rollback(); transactionOpen = false;
      await auditCampaign(pool, req, { eventCode: `ADMIN_CAMPAIGN_${operation.eventSuffix}`, actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, metadata: { reason: "CAMPAIGN_NOT_FOUND", requested_reason: reason } });
      return res.status(404).json({ error: "Campanha não encontrada.", code: "CAMPAIGN_NOT_FOUND" });
    }

    if (!operation.from.has(before.status_code)) {
      await transaction.rollback(); transactionOpen = false;
      await auditCampaign(pool, req, { eventCode: `ADMIN_CAMPAIGN_${operation.eventSuffix}`, actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, before, metadata: { reason: "INVALID_CAMPAIGN_TRANSITION", requested_reason: reason, from_status: before.status_code, to_status: operation.to } });
      return res.status(409).json({ error: `Transição ${before.status_code} → ${operation.to} não permitida.`, code: "INVALID_CAMPAIGN_TRANSITION" });
    }

    let startsAt = before.starts_at ? new Date(before.starts_at) : null;
    let endsAt = before.ends_at ? new Date(before.ends_at) : null;
    if (operation.name === "schedule") {
      if (isOwn(req.body, "starts_at")) {
        const p = parseNullableDate(req.body.starts_at); if (p.error) { await transaction.rollback(); transactionOpen = false; return res.status(400).json({ error: "starts_at inválido.", code: "INVALID_CAMPAIGN_DATE" }); } startsAt = p.value;
      }
      if (isOwn(req.body, "ends_at")) {
        const p = parseNullableDate(req.body.ends_at); if (p.error) { await transaction.rollback(); transactionOpen = false; return res.status(400).json({ error: "ends_at inválido.", code: "INVALID_CAMPAIGN_DATE" }); } endsAt = p.value;
      }
      if (!startsAt) {
        await transaction.rollback(); transactionOpen = false;
        await auditCampaign(pool, req, { eventCode: `ADMIN_CAMPAIGN_${operation.eventSuffix}`, actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, before, metadata: { reason: "CAMPAIGN_START_REQUIRED", requested_reason: reason } });
        return res.status(400).json({ error: "starts_at é obrigatório para programar a campanha.", code: "CAMPAIGN_START_REQUIRED" });
      }
      const windowError = validateWindow(startsAt, endsAt);
      if (windowError) {
        await transaction.rollback(); transactionOpen = false;
        await auditCampaign(pool, req, { eventCode: `ADMIN_CAMPAIGN_${operation.eventSuffix}`, actionCode: "WRITE", resultCode: "DENIED", targetId: campaignId, before, metadata: { reason: windowError.code, requested_reason: reason } });
        return res.status(400).json({ error: windowError.error, code: windowError.code });
      }
    }

    const request = transaction.request()
      .input("campaign_id", sql.Int, campaignId)
      .input("status_code", sql.VarChar(20), operation.to)
      .input("actor_user_id", sql.Int, actorUserId(req));
    const setters = ["status_code = @status_code", "updated_by_user_id = @actor_user_id", "updated_at = SYSUTCDATETIME()"];
    if (operation.name === "schedule") {
      request.input("starts_at", sql.DateTime2(3), startsAt).input("ends_at", sql.DateTime2(3), endsAt);
      setters.push("starts_at = @starts_at", "ends_at = @ends_at");
    }
    await request.query(`UPDATE dbo.platform_campaign SET ${setters.join(", ")} WHERE campaign_id = @campaign_id;`);
    const after = await loadCampaign(transaction, campaignId, false);
    await transaction.commit(); transactionOpen = false;

    await auditCampaign(pool, req, {
      eventCode: `ADMIN_CAMPAIGN_${operation.eventSuffix}`, actionCode: "WRITE", targetId: campaignId,
      before, after, metadata: { reason, from_status: before.status_code, to_status: operation.to },
    });
    return res.json({ ok: true, campaign: after });
  } catch (err) {
    try { if (transactionOpen) await transaction.rollback(); } catch {}
    console.error(`[ADMIN CAMPAIGNS] Falha em ${operation.name}:`, err);
    await auditCampaign(pool, req, {
      eventCode: `ADMIN_CAMPAIGN_${operation.eventSuffix}`, actionCode: "WRITE", resultCode: "FAILED",
      targetId: campaignId, before, metadata: { reason: "INTERNAL_ERROR", requested_reason: reason },
    });
    return res.status(500).json({ error: "Falha ao alterar lifecycle da campanha.", code: "ADMIN_CAMPAIGN_WRITE_ERROR" });
  }
}

const lifecycleOps = {
  schedule: { name: "schedule", eventSuffix: "SCHEDULED", from: new Set(["DRAFT"]), to: "SCHEDULED" },
  pause: { name: "pause", eventSuffix: "PAUSED", from: new Set(["SCHEDULED"]), to: "PAUSED" },
  resume: { name: "resume", eventSuffix: "RESUMED", from: new Set(["PAUSED"]), to: "SCHEDULED" },
  cancel: { name: "cancel", eventSuffix: "CANCELLED", from: new Set(["DRAFT", "SCHEDULED", "PAUSED"]), to: "CANCELLED" },
};

for (const [path, op] of Object.entries(lifecycleOps)) {
  router.post(`/campaigns/:campaignId/${path}`, authRequired, requireAdminPermission("CAMPAIGN_WRITE"), (req, res) => lifecycle(req, res, op));
}

export default router;
