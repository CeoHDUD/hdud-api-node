// HDUD Admin — Implementação 10 | HDUD Ads — Administração
// Domínio publicitário comercial de terceiros.
// Fronteiras: não reutiliza platform_campaign; não administra conteúdo editorial de Autor.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireAdminPermission } from "../middleware/adminAuthorization.js";
import { getPool, sql } from "../db.js";
import { writeAdminAuditSafe } from "../services/adminAuditService.js";

const router = Router();

const CAMPAIGN_STATUSES = new Set(["DRAFT","PENDING_APPROVAL","APPROVED","ACTIVE","PAUSED","COMPLETED","CANCELLED","REJECTED"]);
// Dados básicos da campanha só podem ser alterados antes da aprovação.
// REJECTED volta a DRAFT no primeiro save válido, exigindo nova submissão/aprovação.
const CAMPAIGN_EDITABLE_STATUSES = new Set(["DRAFT","REJECTED","PENDING_APPROVAL","APPROVED","ACTIVE","PAUSED"]);
const ADVERTISER_STATUSES = new Set(["ACTIVE","INACTIVE","BLOCKED"]);
const CREATIVE_TYPES = new Set(["IMAGE","TEXT","BANNER"]);
const CREATIVE_STATUSES = new Set(["DRAFT","ACTIVE","PAUSED","REJECTED","ARCHIVED"]);
const PLACEMENT_STATUSES = new Set(["ACTIVE","INACTIVE"]);
const FLIGHT_STATUSES = new Set(["DRAFT","ACTIVE","PAUSED","COMPLETED","CANCELLED"]);
const BUDGET_STATUSES = new Set(["ACTIVE","PAUSED","CLOSED"]);

function own(o, k) { return Object.prototype.hasOwnProperty.call(o || {}, k); }
function trim(v) { return typeof v === "string" ? v.trim() : ""; }
function upper(v) { return trim(v).toUpperCase(); }
function positiveInt(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function positiveBigIntString(v) { const s = String(v ?? "").trim(); return /^\d+$/.test(s) && BigInt(s) > 0n ? s : null; }
function actorUserId(req) { return positiveInt(req.user?.sub ?? req.user?.user_id ?? req.user?.id); }
function actorLabel(req) { return req.user?.email || null; }
function reasonOf(body, required = true) { const v = trim(body?.reason); return (!v || v.length > 2000) ? (required ? null : "") : v; }
function pageOf(req) { const n = Number(req.query?.page); return Number.isInteger(n) && n > 0 ? Math.min(n, 1000000) : 1; }
function pageSizeOf(req) { const n = Number(req.query?.page_size); return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 25; }
function nullableText(v, max) { if (v == null || v === "") return null; if (typeof v !== "string") return undefined; const s=v.trim(); return s.length <= max ? (s || null) : undefined; }
function dateValue(v) { if (v == null || v === "") return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; }
function currency(v) { const s=upper(v); return /^[A-Z]{3}$/.test(s) ? s : null; }
function decimal(v) { if (v == null || v === "") return null; const n=Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; }
function code(v, max=80) { const s=upper(v); return s && s.length <= max && /^[A-Z0-9][A-Z0-9_-]*$/.test(s) ? s : null; }
function normalizeCnpj(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const digits = v.replace(/\D/g, "");
  return digits.length === 14 ? digits : undefined;
}
function isValidCnpj(v) {
  const cnpj = normalizeCnpj(v);
  if (!cnpj || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (base, weights) => {
    const sum = base.split("").reduce((acc, digit, i) => acc + Number(digit) * weights[i], 0);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const d1 = calc(cnpj.slice(0, 12), [5,4,3,2,9,8,7,6,5,4,3,2]);
  const d2 = calc(cnpj.slice(0, 12) + d1, [6,5,4,3,2,9,8,7,6,5,4,3,2]);
  return cnpj === cnpj.slice(0, 12) + String(d1) + String(d2);
}

function firstProviderText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeProviderPhone(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `(${digits.slice(0,2)}) ${digits.slice(2,6)}-${digits.slice(6)}`;
  if (digits.length === 11) return `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
  return value.trim().slice(0, 40) || null;
}

async function lookupBrasilApiCnpj(cnpj) {
  const base = String(process.env.BRASILAPI_BASE_URL || "https://brasilapi.com.br/api").replace(/\/$/, "");
  const timeoutMsRaw = Number(process.env.BRASILAPI_TIMEOUT_MS || 8000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.min(timeoutMsRaw, 20000)) : 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/cnpj/v1/${encodeURIComponent(cnpj)}`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "HDUD-Admin/1.0" },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 404) {
      const err = new Error("CNPJ_NOT_FOUND"); err.status = 404; throw err;
    }
    if (response.status === 400) {
      const err = new Error("PROVIDER_INVALID_CNPJ"); err.status = 400; throw err;
    }
    if (!response.ok || !payload) {
      const err = new Error("PROVIDER_UNAVAILABLE"); err.status = 502; throw err;
    }
    return payload;
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeout = new Error("PROVIDER_TIMEOUT"); timeout.status = 504; throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
function rowVersionBuffer(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^0x[0-9A-Fa-f]{16}$/.test(s)) return null;
  return Buffer.from(s.slice(2), "hex");
}
function ip(req) {
  const f=req?.headers?.["x-forwarded-for"];
  if (typeof f === "string" && f.trim()) return f.split(",")[0].trim().slice(0,45);
  return String(req?.ip || req?.socket?.remoteAddress || "").slice(0,45) || null;
}

async function auditOn(executor, req, { eventCode, actionCode="WRITE", resultCode="SUCCESS", targetType=null, targetId=null, before=null, after=null, metadata=null }) {
  await executor.request()
    .input("actor_type", sql.VarChar(20), actorUserId(req) ? "USER" : "ANONYMOUS")
    .input("actor_user_id", sql.Int, actorUserId(req))
    .input("actor_label", sql.NVarChar(320), actorLabel(req))
    .input("event_code", sql.VarChar(100), eventCode)
    .input("resource_code", sql.VarChar(60), "ADS")
    .input("action_code", sql.VarChar(40), actionCode)
    .input("result_code", sql.VarChar(20), resultCode)
    .input("target_type", sql.VarChar(80), targetType)
    .input("target_id", sql.NVarChar(200), targetId == null ? null : String(targetId))
    .input("before_json", sql.NVarChar(sql.MAX), before == null ? null : JSON.stringify(before))
    .input("after_json", sql.NVarChar(sql.MAX), after == null ? null : JSON.stringify(after))
    .input("ip_address", sql.VarChar(45), ip(req))
    .input("user_agent", sql.NVarChar(1024), req?.headers?.["user-agent"] || null)
    .input("metadata_json", sql.NVarChar(sql.MAX), metadata == null ? null : JSON.stringify(metadata))
    .query(`INSERT INTO dbo.admin_audit_event (
      actor_type, actor_user_id, actor_label, event_code, resource_code, action_code, result_code,
      target_type, target_id, before_json, after_json, ip_address, user_agent, metadata_json
    ) VALUES (
      @actor_type,@actor_user_id,@actor_label,@event_code,@resource_code,@action_code,@result_code,
      @target_type,@target_id,@before_json,@after_json,@ip_address,@user_agent,@metadata_json
    );`);
}

async function auditDenied(pool, req, eventCode, targetType, targetId, why, before=null, requestedReason=null) {
  await writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req), actorLabel: actorLabel(req), eventCode,
    resourceCode: "ADS", actionCode: "WRITE", resultCode: "DENIED",
    targetType, targetId: targetId == null ? null : String(targetId), before,
    metadata: { reason: why, requested_reason: requestedReason || null },
  });
}

function mapAdvertiser(r) { return r ? { ...r, advertiser_id: String(r.advertiser_id), row_version: r.row_version } : null; }
function mapCampaign(r) { return r ? { ...r, campaign_id: String(r.campaign_id), advertiser_id: String(r.advertiser_id), created_by: Number(r.created_by), updated_by: Number(r.updated_by), row_version: r.row_version } : null; }
function mapCreative(r) { return r ? { ...r, creative_id:String(r.creative_id), campaign_id:String(r.campaign_id), row_version:r.row_version } : null; }
function mapPlacement(r) { return r ? { ...r, placement_id:String(r.placement_id), row_version:r.row_version } : null; }
function mapFlight(r) { return r ? { ...r, flight_id:String(r.flight_id), campaign_id:String(r.campaign_id), row_version:r.row_version } : null; }

async function loadAdvertiser(executor, id, lock=false) {
  const q=await executor.request().input("id",sql.BigInt,id).query(`SELECT advertiser_id,advertiser_code,advertiser_name,legal_name,tax_id,email,phone,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_advertiser ${lock?"WITH (UPDLOCK,HOLDLOCK)":""} WHERE advertiser_id=@id;`);
  return mapAdvertiser(q.recordset?.[0]);
}
async function loadCampaign(executor, id, lock=false) {
  const q=await executor.request().input("id",sql.BigInt,id).query(`SELECT campaign_id,advertiser_id,campaign_code,campaign_name,status_code,starts_at,ends_at,created_by,updated_by,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_campaign ${lock?"WITH (UPDLOCK,HOLDLOCK)":""} WHERE campaign_id=@id;`);
  return mapCampaign(q.recordset?.[0]);
}
async function assertCampaignMutable(executor, campaignId) {
  const campaign = await loadCampaign(executor, campaignId, true);
  if (!campaign) { const e = new Error("CAMPAIGN_NOT_FOUND"); e.status = 404; throw e; }
  if (campaign.status_code === "CANCELLED") { const e = new Error("CAMPAIGN_CANCELLED_TERMINAL"); e.status = 409; e.code = "CAMPAIGN_CANCELLED_TERMINAL"; throw e; }
  return campaign;
}

