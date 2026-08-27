// C:\HDUD_DATA\hdud-api-node\src\routes\stories.js
//
// GO LIVE 005.1 — Story Materialization Engine
// Story Discovery entrega Blueprint. A escrita só acontece depois da pergunta humana e da maturidade narrativa.

import express from "express";
import { authRequired } from "../middleware/auth.js";
import { getPool, sql } from "../db.js";
import {
  acceptNarrativeStory,
  discardNarrativeStory,
  discoverAndPersistStoriesForAuthor,
  listAuthorActiveStories,
  snoozeNarrativeStory,
} from "../services/story/story-lifecycle.service.js";
import { generateStoryEditorialDraft } from "../services/story/story-generation.service.js";
import { discoverStoryHypothesesForAuthor } from "../services/story/story-discovery-orchestrator.service.js";
import { saveApprovedStory } from "../services/story/story-editorial.service.js";
import { buildStoryPublicationStatus, publishStoryIfReady } from "../services/stories/story-publication-pipeline.service.js";
import { buildChapterCandidatesForAuthor, listPersistedChapterCandidates } from "../services/stories/chapter-candidate-engine.service.js";
import {
  checkPlanFeature,
  checkNarrativeAiGenerationQuota,
  reservePlanQuota,
  reserveNarrativeAiGenerationQuota,
  commitPlanQuotaReservation,
  releasePlanQuotaReservation,
  sendPlanDenied,
} from "../services/plan-enforcement.service.js";

const router = express.Router();
const DEFAULT_VISIBLE_CANDIDATES = 3;
const MAX_LIST_LIMIT = 200;

function ensureAuthorId(req, res) {
  const authorId = req?.user?.author_id;
  if (!authorId) {
    res.status(401).json({ error: "Não autenticado." });
    return null;
  }
  return Number(authorId);
}

function resolveAuthenticatedUserId(req) {
  const value = Number(
    req?.user?.user_id ??
    req?.user?.userId ??
    req?.user?.id ??
    req?.user?.uid ??
    req?.user?.sub
  );
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function hasPriorStoryAiGeneration({ pool, authorId, storyId }) {
  const sid = toPositiveInt(storyId);
  if (!sid) return false;

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, Number(authorId))
    .input("story_id", sql.BigInt, sid)
    .query(`
      SELECT TOP (1) 1 AS has_prior_ai_generation
      FROM dbo.ai_usage_ledger
      WHERE author_id = @author_id
        AND operation_code = 'STORY_GENERATION'
        AND entity_type = 'STORY'
        AND entity_id = @story_id
        AND status = 'SUCCEEDED'
      ORDER BY occurred_at DESC, ai_usage_id DESC;
    `);

  return Number(result?.recordset?.[0]?.has_prior_ai_generation || 0) === 1;
}

async function resolveStoryEconomicOperation({ pool, userId, authorId, storyId }) {
  // Fonte de verdade econômica:
  // somente uma geração IA anterior comprovada no ledger transforma
  // a próxima operação em Regeneração. Resumo/conteúdo de descoberta
  // NÃO significa manuscrito IA já gerado.
  const hasLedgerGeneration = await hasPriorStoryAiGeneration({ pool, authorId, storyId });
  const isRegeneration = hasLedgerGeneration;
  const featureCode = isRegeneration
    ? "AI_REGENERATION_COUNT"
    : "STORY_AI_GENERATION_COUNT";

  const planCheck = isRegeneration
    ? await checkPlanFeature({ pool, userId, featureCode, requestedValue: 1 })
    : await checkNarrativeAiGenerationQuota({ pool, userId, requestedValue: 1 });

  return {
    isRegeneration,
    featureCode,
    planCheck,
  };
}

async function reserveStoryEconomicOperation({
  pool,
  userId,
  authorId,
  storyId,
  economic,
  source,
}) {
  const metadata = {
    author_id: authorId,
    source,
    economic_operation: economic.isRegeneration
      ? "REGENERATION"
      : "STORY_AI_GENERATION",
  };

  if (economic.isRegeneration) {
    return reservePlanQuota({
      pool,
      userId,
      featureCode: "AI_REGENERATION_COUNT",
      reserveValue: 1,
      entityType: "STORY",
      entityId: storyId,
      metadata,
    });
  }

  return reserveNarrativeAiGenerationQuota({
    pool,
    userId,
    targetFeatureCode: "STORY_AI_GENERATION_COUNT",
    reserveValue: 1,
    entityType: "STORY",
    entityId: storyId,
    metadata,
  });
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toBoolean(value) {
  return ["1", "true", "yes", "sim", "s"].includes(String(value || "").trim().toLowerCase());
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : fallback;
}

function makeExcerpt(value, max = 220) {
  const text = safeText(value, "");
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 1) return Math.max(0, Math.min(100, Math.round(n * 100)));
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeStoryList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.stories)) return payload.stories;
  if (Array.isArray(payload?.candidates)) return payload.candidates;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function storyIdFromUrl(value) {
  const text = safeText(value, "");
  if (!text) return null;
  const match = text.match(/\/stories\/(\d+)(?:\/|$)/i) || text.match(/\/api\/stories\/(\d+)(?:\/|$)/i);
  return match ? toPositiveInt(match[1]) : null;
}

function normalizeStoryId(row) {
  const direct = toPositiveInt(
    row?.story_id ??
    row?.id ??
    row?.narrative_story_id ??
    row?.candidate_id ??
    row?.story_candidate_id ??
    row?.persisted_story_id ??
    row?.source_story_id
  );
  if (direct) return direct;

  const nestedSources = [
    row?.story,
    row?.candidate,
    row?.narrative_story,
    row?.payload,
    row?.data,
    row?.result,
  ];

  for (const source of nestedSources) {
    const nested = toPositiveInt(
      source?.story_id ??
      source?.id ??
      source?.narrative_story_id ??
      source?.candidate_id ??
      source?.story_candidate_id ??
      source?.persisted_story_id ??
      source?.source_story_id
    );
    if (nested) return nested;
  }

  const actionUrls = [
    row?.actions?.editorial_url,
    row?.actions?.explore_url,
    row?.actions?.generate_url,
    row?.editorial_url,
  ];

  for (const url of actionUrls) {
    const parsed = storyIdFromUrl(url);
    if (parsed) return parsed;
  }

  return null;
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeYear(value) {
  const date = safeDate(value);
  if (date) return date.getUTCFullYear();
  const text = String(value || "").trim();
  const match = text.match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2}|2200)\b/);
  return match ? Number(match[1]) : null;
}

function extractStoryMemories(story) {
  const direct = story?.memories || story?.related_memories || story?.memory_items || story?.evidence || story?.items;
  return Array.isArray(direct) ? direct : [];
}

function normalizeMemoryRow(row) {
  const memoryId = toPositiveInt(row?.memory_id ?? row?.id ?? row?.memoryId);
  if (!memoryId) return null;

  const memoryDate = row?.memory_date || row?.narrative_date || row?.event_date || row?.created_at || row?.published_at || null;
  const year = safeYear(memoryDate);

  const content = row?.content || row?.memory_content || row?.description || "";

  return {
    memory_id: memoryId,
    title: safeText(row?.title || row?.memory_title || row?.name, `Memória ${memoryId}`),
    content,
    excerpt: makeExcerpt(row?.summary || row?.excerpt || content),
    memory_date: memoryDate,
    created_at: row?.created_at || null,
    year,
    media_id: toPositiveInt(row?.media_id),
    image_storage_path: safeText(row?.image_storage_path || row?.storage_path, null),
    image_url: safeText(row?.image_url || row?.photo_url || row?.cover_url || row?.media_url, null),
  };
}

function confidenceLevel(confidence) {
  const score = normalizeConfidence(confidence) ?? 0;
  if (score >= 95) return { code: "MATURE", label: "História madura" };
  if (score >= 80) return { code: "VERY_STRONG", label: "História muito forte" };
  if (score >= 65) return { code: "CONSISTENT", label: "História consistente" };
  if (score >= 45) return { code: "EMERGING", label: "História emergindo" };
  return { code: "INSUFFICIENT", label: "Sinais iniciais" };
}

function storyTitle(story) {
  return safeText(story?.title || story?.suggested_title || story?.name || story?.central_theme || story?.dominant_theme, "História descoberta");
}

function storyTheme(story) {
  return safeText(story?.central_theme || story?.dominant_theme || story?.theme || story?.main_transformation, "Continuidade narrativa");
}

function storySummary(story) {
  return safeText(
    story?.one_line_summary || story?.summary || story?.description,
    "Encontramos memórias que parecem formar uma mesma história maior."
  );
}

function extractPeriod(story, memories = []) {
  const firstYear = safeYear(story?.first_year || story?.start_year || story?.started_at);
  const lastYear = safeYear(story?.last_year || story?.end_year || story?.ended_at);
  const years = (Array.isArray(memories) ? memories : [])
    .map((memory) => safeYear(memory?.memory_date || memory?.narrative_date || memory?.event_date || memory?.created_at))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const start = firstYear || years[0] || null;
  const end = lastYear || years[years.length - 1] || null;
  if (!start && !end) return null;
  if (start && end && start !== end) return { start_year: start, end_year: end, label: `${start}–${end}` };
  return { start_year: start || end, end_year: end || start, label: String(start || end) };
}

