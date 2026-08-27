// HDUD Admin — Implementação 04 | Authorization Engine
// Audit administrativo central para decisões de autorização.

import { sql } from "../db.js";

function clientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 45);
  }
  return String(req?.ip || req?.socket?.remoteAddress || "").slice(0, 45) || null;
}

export async function writeAdminAudit(pool, req, {
  actorUserId = null,
  actorLabel = null,
  eventCode,
  resourceCode = "ADMIN_AUTH",
  actionCode = "AUTHORIZE",
  resultCode,
  targetType = null,
  targetId = null,
  before = null,
  after = null,
  metadata = null,
}) {
  if (!pool) throw new Error("writeAdminAudit exige pool SQL.");
  if (!eventCode) throw new Error("writeAdminAudit exige eventCode.");
  if (!resultCode) throw new Error("writeAdminAudit exige resultCode.");

  await pool.request()
    .input("actor_type", sql.VarChar(20), actorUserId ? "USER" : "ANONYMOUS")
    .input("actor_user_id", sql.Int, actorUserId ? Number(actorUserId) : null)
    .input("actor_label", sql.NVarChar(320), actorLabel || null)
    .input("event_code", sql.VarChar(100), eventCode)
    .input("resource_code", sql.VarChar(60), resourceCode)
    .input("action_code", sql.VarChar(40), actionCode)
    .input("result_code", sql.VarChar(20), resultCode)
    .input("target_type", sql.VarChar(80), targetType || null)
    .input("target_id", sql.NVarChar(200), targetId || null)
    .input("before_json", sql.NVarChar(sql.MAX), before == null ? null : JSON.stringify(before))
    .input("after_json", sql.NVarChar(sql.MAX), after == null ? null : JSON.stringify(after))
    .input("ip_address", sql.VarChar(45), clientIp(req))
    .input("user_agent", sql.NVarChar(1024), req?.headers?.["user-agent"] || null)
    .input("metadata_json", sql.NVarChar(sql.MAX), metadata ? JSON.stringify(metadata) : null)
    .query(`
      INSERT INTO dbo.admin_audit_event (
        actor_type, actor_user_id, actor_label,
        event_code, resource_code, action_code, result_code,
        target_type, target_id, before_json, after_json,
        ip_address, user_agent, metadata_json
      )
      VALUES (
        @actor_type, @actor_user_id, @actor_label,
        @event_code, @resource_code, @action_code, @result_code,
        @target_type, @target_id, @before_json, @after_json,
        @ip_address, @user_agent, @metadata_json
      );
    `);
}

export async function writeAdminAuditSafe(pool, req, payload) {
  try {
    await writeAdminAudit(pool, req, payload);
    return true;
  } catch (err) {
    console.error("[ADMIN AUDIT] Falha ao registrar evento:", payload?.eventCode, err);
    return false;
  }
}