async function loadCreative(executor, id, lock=false) {
  const q=await executor.request().input("id",sql.BigInt,id).query(`SELECT creative_id,campaign_id,creative_code,creative_name,creative_type,headline,body,asset_path,cta_label,cta_url,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_creative ${lock?"WITH (UPDLOCK,HOLDLOCK)":""} WHERE creative_id=@id;`);
  return mapCreative(q.recordset?.[0]);
}
async function loadPlacement(executor, id, lock=false) {
  const q=await executor.request().input("id",sql.BigInt,id).query(`SELECT placement_id,placement_code,placement_name,description,surface_code,status_code,max_creatives,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_placement ${lock?"WITH (UPDLOCK,HOLDLOCK)":""} WHERE placement_id=@id;`);
  return mapPlacement(q.recordset?.[0]);
}
async function loadFlight(executor,id,lock=false){const q=await executor.request().input("id",sql.BigInt,id).query(`SELECT flight_id,campaign_id,flight_code,starts_at,ends_at,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_flight ${lock?"WITH (UPDLOCK,HOLDLOCK)":""} WHERE flight_id=@id;`);return mapFlight(q.recordset?.[0]);}

async function campaignReadiness(executor, campaignId) {
  const q=await executor.request().input("id",sql.BigInt,campaignId).query(`
    SELECT
      c.campaign_id,
      c.status_code,
      a.status_code advertiser_status,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.ads_creative cr
        WHERE cr.campaign_id=c.campaign_id
          AND cr.status_code IN ('DRAFT','ACTIVE','PAUSED')
      ) THEN 1 ELSE 0 END has_creative,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.ads_creative cr
        WHERE cr.campaign_id=c.campaign_id
          AND cr.status_code='ACTIVE'
      ) THEN 1 ELSE 0 END has_active_creative,
      CASE WHEN EXISTS (
        SELECT 1
        FROM dbo.ads_campaign_placement cp
        JOIN dbo.ads_placement p ON p.placement_id=cp.placement_id
        WHERE cp.campaign_id=c.campaign_id
          AND cp.status_code='ACTIVE'
          AND p.status_code='ACTIVE'
      ) THEN 1 ELSE 0 END has_placement,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.ads_flight f
        WHERE f.campaign_id=c.campaign_id
          AND f.status_code <> 'CANCELLED'
          AND f.ends_at>f.starts_at
      ) THEN 1 ELSE 0 END has_flight,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.ads_flight f
        WHERE f.campaign_id=c.campaign_id
          AND f.status_code='ACTIVE'
          AND f.ends_at>f.starts_at
      ) THEN 1 ELSE 0 END has_active_flight,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.ads_commercial_terms t
        WHERE t.campaign_id=c.campaign_id
      ) THEN 1 ELSE 0 END has_terms,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.ads_budget b
        WHERE b.campaign_id=c.campaign_id
      ) THEN 1 ELSE 0 END has_budget,
      (SELECT TOP (1) t.currency_code FROM dbo.ads_commercial_terms t WHERE t.campaign_id=c.campaign_id) terms_currency,
      (SELECT TOP (1) b.currency_code FROM dbo.ads_budget b WHERE b.campaign_id=c.campaign_id) budget_currency,
      (SELECT TOP (1) b.status_code FROM dbo.ads_budget b WHERE b.campaign_id=c.campaign_id) budget_status
    FROM dbo.ads_campaign c
    JOIN dbo.ads_advertiser a ON a.advertiser_id=c.advertiser_id
    WHERE c.campaign_id=@id;`);
  const r=q.recordset?.[0]; if(!r) return null;

  const missing=[];
  if(r.advertiser_status!=="ACTIVE") missing.push("ACTIVE_ADVERTISER");
  if(!r.has_creative) missing.push("CREATIVE");
  if(!r.has_placement) missing.push("PLACEMENT");
  if(!r.has_flight) missing.push("FLIGHT");
  if(!r.has_terms) missing.push("COMMERCIAL_TERMS");
  if(!r.has_budget) missing.push("BUDGET");

  const activationMissing=[];
  if(r.advertiser_status!=="ACTIVE") activationMissing.push("ACTIVE_ADVERTISER");
  if(!r.has_active_creative) activationMissing.push("ACTIVE_CREATIVE");
  if(!r.has_placement) activationMissing.push("ACTIVE_PLACEMENT");
  if(!r.has_active_flight) activationMissing.push("ACTIVE_FLIGHT");
  if(!r.has_terms) activationMissing.push("COMMERCIAL_TERMS");
  if(!r.has_budget) activationMissing.push("BUDGET");
  if(r.has_budget && r.budget_status!=="ACTIVE") activationMissing.push("ACTIVE_BUDGET");
  if(r.has_terms && r.has_budget && r.terms_currency!==r.budget_currency) activationMissing.push("BUDGET_CURRENCY_MATCH");

  const terminalCancelled = r.status_code === "CANCELLED";
  return {
    ready:!terminalCancelled && missing.length===0,
    missing: terminalCancelled ? ["CAMPAIGN_CANCELLED_TERMINAL", ...missing] : missing,
    activation_ready:!terminalCancelled && activationMissing.length===0,
    activation_missing: terminalCancelled ? ["CAMPAIGN_CANCELLED_TERMINAL", ...activationMissing] : activationMissing,
    advertiser_status:r.advertiser_status
  };
}

async function withMutation(pool, fn) {
  const tx=pool.transaction();
  try { await tx.begin(); const value=await fn(tx); await tx.commit(); return value; }
  catch(e){ try{await tx.rollback();}catch{} throw e; }
}