function buildTimelineFromMemories(memories) {
  const normalized = (Array.isArray(memories) ? memories : [])
    .map(normalizeMemoryRow)
    .filter(Boolean)
    .sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.memory_id - b.memory_id);

  const byYear = new Map();
  for (const memory of normalized) {
    const key = memory.year || "Sem data";
    if (!byYear.has(key)) byYear.set(key, []);
    byYear.get(key).push(memory);
  }

  return [...byYear.keys()].map((year, index, years) => {
    const group = byYear.get(year) || [];
    const isFirst = index === 0;
    const isLast = index === years.length - 1;
    const isMiddle = years.length >= 3 && index === Math.floor(years.length / 2);

    let type = "CONTINUITY";
    let title = "A história ganhou forma";
    let description = "Novas memórias começaram a reforçar esta transformação.";

    if (isFirst) {
      type = "BEGINNING";
      title = "Primeiros sinais";
      description = "Foi aqui que percebemos os primeiros sinais desta história.";
    } else if (isMiddle) {
      type = "TURNING_POINT";
      title = "Mudança importante";
      description = "Aqui encontramos um momento que mudou a direção desta história.";
    } else if (isLast) {
      type = "MATURATION";
      title = "Maturação";
      description = "A narrativa tornou-se mais consistente neste período.";
    }

    return {
      year,
      type,
      title,
      description,
      memory_count: group.length,
      memory_ids: group.map((memory) => memory.memory_id),
      memories: group.map((memory) => ({
        memory_id: memory.memory_id,
        title: memory.title,
        excerpt: memory.excerpt || makeExcerpt(memory.content),
        memory_date: memory.memory_date,
      })),
    };
  });
}

function buildDiscoveryExplanation(story, memories = []) {
  const period = extractPeriod(story, memories);
  const count = Number(story?.memory_count || memories.length || 0);

  if (period?.label && count >= 2) {
    return `Observamos ${count} memórias conectadas ao longo de ${period.label}. A sequência temporal e o tema recorrente indicam uma narrativa com potencial para virar História.`;
  }

  return "Observamos sinais de continuidade narrativa entre estas memórias. Elas compartilham contexto, transformação e permanência emocional suficientes para serem exploradas como uma história maior.";
}

function buildEditorialOverview(story, memories = []) {
  const title = storyTitle(story);
  const theme = storyTheme(story);
  const period = extractPeriod(story, memories);

  return {
    suggested_title: title,
    central_theme: theme,
    transformation: safeText(
      story?.main_transformation || story?.transformation,
      `Uma sequência de memórias começa a se organizar em torno de ${theme.toLowerCase()}.`
    ),
    editorial_direction: `A IA Editorial deve transformar estas memórias em narrativa contínua sobre ${theme.toLowerCase()}, sem resumir, sem cortar e sem tom administrativo.`,
    period: period?.label || null,
    memory_count: memories.length,
  };
}


