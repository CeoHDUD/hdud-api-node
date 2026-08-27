// HDUD Admin — Implementação 07A | AI Ledger — Read Only
// Observabilidade administrativa do consumo externo de IA.
// Fonte da verdade: dbo.ai_usage_ledger. Nenhuma mutação/recalculo histórico neste módulo.

import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireAdminPermission } from "../middleware/adminAuthorization.js";
import { getPool, sql } from "../db.js";
import { writeAdminAuditSafe } from "../services/adminAuditService.js";

const router = Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

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

function normalizeExactString(value, maxLength) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function parseIsoDate(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function parseMetadata(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return { _raw: String(value) };
  }
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validateListQuery(query) {
  const details = [];

  const page = query.page == null || query.page === "" ? 1 : asPositiveInt(query.page);
  if (!page) details.push({ field: "page", issue: "must_be_positive_integer" });

  const pageSizeRaw = query.page_size == null || query.page_size === ""
    ? DEFAULT_PAGE_SIZE
    : asPositiveInt(query.page_size);
  const pageSize = pageSizeRaw && pageSizeRaw <= MAX_PAGE_SIZE ? pageSizeRaw : null;
  if (!pageSize) details.push({ field: "page_size", issue: "must_be_between_1_and_100" });

  const occurredFrom = parseIsoDate(query.occurred_from);
  const occurredTo = parseIsoDate(query.occurred_to);
  if (occurredFrom === undefined) details.push({ field: "occurred_from", issue: "invalid_iso8601" });
  if (occurredTo === undefined) details.push({ field: "occurred_to", issue: "invalid_iso8601" });
  if (occurredFrom && occurredTo && occurredFrom > occurredTo) {
    details.push({ field: "occurred_from", issue: "must_not_be_after_occurred_to" });
  }

  const operationCode = normalizeExactString(query.operation_code, 80);
  const provider = normalizeExactString(query.provider, 30);
  const model = normalizeExactString(query.model, 120);
  const status = normalizeExactString(query.status, 20);

  for (const [field, value] of [
    ["operation_code", operationCode],
    ["provider", provider],
    ["model", model],
    ["status", status],
  ]) {
    if (value === undefined) details.push({ field, issue: "invalid_string" });
  }

  const userId = query.user_id == null || query.user_id === "" ? null : asPositiveInt(query.user_id);
  const authorId = query.author_id == null || query.author_id === "" ? null : asPositiveInt(query.author_id);
  if (query.user_id != null && query.user_id !== "" && !userId) {
    details.push({ field: "user_id", issue: "must_be_positive_integer" });
  }
  if (query.author_id != null && query.author_id !== "" && !authorId) {
    details.push({ field: "author_id", issue: "must_be_positive_integer" });
  }

  if (details.length) return { error: details };

  return {
    page,
    pageSize,
    occurredFrom,
    occurredTo,
    operationCode,
    provider,
    model,
    status,
    userId,
    authorId,
  };
}

function buildLedgerWhere(request, filters) {
  const where = [];

  if (filters.occurredFrom) {
    request.input("occurred_from", sql.DateTime2, filters.occurredFrom);
    where.push("l.occurred_at >= @occurred_from");
  }
  if (filters.occurredTo) {
    request.input("occurred_to", sql.DateTime2, filters.occurredTo);
    where.push("l.occurred_at <= @occurred_to");
  }
  if (filters.operationCode) {
    request.input("operation_code", sql.VarChar(80), filters.operationCode);
    where.push("l.operation_code = @operation_code");
  }
  if (filters.provider) {
    request.input("provider", sql.VarChar(30), filters.provider);
    where.push("l.provider = @provider");
  }
  if (filters.model) {
    request.input("model", sql.VarChar(120), filters.model);
    where.push("l.model = @model");
  }
  if (filters.status) {
    request.input("status", sql.VarChar(20), filters.status);
    where.push("l.status = @status");
  }
  if (filters.userId) {
    request.input("user_id", sql.BigInt, filters.userId);
    where.push("l.user_id = @user_id");
  }
  if (filters.authorId) {
    request.input("author_id", sql.BigInt, filters.authorId);
    where.push("l.author_id = @author_id");
  }

  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

function publicFilters(filters) {
  return {
    occurred_from: filters.occurredFrom?.toISOString?.() || null,
    occurred_to: filters.occurredTo?.toISOString?.() || null,
    operation_code: filters.operationCode || null,
    provider: filters.provider || null,
    model: filters.model || null,
    status: filters.status || null,
    user_id: filters.userId || null,
    author_id: filters.authorId || null,
  };
}

async function auditSensitiveQuery(pool, req, filters, resultCode = "SUCCESS") {
  const targetType = filters.userId ? "IDENTITY_USER" : "IDENTITY_AUTHOR";
  const targetId = filters.userId || filters.authorId;
  return writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: actorLabel(req),
    eventCode: "ADMIN_AI_LEDGER_SUBJECT_QUERY",
    resourceCode: "AI_LEDGER",
    actionCode: "READ",
    resultCode,
    targetType,
    targetId: String(targetId),
    metadata: { filters: publicFilters(filters) },
  });
}

