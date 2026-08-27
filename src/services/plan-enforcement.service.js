// C:\HDUD_DATA\hdud-api-node\src\services\plan-enforcement.service.js
import { sql } from "../db.js";

function firstRow(result) {
  return result?.recordset?.[0] || result?.recordsets?.[0]?.[0] || null;
}

function normalizeCheckRow(row = {}, fallbackFeatureCode = null) {
  return {
    ok: Number(row.ok ?? 0) === 1,
    allowed: Number(row.allowed ?? 0) === 1,
    reason_code: row.reason_code ? String(row.reason_code) : null,
    feature_code: row.feature_code ? String(row.feature_code) : fallbackFeatureCode,
    enforcement_mode: row.enforcement_mode ? String(row.enforcement_mode) : null,
    bool_value: row.bool_value == null ? null : !!row.bool_value,
    limit_or_quota_value:
      row.limit_or_quota_value == null ? null : Number(row.limit_or_quota_value),
    string_value: row.string_value == null ? null : String(row.string_value),
    consumed_value: row.consumed_value == null ? null : Number(row.consumed_value),
    reserved_value: row.reserved_value == null ? null : Number(row.reserved_value),
    remaining_value: row.remaining_value == null ? null : Number(row.remaining_value),
    reservation_event_id:
      row.reservation_event_id == null ? null : Number(row.reservation_event_id),
  };
}

export async function checkPlanFeature({
  pool,
  userId,
  featureCode,
  requestedValue = 1,
}) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("feature_code", sql.VarChar(80), String(featureCode))
    .input("requested_value", sql.BigInt, Number(requestedValue))
    .execute("dbo.p_CheckPlanFeature");

  return normalizeCheckRow(firstRow(result) || {}, String(featureCode));
}

export async function checkNarrativeAiGenerationQuota({
  pool,
  userId,
  requestedValue = 1,
}) {
  // p_CheckPlanFeature já consolida STORY + CHAPTER no mesmo pool narrativo.
  // Não somar os dois retornos aqui, pois isso duplica consumed/reserved.
  const shared = await checkPlanFeature({
    pool,
    userId,
    featureCode: "STORY_AI_GENERATION_COUNT",
    requestedValue,
  });

  return {
    ...shared,
    feature_code: "NARRATIVE_AI_GENERATION_COUNT",
  };
}

export async function reservePlanQuota({
  pool,
  userId,
  featureCode,
  reserveValue = 1,
  entityType = null,
  entityId = null,
  metadata = null,
}) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("feature_code", sql.VarChar(80), String(featureCode))
    .input("reserve_value", sql.BigInt, Number(reserveValue))
    .input("entity_type", sql.VarChar(40), entityType ? String(entityType) : null)
    .input("entity_id", sql.BigInt, entityId != null ? Number(entityId) : null)
    .input(
      "metadata_json",
      sql.NVarChar(sql.MAX),
      metadata == null ? null : JSON.stringify(metadata)
    )
    .execute("dbo.p_ReservePlanQuota");

  return normalizeCheckRow(firstRow(result) || {}, String(featureCode));
}

export async function reserveNarrativeAiGenerationQuota({
  pool,
  userId,
  targetFeatureCode,
  reserveValue = 1,
  entityType = null,
  entityId = null,
  metadata = null,
}) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("target_feature_code", sql.VarChar(80), String(targetFeatureCode))
    .input("reserve_value", sql.BigInt, Number(reserveValue))
    .input("entity_type", sql.VarChar(40), entityType ? String(entityType) : null)
    .input("entity_id", sql.BigInt, entityId != null ? Number(entityId) : null)
    .input(
      "metadata_json",
      sql.NVarChar(sql.MAX),
      metadata == null ? null : JSON.stringify(metadata)
    )
    .execute("dbo.p_ReserveNarrativeAiGenerationQuota");

  return normalizeCheckRow(firstRow(result) || {}, "NARRATIVE_AI_GENERATION_COUNT");
}

export async function commitPlanQuotaReservation({
  pool,
  userId,
  reservationEventId,
  aiUsageId = null,
  metadata = null,
}) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("reservation_event_id", sql.BigInt, Number(reservationEventId))
    .input("ai_usage_id", sql.BigInt, aiUsageId != null ? Number(aiUsageId) : null)
    .input(
      "metadata_json",
      sql.NVarChar(sql.MAX),
      metadata == null ? null : JSON.stringify(metadata)
    )
    .execute("dbo.p_CommitPlanQuotaReservation");

  const row = firstRow(result) || {};
  return {
    ok: Number(row.ok ?? 0) === 1,
    allowed: Number(row.allowed ?? 0) === 1,
    reason_code: row.reason_code ? String(row.reason_code) : null,
    reservation_event_id:
      row.reservation_event_id == null ? null : Number(row.reservation_event_id),
  };
}

export async function releasePlanQuotaReservation({
  pool,
  userId,
  reservationEventId,
  reasonCode = "OPERATION_FAILED",
  metadata = null,
}) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("reservation_event_id", sql.BigInt, Number(reservationEventId))
    .input("reason_code", sql.VarChar(80), reasonCode ? String(reasonCode) : null)
    .input(
      "metadata_json",
      sql.NVarChar(sql.MAX),
      metadata == null ? null : JSON.stringify(metadata)
    )
    .execute("dbo.p_ReleasePlanQuotaReservation");

  const row = firstRow(result) || {};
  return {
    ok: Number(row.ok ?? 0) === 1,
    allowed: Number(row.allowed ?? 0) === 1,
    reason_code: row.reason_code ? String(row.reason_code) : null,
    reservation_event_id:
      row.reservation_event_id == null ? null : Number(row.reservation_event_id),
  };
}

// Mantido por compatibilidade com consumidores legados.
// Novas operações pagas devem preferir RESERVE -> IA -> COMMIT/RELEASE.
export async function consumePlanQuota({
  pool,
  userId,
  featureCode,
  consumeValue = 1,
  entityType = null,
  entityId = null,
  aiUsageId = null,
  metadata = null,
}) {
  const result = await pool
    .request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("feature_code", sql.VarChar(80), String(featureCode))
    .input("consume_value", sql.BigInt, Number(consumeValue))
    .input("entity_type", sql.VarChar(40), entityType ? String(entityType) : null)
    .input("entity_id", sql.BigInt, entityId != null ? Number(entityId) : null)
    .input("ai_usage_id", sql.BigInt, aiUsageId != null ? Number(aiUsageId) : null)
    .input(
      "metadata_json",
      sql.NVarChar(sql.MAX),
      metadata == null ? null : JSON.stringify(metadata)
    )
    .execute("dbo.p_ConsumePlanQuota");

  const row = firstRow(result) || {};
  return {
    ok: Number(row.ok ?? 0) === 1,
    allowed: Number(row.allowed ?? 0) === 1,
    reason_code: row.reason_code ? String(row.reason_code) : null,
    remaining_value: row.remaining_value == null ? null : Number(row.remaining_value),
  };
}

export function sendPlanDenied(
  res,
  check,
  {
    status = 403,
    message = "Seu plano atual não permite esta operação.",
  } = {}
) {
  return res.status(status).json({
    ok: false,
    error: message,
    code: check?.reason_code || "PLAN_ENFORCEMENT_DENIED",
    feature_code: check?.feature_code || null,
    quota_or_limit: check?.limit_or_quota_value ?? null,
    consumed_value: check?.consumed_value ?? null,
    reserved_value: check?.reserved_value ?? null,
    remaining_value: check?.remaining_value ?? null,
  });
}