function buildCentralQuestion(story, memories = []) {
  const text = `${storyTitle(story)} ${storyTheme(story)} ${storySummary(story)} ${memories.map((memory) => `${memory?.title || ""} ${memory?.content || ""}`).join(" ")}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (text.includes("bruna")) return "Como conheci Bruna?";
  if (text.includes("cirurgia") || text.includes("hospital") || text.includes("dor") || text.includes("l5")) return "Como a cirurgia mudou minha vida?";
  if (text.includes("hdud") || text.includes("historias de um desconhecido")) return "Por que criei a HDUD?";
  if (text.includes("trabalho") || text.includes("profissao") || text.includes("dba") || text.includes("sql")) return "Quando descobri minha profissão?";
  if (text.includes("felipe") || text.includes("zezo") || text.includes("filho")) return "O que aprendi sendo pai?";
  if (text.includes("familia")) return "Como minha família ajudou a formar quem eu sou?";
  return "Que transformação estas memórias estão tentando revelar?";
}

function buildMissingMemoriesForBlueprint(story, memories = [], confidence = 0) {
  const missing = [];
  const normalizedMemories = memories.map(normalizeMemoryRow).filter(Boolean);
  const joined = normalizedMemories.map((memory) => `${memory.title} ${memory.content}`).join(" ").toLowerCase();

  if (normalizedMemories.length < 3) {
    missing.push({ code: "MORE_MEMORIES", label: "mais memórias", reason: "Ainda há poucas memórias para uma história humana completa." });
  }
  if (!joined.includes("famil")) {
    missing.push({ code: "FAMILY_CONTEXT", label: "contexto familiar", reason: "Pode faltar o entorno humano desta história." });
  }
  if (!joined.includes("depois") && !joined.includes("consequ") && normalizedMemories.length < 5) {
    missing.push({ code: "CONSEQUENCES", label: "consequências", reason: "Ainda não está claro o que mudou depois dos acontecimentos." });
  }
  if ((normalizeConfidence(confidence) ?? 0) < 55) {
    missing.push({ code: "EVIDENCE", label: "mais evidência narrativa", reason: "A história ainda está fraca para ser escrita com segurança." });
  }

  return missing.slice(0, 5);
}

function buildStoryBlueprint(story, memories = []) {
  if (story?.story_blueprint || story?.blueprint) return story.story_blueprint || story.blueprint;

  const normalizedMemories = memories.map(normalizeMemoryRow).filter(Boolean);
  const confidence = normalizeConfidence(story?.confidence ?? story?.confidence_score) ?? 0;
  const missing = buildMissingMemoriesForBlueprint(story, normalizedMemories, confidence);
  const used = normalizedMemories.map((memory) => ({
    memory_id: memory.memory_id,
    title: memory.title,
    memory_date: memory.memory_date,
    excerpt: memory.excerpt,
  }));
  const discarded = (Array.isArray(story?.discarded_memories) ? story.discarded_memories : [])
    .map(normalizeMemoryRow)
    .filter(Boolean)
    .map((memory) => ({ memory_id: memory.memory_id, title: memory.title, reason: "Sem aderência suficiente para esta pergunta." }));

  return {
    type: "STORY_BLUEPRINT",
    status: missing.some((item) => item.code === "EVIDENCE") || used.length < 2 ? "NEEDS_MORE_MEMORIES" : "READY_FOR_AUTHOR_REVIEW",
    title: storyTitle(story),
    provisional_title: storyTitle(story),
    central_question: safeText(story?.central_question || story?.question, buildCentralQuestion(story, normalizedMemories)),
    transformation: safeText(story?.transformation || story?.main_transformation || story?.editorial_overview?.transformation, `De memórias separadas para uma transformação reconhecível sobre ${storyTheme(story).toLowerCase()}.`),
    beginning: used[0] || null,
    conflict: used.length >= 2 ? used[Math.floor((used.length - 1) / 2)] : null,
    turning_point: used.length >= 3 ? used[Math.floor(used.length / 2)] : null,
    resolution: used.length >= 2 ? used[used.length - 1] : null,
    used_memories: used,
    discarded_memories: discarded,
    missing_memories: missing,
    confidence,
    author_decision_required: true,
    source_policy: "Blueprint primeiro. A História só deve ser escrita depois da aprovação do autor.",
  };
}

function decorateStoryCandidate(story, options = {}) {
  const memories = Array.isArray(options.memories) && options.memories.length ? options.memories : extractStoryMemories(story);
  const confidence = normalizeConfidence(story?.confidence ?? story?.confidence_score) ?? 0;
  const level = confidenceLevel(confidence);
  const period = extractPeriod(story, memories);
  const title = storyTitle(story);
  const storyId = normalizeStoryId(story);
  const blueprint = buildStoryBlueprint(story, memories);

  return {
    ...story,
    story_id: storyId,
    candidate_id: storyId,
    type: "STORY_BLUEPRINT",
    story_blueprint: blueprint,
    blueprint,
    central_question: blueprint.central_question,
    transformation: blueprint.transformation,
    missing_memories: blueprint.missing_memories,
    title,
    suggested_title: safeText(story?.suggested_title, title),
    status: story?.status || story?.story_status || "DISCOVERED",
    confidence,
    confidence_level: level,
    maturity: level,
    memory_count: Number(story?.memory_count || memories.length || 0),
    period,
    summary: storySummary(story),
    discovery_copy: buildDiscoveryExplanation(story, memories),
    why_found: buildDiscoveryExplanation(story, memories),
    editorial_overview: buildEditorialOverview(story, memories),
    blueprint_overview: {
      title: blueprint.title,
      central_question: blueprint.central_question,
      transformation: blueprint.transformation,
      missing_memories: blueprint.missing_memories,
    },
    memories: memories.map(normalizeMemoryRow).filter(Boolean),
    actions: storyId ? {
      explore_url: `/stories/${storyId}`,
      editorial_url: `/stories/${storyId}/editorial`,
      generate_url: `/api/stories/${storyId}/generate`,
      save_url: `/api/stories/${storyId}/save`,
      timeline_url: `/api/stories/${storyId}/timeline`,
      publication_status_url: `/api/stories/${storyId}/publication-status`,
      publish_to_book_url: `/api/stories/${storyId}/publication/publish`,
      accept_url: `/api/stories/${storyId}/accept`,
      discard_url: `/api/stories/${storyId}/discard`,
      snooze_url: `/api/stories/${storyId}/snooze`,
    } : {},
  };
}

function sortStoriesByMaturity(stories) {
  return [...stories].sort((a, b) => {
    const bc = normalizeConfidence(b?.confidence ?? b?.confidence_score) ?? 0;
    const ac = normalizeConfidence(a?.confidence ?? a?.confidence_score) ?? 0;
    if (bc !== ac) return bc - ac;
    return storyTitle(a).localeCompare(storyTitle(b), "pt-BR");
  });
}

function normalizeStoryExperiencePayload(result, options = {}) {
  const showAll = Boolean(options.showAll);
  const visibleLimit = toPositiveInt(options.limit) || DEFAULT_VISIBLE_CANDIDATES;
  const decorated = sortStoriesByMaturity(normalizeStoryList(result)).map((story) => decorateStoryCandidate(story));
  const visible = showAll ? decorated : decorated.slice(0, visibleLimit);

  return {
    ...(result && typeof result === "object" && !Array.isArray(result) ? result : {}),
    ok: result?.ok !== false,
    experience: "STORY_MATERIALIZATION_DISCOVERY",
    title: "Histórias",
    headline: "Sua vida está revelando perguntas humanas.",
    intro: "A HDUD encontrou perguntas que podem virar histórias. Primeiro vem o Blueprint. Depois, se o autor aprovar, vem a escrita.",
    stories: visible,
    candidates: visible,
    total_candidates: decorated.length,
    visible_candidates: visible.length,
    has_more: decorated.length > visible.length,
    more_label: decorated.length > visible.length ? "+ Ver mais" : null,
    meta: {
      ...(result?.meta || {}),
      generated_at: new Date().toISOString(),
      visible_limit: showAll ? null : visibleLimit,
      show_all: showAll,
      source_policy: "Story Experience mostra primeiro Blueprints narrativos. Nenhuma história é escrita antes da aprovação do autor.",
    },
  };
}

async function fetchStoryRelatedMemories({ pool, authorId, storyId }) {
  const result = await pool
    .request()
    .input("story_id", sql.BigInt, storyId)
    .input("author_id", sql.BigInt, authorId)
    .query(`
      SELECT DISTINCT
        m.memory_id,
        m.title,
        m.content,
        COALESCE(m.published_at, m.created_at) AS memory_date,
        m.created_at,
        media.media_id,
        media.storage_path AS image_storage_path,
        CASE WHEN media.media_id IS NULL THEN NULL ELSE '/cdn/memory-media/' + CAST(m.author_id AS varchar(20)) + '/' + CAST(m.memory_id AS varchar(20)) + '/' + CAST(media.media_id AS varchar(20)) + '/feed' END AS image_url
      FROM dbo.identity_narrative_story_memory sm
      INNER JOIN dbo.identity_memory m
        ON m.memory_id = sm.memory_id
       AND m.author_id = sm.author_id
      OUTER APPLY (
        SELECT TOP 1 mm.media_id, mm.storage_path
        FROM dbo.identity_memory_media mm
        WHERE mm.memory_id = m.memory_id
          AND mm.author_id = m.author_id
          AND mm.media_type = 'image'
          AND ISNULL(mm.is_deleted, 0) = 0
        ORDER BY ISNULL(mm.is_primary_for_memory, 0) DESC, mm.created_at ASC, mm.media_id ASC
      ) media
      WHERE sm.story_id = @story_id
        AND sm.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY COALESCE(m.published_at, m.created_at) ASC, m.memory_id ASC;
    `);

  return result.recordset || [];
}


async function fetchAuthorMemories({ pool, authorId, search = "", limit = 200 }) {
  const request = pool.request()
    .input("author_id", sql.BigInt, authorId)
    .input("search", sql.NVarChar(240), `%${safeText(search, "")}%`)
    .input("limit", sql.Int, Math.min(Math.max(Number(limit) || 100, 1), 200));
  const result = await request.query(`
    SELECT TOP (@limit)
      m.memory_id, m.title, m.content,
      COALESCE(m.published_at, m.created_at) AS memory_date, m.created_at,
      media.media_id, media.storage_path AS image_storage_path,
      CASE WHEN media.media_id IS NULL THEN NULL ELSE '/cdn/memory-media/' + CAST(m.author_id AS varchar(20)) + '/' + CAST(m.memory_id AS varchar(20)) + '/' + CAST(media.media_id AS varchar(20)) + '/feed' END AS image_url
    FROM dbo.identity_memory m
    OUTER APPLY (
      SELECT TOP 1 mm.media_id, mm.storage_path
      FROM dbo.identity_memory_media mm
      WHERE mm.memory_id = m.memory_id
        AND mm.author_id = m.author_id
        AND mm.media_type = 'image'
        AND ISNULL(mm.is_deleted, 0) = 0
      ORDER BY ISNULL(mm.is_primary_for_memory, 0) DESC, mm.created_at ASC, mm.media_id ASC
    ) media
    WHERE m.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0
      AND (@search = '%%' OR m.title LIKE @search OR m.content LIKE @search)
    ORDER BY COALESCE(m.published_at, m.created_at) DESC, m.memory_id DESC;
  `);
  return (result.recordset || []).map(normalizeMemoryRow).filter(Boolean);
}

function normalizeSelectedMemoryIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(toPositiveInt).filter(Boolean))];
}

function normalizeEditorialOrigin(value, fallback = "AI") {
  const origin = safeText(value, fallback).toUpperCase();
  return origin === "AUTHOR" || origin === "AUTOR" ? "AUTHOR" : "AI";
}

function normalizeEditorialOrigins(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, origin]) => [String(toPositiveInt(key) || ""), normalizeEditorialOrigin(origin)])
      .filter(([key]) => Boolean(key))
  );
}

function decorateMemoryOrigin(memory, origin = "AI") {
  return {
    ...(memory || {}),
    editorial_origin: normalizeEditorialOrigin(memory?.editorial_origin ?? memory?.origin, origin),
    origin: normalizeEditorialOrigin(memory?.editorial_origin ?? memory?.origin, origin),
  };
}


async function listPersistedEditorialStories({ pool, authorId, limit = MAX_LIST_LIMIT }) {
  const safeLimit = Math.min(Math.max(Number(limit) || MAX_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const result = await pool.request()
    .input("author_id", sql.Int, authorId)
    .input("limit", sql.Int, safeLimit)
    .query(`
      SELECT TOP (@limit)
        s.story_id,
        s.title,
        s.subtitle,
        s.summary,
        s.story_key,
        s.origin,
        s.status,
        s.memory_count,
        s.confidence_score,
        s.chapter_lineage,
        s.created_at,
        s.updated_at,
        v.content,
        v.payload_json,
        v.version_number
      FROM dbo.identity_story s
      OUTER APPLY (
        SELECT TOP 1
          sv.content,
          sv.payload_json,
          sv.version_number
        FROM dbo.identity_story_version sv
        WHERE sv.story_id = s.story_id
          AND sv.author_id = s.author_id
        ORDER BY sv.version_number DESC, sv.story_version_id DESC
      ) v
      WHERE s.author_id = @author_id
        AND ISNULL(s.is_deleted, 0) = 0
        AND UPPER(ISNULL(s.status, 'DRAFT')) <> 'ARCHIVED'
      ORDER BY COALESCE(s.updated_at, s.created_at) DESC, s.story_id DESC;

      SELECT
        sm.story_id,
        sm.memory_id,
        sm.sort_order,
        m.title,
        m.content,
        COALESCE(m.published_at, m.created_at) AS memory_date,
        m.created_at
      FROM dbo.identity_story_memory sm
      INNER JOIN dbo.identity_memory m
        ON m.memory_id = sm.memory_id
       AND m.author_id = sm.author_id
      INNER JOIN dbo.identity_story s
        ON s.story_id = sm.story_id
       AND s.author_id = sm.author_id
      WHERE sm.author_id = @author_id
        AND ISNULL(s.is_deleted, 0) = 0
        AND UPPER(ISNULL(s.status, 'DRAFT')) <> 'ARCHIVED'
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY sm.story_id, sm.sort_order, sm.memory_id;
    `);

  const memoryMap = new Map();
  for (const row of result.recordsets?.[1] || []) {
    const storyId = Number(row.story_id);
    if (!memoryMap.has(storyId)) memoryMap.set(storyId, []);
    const normalized = normalizeMemoryRow(row);
    if (normalized) memoryMap.get(storyId).push(normalized);
  }

  return (result.recordsets?.[0] || []).map((row) => {
    let payload = {};
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch {}
    const memories = memoryMap.get(Number(row.story_id)) || [];
    const hypothesisId = safeText(row.story_key || payload?.hypothesis_id, null);
    const manuscript = safeText(row.content || row.summary, "");

    return {
      persisted: true,
      is_persisted_story: true,
      story_id: Number(row.story_id),
      id: Number(row.story_id),
      persisted_story_id: Number(row.story_id),
      title: row.title,
      suggested_title: row.title,
      subtitle: row.subtitle,
      central_question: row.subtitle || payload?.central_question || payload?.editorial_plan?.central_question || null,
      summary: row.summary || manuscript,
      content: manuscript,
      narrative_content: manuscript,
      story_key: hypothesisId,
      origin: row.origin || "DISCOVERED_BY_AI",
      hypothesis_id: hypothesisId,
      status: row.status || "draft",
      memory_count: Number(row.memory_count || memories.length || 0),
      confidence: Number(row.confidence_score ?? 100),
      confidence_score: Number(row.confidence_score ?? 100),
      chapter_lineage: row.chapter_lineage || null,
      lineage: Array.isArray(payload?.lineage) ? payload.lineage : [],
      editorial_plan: payload?.editorial_plan || null,
      timeline: Array.isArray(payload?.timeline) ? payload.timeline : [],
      memories,
      related_memories: memories,
      version_number: Number(row.version_number || 1),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      actions: {
        editorial_url: `/stories/${Number(row.story_id)}/editorial`,
      },
    };
  });
}

async function listMaterializedStoryMarkers({ pool, authorId }) {
  const result = await pool.request()
    .input("author_id", sql.Int, authorId)
    .query(`
      SELECT
        s.story_id,
        s.story_key,
        v.payload_json
      FROM dbo.identity_story s
      OUTER APPLY (
        SELECT TOP 1 sv.payload_json
        FROM dbo.identity_story_version sv
        WHERE sv.story_id = s.story_id
          AND sv.author_id = s.author_id
        ORDER BY sv.version_number DESC, sv.story_version_id DESC
      ) v
      WHERE s.author_id = @author_id
        AND ISNULL(s.is_deleted, 0) = 0
        AND UPPER(ISNULL(s.status, '')) = 'ARCHIVED';
    `);

  const persistedStoryIds = new Set();
  const sourceStoryIds = new Set();
  const hypothesisIds = new Set();

  for (const row of result.recordset || []) {
    const persistedId = toPositiveInt(row.story_id);
    if (persistedId) persistedStoryIds.add(persistedId);

    const storyKey = safeText(row.story_key, null);
    if (storyKey) hypothesisIds.add(storyKey);

    let payload = {};
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch {}

    const sourceId = toPositiveInt(payload?.source_story_id);
    if (sourceId) sourceStoryIds.add(sourceId);

    const hypothesisId = safeText(payload?.hypothesis_id, null);
    if (hypothesisId) hypothesisIds.add(hypothesisId);
  }

  return { persistedStoryIds, sourceStoryIds, hypothesisIds };
}

function isMaterializedStoryCandidate(story, markers) {
  const storyId = normalizeStoryId(story);
  const persistedId = toPositiveInt(story?.persisted_story_id);
  const hypothesisId = safeText(story?.hypothesis_id || story?.story_key, null);

  return Boolean(
    (storyId && (markers.persistedStoryIds.has(storyId) || markers.sourceStoryIds.has(storyId))) ||
    (persistedId && markers.persistedStoryIds.has(persistedId)) ||
    (hypothesisId && markers.hypothesisIds.has(hypothesisId))
  );
}

function mergeStoryCollections(primary = [], secondary = []) {
  const merged = [];
  const seenPersisted = new Set();
  const seenHypotheses = new Set();

  for (const story of [...primary, ...secondary]) {
    const persistedId = toPositiveInt(story?.persisted_story_id ?? (story?.persisted ? story?.story_id : null));
    const hypothesisId = safeText(story?.hypothesis_id || story?.story_key, null);

    if (persistedId && seenPersisted.has(persistedId)) continue;
    if (!persistedId && hypothesisId && seenHypotheses.has(hypothesisId)) continue;

    if (persistedId) seenPersisted.add(persistedId);
    if (hypothesisId) seenHypotheses.add(hypothesisId);
    merged.push(story);
  }

  return merged;
}

async function fetchStoryCandidate({ authorId, storyId }) {
  const activeStoriesPayload = await listAuthorActiveStories({
    authorId,
    limit: MAX_LIST_LIMIT,
    includeSnoozed: true,
  });

  const activeStories = normalizeStoryList(activeStoriesPayload);
  return activeStories.find((item) => normalizeStoryId(item) === storyId) || null;
}

async function fetchPersistedStoryCandidate({ pool, authorId, storyId }) {
  const result = await pool.request()
    .input("author_id", sql.Int, authorId)
    .input("story_id", sql.Int, storyId)
    .query(`
      SELECT TOP 1
        story_id, title, subtitle, summary, story_key, origin,
        memory_count, confidence_score, status, created_at, updated_at
      FROM dbo.identity_story
      WHERE story_id = @story_id
        AND author_id = @author_id
        AND ISNULL(is_deleted, 0) = 0;
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return {
    ...row,
    persisted: true,
    persisted_story_id: Number(row.story_id),
    story_id: Number(row.story_id),
    id: Number(row.story_id),
    candidate_id: Number(row.story_id),
    central_question: row.subtitle || null,
    origin: row.origin || "DISCOVERED_BY_AI",
  };
}