// -------------------- ADVERTISERS --------------------
router.get("/ads/advertisers",authRequired,requireAdminPermission("ADS_READ"),async(req,res)=>{
  const pool=await getPool(); const page=pageOf(req),size=pageSizeOf(req),offset=(page-1)*size; const status=upper(req.query?.status),search=trim(req.query?.q);
  if(status&&!ADVERTISER_STATUSES.has(status)) return res.status(400).json({error:"status inválido.",code:"INVALID_ADVERTISER_STATUS"});
  const r=pool.request().input("offset",sql.Int,offset).input("size",sql.Int,size).input("status",sql.VarChar(20),status||null).input("q",sql.NVarChar(200),search||null);
  const q=await r.query(`SELECT advertiser_id,advertiser_code,advertiser_name,legal_name,tax_id,email,phone,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version,COUNT(*) OVER() total_count FROM dbo.ads_advertiser WHERE (@status IS NULL OR status_code=@status) AND (@q IS NULL OR advertiser_name LIKE '%'+@q+'%' OR legal_name LIKE '%'+@q+'%' OR advertiser_code LIKE '%'+@q+'%') ORDER BY updated_at DESC,advertiser_id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;`);
  res.json({ok:true,page,page_size:size,total:Number(q.recordset?.[0]?.total_count||0),items:(q.recordset||[]).map(({total_count,...x})=>mapAdvertiser(x))});
});
router.get("/ads/advertisers/cnpj/:cnpj",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{
  const pool=await getPool();
  const cnpj=normalizeCnpj(req.params.cnpj);
  if(!cnpj||!isValidCnpj(cnpj)) return res.status(400).json({error:"CNPJ inválido.",code:"INVALID_CNPJ"});

  const existing=await pool.request().input("tax",sql.VarChar(40),cnpj).query(`SELECT advertiser_id,advertiser_code,advertiser_name,legal_name,tax_id,email,phone,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_advertiser WHERE tax_id=@tax;`);
  if(existing.recordset?.[0]){
    const advertiser=mapAdvertiser(existing.recordset[0]);
    await writeAdminAuditSafe(pool,req,{actorUserId:actorUserId(req),actorLabel:actorLabel(req),eventCode:"ADS_ADVERTISER_CNPJ_LOOKUP",resourceCode:"ADS",actionCode:"READ",resultCode:"SUCCESS",targetType:"ADS_ADVERTISER",targetId:String(advertiser.advertiser_id),metadata:{source:"HDUD_CORE",existing:true}});
    return res.json({ok:true,source:"HDUD_CORE",existing:true,advertiser});
  }

  try{
    const raw=await lookupBrasilApiCnpj(cnpj);
    const legalName=firstProviderText(raw?.razao_social);
    const tradeName=firstProviderText(raw?.nome_fantasia,raw?.razao_social);
    if(!legalName&&!tradeName){
      await writeAdminAuditSafe(pool,req,{actorUserId:actorUserId(req),actorLabel:actorLabel(req),eventCode:"ADS_ADVERTISER_CNPJ_LOOKUP",resourceCode:"ADS",actionCode:"READ",resultCode:"DENIED",targetType:"CNPJ",targetId:cnpj,metadata:{source:"BRASILAPI",reason:"INVALID_PROVIDER_PAYLOAD"}});
      return res.status(502).json({error:"Consulta de CNPJ retornou dados cadastrais incompletos.",code:"CNPJ_PROVIDER_INVALID_RESPONSE"});
    }
    const phone=normalizeProviderPhone(firstProviderText(raw?.ddd_telefone_1,raw?.ddd_telefone_2));
    const company={
      cnpj,
      legal_name:legalName,
      advertiser_name:tradeName||legalName,
      email:firstProviderText(raw?.email),
      phone,
      registration_status:firstProviderText(raw?.descricao_situacao_cadastral),
      registration_status_date:firstProviderText(raw?.data_situacao_cadastral),
      uf:firstProviderText(raw?.uf),
      municipio:firstProviderText(raw?.municipio),
      suggested_advertiser_code:`ADV_${cnpj}`,
    };
    await writeAdminAuditSafe(pool,req,{actorUserId:actorUserId(req),actorLabel:actorLabel(req),eventCode:"ADS_ADVERTISER_CNPJ_LOOKUP",resourceCode:"ADS",actionCode:"READ",resultCode:"SUCCESS",targetType:"CNPJ",targetId:cnpj,metadata:{source:"BRASILAPI",existing:false,registration_status:company.registration_status||null}});
    return res.json({ok:true,source:"BRASILAPI",existing:false,company});
  }catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});
    const code=e?.message;
    const status=Number(e?.status)||502;
    const mapped=code==="CNPJ_NOT_FOUND"?{status:404,error:"CNPJ não encontrado na fonte cadastral.",code:"CNPJ_NOT_FOUND"}:code==="PROVIDER_TIMEOUT"?{status:504,error:"A consulta cadastral de CNPJ excedeu o tempo limite.",code:"CNPJ_PROVIDER_TIMEOUT"}:code==="PROVIDER_INVALID_CNPJ"?{status:400,error:"CNPJ recusado pela fonte cadastral.",code:"INVALID_CNPJ"}:{status,error:"Fonte cadastral de CNPJ temporariamente indisponível.",code:"CNPJ_PROVIDER_UNAVAILABLE"};
    await writeAdminAuditSafe(pool,req,{actorUserId:actorUserId(req),actorLabel:actorLabel(req),eventCode:"ADS_ADVERTISER_CNPJ_LOOKUP",resourceCode:"ADS",actionCode:"READ",resultCode:"DENIED",targetType:"CNPJ",targetId:cnpj,metadata:{source:"BRASILAPI",reason:mapped.code}});
    return res.status(mapped.status).json({error:mapped.error,code:mapped.code});
  }
});
router.get("/ads/advertisers/:advertiserId",authRequired,requireAdminPermission("ADS_READ"),async(req,res)=>{const id=positiveBigIntString(req.params.advertiserId);if(!id)return res.status(400).json({error:"advertiserId inválido.",code:"INVALID_ADVERTISER_ID"});const a=await loadAdvertiser(await getPool(),id);return a?res.json({ok:true,advertiser:a}):res.status(404).json({error:"Anunciante não encontrado.",code:"ADVERTISER_NOT_FOUND"});});
router.get("/ads/advertisers/:advertiserId/history",authRequired,requireAdminPermission("ADS_READ"),async(req,res)=>{
  const id=positiveBigIntString(req.params.advertiserId);
  if(!id)return res.status(400).json({error:"advertiserId inválido.",code:"INVALID_ADVERTISER_ID"});
  try{
    const pool=await getPool();
    const advertiser=await loadAdvertiser(pool,id);
    if(!advertiser)return res.status(404).json({error:"Anunciante não encontrado.",code:"ADVERTISER_NOT_FOUND"});
    // Compatibilidade com a estrutura física homologada do admin_audit_event.
    // A coluna temporal pode variar entre snapshots/migrations do Admin; resolvemos
    // somente entre nomes conhecidos e nunca interpolamos entrada do usuário.
    const schema=await pool.request().query(`
      SELECT c.name
      FROM sys.columns c
      WHERE c.object_id=OBJECT_ID('dbo.admin_audit_event')
        AND c.name IN ('created_at','occurred_at','event_at','logged_at','audit_event_id','admin_audit_event_id');`);
    const available=new Set((schema.recordset||[]).map(r=>String(r.name)));
    const timeColumn=['created_at','occurred_at','event_at','logged_at'].find(c=>available.has(c))||null;
    const idColumn=['audit_event_id','admin_audit_event_id'].find(c=>available.has(c))||null;
    const timeSelect=timeColumn ? `${timeColumn} AS created_at` : `CAST(NULL AS datetime2) AS created_at`;
    const orderBy=timeColumn ? `${timeColumn} DESC${idColumn ? `, ${idColumn} DESC` : ''}` : (idColumn ? `${idColumn} DESC` : `event_code DESC`);
    const q=await pool.request().input("target_id",sql.NVarChar(200),String(id)).query(`
      SELECT actor_user_id,actor_label,event_code,action_code,result_code,before_json,after_json,${timeSelect}
      FROM dbo.admin_audit_event
      WHERE resource_code='ADS'
        AND target_type='ADS_ADVERTISER'
        AND target_id=@target_id
        AND event_code IN ('ADS_ADVERTISER_CREATE','ADS_ADVERTISER_UPDATE')
        AND result_code='SUCCESS'
      ORDER BY ${orderBy};`);
    const parseJsonSafe=(value)=>{
      if(value==null||value==='')return null;
      if(typeof value==='object')return value;
      try{return JSON.parse(String(value));}catch{return null;}
    };
    const items=(q.recordset||[]).map(x=>({
      ...x,
      before: parseJsonSafe(x.before_json),
      after: parseJsonSafe(x.after_json),
      before_json: undefined,after_json: undefined,
    }));
    return res.json({ok:true,advertiser_id:String(id),items});
  }catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});console.error("[ADMIN ADS] advertiser history",e);return res.status(500).json({error:"Falha ao consultar histórico do anunciante.",code:"ADMIN_ADS_HISTORY_ERROR"});}
});
router.post("/ads/advertisers",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{
  const pool=await getPool();
  const reason=reasonOf(req.body),c=code(req.body?.advertiser_code),name=trim(req.body?.advertiser_name),status=upper(req.body?.status_code||"ACTIVE");
  if(!reason)return res.status(400).json({error:"reason é obrigatório.",code:"REASON_REQUIRED"});
  if(!c||!name||name.length>200||!ADVERTISER_STATUSES.has(status))return res.status(400).json({error:"Dados do anunciante inválidos.",code:"INVALID_ADVERTISER"});
  const legal=nullableText(req.body?.legal_name,250),tax=normalizeCnpj(req.body?.tax_id),email=nullableText(req.body?.email,320),phone=nullableText(req.body?.phone,40);if([legal,tax,email,phone].some(v=>v===undefined))return res.status(400).json({error:"Campo textual inválido.",code:"INVALID_ADVERTISER_TEXT"});if(tax&&!isValidCnpj(tax))return res.status(400).json({error:"CNPJ inválido.",code:"INVALID_CNPJ"});
  try{const after=await withMutation(pool,async tx=>{if(tax){const dup=await tx.request().input("tax",sql.VarChar(40),tax).query(`SELECT TOP (1) advertiser_id FROM dbo.ads_advertiser WITH (UPDLOCK,HOLDLOCK) WHERE tax_id=@tax;`);if(dup.recordset?.length){const x=new Error("CNPJ_EXISTS");x.status=409;throw x;}}const q=await tx.request().input("code",sql.VarChar(80),c).input("name",sql.NVarChar(200),name).input("legal",sql.NVarChar(250),legal).input("tax",sql.VarChar(40),tax).input("email",sql.NVarChar(320),email).input("phone",sql.NVarChar(40),phone).input("status",sql.VarChar(20),status).query(`INSERT dbo.ads_advertiser(advertiser_code,advertiser_name,legal_name,tax_id,email,phone,status_code) OUTPUT inserted.advertiser_id VALUES(@code,@name,@legal,@tax,@email,@phone,@status);`);const id=String(q.recordset[0].advertiser_id);const a=await loadAdvertiser(tx,id);await auditOn(tx,req,{eventCode:"ADS_ADVERTISER_CREATE",targetType:"ADS_ADVERTISER",targetId:id,after:a,metadata:{operation:"ORDINARY_ADVERTISER_CREATE",reason}});return a;});return res.status(201).json({ok:true,advertiser:after});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===409&&e.message==="CNPJ_EXISTS")return res.status(409).json({error:"CNPJ já cadastrado para outro anunciante.",code:"ADVERTISER_CNPJ_EXISTS"});if([2601,2627].includes(Number(e?.number)))return res.status(409).json({error:"advertiser_code já existe.",code:"ADVERTISER_CODE_EXISTS"});console.error("[ADMIN ADS] advertiser create",e);return res.status(500).json({error:"Falha ao criar anunciante.",code:"ADMIN_ADS_WRITE_ERROR"});}
});
router.put("/ads/advertisers/:advertiserId",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{
  const pool=await getPool(),id=positiveBigIntString(req.params.advertiserId),rv=rowVersionBuffer(req.body?.row_version),reason=reasonOf(req.body);if(!id)return res.status(400).json({error:"advertiserId inválido.",code:"INVALID_ADVERTISER_ID"});if(!rv)return res.status(400).json({error:"row_version inválido ou ausente.",code:"ROW_VERSION_REQUIRED"});if(!reason)return res.status(400).json({error:"reason é obrigatório.",code:"REASON_REQUIRED"});
  try{const out=await withMutation(pool,async tx=>{const before=await loadAdvertiser(tx,id,true);if(!before){const x=new Error("NF");x.status=404;throw x;}const sets=[],r=tx.request().input("id",sql.BigInt,id).input("rv",sql.VarBinary(8),rv);if(own(req.body,"advertiser_name")){const v=trim(req.body.advertiser_name);if(!v||v.length>200){const x=new Error("BAD");x.status=400;throw x;}r.input("name",sql.NVarChar(200),v);sets.push("advertiser_name=@name");}for(const [k,t,m] of [["legal_name",sql.NVarChar(250),250],["email",sql.NVarChar(320),320],["phone",sql.NVarChar(40),40]])if(own(req.body,k)){const v=nullableText(req.body[k],m);if(v===undefined){const x=new Error("BAD");x.status=400;throw x;}r.input(k,t,v);sets.push(`${k}=@${k}`);}if(own(req.body,"tax_id")){const v=normalizeCnpj(req.body.tax_id);if(v===undefined|| (v&&!isValidCnpj(v))){const x=new Error("CNPJ");x.status=400;throw x;}if(v){const dup=await tx.request().input("tax",sql.VarChar(40),v).input("current_id",sql.BigInt,id).query(`SELECT TOP (1) advertiser_id FROM dbo.ads_advertiser WITH (UPDLOCK,HOLDLOCK) WHERE tax_id=@tax AND advertiser_id<>@current_id;`);if(dup.recordset?.length){const x=new Error("CNPJ_EXISTS");x.status=409;throw x;}}r.input("tax_id",sql.VarChar(40),v);sets.push("tax_id=@tax_id");}if(own(req.body,"status_code")){const v=upper(req.body.status_code);if(!ADVERTISER_STATUSES.has(v)){const x=new Error("BAD");x.status=400;throw x;}r.input("status",sql.VarChar(20),v);sets.push("status_code=@status");}if(!sets.length){const x=new Error("NO");x.status=400;throw x;}sets.push("updated_at=SYSUTCDATETIME()");const u=await r.query(`UPDATE dbo.ads_advertiser SET ${sets.join(",")} WHERE advertiser_id=@id AND row_version=@rv; SELECT @@ROWCOUNT affected;`);if(Number(u.recordset?.[0]?.affected||0)!==1){const x=new Error("CONFLICT");x.status=409;throw x;}const after=await loadAdvertiser(tx,id);await auditOn(tx,req,{eventCode:"ADS_ADVERTISER_UPDATE",targetType:"ADS_ADVERTISER",targetId:id,before,after,metadata:{operation:"ORDINARY_ADVERTISER_UPDATE",reason}});return after;});return res.json({ok:true,advertiser:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Anunciante não encontrado.",code:"ADVERTISER_NOT_FOUND"});if(e.status===409&&e.message==="CNPJ_EXISTS")return res.status(409).json({error:"CNPJ já cadastrado para outro anunciante.",code:"ADVERTISER_CNPJ_EXISTS"});if(e.status===409)return res.status(409).json({error:"Registro alterado por outra operação.",code:"ROW_VERSION_CONFLICT"});if(e.status===400&&e.message==="CNPJ")return res.status(400).json({error:"CNPJ inválido.",code:"INVALID_CNPJ"});if(e.status===400)return res.status(400).json({error:"Alteração inválida.",code:"INVALID_ADVERTISER_UPDATE"});console.error("[ADMIN ADS] advertiser update",e);return res.status(500).json({error:"Falha ao atualizar anunciante.",code:"ADMIN_ADS_WRITE_ERROR"});}
});

// -------------------- CAMPAIGNS --------------------
router.get("/ads/campaigns",authRequired,requireAdminPermission("ADS_READ"),async(req,res)=>{const pool=await getPool(),page=pageOf(req),size=pageSizeOf(req),offset=(page-1)*size,status=upper(req.query?.status),adv=positiveBigIntString(req.query?.advertiser_id);if(status&&!CAMPAIGN_STATUSES.has(status))return res.status(400).json({error:"status inválido.",code:"INVALID_CAMPAIGN_STATUS"});const r=await pool.request().input("offset",sql.Int,offset).input("size",sql.Int,size).input("status",sql.VarChar(30),status||null).input("adv",sql.BigInt,adv).query(`SELECT c.campaign_id,c.advertiser_id,c.campaign_code,c.campaign_name,c.status_code,c.starts_at,c.ends_at,c.created_by,c.updated_by,c.created_at,c.updated_at,sys.fn_varbintohexstr(c.row_version) row_version,a.advertiser_name,COUNT(*) OVER() total_count FROM dbo.ads_campaign c JOIN dbo.ads_advertiser a ON a.advertiser_id=c.advertiser_id WHERE (@status IS NULL OR c.status_code=@status) AND (@adv IS NULL OR c.advertiser_id=@adv) ORDER BY c.updated_at DESC,c.campaign_id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;`);res.json({ok:true,page,page_size:size,total:Number(r.recordset?.[0]?.total_count||0),items:(r.recordset||[]).map(({total_count,...x})=>mapCampaign(x))});});
router.get("/ads/campaigns/:campaignId",authRequired,requireAdminPermission("ADS_READ"),async(req,res)=>{const id=positiveBigIntString(req.params.campaignId);if(!id)return res.status(400).json({error:"campaignId inválido.",code:"INVALID_CAMPAIGN_ID"});const pool=await getPool(),c=await loadCampaign(pool,id);if(!c)return res.status(404).json({error:"Campanha não encontrada.",code:"CAMPAIGN_NOT_FOUND"});const [a,cr,p,f,t,b,ap,ready]=await Promise.all([loadAdvertiser(pool,c.advertiser_id),pool.request().input("id",sql.BigInt,id).query(`SELECT creative_id,campaign_id,creative_code,creative_name,creative_type,headline,body,asset_path,cta_label,cta_url,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_creative WHERE campaign_id=@id ORDER BY creative_id;`),pool.request().input("id",sql.BigInt,id).query(`SELECT p.placement_id,p.placement_code,p.placement_name,p.surface_code,p.status_code,cp.status_code association_status FROM dbo.ads_campaign_placement cp JOIN dbo.ads_placement p ON p.placement_id=cp.placement_id WHERE cp.campaign_id=@id ORDER BY p.placement_id;`),pool.request().input("id",sql.BigInt,id).query(`SELECT flight_id,campaign_id,flight_code,starts_at,ends_at,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_flight WHERE campaign_id=@id ORDER BY starts_at;`),pool.request().input("id",sql.BigInt,id).query(`SELECT commercial_terms_id,campaign_id,currency_code,pricing_model_code,contracted_amount,unit_price,notes,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_commercial_terms WHERE campaign_id=@id;`),pool.request().input("id",sql.BigInt,id).query(`SELECT budget_id,campaign_id,currency_code,total_budget,daily_budget,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_budget WHERE campaign_id=@id;`),pool.request().input("id",sql.BigInt,id).query(`SELECT approval_id,campaign_id,approval_status,reviewed_by_user_id,reason,reviewed_at,created_at FROM dbo.ads_approval WHERE campaign_id=@id ORDER BY approval_id;`),campaignReadiness(pool,id)]);res.json({ok:true,campaign:{...c,advertiser:a,creatives:(cr.recordset||[]).map(mapCreative),placements:(p.recordset||[]).map(x=>({...x,placement_id:String(x.placement_id)})),flights:(f.recordset||[]).map(mapFlight),commercial_terms:t.recordset?.[0]||null,budget:b.recordset?.[0]||null,approval_history:ap.recordset||[],readiness:ready}});});
router.post("/ads/campaigns",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),reason=reasonOf(req.body),adv=positiveBigIntString(req.body?.advertiser_id),c=code(req.body?.campaign_code),name=trim(req.body?.campaign_name),start=dateValue(req.body?.starts_at),end=dateValue(req.body?.ends_at);if(!reason)return res.status(400).json({error:"reason é obrigatório.",code:"REASON_REQUIRED"});if(!adv||!c||!name||name.length>200||start===undefined||end===undefined||(start&&end&&end<=start))return res.status(400).json({error:"Dados da campanha inválidos.",code:"INVALID_CAMPAIGN"});try{const after=await withMutation(pool,async tx=>{const a=await loadAdvertiser(tx,adv,true);if(!a){const e=new Error();e.status=404;throw e;}const q=await tx.request().input("adv",sql.BigInt,adv).input("code",sql.VarChar(80),c).input("name",sql.NVarChar(200),name).input("start",sql.DateTime2(3),start).input("end",sql.DateTime2(3),end).input("user",sql.Int,actorUserId(req)).query(`INSERT dbo.ads_campaign(advertiser_id,campaign_code,campaign_name,status_code,starts_at,ends_at,created_by,updated_by) OUTPUT inserted.campaign_id VALUES(@adv,@code,@name,'DRAFT',@start,@end,@user,@user);`);const id=String(q.recordset[0].campaign_id);const x=await loadCampaign(tx,id);await auditOn(tx,req,{eventCode:"ADS_CAMPAIGN_CREATE",targetType:"ADS_CAMPAIGN",targetId:id,after:x,metadata:{reason}});return x;});return res.status(201).json({ok:true,campaign:after});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Anunciante não encontrado.",code:"ADVERTISER_NOT_FOUND"});if([2601,2627].includes(Number(e?.number)))return res.status(409).json({error:"campaign_code já existe.",code:"CAMPAIGN_CODE_EXISTS"});console.error("[ADMIN ADS] campaign create",e);return res.status(500).json({error:"Falha ao criar campanha.",code:"ADMIN_ADS_WRITE_ERROR"});}});
router.put("/ads/campaigns/:campaignId",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),id=positiveBigIntString(req.params.campaignId),reason=reasonOf(req.body),rv=rowVersionBuffer(req.body?.row_version);if(!id)return res.status(400).json({error:"campaignId inválido.",code:"INVALID_CAMPAIGN_ID"});if(!reason)return res.status(400).json({error:"reason é obrigatório.",code:"REASON_REQUIRED"});if(!rv)return res.status(400).json({error:"row_version obrigatório.",code:"ROW_VERSION_REQUIRED"});try{const after=await withMutation(pool,async tx=>{const before=await loadCampaign(tx,id,true);if(!before){const e=new Error();e.status=404;throw e;}if(!CAMPAIGN_EDITABLE_STATUSES.has(before.status_code)){const e=new Error();e.status=409;e.code=["CANCELLED","COMPLETED"].includes(before.status_code)?"TERMINAL":"LOCKED_STATE";e.before=before;throw e;}const sets=[],r=tx.request().input("id",sql.BigInt,id).input("rv",sql.VarBinary(8),rv).input("user",sql.Int,actorUserId(req));if(own(req.body,"campaign_name")){const v=trim(req.body.campaign_name);if(!v||v.length>200){const e=new Error();e.status=400;throw e;}r.input("name",sql.NVarChar(200),v);sets.push("campaign_name=@name");}if(own(req.body,"starts_at")){const v=dateValue(req.body.starts_at);if(v===undefined){const e=new Error();e.status=400;throw e;}r.input("start",sql.DateTime2(3),v);sets.push("starts_at=@start");}if(own(req.body,"ends_at")){const v=dateValue(req.body.ends_at);if(v===undefined){const e=new Error();e.status=400;throw e;}r.input("end",sql.DateTime2(3),v);sets.push("ends_at=@end");}if(!sets.length){const e=new Error();e.status=400;throw e;}sets.push("updated_by=@user","updated_at=SYSUTCDATETIME()",...(before.status_code==="REJECTED"?["status_code='DRAFT'"]:[]));const q=await r.query(`UPDATE dbo.ads_campaign SET ${sets.join(",")} WHERE campaign_id=@id AND row_version=@rv;SELECT @@ROWCOUNT affected;`);if(Number(q.recordset?.[0]?.affected||0)!==1){const e=new Error();e.status=409;e.code="RV";throw e;}const x=await loadCampaign(tx,id);if(x.starts_at&&x.ends_at&&new Date(x.ends_at)<=new Date(x.starts_at)){const e=new Error();e.status=400;throw e;}await auditOn(tx,req,{eventCode:"ADS_CAMPAIGN_UPDATE",targetType:"ADS_CAMPAIGN",targetId:id,before,after:x,metadata:{reason}});return x;});return res.json({ok:true,campaign:after});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Campanha não encontrada.",code:"CAMPAIGN_NOT_FOUND"});if(e.status===409){
  if(e.code==="TERMINAL"||e.code==="LOCKED_STATE"){
    await auditDenied(pool,req,"ADS_CAMPAIGN_UPDATE_DENIED","ADS_CAMPAIGN",id,e.code==="TERMINAL"?"CAMPAIGN_TERMINAL":"CAMPAIGN_IMMUTABLE_STATE",e.before,reason);
    return res.status(409).json({
      error:e.code==="TERMINAL"?"Campanha em estado terminal e imutável.":"Dados básicos não podem ser alterados neste estado.",
      code:e.code==="TERMINAL"?"CAMPAIGN_TERMINAL":"CAMPAIGN_IMMUTABLE_STATE",
      status_code:e.before?.status_code||null,
      editable_statuses:["DRAFT","REJECTED","PENDING_APPROVAL","APPROVED","ACTIVE","PAUSED"]
    });
  }
  return res.status(409).json({error:"Conflito de concorrência.",code:"ROW_VERSION_CONFLICT"});
}if(e.status===400)return res.status(400).json({error:"Alteração inválida.",code:"INVALID_CAMPAIGN_UPDATE"});console.error("[ADMIN ADS] campaign update",e);return res.status(500).json({error:"Falha ao atualizar campanha.",code:"ADMIN_ADS_WRITE_ERROR"});}});

async function lifecycle(req,res,op){const pool=await getPool(),id=positiveBigIntString(req.params.campaignId),reason=reasonOf(req.body);if(!id)return res.status(400).json({error:"campaignId inválido.",code:"INVALID_CAMPAIGN_ID"});if(!reason)return res.status(400).json({error:"reason é obrigatório.",code:"REASON_REQUIRED"});try{const after=await withMutation(pool,async tx=>{const before=await loadCampaign(tx,id,true);if(!before){const e=new Error();e.status=404;throw e;}if(!op.from.has(before.status_code)){const e=new Error();e.status=409;e.code="TRANSITION";throw e;}if(op.name==="submit"||op.name==="activate"){const ready=await campaignReadiness(tx,id);const ok=op.name==="activate"?ready?.activation_ready:ready?.ready;const missing=op.name==="activate"?(ready?.activation_missing||[]):(ready?.missing||[]);if(!ok){const e=new Error();e.status=409;e.code="NOT_READY";e.missing=missing;throw e;}}if(op.name==="submit")await tx.request().input("id",sql.BigInt,id).query(`INSERT dbo.ads_approval(campaign_id,approval_status) VALUES(@id,'PENDING');`);if(op.name==="approve"||op.name==="reject")await tx.request().input("id",sql.BigInt,id).input("user",sql.Int,actorUserId(req)).input("reason",sql.NVarChar(2000),reason).input("status",sql.VarChar(20),op.name==="approve"?"APPROVED":"REJECTED").query(`INSERT dbo.ads_approval(campaign_id,approval_status,reviewed_by_user_id,reason,reviewed_at) VALUES(@id,@status,@user,@reason,SYSUTCDATETIME());`);
// Campaign CANCELLED is terminal for delivery and for persisted operational state.
// Cascade only flights that are still operational; preserve COMPLETED/CANCELLED history.
let cancelledFlights=[];
if(op.name==="cancel"){
  const fq=await tx.request().input("id",sql.BigInt,id).query(`
    SELECT flight_id,campaign_id,flight_code,starts_at,ends_at,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version
    FROM dbo.ads_flight WITH (UPDLOCK,HOLDLOCK)
    WHERE campaign_id=@id AND status_code IN ('DRAFT','ACTIVE','PAUSED')
    ORDER BY flight_id;`);
  const beforeFlights=(fq.recordset||[]).map(mapFlight);
  if(beforeFlights.length){
    await tx.request().input("id",sql.BigInt,id).query(`
      UPDATE dbo.ads_flight
         SET status_code='CANCELLED', updated_at=SYSUTCDATETIME()
       WHERE campaign_id=@id AND status_code IN ('DRAFT','ACTIVE','PAUSED');`);
    for(const flightBefore of beforeFlights){
      const flightAfter=await loadFlight(tx,flightBefore.flight_id);
      cancelledFlights.push(flightAfter);
      await auditOn(tx,req,{eventCode:"ADS_FLIGHT_CANCEL_BY_CAMPAIGN",targetType:"ADS_FLIGHT",targetId:flightBefore.flight_id,before:flightBefore,after:flightAfter,metadata:{reason,campaign_id:id,trigger:"CAMPAIGN_CANCELLED",from_status:flightBefore.status_code,to_status:"CANCELLED"}});
    }
  }
}
await tx.request().input("id",sql.BigInt,id).input("status",sql.VarChar(30),op.to).input("user",sql.Int,actorUserId(req)).query(`UPDATE dbo.ads_campaign SET status_code=@status,updated_by=@user,updated_at=SYSUTCDATETIME() WHERE campaign_id=@id;`);const x=await loadCampaign(tx,id);await auditOn(tx,req,{eventCode:`ADS_CAMPAIGN_${op.event}`,targetType:"ADS_CAMPAIGN",targetId:id,before,after:x,metadata:{reason,from_status:before.status_code,to_status:op.to,cancelled_flights:cancelledFlights.map(f=>({flight_id:f.flight_id,flight_code:f.flight_code,status_code:f.status_code}))}});return x;});return res.json({ok:true,campaign:after});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Campanha não encontrada.",code:"CAMPAIGN_NOT_FOUND"});if(e.code==="NOT_READY")return res.status(409).json({error:"Campanha ainda não está pronta.",code:"CAMPAIGN_NOT_READY",missing:e.missing});if(e.status===409)return res.status(409).json({error:"Transição de estado não permitida.",code:"INVALID_CAMPAIGN_TRANSITION"});console.error("[ADMIN ADS] lifecycle",op.name,e);return res.status(500).json({error:"Falha ao alterar lifecycle.",code:"ADMIN_ADS_WRITE_ERROR"});}}
const ops={submit:{name:"submit",event:"SUBMIT",from:new Set(["DRAFT"]),to:"PENDING_APPROVAL"},approve:{name:"approve",event:"APPROVE",from:new Set(["PENDING_APPROVAL"]),to:"APPROVED"},reject:{name:"reject",event:"REJECT",from:new Set(["PENDING_APPROVAL"]),to:"REJECTED"},activate:{name:"activate",event:"ACTIVATE",from:new Set(["APPROVED","PAUSED"]),to:"ACTIVE"},pause:{name:"pause",event:"PAUSE",from:new Set(["ACTIVE"]),to:"PAUSED"},cancel:{name:"cancel",event:"CANCEL",from:new Set(["DRAFT","REJECTED","APPROVED","ACTIVE","PAUSED"]),to:"CANCELLED"}};for(const[k,v]of Object.entries(ops))router.post(`/ads/campaigns/:campaignId/${k}`,authRequired,requireAdminPermission("ADS_WRITE"),(req,res)=>lifecycle(req,res,v));

// -------------------- CREATIVES --------------------
router.get("/ads/creatives/:creativeId/history",authRequired,requireAdminPermission("ADS_READ"),async(req,res)=>{
  const id=positiveBigIntString(req.params.creativeId);
  if(!id)return res.status(400).json({error:"creativeId inválido.",code:"INVALID_CREATIVE_ID"});
  try{
    const pool=await getPool();
    const exists=await loadCreative(pool,id);
    if(!exists)return res.status(404).json({error:"Creative não encontrado.",code:"CREATIVE_NOT_FOUND"});
    const schema=await pool.request().query(`
      SELECT c.name
      FROM sys.columns c
      WHERE c.object_id=OBJECT_ID('dbo.admin_audit_event')
        AND c.name IN ('created_at','occurred_at','event_at','logged_at','audit_event_id','admin_audit_event_id');`);
    const available=new Set((schema.recordset||[]).map(r=>String(r.name)));
    const timeColumn=['created_at','occurred_at','event_at','logged_at'].find(c=>available.has(c))||null;
    const idColumn=['audit_event_id','admin_audit_event_id'].find(c=>available.has(c))||null;
    const timeSelect=timeColumn ? `${timeColumn} AS created_at` : `CAST(NULL AS datetime2) AS created_at`;
    const orderBy=timeColumn ? `${timeColumn} DESC${idColumn ? `, ${idColumn} DESC` : ''}` : (idColumn ? `${idColumn} DESC` : `event_code DESC`);
    const q=await pool.request().input("target_id",sql.NVarChar(200),String(id)).query(`
      SELECT actor_user_id,actor_label,event_code,action_code,result_code,before_json,after_json,metadata_json,${timeSelect}
      FROM dbo.admin_audit_event
      WHERE resource_code='ADS'
        AND target_type='ADS_CREATIVE'
        AND target_id=@target_id
        AND event_code IN ('ADS_CREATIVE_CREATE','ADS_CREATIVE_UPDATE')
        AND result_code='SUCCESS'
      ORDER BY ${orderBy};`);
    const parseJsonSafe=(value)=>{
      if(value==null||value==='')return null;
      if(typeof value==='object')return value;
      try{return JSON.parse(String(value));}catch{return null;}
    };
    const items=(q.recordset||[]).map(x=>{
      const metadata=parseJsonSafe(x.metadata_json)||{};
      return {
        actor_user_id:x.actor_user_id,
        actor_label:x.actor_label,
        event_code:x.event_code,
        action_code:x.action_code,
        result_code:x.result_code,
        created_at:x.created_at,
        reason:metadata.reason||null,
        before:parseJsonSafe(x.before_json),
        after:parseJsonSafe(x.after_json),
      };
    });
    return res.json({ok:true,creative_id:String(id),items});
  }catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});
    console.error("[ADMIN ADS] creative history",e);
    return res.status(500).json({error:"Falha ao consultar histórico do creative.",code:"ADMIN_ADS_CREATIVE_HISTORY_ERROR"});
  }
});