async function auditDetail(pool, req, aiUsageId, resultCode = "SUCCESS") {
  return writeAdminAuditSafe(pool, req, {
    actorUserId: actorUserId(req),
    actorLabel: actorLabel(req),
    eventCode: "ADMIN_AI_LEDGER_DETAIL_READ",
    resourceCode: "AI_LEDGER",
    actionCode: "READ",
    resultCode,
    targetType: "AI_USAGE",
    targetId: String(aiUsageId),
    metadata: { ai_usage_id: aiUsageId },
  });
}

// GET /api/admin/ai-ledger
router.get(
  "/ai-ledger",
  authRequired,
  requireAdminPermission("AI_LEDGER_READ"),
  async (req, res) => {
    const validated = validateListQuery(req.query || {});
    if (validated.error) {
      return res.status(400).json({
        error: "Parâmetros de consulta inválidos.",
        code: "INVALID_AI_LEDGER_FILTER",
        details: validated.error,
      });
    }

    const filters = validated;
    const pool = await getPool();

    try {
      const aggregateRequest = pool.request();
      const aggregateWhere = buildLedgerWhere(aggregateRequest, filters);
      const aggregateResult = await aggregateRequest.query(`
        SELECT
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(l.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(l.cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
          COALESCE(SUM(l.audio_seconds), 0) AS audio_seconds,
          COALESCE(SUM(l.cost_usd), 0) AS cost_usd
        FROM dbo.ai_usage_ledger l
        ${aggregateWhere};
      `);

      const summaryRow = aggregateResult.recordset?.[0] || {};
      const totalItems = numberOrZero(summaryRow.calls);
      const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filters.pageSize);
      const offset = (filters.page - 1) * filters.pageSize;

      const listRequest = pool.request()
        .input("offset", sql.Int, offset)
        .input("page_size", sql.Int, filters.pageSize);
      const listWhere = buildLedgerWhere(listRequest, filters);
      const listResult = await listRequest.query(`
        SELECT
          l.ai_usage_id,
          l.occurred_at,
          l.status,
          l.user_id,
          l.author_id,
          l.operation_code,
          l.provider,
          l.model,
          l.input_tokens,
          l.cached_input_tokens,
          l.output_tokens,
          l.total_tokens,
          l.audio_seconds,
          l.cost_usd,
          l.entity_type,
          l.entity_id,
          l.request_key
        FROM dbo.ai_usage_ledger l
        ${listWhere}
        ORDER BY l.occurred_at DESC, l.ai_usage_id DESC
        OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
      `);

      if (filters.userId || filters.authorId) {
        await auditSensitiveQuery(pool, req, filters, "SUCCESS");
      }

      return res.json({
        ok: true,
        pagination: {
          page: filters.page,
          page_size: filters.pageSize,
          total_items: totalItems,
          total_pages: totalPages,
        },
        filters: publicFilters(filters),
        summary: {
          calls: totalItems,
          input_tokens: numberOrZero(summaryRow.input_tokens),
          cached_input_tokens: numberOrZero(summaryRow.cached_input_tokens),
          output_tokens: numberOrZero(summaryRow.output_tokens),
          total_tokens: numberOrZero(summaryRow.total_tokens),
          audio_seconds: numberOrZero(summaryRow.audio_seconds),
          cost_usd: numberOrZero(summaryRow.cost_usd),
        },
        items: (listResult.recordset || []).map((row) => ({
          ai_usage_id: Number(row.ai_usage_id),
          occurred_at: row.occurred_at,
          status: row.status,
          user_id: nullableNumber(row.user_id),
          author_id: nullableNumber(row.author_id),
          operation_code: row.operation_code,
          provider: row.provider,
          model: row.model,
          input_tokens: numberOrZero(row.input_tokens),
          cached_input_tokens: numberOrZero(row.cached_input_tokens),
          output_tokens: numberOrZero(row.output_tokens),
          total_tokens: numberOrZero(row.total_tokens),
          audio_seconds: numberOrZero(row.audio_seconds),
          cost_usd: nullableNumber(row.cost_usd),
          entity_type: row.entity_type,
          entity_id: nullableNumber(row.entity_id),
          request_key: row.request_key,
        })),
      });
    } catch (err) {
      console.error("[GET /api/admin/ai-ledger] erro:", err);
      return res.status(500).json({
        error: "Erro ao consultar AI Ledger.",
        code: "AI_LEDGER_QUERY_FAILED",
      });
    }
  }
);

