// HDUD — AI Cost & Usage Engine
// Regra econômica: processamento local não entra neste ledger.
// Save Memory / MEI / NTG / Local Classification => external AI cost = 0.

import { getPool, sql } from "../db.js";

const PROVIDER = "OPENAI";

const BUILTIN_RATES = {
  "gpt-4.1": { inputUsdPer1M: 2, outputUsdPer1M: 8 },
  "gpt-4.1-mini": { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  "gpt-4.1-nano": { inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  "gpt-4o-mini-transcribe": { audioUsdPerMinute: 0.003, inputUsdPer1M: 1.25, outputUsdPer1M: 5 },
  "gpt-4o-transcribe": { audioUsdPerMinute: 0.006, inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  "gpt-transcribe": { audioUsdPerMinute: 0.0045 },
};

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value, max = 120) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function json(value) {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

export function extractOpenAIUsage(response = {}) {
  const usage = response?.usage || {};
  const inputTokens = n(usage.input_tokens ?? usage.prompt_tokens, 0);
  const outputTokens = n(usage.output_tokens ?? usage.completion_tokens, 0);
  const cachedInputTokens = n(
    usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
    0
  );
  const totalTokens = n(usage.total_tokens, inputTokens + outputTokens);
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

async function objectExists(pool, objectName) {
  const r = await pool.request().input("object_name", sql.NVarChar(256), objectName).query(`
    SELECT CASE WHEN OBJECT_ID(@object_name, 'U') IS NULL THEN 0 ELSE 1 END AS ok;
  `);
  return Boolean(r.recordset?.[0]?.ok);
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsUtcClamped(dateInput, months = 1) {
  const source = new Date(dateInput);
  if (Number.isNaN(source.getTime())) return null;
  const targetMonthIndex = source.getUTCMonth() + Number(months || 0);
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const targetDay = Math.min(source.getUTCDate(), daysInUtcMonth(targetYear, normalizedMonth));
  return new Date(Date.UTC(targetYear, normalizedMonth, targetDay, source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()));
}

function resolveBillingCycle(startsAt, nowInput = new Date()) {
  const anchor = new Date(startsAt);
  const now = new Date(nowInput);
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(now.getTime())) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { start, end: addMonthsUtcClamped(start, 1) };
  }
  if (now < anchor) return { start: anchor, end: addMonthsUtcClamped(anchor, 1) };
  let offset = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  let start = addMonthsUtcClamped(anchor, offset) || anchor;
  if (start > now) { offset -= 1; start = addMonthsUtcClamped(anchor, offset) || anchor; }
  let end = addMonthsUtcClamped(anchor, offset + 1);
  while (end && end <= now) { offset += 1; start = end; end = addMonthsUtcClamped(anchor, offset + 1); }
  return { start, end };
}

async function resolveUserId(pool, userId, authorId) {
  // Fonte preferencial: identidade autenticada propagada pelo fluxo real.
  if (Number.isFinite(Number(userId)) && Number(userId) > 0) return Number(userId);
  if (!Number.isFinite(Number(authorId)) || Number(authorId) <= 0) return null;

  // Compatibilidade para serviços legados/assíncronos que ainda conhecem apenas author_id.
  // Um mesmo author_id pode possuir mais de um identity_user histórico; nunca devemos
  // debitar IA no usuário mais antigo apenas por ORDER BY ASC. Priorizamos o usuário
  // com assinatura ACTIVE mais recente e, na ausência dela, o identity_user mais novo.
  try {
    const r = await pool.request().input("author_id", sql.BigInt, Number(authorId)).query(`
      SELECT TOP 1 u.user_id
      FROM dbo.identity_user u
      OUTER APPLY (
        SELECT TOP 1
          us.user_subscription_id,
          us.starts_at,
          us.created_at
        FROM dbo.user_subscription us
        WHERE us.user_id = u.user_id
          AND us.status = 'ACTIVE'
        ORDER BY
          us.starts_at DESC,
          us.created_at DESC,
          us.user_subscription_id DESC
      ) active_subscription
      WHERE u.author_id = @author_id
      ORDER BY
        CASE WHEN active_subscription.user_subscription_id IS NOT NULL THEN 0 ELSE 1 END ASC,
        active_subscription.starts_at DESC,
        active_subscription.created_at DESC,
        u.user_id DESC;
    `);
    const value = Number(r.recordset?.[0]?.user_id);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // Fallback defensivo para instalações em que user_subscription ainda não exista.
    try {
      const r = await pool.request().input("author_id", sql.BigInt, Number(authorId)).query(`
        SELECT TOP 1 user_id
        FROM dbo.identity_user
        WHERE author_id = @author_id
        ORDER BY user_id DESC;
      `);
      const value = Number(r.recordset?.[0]?.user_id);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }
}

function resolveRateModel(model) {
  const modelName = text(model, 120);
  if (!modelName) return null;

  // OpenAI pode devolver snapshots versionados (ex.: gpt-4.1-2025-04-14).
  // Mantemos o snapshot real no ledger para auditoria, mas precificamos pela família
  // comercial correspondente do rate card.
  const knownModels = Object.keys(BUILTIN_RATES).sort((a, b) => b.length - a.length);
  const family = knownModels.find(
    (candidate) => modelName === candidate || modelName.startsWith(`${candidate}-`)
  );

  return { modelName, rateModel: family || modelName };
}

async function getRate(pool, model) {
  const resolved = resolveRateModel(model);
  if (!resolved) return null;
  const { modelName, rateModel } = resolved;

  try {
    if (await objectExists(pool, "dbo.ai_cost_model_rate")) {
      const r = await pool.request()
        .input("provider", sql.VarChar(30), PROVIDER)
        .input("model", sql.VarChar(120), rateModel)
        .query(`
          SELECT TOP 1 input_usd_per_1m_tokens, cached_input_usd_per_1m_tokens,
                 output_usd_per_1m_tokens, audio_usd_per_minute
          FROM dbo.ai_cost_model_rate
          WHERE provider = @provider AND model = @model
            AND active_from <= SYSUTCDATETIME()
            AND (active_until IS NULL OR active_until > SYSUTCDATETIME())
          ORDER BY active_from DESC, model_rate_id DESC;
        `);
      const row = r.recordset?.[0];
      if (row) {
        return {
          inputUsdPer1M: n(row.input_usd_per_1m_tokens),
          cachedInputUsdPer1M: row.cached_input_usd_per_1m_tokens == null ? null : n(row.cached_input_usd_per_1m_tokens),
          outputUsdPer1M: n(row.output_usd_per_1m_tokens),
          audioUsdPerMinute: row.audio_usd_per_minute == null ? null : n(row.audio_usd_per_minute),
          rateModel,
          actualModel: modelName,
        };
      }
    }
  } catch (err) {
    console.warn("[AI_COST] rate lookup fallback:", err?.message || err);
  }

  const builtin = BUILTIN_RATES[rateModel] || null;
  return builtin ? { ...builtin, rateModel, actualModel: modelName } : null;
}

function calculateCost(rate, { inputTokens, outputTokens, cachedInputTokens, audioSeconds }) {
  if (!rate) return null;
  if (n(audioSeconds) > 0 && rate.audioUsdPerMinute != null) {
    return (n(audioSeconds) / 60) * n(rate.audioUsdPerMinute);
  }
  const cached = Math.min(n(cachedInputTokens), n(inputTokens));
  const regularInput = Math.max(0, n(inputTokens) - cached);
  const cachedRate = rate.cachedInputUsdPer1M == null ? rate.inputUsdPer1M : rate.cachedInputUsdPer1M;
  return (
    (regularInput / 1_000_000) * n(rate.inputUsdPer1M) +
    (cached / 1_000_000) * n(cachedRate) +
    (n(outputTokens) / 1_000_000) * n(rate.outputUsdPer1M)
  );
}

async function getPolicyContext(pool, effectiveUserId) {
  if (!effectiveUserId) return { policy: null, cycle: resolveBillingCycle(null) };
  try {
    if (!(await objectExists(pool, "dbo.subscription_plan_ai_policy"))) {
      return { policy: null, cycle: resolveBillingCycle(null) };
    }
    const r = await pool.request().input("user_id", sql.BigInt, Number(effectiveUserId)).query(`
      SELECT TOP 1
          us.starts_at,
          sp.code AS plan_code,
          sp.name AS plan_name,
          p.monthly_external_ai_budget_usd,
          p.hard_stop,
          COALESCE(p.warning_pct, 80) AS warning_pct,
          COALESCE(p.critical_pct, 90) AS critical_pct,
          COALESCE(p.block_pct, 100) AS block_pct,
          COALESCE(p.allow_overage, 0) AS allow_overage,
          COALESCE(p.overage_mode, 'BLOCK') AS overage_mode
      FROM dbo.user_subscription us
      INNER JOIN dbo.subscription_plan sp ON sp.plan_id = us.plan_id
      LEFT JOIN dbo.subscription_plan_ai_policy p ON p.plan_id = us.plan_id
      WHERE us.user_id=@user_id AND us.status='ACTIVE'
      ORDER BY us.created_at DESC, us.user_subscription_id DESC;
    `);
    const row = r.recordset?.[0] || null;
    return { policy: row, cycle: resolveBillingCycle(row?.starts_at || null) };
  } catch (err) {
    console.warn("[AI_COST] policy lookup fallback:", err?.message || err);
    return { policy: null, cycle: resolveBillingCycle(null) };
  }
}

function normalizeThreshold(value, fallback) {
  return Math.max(0, Math.min(100, n(value, fallback)));
}

function buildEconomicState(policy, usedUsd) {
  const budget = policy?.monthly_external_ai_budget_usd == null
    ? null
    : Math.max(0, n(policy.monthly_external_ai_budget_usd));
  const warningPct = normalizeThreshold(policy?.warning_pct, 80);
  const criticalPct = Math.max(warningPct, normalizeThreshold(policy?.critical_pct, 90));
  const blockPct = Math.max(criticalPct, normalizeThreshold(policy?.block_pct, 100));
  const used = Math.max(0, n(usedUsd));
  const usedPct = budget != null && budget > 0 ? (used / budget) * 100 : null;

  let level = "UNCONFIGURED";
  if (usedPct != null) {
    if (usedPct >= blockPct) level = "EXHAUSTED";
    else if (usedPct >= criticalPct) level = "CRITICAL";
    else if (usedPct >= warningPct) level = "WARNING";
    else level = "NORMAL";
  }

  const allowOverage = Boolean(policy?.allow_overage);
  const hardStop = Boolean(policy?.hard_stop);
  const overageMode = String(policy?.overage_mode || "BLOCK").toUpperCase();
  const blocked = level === "EXHAUSTED" && hardStop && !allowOverage && overageMode === "BLOCK";

  return {
    budgetUsd: budget,
    usedUsd: used,
    remainingUsd: budget == null ? null : Math.max(0, budget - used),
    overageUsd: budget == null ? 0 : Math.max(0, used - budget),
    usedPct,
    warningPct,
    criticalPct,
    blockPct,
    level,
    hardStop,
    allowOverage,
    overageMode,
    blocked,
  };
}

async function getCycleCost(pool, effectiveUserId, cycle) {
  const r = await pool.request()
    .input("user_id", sql.BigInt, effectiveUserId)
    .input("cycle_start", sql.DateTime2, cycle.start)
    .input("cycle_end", sql.DateTime2, cycle.end)
    .query(`
      SELECT COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 0 ELSE cost_usd END),0) cost_usd,
             SUM(CASE WHEN cost_usd IS NULL AND status='SUCCEEDED' THEN 1 ELSE 0 END) unpriced_calls
      FROM dbo.ai_usage_ledger
      WHERE user_id=@user_id
        AND status='SUCCEEDED'
        AND occurred_at>=@cycle_start
        AND occurred_at<@cycle_end;
    `);
  return {
    costUsd: n(r.recordset?.[0]?.cost_usd),
    unpricedCalls: n(r.recordset?.[0]?.unpriced_calls),
  };
}

export async function assertExternalAIAllowed({ pool: suppliedPool = null, userId = null, authorId = null } = {}) {
  const pool = suppliedPool || await getPool();
  const effectiveUserId = await resolveUserId(pool, userId, authorId);
  if (!effectiveUserId || !(await objectExists(pool, "dbo.ai_usage_ledger"))) {
    return { allowed: true, configured: false };
  }

  const { policy, cycle } = await getPolicyContext(pool, effectiveUserId);
  if (!policy) return { allowed: true, configured: false };

  const cycleCost = await getCycleCost(pool, effectiveUserId, cycle);
  const economic = buildEconomicState(policy, cycleCost.costUsd);

  // Sem franquia econômica homologada: somente observabilidade, nunca inventamos limite.
  if (economic.budgetUsd == null || economic.budgetUsd <= 0) {
    return {
      allowed: true,
      configured: true,
      enforcementActive: false,
      level: economic.level,
      planCode: policy?.plan_code || null,
    };
  }

  if (economic.blocked) {
    const error = new Error("Limite de processamento por IA externa atingido para o ciclo atual.");
    error.statusCode = 429;
    error.code = "AI_EXTERNAL_BUDGET_EXHAUSTED";
    error.details = {
      plan_code: policy?.plan_code || null,
      budget_usd: economic.budgetUsd,
      used_usd: economic.usedUsd,
      used_pct: economic.usedPct,
      block_pct: economic.blockPct,
      cycle_start: cycle.start?.toISOString?.(),
      cycle_end: cycle.end?.toISOString?.(),
    };
    throw error;
  }

  return {
    allowed: true,
    configured: true,
    enforcementActive: economic.hardStop,
    level: economic.level,
    planCode: policy?.plan_code || null,
    budgetUsd: economic.budgetUsd,
    usedUsd: economic.usedUsd,
    usedPct: economic.usedPct,
    remainingUsd: economic.remainingUsd,
  };
}

export async function recordExternalAIUsage({
  pool: suppliedPool = null,
  userId = null,
  authorId = null,
  operationCode,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0,
  totalTokens = null,
  audioSeconds = 0,
  entityType = null,
  entityId = null,
  requestKey = null,
  status = "SUCCEEDED",
  metadata = null,
} = {}) {
  if (!operationCode || !model) return { recorded: false, reason: "operation/model missing" };
  try {
    const pool = suppliedPool || await getPool();
    if (!(await objectExists(pool, "dbo.ai_usage_ledger"))) {
      return { recorded: false, reason: "migration_not_applied" };
    }
    const effectiveUserId = await resolveUserId(pool, userId, authorId);
    const rate = await getRate(pool, model);
    const costUsd = calculateCost(rate, { inputTokens, outputTokens, cachedInputTokens, audioSeconds });
    const effectiveTotal = totalTokens == null ? n(inputTokens) + n(outputTokens) : n(totalTokens);

    const r = await pool.request()
      .input("user_id", sql.BigInt, effectiveUserId)
      .input("author_id", sql.BigInt, Number.isFinite(Number(authorId)) ? Number(authorId) : null)
      .input("operation_code", sql.VarChar(80), text(operationCode, 80))
      .input("provider", sql.VarChar(30), PROVIDER)
      .input("model", sql.VarChar(120), text(model, 120))
      .input("input_tokens", sql.BigInt, Math.max(0, Math.round(n(inputTokens))))
      .input("cached_input_tokens", sql.BigInt, Math.max(0, Math.round(n(cachedInputTokens))))
      .input("output_tokens", sql.BigInt, Math.max(0, Math.round(n(outputTokens))))
      .input("total_tokens", sql.BigInt, Math.max(0, Math.round(effectiveTotal)))
      .input("audio_seconds", sql.Decimal(18, 3), Math.max(0, n(audioSeconds)))
      .input("cost_usd", sql.Decimal(18, 8), costUsd == null ? null : costUsd)
      .input("entity_type", sql.VarChar(40), text(entityType, 40))
      .input("entity_id", sql.BigInt, Number.isFinite(Number(entityId)) ? Number(entityId) : null)
      .input("request_key", sql.VarChar(160), text(requestKey, 160))
      .input("status", sql.VarChar(20), text(status, 20) || "SUCCEEDED")
      .input("metadata_json", sql.NVarChar(sql.MAX), json(metadata))
      .query(`
        INSERT INTO dbo.ai_usage_ledger
        (user_id, author_id, operation_code, provider, model,
         input_tokens, cached_input_tokens, output_tokens, total_tokens, audio_seconds,
         cost_usd, entity_type, entity_id, request_key, status, metadata_json, occurred_at)
        OUTPUT INSERTED.ai_usage_id
        VALUES
        (@user_id, @author_id, @operation_code, @provider, @model,
         @input_tokens, @cached_input_tokens, @output_tokens, @total_tokens, @audio_seconds,
         @cost_usd, @entity_type, @entity_id, @request_key, @status, @metadata_json, SYSUTCDATETIME());
      `);
    return { recorded: true, usageId: Number(r.recordset?.[0]?.ai_usage_id), costUsd, rateFound: Boolean(rate) };
  } catch (err) {
    // Observabilidade de custo nunca pode derrubar o fluxo editorial.
    console.warn("[AI_COST] ledger write failed:", err?.message || err);
    return { recorded: false, reason: err?.message || "ledger_write_failed" };
  }
}

export async function getAIUsageSummary({ pool: suppliedPool = null, userId, limit = 40 } = {}) {
  const pool = suppliedPool || await getPool();
  if (!(await objectExists(pool, "dbo.ai_usage_ledger"))) {
    return {
      configured: false,
      summary: {
        calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, audio_seconds: 0,
        unpriced_calls: 0, monthly_budget_usd: null, remaining_budget_usd: null,
        used_budget_pct: null, level: "UNCONFIGURED", blocked: false,
      },
      operations: [], recent: []
    };
  }

  const policyContext = await getPolicyContext(pool, Number(userId));
  const cycle = policyContext.cycle;
  const summaryResult = await pool.request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("cycle_start", sql.DateTime2, cycle.start)
    .input("cycle_end", sql.DateTime2, cycle.end)
    .query(`
      SELECT COUNT_BIG(*) calls,
             COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 0 ELSE cost_usd END),0) cost_usd,
             COALESCE(SUM(input_tokens),0) input_tokens,
             COALESCE(SUM(output_tokens),0) output_tokens,
             COALESCE(SUM(audio_seconds),0) audio_seconds,
             COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END),0) unpriced_calls
      FROM dbo.ai_usage_ledger
      WHERE user_id=@user_id AND status='SUCCEEDED'
        AND occurred_at >= @cycle_start AND occurred_at < @cycle_end;

      SELECT operation_code, COUNT_BIG(*) calls,
             COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 0 ELSE cost_usd END),0) cost_usd,
             COALESCE(SUM(input_tokens),0) input_tokens,
             COALESCE(SUM(output_tokens),0) output_tokens,
             COALESCE(SUM(audio_seconds),0) audio_seconds,
             COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END),0) unpriced_calls
      FROM dbo.ai_usage_ledger
      WHERE user_id=@user_id AND status='SUCCEEDED'
        AND occurred_at >= @cycle_start AND occurred_at < @cycle_end
      GROUP BY operation_code
      ORDER BY cost_usd DESC, calls DESC;
    `);

  const recentResult = await pool.request()
    .input("user_id", sql.BigInt, Number(userId))
    .input("limit", sql.Int, Math.min(100, Math.max(1, Number(limit) || 40)))
    .query(`
      SELECT TOP (@limit) ai_usage_id, operation_code, provider, model, input_tokens,
             cached_input_tokens, output_tokens, total_tokens, audio_seconds, cost_usd,
             entity_type, entity_id, status, occurred_at
      FROM dbo.ai_usage_ledger
      WHERE user_id=@user_id
      ORDER BY occurred_at DESC, ai_usage_id DESC;
    `);

  const row = summaryResult.recordsets?.[0]?.[0] || {};
  const economic = buildEconomicState(policyContext.policy, n(row.cost_usd));

  return {
    configured: true,
    summary: {
      calls: n(row.calls),
      cost_usd: economic.usedUsd,
      input_tokens: n(row.input_tokens),
      output_tokens: n(row.output_tokens),
      audio_seconds: n(row.audio_seconds),
      unpriced_calls: n(row.unpriced_calls),
      monthly_budget_usd: economic.budgetUsd,
      remaining_budget_usd: economic.remainingUsd,
      overage_usd: economic.overageUsd,
      used_budget_pct: economic.usedPct,
      warning_pct: economic.warningPct,
      critical_pct: economic.criticalPct,
      block_pct: economic.blockPct,
      level: economic.level,
      hard_stop: economic.hardStop,
      allow_overage: economic.allowOverage,
      overage_mode: economic.overageMode,
      blocked: economic.blocked,
      enforcement_active: economic.budgetUsd != null && economic.budgetUsd > 0 && economic.hardStop,
      plan_code: policyContext.policy?.plan_code || null,
      plan_name: policyContext.policy?.plan_name || null,
      cycle_start: cycle.start?.toISOString?.() || null,
      cycle_end: cycle.end?.toISOString?.() || null,
    },
    operations: summaryResult.recordsets?.[1] || [],
    recent: recentResult.recordset || [],
  };
}