async function fetchPersistedStoryMemories({ pool, authorId, storyId }) {
  const result = await pool.request()
    .input("author_id", sql.Int, authorId)
    .input("story_id", sql.Int, storyId)
    .query(`
      SELECT
        sm.memory_id, m.title, m.content,
        COALESCE(m.published_at, m.created_at) AS memory_date,
        m.created_at, sm.sort_order,
        media.media_id, media.storage_path AS image_storage_path,
        CASE WHEN media.media_id IS NULL THEN NULL ELSE '/cdn/memory-media/' + CAST(m.author_id AS varchar(20)) + '/' + CAST(m.memory_id AS varchar(20)) + '/' + CAST(media.media_id AS varchar(20)) + '/feed' END AS image_url
      FROM dbo.identity_story_memory sm
      INNER JOIN dbo.identity_memory m
        ON m.memory_id = sm.memory_id AND m.author_id = sm.author_id
      OUTER APPLY (
        SELECT TOP 1 mm.media_id, mm.storage_path
        FROM dbo.identity_memory_media mm
        WHERE mm.memory_id = m.memory_id
          AND mm.author_id = m.author_id
          AND mm.media_type = 'image'
          AND ISNULL(mm.is_deleted, 0) = 0
        ORDER BY ISNULL(mm.is_primary_for_memory, 0) DESC, mm.created_at ASC, mm.media_id ASC
      ) media
      WHERE sm.story_id = @story_id
        AND sm.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY sm.sort_order, sm.memory_id;
    `);
  return (result.recordset || []).map(normalizeMemoryRow).filter(Boolean);
}


router.get("/chapter-candidates", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const source = String(req.query?.source || "").trim().toLowerCase();
    if (source === "persisted") {
      return res.json(await listPersistedChapterCandidates({
        authorId,
        limit: req.query?.limit,
      }));
    }

    return res.json(await buildChapterCandidatesForAuthor({
      authorId,
      limit: req.query?.limit,
      persist: toBoolean(req.query?.persist),
    }));
  } catch (error) {
    return next(error);
  }
});

router.post("/chapter-candidates/rebuild", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    return res.json(await buildChapterCandidatesForAuthor({
      authorId,
      limit: req.body?.limit || req.query?.limit,
      persist: true,
    }));
  } catch (error) {
    return next(error);
  }
});

router.get("/candidates", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const pool = await getPool();
    const [persistedStories, activeResult, materializedMarkers] = await Promise.all([
      listPersistedEditorialStories({ pool, authorId, limit: req.query?.limit || MAX_LIST_LIMIT }),
      listAuthorActiveStories({
        authorId,
        limit: MAX_LIST_LIMIT,
        includeSnoozed: toBoolean(req.query?.includeSnoozed),
      }),
      listMaterializedStoryMarkers({ pool, authorId }),
    ]);

    const activeStories = normalizeStoryList(activeResult)
      .filter((story) => !isMaterializedStoryCandidate(story, materializedMarkers));
    const stories = mergeStoryCollections(persistedStories, activeStories);
    const mergedResult = {
      ...(activeResult && typeof activeResult === "object" && !Array.isArray(activeResult) ? activeResult : {}),
      ok: activeResult?.ok !== false,
      stories,
      candidates: stories,
    };

    return res.json(normalizeStoryExperiencePayload(mergedResult, {
      showAll: toBoolean(req.query?.showAll),
      limit: req.query?.limit,
    }));
  } catch (error) {
    return next(error);
  }
});



async function resolveEditorialHypothesis({ authorId, hypothesisId, limit = 300, generateStories = false }) {
  const discovery = await discoverStoryHypothesesForAuthor({
    authorId,
    limit,
    visibleLimit: 12,
    includeWeak: false,
    generateStories,
  });

  const hypothesis = (discovery.hypotheses || []).find((item) => String(item?.hypothesis_id) === hypothesisId);
  const candidate = (discovery.candidates || []).find((item) =>
    String(item?.hypothesis_id || item?.narrative_hypothesis?.hypothesis_id || item?.story_blueprint?.hypothesis_id) === hypothesisId
  );
  const generated = (discovery.story_generation_results || []).find((item) =>
    String(item?.hypothesis_id || item?.pipeline_contract?.blueprint?.hypothesis_id || item?.pipeline_contract?.candidate_id) === hypothesisId ||
    (candidate && Number(item?.candidate_id) === Number(candidate?.candidate_id || candidate?.story_id || candidate?.id))
  );

  return { discovery, hypothesis, candidate, generated, sourceCandidate: candidate || hypothesis };
}

function hypothesisMemoryIds(hypothesis, sourceCandidate) {
  return [...new Set([
    ...(hypothesis?.memories || []),
    ...(sourceCandidate?.memory_ids || []),
    ...((sourceCandidate?.memories || []).map((memory) => memory?.memory_id ?? memory?.id ?? memory)),
  ].map(Number).filter(Boolean))];
}