// GET /api/admin/ai-ledger/analytics
// Agregações FinOps read-only sobre a mesma fonte da verdade do Ledger.
router.get(
  "/ai-ledger/analytics",
  authRequired,
  requireAdminPermission("AI_LEDGER_READ"),
  async (req, res) => {
    const validated = validateListQuery({ ...(req.query || {}), page: 1, page_size: 1 });
    if (validated.error) {
      return res.status(400).json({
        error: "Parâmetros de consulta inválidos.",
        code: "INVALID_AI_LEDGER_ANALYTICS_FILTER",
        details: validated.error.filter((d) => d.field !== "page" && d.field !== "page_size"),
      });
    }

    const filters = validated;
    const pool = await getPool();

    try {
      const summaryRequest = pool.request();
      const summaryWhere = buildLedgerWhere(summaryRequest, filters);
      const summaryResult = await summaryRequest.query(`
        SELECT
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(l.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(l.cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
          COALESCE(SUM(l.audio_seconds), 0) AS audio_seconds,
          COALESCE(SUM(l.cost_usd), 0) AS cost_usd,
          SUM(CASE WHEN l.cost_usd IS NULL THEN 1 ELSE 0 END) AS events_without_cost,
          SUM(CASE WHEN l.user_id IS NULL THEN 1 ELSE 0 END) AS events_without_user,
          SUM(CASE WHEN l.author_id IS NULL THEN 1 ELSE 0 END) AS events_without_author,
          SUM(CASE WHEN l.entity_type IS NULL OR l.entity_id IS NULL THEN 1 ELSE 0 END) AS events_without_entity,
          SUM(CASE WHEN l.request_key IS NULL THEN 1 ELSE 0 END) AS events_without_request_key,
          SUM(CASE WHEN l.metadata_json IS NULL THEN 1 ELSE 0 END) AS events_without_metadata,
          MIN(l.occurred_at) AS first_event,
          MAX(l.occurred_at) AS last_event
        FROM dbo.ai_usage_ledger l
        ${summaryWhere};
      `);

      const timelineRequest = pool.request();
      const timelineWhere = buildLedgerWhere(timelineRequest, filters);
      const timelineResult = await timelineRequest.query(`
        SELECT
          CONVERT(date, l.occurred_at) AS bucket_date,
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
          COALESCE(SUM(l.audio_seconds), 0) AS audio_seconds,
          COALESCE(SUM(l.cost_usd), 0) AS cost_usd
        FROM dbo.ai_usage_ledger l
        ${timelineWhere}
        GROUP BY CONVERT(date, l.occurred_at)
        ORDER BY bucket_date ASC;
      `);

      const operationRequest = pool.request();
      const operationWhere = buildLedgerWhere(operationRequest, filters);
      const operationResult = await operationRequest.query(`
        SELECT
          l.operation_code,
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
          COALESCE(SUM(l.audio_seconds), 0) AS audio_seconds,
          COALESCE(SUM(l.cost_usd), 0) AS cost_usd
        FROM dbo.ai_usage_ledger l
        ${operationWhere}
        GROUP BY l.operation_code
        ORDER BY cost_usd DESC, calls DESC, l.operation_code ASC;
      `);

      const modelRequest = pool.request();
      const modelWhere = buildLedgerWhere(modelRequest, filters);
      const modelResult = await modelRequest.query(`
        SELECT
          l.provider,
          l.model,
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
          COALESCE(SUM(l.audio_seconds), 0) AS audio_seconds,
          COALESCE(SUM(l.cost_usd), 0) AS cost_usd
        FROM dbo.ai_usage_ledger l
        ${modelWhere}
        GROUP BY l.provider, l.model
        ORDER BY cost_usd DESC, calls DESC, l.provider ASC, l.model ASC;
      `);

      const authorRequest = pool.request();
      const authorWhere = buildLedgerWhere(authorRequest, filters);
      const authorResult = await authorRequest.query(`
        SELECT TOP (50)
          l.author_id,
          a.full_name AS author_name,
          a.author_code,
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
          COALESCE(SUM(l.audio_seconds), 0) AS audio_seconds,
          COALESCE(SUM(l.cost_usd), 0) AS cost_usd
        FROM dbo.ai_usage_ledger l
        LEFT JOIN dbo.identity_author a ON a.author_id = l.author_id
        ${authorWhere}
        GROUP BY l.author_id, a.full_name, a.author_code
        ORDER BY cost_usd DESC, calls DESC, l.author_id ASC;
      `);

      const userRequest = pool.request();
      const userWhere = buildLedgerWhere(userRequest, filters);
      const userResult = await userRequest.query(`
        SELECT TOP (50)
          l.user_id,
          u.email AS user_email,
          u.full_name AS user_full_name,
          COUNT_BIG(*) AS calls,
          COALESCE(SUM(l.total_tokens), 0) AS total_tokens,
          COALESCE(SUM(l.audio_seconds), 0) AS audio_seconds,
          COALESCE(SUM(l.cost_usd), 0) AS cost_usd
        FROM dbo.ai_usage_ledger l
        LEFT JOIN dbo.identity_user u ON u.user_id = l.user_id
        ${userWhere}
        GROUP BY l.user_id, u.email, u.full_name
        ORDER BY cost_usd DESC, calls DESC, l.user_id ASC;
      `);

      const pricingRequest = pool.request();
      const pricingWhere = buildLedgerWhere(pricingRequest, filters);
      const pricingResult = await pricingRequest.query(`
        SELECT COUNT_BIG(*) AS events_without_compatible_rate
        FROM dbo.ai_usage_ledger l
        ${pricingWhere}
        ${pricingWhere ? "AND" : "WHERE"} NOT EXISTS (
          SELECT 1
          FROM dbo.ai_cost_model_rate r
          WHERE r.provider = l.provider
            AND (l.model = r.model OR l.model LIKE r.model + '-%')
            AND r.active_from <= l.occurred_at
            AND (r.active_until IS NULL OR r.active_until > l.occurred_at)
        );
      `);

      if (filters.userId || filters.authorId) {
        await auditSensitiveQuery(pool, req, filters, "SUCCESS");
      }

      const row = summaryResult.recordset?.[0] || {};
      const calls = numberOrZero(row.calls);
      const costUsd = numberOrZero(row.cost_usd);

      const mapAgg = (r) => ({
        calls: numberOrZero(r.calls),
        total_tokens: numberOrZero(r.total_tokens),
        audio_seconds: numberOrZero(r.audio_seconds),
        cost_usd: numberOrZero(r.cost_usd),
      });

      return res.json({
        ok: true,
        filters: publicFilters(filters),
        summary: {
          calls,
          input_tokens: numberOrZero(row.input_tokens),
          cached_input_tokens: numberOrZero(row.cached_input_tokens),
          output_tokens: numberOrZero(row.output_tokens),
          total_tokens: numberOrZero(row.total_tokens),
          audio_seconds: numberOrZero(row.audio_seconds),
          cost_usd: costUsd,
          average_cost_usd_per_call: calls > 0 ? costUsd / calls : 0,
          first_event: row.first_event || null,
          last_event: row.last_event || null,
        },
        integrity: {
          events_without_cost: numberOrZero(row.events_without_cost),
          events_without_compatible_rate: numberOrZero(pricingResult.recordset?.[0]?.events_without_compatible_rate),
          events_without_user: numberOrZero(row.events_without_user),
          events_without_author: numberOrZero(row.events_without_author),
          events_without_entity: numberOrZero(row.events_without_entity),
          events_without_request_key: numberOrZero(row.events_without_request_key),
          events_without_metadata: numberOrZero(row.events_without_metadata),
        },
        timeline: (timelineResult.recordset || []).map((r) => ({
          date: r.bucket_date,
          ...mapAgg(r),
        })),
        by_operation: (operationResult.recordset || []).map((r) => ({
          operation_code: r.operation_code,
          ...mapAgg(r),
        })),
        by_provider_model: (modelResult.recordset || []).map((r) => ({
          provider: r.provider,
          model: r.model,
          ...mapAgg(r),
        })),
        by_author: (authorResult.recordset || []).map((r) => ({
          author_id: nullableNumber(r.author_id),
          author_name: r.author_name || null,
          author_code: r.author_code || null,
          ...mapAgg(r),
        })),
        by_user: (userResult.recordset || []).map((r) => ({
          user_id: nullableNumber(r.user_id),
          email: r.user_email || null,
          full_name: r.user_full_name || null,
          ...mapAgg(r),
        })),
      });
    } catch (err) {
      console.error("[GET /api/admin/ai-ledger/analytics] erro:", err);
      return res.status(500).json({
        error: "Erro ao consultar analytics do AI Ledger.",
        code: "AI_LEDGER_ANALYTICS_FAILED",
      });
    }
  }
);