router.post("/ads/campaigns/:campaignId/creatives",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),cid=positiveBigIntString(req.params.campaignId),reason=reasonOf(req.body),c=code(req.body?.creative_code),name=trim(req.body?.creative_name),type=upper(req.body?.creative_type);if(!cid||!reason||!c||!name||name.length>200||!CREATIVE_TYPES.has(type))return res.status(400).json({error:"Dados do creative inválidos.",code:"INVALID_CREATIVE"});const headline=nullableText(req.body?.headline,250),body=nullableText(req.body?.body,2000),asset=nullableText(req.body?.asset_path,1000),label=nullableText(req.body?.cta_label,120),url=nullableText(req.body?.cta_url,1500);if([headline,body,asset,label,url].some(v=>v===undefined)||(!headline&&!body&&!asset)||(label==null)!==(url==null))return res.status(400).json({error:"Conteúdo do creative inválido.",code:"INVALID_CREATIVE_CONTENT"});try{const out=await withMutation(pool,async tx=>{await assertCampaignMutable(tx,cid);const q=await tx.request().input("cid",sql.BigInt,cid).input("code",sql.VarChar(80),c).input("name",sql.NVarChar(200),name).input("type",sql.VarChar(20),type).input("headline",sql.NVarChar(250),headline).input("body",sql.NVarChar(2000),body).input("asset",sql.NVarChar(1000),asset).input("label",sql.NVarChar(120),label).input("url",sql.NVarChar(1500),url).query(`INSERT dbo.ads_creative(campaign_id,creative_code,creative_name,creative_type,headline,body,asset_path,cta_label,cta_url) OUTPUT inserted.creative_id VALUES(@cid,@code,@name,@type,@headline,@body,@asset,@label,@url);`);const id=String(q.recordset[0].creative_id),x=await loadCreative(tx,id);await auditOn(tx,req,{eventCode:"ADS_CREATIVE_CREATE",targetType:"ADS_CREATIVE",targetId:id,after:x,metadata:{reason,campaign_id:cid}});return x;});return res.status(201).json({ok:true,creative:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Campanha não encontrada.",code:"CAMPAIGN_NOT_FOUND"});if([2601,2627].includes(Number(e?.number)))return res.status(409).json({error:"creative_code já existe.",code:"CREATIVE_CODE_EXISTS"});console.error("[ADMIN ADS] creative create",e);return res.status(500).json({error:"Falha ao criar creative.",code:"ADMIN_ADS_WRITE_ERROR"});}});
router.put("/ads/creatives/:creativeId",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),id=positiveBigIntString(req.params.creativeId),reason=reasonOf(req.body),rv=rowVersionBuffer(req.body?.row_version);if(!id||!reason||!rv)return res.status(400).json({error:"creativeId, reason e row_version são obrigatórios.",code:"INVALID_CREATIVE_UPDATE"});try{const out=await withMutation(pool,async tx=>{const before=await loadCreative(tx,id,true);if(!before){const e=new Error();e.status=404;throw e;}await assertCampaignMutable(tx,before.campaign_id);const sets=[],r=tx.request().input("id",sql.BigInt,id).input("rv",sql.VarBinary(8),rv);for(const[k,t,m]of[["creative_name",sql.NVarChar(200),200],["headline",sql.NVarChar(250),250],["body",sql.NVarChar(2000),2000],["asset_path",sql.NVarChar(1000),1000],["cta_label",sql.NVarChar(120),120],["cta_url",sql.NVarChar(1500),1500]])if(own(req.body,k)){const v=k==="creative_name"?trim(req.body[k]):nullableText(req.body[k],m);if(v===undefined||k==="creative_name"&&!v){const e=new Error();e.status=400;throw e;}r.input(k,t,v);sets.push(`${k}=@${k}`);}if(own(req.body,"creative_type")){const v=upper(req.body.creative_type);if(!CREATIVE_TYPES.has(v)){const e=new Error();e.status=400;throw e;}r.input("creative_type",sql.VarChar(20),v);sets.push("creative_type=@creative_type");}if(own(req.body,"status_code")){const v=upper(req.body.status_code);if(!CREATIVE_STATUSES.has(v)){const e=new Error();e.status=400;throw e;}r.input("status",sql.VarChar(20),v);sets.push("status_code=@status");}if(!sets.length){const e=new Error();e.status=400;throw e;}sets.push("updated_at=SYSUTCDATETIME()");const q=await r.query(`UPDATE dbo.ads_creative SET ${sets.join(",")} WHERE creative_id=@id AND row_version=@rv;SELECT @@ROWCOUNT affected;`);if(Number(q.recordset?.[0]?.affected||0)!==1){const e=new Error();e.status=409;throw e;}const x=await loadCreative(tx,id);await auditOn(tx,req,{eventCode:"ADS_CREATIVE_UPDATE",targetType:"ADS_CREATIVE",targetId:id,before,after:x,metadata:{reason}});return x;});return res.json({ok:true,creative:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Creative não encontrado.",code:"CREATIVE_NOT_FOUND"});if(e.status===409)return res.status(409).json({error:"Conflito de concorrência.",code:"ROW_VERSION_CONFLICT"});if(e.status===400)return res.status(400).json({error:"Alteração inválida.",code:"INVALID_CREATIVE_UPDATE"});console.error("[ADMIN ADS] creative update",e);return res.status(500).json({error:"Falha ao atualizar creative.",code:"ADMIN_ADS_WRITE_ERROR"});}});

// -------------------- PLACEMENTS --------------------
router.get("/ads/placements",authRequired,requireAdminPermission("ADS_READ"),async(req,res)=>{const pool=await getPool(),status=upper(req.query?.status),surface=upper(req.query?.surface);if(status&&!PLACEMENT_STATUSES.has(status))return res.status(400).json({error:"status inválido.",code:"INVALID_PLACEMENT_STATUS"});const q=await pool.request().input("status",sql.VarChar(20),status||null).input("surface",sql.VarChar(80),surface||null).query(`SELECT placement_id,placement_code,placement_name,description,surface_code,status_code,max_creatives,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_placement WHERE (@status IS NULL OR status_code=@status) AND (@surface IS NULL OR surface_code=@surface) ORDER BY placement_name;`);res.json({ok:true,items:(q.recordset||[]).map(mapPlacement)});});
router.post("/ads/placements",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),reason=reasonOf(req.body),c=code(req.body?.placement_code),name=trim(req.body?.placement_name),surface=code(req.body?.surface_code),status=upper(req.body?.status_code||"ACTIVE"),desc=nullableText(req.body?.description,1000),max=req.body?.max_creatives==null?null:positiveInt(req.body.max_creatives);if(!reason||!c||!name||name.length>200||!surface||!PLACEMENT_STATUSES.has(status)||desc===undefined||(req.body?.max_creatives!=null&&!max))return res.status(400).json({error:"Dados do placement inválidos.",code:"INVALID_PLACEMENT"});try{const out=await withMutation(pool,async tx=>{const q=await tx.request().input("code",sql.VarChar(80),c).input("name",sql.NVarChar(200),name).input("desc",sql.NVarChar(1000),desc).input("surface",sql.VarChar(80),surface).input("status",sql.VarChar(20),status).input("max",sql.Int,max).query(`INSERT dbo.ads_placement(placement_code,placement_name,description,surface_code,status_code,max_creatives) OUTPUT inserted.placement_id VALUES(@code,@name,@desc,@surface,@status,@max);`);const id=String(q.recordset[0].placement_id),x=await loadPlacement(tx,id);await auditOn(tx,req,{eventCode:"ADS_PLACEMENT_CREATE",targetType:"ADS_PLACEMENT",targetId:id,after:x,metadata:{reason}});return x;});return res.status(201).json({ok:true,placement:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if([2601,2627].includes(Number(e?.number)))return res.status(409).json({error:"placement_code já existe.",code:"PLACEMENT_CODE_EXISTS"});console.error("[ADMIN ADS] placement create",e);return res.status(500).json({error:"Falha ao criar placement.",code:"ADMIN_ADS_WRITE_ERROR"});}});
router.put("/ads/placements/:placementId",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),id=positiveBigIntString(req.params.placementId),reason=reasonOf(req.body),rv=rowVersionBuffer(req.body?.row_version);if(!id||!reason||!rv)return res.status(400).json({error:"placementId, reason e row_version obrigatórios.",code:"INVALID_PLACEMENT_UPDATE"});try{const out=await withMutation(pool,async tx=>{const before=await loadPlacement(tx,id,true);if(!before){const e=new Error();e.status=404;throw e;}const sets=[],r=tx.request().input("id",sql.BigInt,id).input("rv",sql.VarBinary(8),rv);for(const[k,t,m]of[["placement_name",sql.NVarChar(200),200],["description",sql.NVarChar(1000),1000]])if(own(req.body,k)){const v=k==="placement_name"?trim(req.body[k]):nullableText(req.body[k],m);if(v===undefined||k==="placement_name"&&!v){const e=new Error();e.status=400;throw e;}r.input(k,t,v);sets.push(`${k}=@${k}`);}if(own(req.body,"surface_code")){const v=code(req.body.surface_code);if(!v){const e=new Error();e.status=400;throw e;}r.input("surface",sql.VarChar(80),v);sets.push("surface_code=@surface");}if(own(req.body,"status_code")){const v=upper(req.body.status_code);if(!PLACEMENT_STATUSES.has(v)){const e=new Error();e.status=400;throw e;}r.input("status",sql.VarChar(20),v);sets.push("status_code=@status");}if(own(req.body,"max_creatives")){const v=req.body.max_creatives==null?null:positiveInt(req.body.max_creatives);if(req.body.max_creatives!=null&&!v){const e=new Error();e.status=400;throw e;}r.input("max",sql.Int,v);sets.push("max_creatives=@max");}if(!sets.length){const e=new Error();e.status=400;throw e;}sets.push("updated_at=SYSUTCDATETIME()");const q=await r.query(`UPDATE dbo.ads_placement SET ${sets.join(",")} WHERE placement_id=@id AND row_version=@rv;SELECT @@ROWCOUNT affected;`);if(Number(q.recordset?.[0]?.affected||0)!==1){const e=new Error();e.status=409;throw e;}const x=await loadPlacement(tx,id);await auditOn(tx,req,{eventCode:"ADS_PLACEMENT_UPDATE",targetType:"ADS_PLACEMENT",targetId:id,before,after:x,metadata:{reason}});return x;});return res.json({ok:true,placement:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Placement não encontrado.",code:"PLACEMENT_NOT_FOUND"});if(e.status===409)return res.status(409).json({error:"Conflito de concorrência.",code:"ROW_VERSION_CONFLICT"});if(e.status===400)return res.status(400).json({error:"Alteração inválida.",code:"INVALID_PLACEMENT_UPDATE"});console.error("[ADMIN ADS] placement update",e);return res.status(500).json({error:"Falha ao atualizar placement.",code:"ADMIN_ADS_WRITE_ERROR"});}});
router.post("/ads/campaigns/:campaignId/placements",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),cid=positiveBigIntString(req.params.campaignId),pid=positiveBigIntString(req.body?.placement_id),reason=reasonOf(req.body);if(!cid||!pid||!reason)return res.status(400).json({error:"campaignId, placement_id e reason obrigatórios.",code:"INVALID_CAMPAIGN_PLACEMENT"});try{await withMutation(pool,async tx=>{await assertCampaignMutable(tx,cid);if(!await loadPlacement(tx,pid,true)){const e=new Error();e.status=404;e.code="P";throw e;}await tx.request().input("cid",sql.BigInt,cid).input("pid",sql.BigInt,pid).query(`IF EXISTS(SELECT 1 FROM dbo.ads_campaign_placement WHERE campaign_id=@cid AND placement_id=@pid) UPDATE dbo.ads_campaign_placement SET status_code='ACTIVE',updated_at=SYSUTCDATETIME() WHERE campaign_id=@cid AND placement_id=@pid; ELSE INSERT dbo.ads_campaign_placement(campaign_id,placement_id,status_code) VALUES(@cid,@pid,'ACTIVE');`);await auditOn(tx,req,{eventCode:"ADS_CAMPAIGN_PLACEMENT_ADD",targetType:"ADS_CAMPAIGN",targetId:cid,metadata:{reason,placement_id:pid}});});return res.json({ok:true,campaign_id:cid,placement_id:pid});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:e.code==="P"?"Placement não encontrado.":"Campanha não encontrada.",code:e.code==="P"?"PLACEMENT_NOT_FOUND":"CAMPAIGN_NOT_FOUND"});console.error("[ADMIN ADS] campaign placement add",e);return res.status(500).json({error:"Falha ao associar placement.",code:"ADMIN_ADS_WRITE_ERROR"});}});
router.delete("/ads/campaigns/:campaignId/placements/:placementId",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),cid=positiveBigIntString(req.params.campaignId),pid=positiveBigIntString(req.params.placementId),reason=reasonOf(req.body);if(!cid||!pid||!reason)return res.status(400).json({error:"IDs e reason obrigatórios.",code:"INVALID_CAMPAIGN_PLACEMENT"});try{const affected=await withMutation(pool,async tx=>{await assertCampaignMutable(tx,cid);const q=await tx.request().input("cid",sql.BigInt,cid).input("pid",sql.BigInt,pid).query(`UPDATE dbo.ads_campaign_placement SET status_code='INACTIVE',updated_at=SYSUTCDATETIME() WHERE campaign_id=@cid AND placement_id=@pid AND status_code<>'INACTIVE';SELECT @@ROWCOUNT affected;`);const n=Number(q.recordset?.[0]?.affected||0);if(n)await auditOn(tx,req,{eventCode:"ADS_CAMPAIGN_PLACEMENT_REMOVE",targetType:"ADS_CAMPAIGN",targetId:cid,metadata:{reason,placement_id:pid}});return n;});return affected?res.json({ok:true}):res.status(404).json({error:"Associação ativa não encontrada.",code:"CAMPAIGN_PLACEMENT_NOT_FOUND"});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});console.error("[ADMIN ADS] campaign placement remove",e);return res.status(500).json({error:"Falha ao remover placement.",code:"ADMIN_ADS_WRITE_ERROR"});}});

// -------------------- FLIGHTS --------------------
router.post("/ads/campaigns/:campaignId/flights",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),cid=positiveBigIntString(req.params.campaignId),reason=reasonOf(req.body),fc=code(req.body?.flight_code),start=dateValue(req.body?.starts_at),end=dateValue(req.body?.ends_at);if(!cid||!reason||!fc||!start||!end||end<=start)return res.status(400).json({error:"Dados do flight inválidos.",code:"INVALID_FLIGHT"});try{const out=await withMutation(pool,async tx=>{await assertCampaignMutable(tx,cid);const q=await tx.request().input("cid",sql.BigInt,cid).input("code",sql.VarChar(80),fc).input("start",sql.DateTime2(3),start).input("end",sql.DateTime2(3),end).query(`INSERT dbo.ads_flight(campaign_id,flight_code,starts_at,ends_at) OUTPUT inserted.flight_id VALUES(@cid,@code,@start,@end);`);const id=String(q.recordset[0].flight_id),x=await loadFlight(tx,id);await auditOn(tx,req,{eventCode:"ADS_FLIGHT_CREATE",targetType:"ADS_FLIGHT",targetId:id,after:x,metadata:{reason,campaign_id:cid}});return x;});return res.status(201).json({ok:true,flight:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Campanha não encontrada.",code:"CAMPAIGN_NOT_FOUND"});if([2601,2627].includes(Number(e?.number)))return res.status(409).json({error:"flight_code já existe.",code:"FLIGHT_CODE_EXISTS"});console.error("[ADMIN ADS] flight create",e);return res.status(500).json({error:"Falha ao criar flight.",code:"ADMIN_ADS_WRITE_ERROR"});}});
router.put("/ads/flights/:flightId",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),id=positiveBigIntString(req.params.flightId),reason=reasonOf(req.body),rv=rowVersionBuffer(req.body?.row_version);if(!id||!reason||!rv)return res.status(400).json({error:"flightId, reason e row_version obrigatórios.",code:"INVALID_FLIGHT_UPDATE"});try{const out=await withMutation(pool,async tx=>{const before=await loadFlight(tx,id,true);if(!before){const e=new Error();e.status=404;throw e;}await assertCampaignMutable(tx,before.campaign_id);const start=own(req.body,"starts_at")?dateValue(req.body.starts_at):(before.starts_at?new Date(before.starts_at):null),end=own(req.body,"ends_at")?dateValue(req.body.ends_at):(before.ends_at?new Date(before.ends_at):null);if(start===undefined||end===undefined||!start||!end||end<=start){const e=new Error();e.status=400;throw e;}const status=own(req.body,"status_code")?upper(req.body.status_code):before.status_code;if(!FLIGHT_STATUSES.has(status)){const e=new Error();e.status=400;throw e;}const q=await tx.request().input("id",sql.BigInt,id).input("rv",sql.VarBinary(8),rv).input("start",sql.DateTime2(3),start).input("end",sql.DateTime2(3),end).input("status",sql.VarChar(20),status).query(`UPDATE dbo.ads_flight SET starts_at=@start,ends_at=@end,status_code=@status,updated_at=SYSUTCDATETIME() WHERE flight_id=@id AND row_version=@rv;SELECT @@ROWCOUNT affected;`);if(Number(q.recordset?.[0]?.affected||0)!==1){const e=new Error();e.status=409;throw e;}const x=await loadFlight(tx,id);await auditOn(tx,req,{eventCode:"ADS_FLIGHT_UPDATE",targetType:"ADS_FLIGHT",targetId:id,before,after:x,metadata:{reason}});return x;});return res.json({ok:true,flight:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Flight não encontrado.",code:"FLIGHT_NOT_FOUND"});if(e.status===409)return res.status(409).json({error:"Conflito de concorrência.",code:"ROW_VERSION_CONFLICT"});if(e.status===400)return res.status(400).json({error:"Alteração inválida.",code:"INVALID_FLIGHT_UPDATE"});console.error("[ADMIN ADS] flight update",e);return res.status(500).json({error:"Falha ao atualizar flight.",code:"ADMIN_ADS_WRITE_ERROR"});}});

// -------------------- COMMERCIAL TERMS + BUDGET --------------------
router.put("/ads/campaigns/:campaignId/commercial-terms",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),cid=positiveBigIntString(req.params.campaignId),reason=reasonOf(req.body),cur=currency(req.body?.currency_code),pricing=upper(req.body?.pricing_model_code),amount=decimal(req.body?.contracted_amount),unit=decimal(req.body?.unit_price),notes=nullableText(req.body?.notes,2000);if(!cid||!reason||!cur||pricing!=="FIXED"||amount===undefined||unit===undefined||notes===undefined)return res.status(400).json({error:"Termos comerciais inválidos. V1 aceita apenas FIXED.",code:"INVALID_COMMERCIAL_TERMS"});try{const out=await withMutation(pool,async tx=>{await assertCampaignMutable(tx,cid);const before=(await tx.request().input("id",sql.BigInt,cid).query(`SELECT commercial_terms_id,campaign_id,currency_code,pricing_model_code,contracted_amount,unit_price,notes,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_commercial_terms WHERE campaign_id=@id;`)).recordset?.[0]||null;await tx.request().input("id",sql.BigInt,cid).input("cur",sql.Char(3),cur).input("pricing",sql.VarChar(30),pricing).input("amount",sql.Decimal(19,4),amount).input("unit",sql.Decimal(19,6),unit).input("notes",sql.NVarChar(2000),notes).query(`IF EXISTS(SELECT 1 FROM dbo.ads_commercial_terms WHERE campaign_id=@id) UPDATE dbo.ads_commercial_terms SET currency_code=@cur,pricing_model_code=@pricing,contracted_amount=@amount,unit_price=@unit,notes=@notes,updated_at=SYSUTCDATETIME() WHERE campaign_id=@id; ELSE INSERT dbo.ads_commercial_terms(campaign_id,currency_code,pricing_model_code,contracted_amount,unit_price,notes) VALUES(@id,@cur,@pricing,@amount,@unit,@notes);`);const after=(await tx.request().input("id",sql.BigInt,cid).query(`SELECT commercial_terms_id,campaign_id,currency_code,pricing_model_code,contracted_amount,unit_price,notes,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_commercial_terms WHERE campaign_id=@id;`)).recordset?.[0];await auditOn(tx,req,{eventCode:"ADS_COMMERCIAL_TERMS_SET",targetType:"ADS_CAMPAIGN",targetId:cid,before,after,metadata:{reason}});return after;});return res.json({ok:true,commercial_terms:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Campanha não encontrada.",code:"CAMPAIGN_NOT_FOUND"});console.error("[ADMIN ADS] commercial terms",e);return res.status(500).json({error:"Falha ao definir termos comerciais.",code:"ADMIN_ADS_WRITE_ERROR"});}});
router.put("/ads/campaigns/:campaignId/budget",authRequired,requireAdminPermission("ADS_WRITE"),async(req,res)=>{const pool=await getPool(),cid=positiveBigIntString(req.params.campaignId),reason=reasonOf(req.body),cur=currency(req.body?.currency_code),total=decimal(req.body?.total_budget),daily=decimal(req.body?.daily_budget),status=upper(req.body?.status_code||"ACTIVE");if(!cid||!reason||!cur||total===undefined||total===null||daily===undefined||(daily!=null&&daily>total)||!BUDGET_STATUSES.has(status))return res.status(400).json({error:"Budget inválido.",code:"INVALID_BUDGET"});try{const out=await withMutation(pool,async tx=>{await assertCampaignMutable(tx,cid);const terms=(await tx.request().input("id",sql.BigInt,cid).query(`SELECT currency_code FROM dbo.ads_commercial_terms WHERE campaign_id=@id;`)).recordset?.[0];if(!terms||terms.currency_code!==cur){const e=new Error();e.status=409;e.code="CURRENCY";throw e;}const before=(await tx.request().input("id",sql.BigInt,cid).query(`SELECT budget_id,campaign_id,currency_code,total_budget,daily_budget,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_budget WHERE campaign_id=@id;`)).recordset?.[0]||null;await tx.request().input("id",sql.BigInt,cid).input("cur",sql.Char(3),cur).input("total",sql.Decimal(19,4),total).input("daily",sql.Decimal(19,4),daily).input("status",sql.VarChar(20),status).query(`IF EXISTS(SELECT 1 FROM dbo.ads_budget WHERE campaign_id=@id) UPDATE dbo.ads_budget SET currency_code=@cur,total_budget=@total,daily_budget=@daily,status_code=@status,updated_at=SYSUTCDATETIME() WHERE campaign_id=@id; ELSE INSERT dbo.ads_budget(campaign_id,currency_code,total_budget,daily_budget,status_code) VALUES(@id,@cur,@total,@daily,@status);`);const after=(await tx.request().input("id",sql.BigInt,cid).query(`SELECT budget_id,campaign_id,currency_code,total_budget,daily_budget,status_code,created_at,updated_at,sys.fn_varbintohexstr(row_version) row_version FROM dbo.ads_budget WHERE campaign_id=@id;`)).recordset?.[0];await auditOn(tx,req,{eventCode:"ADS_BUDGET_SET",targetType:"ADS_CAMPAIGN",targetId:cid,before,after,metadata:{reason}});return after;});return res.json({ok:true,budget:out});}catch(e){if(e?.code==="CAMPAIGN_CANCELLED_TERMINAL")return res.status(409).json({error:"Campanha cancelada é terminal e não permite alterações.",code:"CAMPAIGN_CANCELLED_TERMINAL"});if(e.status===404)return res.status(404).json({error:"Campanha não encontrada.",code:"CAMPAIGN_NOT_FOUND"});if(e.code==="CURRENCY")return res.status(409).json({error:"currency_code deve ser igual ao dos termos comerciais.",code:"BUDGET_CURRENCY_MISMATCH"});console.error("[ADMIN ADS] budget",e);return res.status(500).json({error:"Falha ao definir budget.",code:"ADMIN_ADS_WRITE_ERROR"});}});

export default router;