router.get("/hypotheses/:hypothesisId/editorial-selection", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const hypothesisId = safeText(req.params.hypothesisId, "");
    if (!/^hypothesis_[a-z0-9_:-]+$/i.test(hypothesisId)) return res.status(400).json({ ok: false, error: "hypothesisId inválido." });

    const resolved = await resolveEditorialHypothesis({ authorId, hypothesisId, limit: req.query?.limit || 300, generateStories: false });
    if (!resolved.hypothesis && !resolved.candidate) return res.status(404).json({ ok: false, error: "Hipótese narrativa não encontrada para este autor." });

    const pool = await getPool();
    const ids = hypothesisMemoryIds(resolved.hypothesis, resolved.sourceCandidate);
    const authorMemories = await fetchAuthorMemories({ pool, authorId, limit: 500 });
    const byId = new Map(authorMemories.map((memory) => [Number(memory.memory_id), memory]));
    const embedded = Array.isArray(resolved.sourceCandidate?.memories) ? resolved.sourceCandidate.memories : [];
    const embeddedById = new Map(embedded.map((memory) => [Number(memory?.memory_id ?? memory?.id), memory]));
    const memories = ids.map((id) => byId.get(id) || embeddedById.get(id)).filter(Boolean).map(normalizeMemoryRow).filter(Boolean).map((memory) => decorateMemoryOrigin(memory, "AI"));
    const storyEntityId = normalizeStoryId(resolved.sourceCandidate || resolved.hypothesis);
    const hasAiManuscript = storyEntityId
      ? await hasPriorStoryAiGeneration({ pool, authorId, storyId: storyEntityId })
      : false;

    return res.json({
      ok: true,
      has_ai_manuscript: hasAiManuscript,
      hypothesis_id: hypothesisId,
      story: decorateStoryCandidate({ ...resolved.sourceCandidate, ...resolved.hypothesis, hypothesis_id: hypothesisId }, { memories }),
      hypothesis: resolved.hypothesis,
      memories,
      selected_memory_ids: memories.map((memory) => Number(memory.memory_id)),
    });
  } catch (error) { return next(error); }
});

router.get("/hypotheses/:hypothesisId/available-memories", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const hypothesisId = safeText(req.params.hypothesisId, "");
    if (!/^hypothesis_[a-z0-9_:-]+$/i.test(hypothesisId)) return res.status(400).json({ ok: false, error: "hypothesisId inválido." });
    const pool = await getPool();
    const memories = await fetchAuthorMemories({ pool, authorId, search: req.query?.search, limit: req.query?.limit });
    return res.json({ ok: true, hypothesis_id: hypothesisId, memories: memories.map((memory) => decorateMemoryOrigin(memory, "AUTHOR")) });
  } catch (error) { return next(error); }
});

router.post("/hypotheses/:hypothesisId/materialize", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;
    const userId = resolveAuthenticatedUserId(req);

    const hypothesisId = safeText(req.params.hypothesisId, "");
    if (!/^hypothesis_[a-z0-9_:-]+$/i.test(hypothesisId)) {
      return res.status(400).json({ ok: false, error: "hypothesisId inválido." });
    }

    const resolved = await resolveEditorialHypothesis({ authorId, hypothesisId, limit: req.body?.limit || 300, generateStories: false });
    const { hypothesis, candidate, sourceCandidate } = resolved;
    if (!hypothesis && !candidate) return res.status(404).json({ ok: false, error: "Hipótese narrativa não encontrada para este autor." });

    const pool = await getPool();
    if (!userId) return res.status(401).json({ ok: false, error: "user_id não encontrado no token." });

    const storyEntityId = normalizeStoryId(sourceCandidate || hypothesis);
    const economic = await resolveStoryEconomicOperation({
      pool,
      userId,
      authorId,
      storyId: storyEntityId
    });

    if (!economic.planCheck.allowed) {
      return sendPlanDenied(res, economic.planCheck, {
        status: 403,
        message: economic.isRegeneration
          ? "A franquia mensal de regenerações foi atingida."
          : "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    const requestedIds = normalizeSelectedMemoryIds(req.body?.selected_memory_ids || req.body?.selectedMemoryIds);
    if (!requestedIds.length) {
      return res.status(422).json({ ok: false, error: "selected_memory_ids é obrigatório para gerar o manuscrito editorial." });
    }
    const selectedIds = requestedIds;
    const authorMemories = await fetchAuthorMemories({ pool, authorId, limit: 500 });
    const byId = new Map(authorMemories.map((memory) => [Number(memory.memory_id), memory]));
    let memories = selectedIds.map((id) => byId.get(id)).filter(Boolean);
    if (memories.length !== selectedIds.length) return res.status(400).json({ ok: false, error: "Uma ou mais memórias selecionadas não pertencem ao autor." });
    if (!memories.length) return res.status(422).json({ ok: false, error: "Selecione ao menos uma memória para gerar o manuscrito." });
    const timeline = buildTimelineFromMemories(memories);

    const economicSource = economic.isRegeneration
      ? "stories.hypothesis.regenerate"
      : "stories.hypothesis.materialize";
    const reservation = await reserveStoryEconomicOperation({
      pool,
      userId,
      authorId,
      storyId: storyEntityId,
      economic,
      source: economicSource,
    });

    if (!reservation.allowed || !reservation.reservation_event_id) {
      return sendPlanDenied(res, reservation, {
        status: 403,
        message: economic.isRegeneration
          ? "A franquia mensal de regenerações foi atingida."
          : "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    let draft;
    try {
      draft = await generateStoryEditorialDraft({
        storyCandidate: { ...sourceCandidate, ...hypothesis, hypothesis_id: hypothesisId },
        memories,
        timeline,
        instructions: req.body?.instructions || null,
        selectedMemoryIds: selectedIds,
        authorId,
        userId,
      });
    } catch (error) {
      try {
        await releasePlanQuotaReservation({
          pool,
          userId,
          reservationEventId: reservation.reservation_event_id,
          reasonCode: error?.code || "STORY_GENERATION_FAILED",
          metadata: { author_id: authorId, hypothesis_id: hypothesisId, source: economicSource },
        });
      } catch (releaseError) {
        console.error("[PLAN][STORY] Falha ao liberar reserva:", releaseError?.message || releaseError);
      }
      throw error;
    }

    const quotaResult = await commitPlanQuotaReservation({
      pool,
      userId,
      reservationEventId: reservation.reservation_event_id,
      metadata: {
        author_id: authorId,
        hypothesis_id: hypothesisId,
        source: economicSource,
        economic_operation: economic.isRegeneration ? "REGENERATION" : "STORY_AI_GENERATION",
      },
    });
    if (!quotaResult.allowed) {
      return res.status(409).json({
        ok: false,
        error: "A História foi gerada, mas a reserva econômica não pôde ser consolidada.",
        code: quotaResult.reason_code || "PLAN_QUOTA_COMMIT_FAILED",
      });
    }

    return res.json({
      ok: true,
      experience: "STORY_MATERIALIZATION_ENGINE",
      hypothesis_id: hypothesisId,
      hypothesis,
      story: sourceCandidate,
      draft,
      memories: draft?.truth_selection?.selected || memories,
      used_memories: draft?.truth_selection?.selected || memories,
      discarded_memories: draft?.truth_selection?.discarded || [],
      timeline,
      evidence_map: draft?.evidence_map || null,
      story_evidence_score: draft?.story_evidence_score || null,
      meta: {
        generated_at: new Date().toISOString(),
        source_policy: "GO LIVE 008: hipótese aprovada materializada imediatamente; persistência continua exigindo aprovação do autor.",
      },
    });
  } catch (error) {
    return next(error);
  }
});


router.post("/hypotheses/:hypothesisId/approve", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const hypothesisId = safeText(req.params.hypothesisId, "");
    if (!/^hypothesis_[a-z0-9_:-]+$/i.test(hypothesisId)) return res.status(400).json({ ok: false, error: "hypothesisId inválido." });
    const selectedMemoryIds = normalizeSelectedMemoryIds(req.body?.selected_memory_ids || req.body?.selectedMemoryIds);
    if (!selectedMemoryIds.length) return res.status(422).json({ ok: false, error: "A História precisa de ao menos uma memória aprovada." });
    const editorialMemoryOrigins = normalizeEditorialOrigins(req.body?.editorial_memory_origins || req.body?.draft?.editorial_memory_origins);

    const resolved = await resolveEditorialHypothesis({ authorId, hypothesisId, limit: 300, generateStories: false });
    if (!resolved.hypothesis && !resolved.candidate) return res.status(404).json({ ok: false, error: "Hipótese narrativa não encontrada para este autor." });
    // Uma hipótese descoberta pode ser aprovada mesmo quando o SDE ainda não
    // materializou um registro em identity_narrative_story. Nesse caso, a
    // própria aprovação cria a Story editorial e preserva hypothesis_id como
    // linhagem. sourceStoryId permanece opcional no serviço de persistência.
    const sourceStoryId = normalizeStoryId(resolved.sourceCandidate);

    const result = await saveApprovedStory({
      authorId,
      sourceStoryId,
      title: req.body?.title,
      subtitle: req.body?.subtitle,
      content: req.body?.content || req.body?.narrative_content,
      editorialPlan: req.body?.editorial_plan || null,
      timeline: req.body?.timeline || [],
      memories: (req.body?.memories || selectedMemoryIds.map((memory_id) => ({ memory_id }))).map((memory) => ({
        ...memory,
        editorial_origin: normalizeEditorialOrigin(memory?.editorial_origin ?? memory?.origin ?? editorialMemoryOrigins[String(memory?.memory_id ?? memory?.id)], "AI"),
      })),
      editorialMemoryOrigins,
      relationships: req.body?.relationships || [],
      generationPayload: { ...(req.body?.draft || req.body || {}), hypothesis_id: hypothesisId, selected_memory_ids: selectedMemoryIds, editorial_memory_origins: editorialMemoryOrigins, approval_status: "APPROVED" },
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ...result, approved: true, status: "STORY", hypothesis_id: hypothesisId, selected_memory_ids: selectedMemoryIds });
  } catch (error) { return next(error); }
});


router.post("/hypotheses/:hypothesisId/discard", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const hypothesisId = safeText(req.params.hypothesisId, "");
    if (!/^hypothesis_[a-z0-9_:-]+$/i.test(hypothesisId)) return res.status(400).json({ ok: false, error: "hypothesisId inválido." });

    const resolved = await resolveEditorialHypothesis({ authorId, hypothesisId, limit: 300, generateStories: false });
    const sourceStoryId = normalizeStoryId(resolved.sourceCandidate);

    // Descarte idempotente:
    // se a hipótese já deixou de existir entre a primeira ação e uma eventual
    // repetição da requisição, tratamos como sucesso. O estado desejado
    // ("não aparecer mais em Histórias") já foi alcançado.
    if (!sourceStoryId) {
      return res.json({
        ok: true,
        hypothesis_id: hypothesisId,
        discarded: true,
        already_discarded: true,
      });
    }

    const result = await discardNarrativeStory({ authorId, storyId: sourceStoryId });
    return res.json({
      ...result,
      ok: result?.ok !== false,
      hypothesis_id: hypothesisId,
      discarded: result?.ok !== false,
    });
  } catch (error) { return next(error); }
});