// GET /api/admin/ai-ledger/rate-card
router.get(
  "/ai-ledger/rate-card",
  authRequired,
  requireAdminPermission("AI_LEDGER_READ"),
  async (_req, res) => {
    const pool = await getPool();
    try {
      const result = await pool.request().query(`
        SELECT
          model_rate_id,
          provider,
          model,
          input_usd_per_1m_tokens,
          cached_input_usd_per_1m_tokens,
          output_usd_per_1m_tokens,
          audio_usd_per_minute,
          active_from,
          active_until,
          source_note,
          created_at
        FROM dbo.ai_cost_model_rate
        ORDER BY provider ASC, model ASC, active_from DESC, model_rate_id DESC;
      `);

      return res.json({
        ok: true,
        read_only: true,
        items: (result.recordset || []).map((row) => ({
          model_rate_id: Number(row.model_rate_id),
          provider: row.provider,
          model: row.model,
          input_usd_per_1m_tokens: nullableNumber(row.input_usd_per_1m_tokens),
          cached_input_usd_per_1m_tokens: nullableNumber(row.cached_input_usd_per_1m_tokens),
          output_usd_per_1m_tokens: nullableNumber(row.output_usd_per_1m_tokens),
          audio_usd_per_minute: nullableNumber(row.audio_usd_per_minute),
          active_from: row.active_from,
          active_until: row.active_until || null,
          source_note: row.source_note || null,
          created_at: row.created_at,
        })),
      });
    } catch (err) {
      console.error("[GET /api/admin/ai-ledger/rate-card] erro:", err);
      return res.status(500).json({
        error: "Erro ao consultar Rate Card de IA.",
        code: "AI_RATE_CARD_QUERY_FAILED",
      });
    }
  }
);