router.post("/:storyId/materialized-as-chapter", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toPositiveInt(req.params.storyId);
    const chapterId = toPositiveInt(req.body?.chapter_id ?? req.body?.chapterId);

    if (!storyId) return res.status(400).json({ error: "storyId inválido." });
    if (!chapterId) return res.status(400).json({ error: "chapter_id inválido." });

    const pool = await getPool();
    const result = await pool.request()
      .input("author_id", sql.Int, authorId)
      .input("story_id", sql.Int, storyId)
      .input("chapter_id", sql.Int, chapterId)
      .query(`
        IF NOT EXISTS (
          SELECT 1
          FROM dbo.identity_chapter
          WHERE chapter_id = @chapter_id
            AND author_id = @author_id
            AND ISNULL(is_deleted, 0) = 0
        )
        BEGIN
          THROW 50001, 'Capítulo não encontrado para este autor.', 1;
        END

        UPDATE dbo.identity_story
        SET status = 'archived',
            updated_at = SYSUTCDATETIME()
        WHERE story_id = @story_id
          AND author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;

        SELECT @@ROWCOUNT AS affected_rows;
      `);

    const affectedRows = Number(result.recordset?.[0]?.affected_rows || 0);
    if (!affectedRows) {
      return res.status(404).json({ error: "História não encontrada para este autor." });
    }

    return res.json({
      ok: true,
      story_id: storyId,
      chapter_id: chapterId,
      status: "MATERIALIZED_AS_CHAPTER",
      visible_in_stories: false,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:storyId/timeline", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });

    const pool = await getPool();
    const story = await fetchStoryCandidate({ authorId, storyId });
    const relatedMemories = await fetchStoryRelatedMemories({ pool, authorId, storyId });
    const decorated = decorateStoryCandidate(story || { story_id: storyId }, { memories: relatedMemories });
    const timeline = buildTimelineFromMemories(relatedMemories);

    return res.json({
      ok: true,
      story_id: storyId,
      title: decorated.title,
      status: decorated.status || "EMERGING",
      confidence: decorated.confidence,
      confidence_level: decorated.confidence_level,
      memory_count: relatedMemories.length,
      timeline,
      editorial_timeline: timeline,
      meta: {
        generated_at: new Date().toISOString(),
        source_policy: "Timeline de História é apresentada como suporte do Story Blueprint.",
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:storyId/generate", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;
    const userId = resolveAuthenticatedUserId(req);

    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });

    const pool = await getPool();
    if (!userId) return res.status(401).json({ ok: false, error: "user_id não encontrado no token." });
    const discoveredStory = await fetchStoryCandidate({ authorId, storyId });
    const persistedStory = discoveredStory ? null : await fetchPersistedStoryCandidate({ pool, authorId, storyId });
    const story = discoveredStory || persistedStory;
    if (!story) return res.status(404).json({ ok: false, error: "História não encontrada." });

    const economic = await resolveStoryEconomicOperation({
      pool,
      userId,
      authorId,
      storyId
    });
    if (!economic.planCheck.allowed) {
      return sendPlanDenied(res, economic.planCheck, {
        status: 403,
        message: economic.isRegeneration
          ? "A franquia mensal de regenerações foi atingida."
          : "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    const discoveredMemories = discoveredStory
      ? await fetchStoryRelatedMemories({ pool, authorId, storyId })
      : await fetchPersistedStoryMemories({ pool, authorId, storyId });
    const requestedIds = normalizeSelectedMemoryIds(req.body?.selected_memory_ids || req.body?.selectedMemoryIds);
    if (!requestedIds.length) {
      return res.status(422).json({ ok: false, error: "selected_memory_ids é obrigatório para gerar o manuscrito editorial." });
    }
    let relatedMemories = discoveredMemories;
    if (requestedIds.length) {
      const available = await fetchAuthorMemories({ pool, authorId, limit: 200 });
      const byId = new Map(available.map((memory) => [Number(memory.memory_id), memory]));
      relatedMemories = requestedIds.map((id) => byId.get(id)).filter(Boolean);
      if (relatedMemories.length !== requestedIds.length) {
        return res.status(400).json({ ok: false, error: "Uma ou mais memórias selecionadas não pertencem ao autor." });
      }
    }
    if (!relatedMemories.length) return res.status(422).json({ ok: false, error: "Selecione ao menos uma memória para gerar o manuscrito." });
    const timeline = buildTimelineFromMemories(relatedMemories);
    const decorated = decorateStoryCandidate(story, { memories: relatedMemories });
    const blueprint = buildStoryBlueprint(decorated, relatedMemories);

    if (blueprint.status === "NEEDS_MORE_MEMORIES" && !toBoolean(req.body?.forceGenerate || req.query?.forceGenerate)) {
      return res.status(422).json({
        ok: false,
        story_id: storyId,
        experience: "STORY_BLUEPRINT",
        error: "Esta história ainda está fraca. A HDUD não vai escrever antes de haver memória suficiente.",
        story_blueprint: blueprint,
        missing_memories: blueprint.missing_memories,
        meta: {
          generated_at: new Date().toISOString(),
          source_policy: "Blueprint bloqueou geração prematura. Use forceGenerate apenas para teste técnico.",
        },
      });
    }

    const authorSelectionIsAuthoritative = true;
    const truthSelection = null;

    const economicSource = economic.isRegeneration ? "stories.regenerate" : "stories.generate";
    const reservation = await reserveStoryEconomicOperation({
      pool,
      userId,
      authorId,
      storyId,
      economic,
      source: economicSource,
    });

    if (!reservation.allowed || !reservation.reservation_event_id) {
      return sendPlanDenied(res, reservation, {
        status: 403,
        message: economic.isRegeneration
          ? "A franquia mensal de regenerações foi atingida."
          : "A franquia mensal de Gerações Narrativas com IA (Histórias + Capítulos) foi atingida.",
      });
    }

    let draft;
    try {
      draft = await generateStoryEditorialDraft({
        storyCandidate: { ...decorated, story_blueprint: blueprint, blueprint },
        memories: relatedMemories,
        timeline,
        instructions: req.body?.instructions || null,
        truthSelection,
        selectedMemoryIds: authorSelectionIsAuthoritative ? requestedIds : null,
        authorId,
        userId,
      });
    } catch (error) {
      try {
        await releasePlanQuotaReservation({
          pool,
          userId,
          reservationEventId: reservation.reservation_event_id,
          reasonCode: error?.code || "STORY_GENERATION_FAILED",
          metadata: { author_id: authorId, story_id: storyId, source: economicSource },
        });
      } catch (releaseError) {
        console.error("[PLAN][STORY] Falha ao liberar reserva:", releaseError?.message || releaseError);
      }
      throw error;
    }

    const quotaResult = await commitPlanQuotaReservation({
      pool,
      userId,
      reservationEventId: reservation.reservation_event_id,
      metadata: {
        author_id: authorId,
        story_id: storyId,
        source: economicSource,
        economic_operation: economic.isRegeneration ? "REGENERATION" : "STORY_AI_GENERATION",
      },
    });
    if (!quotaResult.allowed) {
      return res.status(409).json({
        ok: false,
        error: "A História foi gerada, mas a reserva econômica não pôde ser consolidada.",
        code: quotaResult.reason_code || "PLAN_QUOTA_COMMIT_FAILED",
      });
    }

    return res.json({
      ok: true,
      story_id: storyId,
      experience: "STORY_MATERIALIZATION_RUNTIME",
      story_blueprint: blueprint,
      draft,
      story: {
        ...decorated,
        truth_score:
          draft?.truth?.truth_report?.average_truth_score ??
          truthSelection?.truth_report?.average_truth_score ??
          null,
        evidence_quality:
          draft.story_evidence_score?.evidence_quality ??
          truthSelection?.story_evidence_score?.evidence_quality ??
          null,
        hallucination_risk:
          draft.story_evidence_score?.hallucination_risk ??
          truthSelection?.story_evidence_score?.hallucination_risk ??
          null,
      },
      memories: draft?.truth_selection?.selected || relatedMemories,
      used_memories: draft?.truth_selection?.selected || relatedMemories,
      discarded_memories: draft?.truth_selection?.discarded || [],
      truth: draft.truth,
      evidence_map: draft.evidence_map,
      story_evidence_score: draft.story_evidence_score,
      timeline,
      meta: {
        generated_at: new Date().toISOString(),
        source_policy: "Manuscrito gerado exclusivamente com selected_memory_ids. Persistência exige aprovação do autor.",
        selected_memory_ids: relatedMemories.map((memory) => Number(memory.memory_id)),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:storyId/editorial-selection", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });
    const pool = await getPool();

    const saved = await pool.request()
      .input("author_id", sql.Int, authorId)
      .input("story_id", sql.Int, storyId)
      .query(`
        SELECT TOP 1
          s.story_id, s.title, s.subtitle, s.summary, s.story_key, s.origin,
          s.chapter_lineage, s.updated_at,
          v.content, v.payload_json, v.version_number
        FROM dbo.identity_story s
        OUTER APPLY (
          SELECT TOP 1 content, payload_json, version_number
          FROM dbo.identity_story_version
          WHERE story_id = s.story_id AND author_id = s.author_id
          ORDER BY version_number DESC, story_version_id DESC
        ) v
        WHERE s.story_id = @story_id
          AND s.author_id = @author_id
          AND ISNULL(s.is_deleted, 0) = 0;

        SELECT
          sm.memory_id,
          m.title,
          m.content,
          COALESCE(m.published_at, m.created_at) AS memory_date,
          m.created_at,
          sm.sort_order,
          sm.evidence_reason,
          media.media_id,
          media.storage_path AS image_storage_path,
          CASE WHEN media.media_id IS NULL THEN NULL ELSE '/cdn/memory-media/' + CAST(m.author_id AS varchar(20)) + '/' + CAST(m.memory_id AS varchar(20)) + '/' + CAST(media.media_id AS varchar(20)) + '/feed' END AS image_url
        FROM dbo.identity_story_memory sm
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = sm.memory_id AND m.author_id = sm.author_id
        OUTER APPLY (
          SELECT TOP 1 mm.media_id, mm.storage_path
          FROM dbo.identity_memory_media mm
          WHERE mm.memory_id = m.memory_id
            AND mm.author_id = m.author_id
            AND mm.media_type = 'image'
            AND ISNULL(mm.is_deleted, 0) = 0
          ORDER BY ISNULL(mm.is_primary_for_memory, 0) DESC, mm.created_at ASC, mm.media_id ASC
        ) media
        WHERE sm.story_id = @story_id
          AND sm.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0
        ORDER BY sm.sort_order, sm.memory_id;
      `);

    const savedStory = saved.recordsets?.[0]?.[0] || null;
    if (savedStory) {
      let payload = {};
      try { payload = savedStory.payload_json ? JSON.parse(savedStory.payload_json) : {}; } catch {}
      const editorialOrigins = normalizeEditorialOrigins(payload?.editorial_memory_origins || {});
      const memories = (saved.recordsets?.[1] || []).map((row) => {
        const normalized = normalizeMemoryRow(row);
        if (!normalized) return null;
        const persistedOrigin = editorialOrigins[String(normalized.memory_id)] || (/incluída pelo autor/i.test(String(row?.evidence_reason || "")) ? "AUTHOR" : "AI");
        return decorateMemoryOrigin(normalized, persistedOrigin);
      }).filter(Boolean);
      const hasAiManuscript = await hasPriorStoryAiGeneration({ pool, authorId, storyId });
      return res.json({
        ok: true,
        persisted: true,
        has_ai_manuscript: hasAiManuscript,
        story: {
          story_id: Number(savedStory.story_id),
          persisted_story_id: Number(savedStory.story_id),
          title: savedStory.title,
          subtitle: savedStory.subtitle,
          summary: savedStory.summary,
          content: savedStory.content || savedStory.summary || "",
          narrative_content: savedStory.content || savedStory.summary || "",
          hypothesis_id: savedStory.story_key || payload?.hypothesis_id || null,
          story_key: savedStory.story_key || payload?.hypothesis_id || null,
          origin: savedStory.origin || payload?.origin || "DISCOVERED_BY_AI",
          editorial_plan: payload?.editorial_plan || null,
          lineage: payload?.lineage || [],
          timeline: payload?.timeline || [],
          version_number: savedStory.version_number || 1,
        },
        draft: {
          ...payload,
          title: savedStory.title,
          subtitle: savedStory.subtitle,
          content: savedStory.content || savedStory.summary || "",
          narrative_content: savedStory.content || savedStory.summary || "",
          hypothesis_id: savedStory.story_key || payload?.hypothesis_id || null,
          origin: savedStory.origin || payload?.origin || "DISCOVERED_BY_AI",
        },
        memories,
        selected_memory_ids: memories.map((m) => Number(m.memory_id)),
      });
    }

    const story = await fetchStoryCandidate({ authorId, storyId });
    if (!story) return res.status(404).json({ ok: false, error: "História não encontrada." });
    const memories = await fetchStoryRelatedMemories({ pool, authorId, storyId });
    const editorialMemories = memories.map(normalizeMemoryRow).filter(Boolean).map((memory) => decorateMemoryOrigin(memory, "AI"));
    const hasAiManuscript = await hasPriorStoryAiGeneration({ pool, authorId, storyId });
    return res.json({ ok: true, has_ai_manuscript: hasAiManuscript, story: decorateStoryCandidate(story, { memories: editorialMemories }), memories: editorialMemories, selected_memory_ids: editorialMemories.map((m) => Number(m.memory_id)) });
  } catch (error) { return next(error); }
});

router.get("/:storyId/available-memories", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const pool = await getPool();
    const memories = await fetchAuthorMemories({ pool, authorId, search: req.query?.search, limit: req.query?.limit });
    return res.json({ ok: true, memories: memories.map((memory) => decorateMemoryOrigin(memory, "AUTHOR")) });
  } catch (error) { return next(error); }
});

router.post("/:storyId/manuscript", authRequired, (req, res, next) => {
  req.url = `/${req.params.storyId}/generate`;
  return router.handle(req, res, next);
});

router.post("/:storyId/approve", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res); if (!authorId) return;
    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });
    const selectedMemoryIds = normalizeSelectedMemoryIds(req.body?.selected_memory_ids || req.body?.selectedMemoryIds);
    if (!selectedMemoryIds.length) return res.status(422).json({ ok: false, error: "A História precisa de ao menos uma memória aprovada." });
    const editorialMemoryOrigins = normalizeEditorialOrigins(req.body?.editorial_memory_origins || req.body?.draft?.editorial_memory_origins);
    const result = await saveApprovedStory({
      authorId, sourceStoryId: storyId, origin: req.body?.origin || req.body?.draft?.origin || "DISCOVERED_BY_AI", title: req.body?.title, subtitle: req.body?.subtitle,
      content: req.body?.content || req.body?.narrative_content, editorialPlan: req.body?.editorial_plan || null,
      timeline: req.body?.timeline || [], memories: (req.body?.memories || selectedMemoryIds.map((memory_id) => ({ memory_id }))).map((memory) => ({
        ...memory,
        editorial_origin: normalizeEditorialOrigin(memory?.editorial_origin ?? memory?.origin ?? editorialMemoryOrigins[String(memory?.memory_id ?? memory?.id)], "AI"),
      })),
      editorialMemoryOrigins,
      relationships: req.body?.relationships || [], generationPayload: { ...(req.body?.draft || req.body || {}), selected_memory_ids: selectedMemoryIds, editorial_memory_origins: editorialMemoryOrigins, approval_status: "APPROVED" },
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json({ ...result, approved: true, status: "STORY", selected_memory_ids: selectedMemoryIds });
  } catch (error) { return next(error); }
});

router.post("/:storyId/save", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });

    const result = await saveApprovedStory({
      authorId,
      origin: req.body?.origin || req.body?.draft?.origin || null,
      persistedStoryId: storyId,
      sourceStoryId: req.body?.source_story_id ?? null,
      title: req.body?.title,
      subtitle: req.body?.subtitle,
      content: req.body?.content || req.body?.narrative_content,
      editorialPlan: req.body?.editorial_plan || req.body?.editorialPlan || null,
      timeline: req.body?.timeline || [],
      memories: req.body?.memories || [],
      editorialMemoryOrigins: req.body?.editorial_memory_origins || req.body?.draft?.editorial_memory_origins || null,
      relationships: req.body?.relationships || [],
      generationPayload: req.body?.generation_payload || req.body?.draft || req.body || null,
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.get("/author-memories", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;
    const pool = await getPool();
    const memories = await fetchAuthorMemories({
      pool,
      authorId,
      search: req.query?.search,
      limit: req.query?.limit || 300,
    });
    return res.json({
      ok: true,
      memories: memories.map((memory) => decorateMemoryOrigin(memory, "AUTHOR")),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:storyId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });

    const pool = await getPool();
    const story = await fetchStoryCandidate({ authorId, storyId });
    if (!story) return res.status(404).json({ ok: false, error: "História não encontrada." });

    const relatedMemories = await fetchStoryRelatedMemories({ pool, authorId, storyId });
    const candidate = decorateStoryCandidate(story, { memories: relatedMemories });
    const timeline = buildTimelineFromMemories(relatedMemories);

    return res.json({
      ok: true,
      experience: "STORY_BLUEPRINT_EXPLORATION",
      story: {
        ...candidate,
        timeline,
        editorial_timeline: timeline,
        exploration: {
          hero: {
            title: candidate.title,
            period: candidate.period?.label || null,
            memory_count: candidate.memory_count,
            confidence_label: candidate.confidence_level?.label,
          },
          why_found: candidate.why_found,
          editorial_overview: candidate.editorial_overview,
          story_blueprint: candidate.story_blueprint,
          primary_action: {
            label: "Aprovar Blueprint e Gerar História",
            intent: "APPROVE_BLUEPRINT_AND_GENERATE_STORY",
            href: `/stories/${storyId}/editorial`,
          },
        },
      },
      meta: {
        generated_at: new Date().toISOString(),
        source_policy: "Exploração apresenta o Blueprint antes da História ser escrita.",
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const pool = await getPool();
    const [persistedStories, activeResult] = await Promise.all([
      listPersistedEditorialStories({ pool, authorId, limit: req.query?.limit || MAX_LIST_LIMIT }),
      listAuthorActiveStories({
        authorId,
        limit: MAX_LIST_LIMIT,
        includeSnoozed: toBoolean(req.query?.includeSnoozed),
      }),
    ]);

    const activeStories = normalizeStoryList(activeResult);
    const stories = mergeStoryCollections(persistedStories, activeStories);
    const mergedResult = {
      ...(activeResult && typeof activeResult === "object" && !Array.isArray(activeResult) ? activeResult : {}),
      ok: activeResult?.ok !== false,
      stories,
      candidates: stories,
    };

    return res.json(normalizeStoryExperiencePayload(mergedResult, {
      showAll: toBoolean(req.query?.showAll),
      limit: req.query?.limit,
    }));
  } catch (error) {
    return next(error);
  }
});



router.post("/author-created", authRequired, async (req, res, next) => {
  const authorId = ensureAuthorId(req, res);
  if (!authorId) return;

  const title = safeText(req.body?.title, "").slice(0, 220);
  const description = safeText(req.body?.description || req.body?.subtitle, "").slice(0, 300);
  const selectedMemoryIds = normalizeSelectedMemoryIds(
    req.body?.selected_memory_ids || req.body?.selectedMemoryIds
  );

  if (title.length < 2) {
    return res.status(422).json({ ok: false, error: "Informe o título da nova História." });
  }
  if (!selectedMemoryIds.length) {
    return res.status(422).json({ ok: false, error: "Selecione ao menos uma memória." });
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();

  try {
    const owned = await tx.request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT memory_id
        FROM dbo.identity_memory
        WHERE author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;
      `);
    const ownedIds = new Set((owned.recordset || []).map((row) => Number(row.memory_id)));
    if (selectedMemoryIds.some((id) => !ownedIds.has(id))) {
      await tx.rollback();
      return res.status(400).json({ ok: false, error: "Uma ou mais memórias não pertencem ao autor." });
    }

    const inserted = await tx.request()
      .input("author_id", sql.Int, authorId)
      .input("title", sql.NVarChar(220), title)
      .input("subtitle", sql.NVarChar(300), description || null)
      .input("memory_count", sql.Int, selectedMemoryIds.length)
      .input("origin", sql.VarChar(30), "CREATED_BY_AUTHOR")
      .query(`
        INSERT INTO dbo.identity_story (
          author_id, title, subtitle, summary, story_type, status,
          consolidation_status, source_date_kind, memory_count,
          strength_score, confidence_score, origin,
          story_publication_status, is_deleted, created_at, updated_at
        )
        OUTPUT INSERTED.story_id
        VALUES (
          @author_id, @title, @subtitle, NULL, 'manual', 'draft',
          'consolidated', 'created_at', @memory_count,
          0, 100, @origin,
          'DRAFT', 0, SYSUTCDATETIME(), SYSUTCDATETIME()
        );
      `);

    const storyId = Number(inserted.recordset?.[0]?.story_id);
    if (!storyId) throw new Error("A nova História foi criada sem identificador.");

    for (let index = 0; index < selectedMemoryIds.length; index += 1) {
      await tx.request()
        .input("story_id", sql.Int, storyId)
        .input("author_id", sql.Int, authorId)
        .input("memory_id", sql.Int, selectedMemoryIds[index])
        .input("sort_order", sql.Int, index + 1)
        .input("is_anchor", sql.Bit, index === 0 ? 1 : 0)
        .query(`
          INSERT INTO dbo.identity_story_memory (
            story_id, author_id, memory_id, sort_order, story_role,
            link_strength, evidence_reason, timeline_at,
            source_date_kind, is_anchor, created_at, updated_at
          )
          VALUES (
            @story_id, @author_id, @memory_id, @sort_order,
            CASE WHEN @is_anchor = 1 THEN 'anchor' ELSE 'supporting' END,
            100, N'Memória adicionada pelo autor ao iniciar esta História.',
            SYSUTCDATETIME(), 'created_at', @is_anchor,
            SYSUTCDATETIME(), SYSUTCDATETIME()
          );
        `);
    }

    await tx.commit();
    return res.status(201).json({
      ok: true,
      story_id: storyId,
      origin: "CREATED_BY_AUTHOR",
      selected_memory_ids: selectedMemoryIds,
      editorial_url: `/stories/${storyId}/editorial`,
    });
  } catch (error) {
    try { await tx.rollback(); } catch {}
    return next(error);
  }
});

router.post("/discover", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const result = await discoverAndPersistStoriesForAuthor({
      authorId,
      memories: Array.isArray(req.body?.memories) ? req.body.memories : [],
      limit: req.body?.limit,
    });

    return res.json(normalizeStoryExperiencePayload(result, {
      showAll: toBoolean(req.body?.showAll || req.query?.showAll),
      limit: req.body?.limit || req.query?.limit,
    }));
  } catch (error) {
    return next(error);
  }
});

router.post("/:storyId/accept", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });

    return res.json(await acceptNarrativeStory({ authorId, storyId }));
  } catch (error) {
    return next(error);
  }
});


router.delete("/:storyId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;
    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ ok: false, error: "storyId inválido." });

    const pool = await getPool();
    const result = await pool.request()
      .input("author_id", sql.Int, authorId)
      .input("story_id", sql.Int, storyId)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;

        IF NOT EXISTS (
          SELECT 1 FROM dbo.identity_story
          WHERE story_id = @story_id
            AND author_id = @author_id
            AND ISNULL(is_deleted, 0) = 0
        )
        BEGIN
          ROLLBACK TRANSACTION;
          SELECT CAST(0 AS int) AS affected_rows;
          RETURN;
        END

        -- Lifecycle editorial: retira a Story do fluxo ativo, preservando
        -- versões e lineage para rastreabilidade histórica.
        IF OBJECT_ID('dbo.identity_story_memory', 'U') IS NOT NULL
          DELETE FROM dbo.identity_story_memory
          WHERE story_id = @story_id AND author_id = @author_id;

        IF OBJECT_ID('dbo.identity_story_timeline', 'U') IS NOT NULL
          DELETE FROM dbo.identity_story_timeline
          WHERE story_id = @story_id;

        IF OBJECT_ID('dbo.identity_story_relationship', 'U') IS NOT NULL
          DELETE FROM dbo.identity_story_relationship
          WHERE story_id = @story_id;

        UPDATE dbo.identity_story
        SET is_deleted = 1,
            status = 'ARCHIVED',
            story_publication_status = CASE
              WHEN COL_LENGTH('dbo.identity_story','story_publication_status') IS NOT NULL THEN 'DRAFT'
              ELSE story_publication_status END,
            updated_at = SYSUTCDATETIME()
        WHERE story_id = @story_id
          AND author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;

        DECLARE @affected_rows int = @@ROWCOUNT;
        COMMIT TRANSACTION;
        SELECT @affected_rows AS affected_rows;
      `);

    const affectedRows = Number(result.recordset?.[0]?.affected_rows || 0);
    if (!affectedRows) return res.status(404).json({ ok: false, error: "História salva não encontrada para descarte." });
    return res.json({ ok: true, story_id: storyId, discarded: true });
  } catch (error) { return next(error); }
});

router.post("/:storyId/discard", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });

    return res.json(await discardNarrativeStory({ authorId, storyId }));
  } catch (error) {
    return next(error);
  }
});

router.post("/:storyId/snooze", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const storyId = toPositiveInt(req.params.storyId);
    if (!storyId) return res.status(400).json({ error: "storyId inválido." });

    return res.json(await snoozeNarrativeStory({
      authorId,
      storyId,
      snoozedUntil: req.body?.snoozed_until || req.body?.snoozedUntil || null,
    }));
  } catch (error) {
    return next(error);
  }
});

export default router;