// GET /api/admin/ai-ledger/:ai_usage_id
router.get(
  "/ai-ledger/:ai_usage_id",
  authRequired,
  requireAdminPermission("AI_LEDGER_READ"),
  async (req, res) => {
    const aiUsageId = asPositiveInt(req.params.ai_usage_id);
    if (!aiUsageId) {
      return res.status(400).json({
        error: "ai_usage_id inválido.",
        code: "INVALID_AI_USAGE_ID",
      });
    }

    const pool = await getPool();

    try {
      const result = await pool.request()
        .input("ai_usage_id", sql.BigInt, aiUsageId)
        .query(`
          SELECT TOP (1)
            l.ai_usage_id,
            l.occurred_at,
            l.status,
            l.user_id,
            u.email AS user_email,
            u.full_name AS user_full_name,
            l.author_id,
            a.full_name AS author_full_name,
            a.author_code,
            l.operation_code,
            l.provider,
            l.model,
            l.input_tokens,
            l.cached_input_tokens,
            l.output_tokens,
            l.total_tokens,
            l.audio_seconds,
            l.cost_usd,
            l.entity_type,
            l.entity_id,
            l.request_key,
            l.metadata_json
          FROM dbo.ai_usage_ledger l
          LEFT JOIN dbo.identity_user u
            ON u.user_id = l.user_id
          LEFT JOIN dbo.identity_author a
            ON a.author_id = l.author_id
          WHERE l.ai_usage_id = @ai_usage_id;

          SELECT TOP (1)
            p.proposal_id
          FROM dbo.identity_memory_ai_proposal p
          WHERE p.primary_ai_usage_id = @ai_usage_id
             OR EXISTS (
               SELECT 1
               FROM dbo.identity_memory_ai_proposal_usage pu
               WHERE pu.proposal_id = p.proposal_id
                 AND pu.ai_usage_id = @ai_usage_id
             )
          ORDER BY CASE WHEN p.primary_ai_usage_id = @ai_usage_id THEN 0 ELSE 1 END,
                   p.proposal_id DESC;

          SELECT TOP (1)
            g.generation_id
          FROM dbo.identity_chapter_generation g
          WHERE g.ai_usage_id = @ai_usage_id
          ORDER BY g.generation_id DESC;
        `);

      const row = result.recordsets?.[0]?.[0] || null;
      if (!row) {
        await auditDetail(pool, req, aiUsageId, "NOT_FOUND");
        return res.status(404).json({
          error: "Registro do AI Ledger não encontrado.",
          code: "AI_LEDGER_NOT_FOUND",
        });
      }

      const proposal = result.recordsets?.[1]?.[0] || null;
      const chapterGeneration = result.recordsets?.[2]?.[0] || null;

      await auditDetail(pool, req, aiUsageId, "SUCCESS");

      return res.json({
        ok: true,
        item: {
          ai_usage_id: Number(row.ai_usage_id),
          occurred_at: row.occurred_at,
          status: row.status,
          user: row.user_id == null ? null : {
            user_id: Number(row.user_id),
            email: row.user_email || null,
            full_name: row.user_full_name || null,
          },
          author: row.author_id == null ? null : {
            author_id: Number(row.author_id),
            name: row.author_full_name || null,
            author_code: row.author_code || null,
          },
          operation: {
            operation_code: row.operation_code,
            provider: row.provider,
            model: row.model,
          },
          usage: {
            input_tokens: numberOrZero(row.input_tokens),
            cached_input_tokens: numberOrZero(row.cached_input_tokens),
            output_tokens: numberOrZero(row.output_tokens),
            total_tokens: numberOrZero(row.total_tokens),
            audio_seconds: numberOrZero(row.audio_seconds),
          },
          economic: {
            cost_usd: nullableNumber(row.cost_usd),
          },
          correlation: {
            entity_type: row.entity_type,
            entity_id: nullableNumber(row.entity_id),
            request_key: row.request_key,
          },
          metadata: parseMetadata(row.metadata_json),
          related: {
            memory_ai_proposal: proposal ? { proposal_id: Number(proposal.proposal_id) } : null,
            chapter_generation: chapterGeneration
              ? { generation_id: Number(chapterGeneration.generation_id) }
              : null,
          },
        },
      });
    } catch (err) {
      console.error("[GET /api/admin/ai-ledger/:ai_usage_id] erro:", err);
      return res.status(500).json({
        error: "Erro ao consultar registro do AI Ledger.",
        code: "AI_LEDGER_DETAIL_FAILED",
      });
    }
  }
);

export default router;
