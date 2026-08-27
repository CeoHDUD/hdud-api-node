// C:\HDUD_DATA\hdud-api-node\src\services\memory-editorial-intelligence.service.js

import { getPool, sql } from "../db.js";
import { assertExternalAIAllowed, extractOpenAIUsage, recordExternalAIUsage } from "./ai-cost-usage.service.js";
import { getPath as getNtgPath } from "./ntg/ntg.service.js";
import { classifyLocalMemoryV2, MEI_LOCAL_ENGINE_VERSION } from "./mei/local-classifier.service.js";

const MEI_ENGINE_VERSION = MEI_LOCAL_ENGINE_VERSION;
const DEFAULT_MODEL = process.env.HDUD_MEI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";

const LIFE_PERIODS = null;
const EDITORIAL_CONTEXTS = null;
const NARRATIVE_ROLES = null;
const CERTAINTY = null;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function clampConfidence(value, fallback = 0.75) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Number(n.toFixed(4));
}

function normalizeCode(value, allowed, fallback, maxLen = 80) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return fallback;
  const clean = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, maxLen);
  if (!clean) return fallback;
  if (allowed && !allowed.has(clean)) return fallback;
  return clean;
}

function normalizeFreeCode(value, fallback = null, maxLen = 120) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const clean = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, maxLen);
  return clean || fallback;
}

function normalizeNullableText(value, maxLen = 1000) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, maxLen) : null;
}

function oneLine(value, maxLen = 260) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > maxLen ? `${s.slice(0, maxLen - 1).trim()}…` : s;
}

function safeJsonParse(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const withoutFence = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(withoutFence); } catch {}
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(withoutFence.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalizeSignalText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, words) {
  const s = ` ${normalizeSignalText(text)} `;
  return words.some((word) => {
    const needle = normalizeSignalText(word);
    return needle && s.includes(` ${needle} `);
  });
}

function memoryText(memory) {
  return `${memory?.title || ""} ${memory?.content || ""}`;
}

// LIFE_PERIOD V2: somente sinais cronológicos reais.
// Domínios de vida (família, trabalho, saúde, casamento, HDUD etc.) nunca são período.
function inferLifePeriod(memory) {
  const text = memoryText(memory);
  if (containsAny(text, ["nasci", "meu nascimento", "quando eu nasci"])) return { code: "BIRTH", score: 0.96 };
  if (containsAny(text, ["primeira infancia", "bebe", "berco", "creche"])) return { code: "EARLY_CHILDHOOD", score: 0.90 };
  if (containsAny(text, ["infancia", "quando eu era crianca", "quando era crianca", "quando eu era menino", "quando era menina"])) return { code: "CHILDHOOD", score: 0.92 };
  if (containsAny(text, ["adolescencia", "adolescente", "quando eu era adolescente"])) return { code: "ADOLESCENCE", score: 0.94 };
  if (containsAny(text, ["juventude", "quando eu era jovem"])) return { code: "YOUTH", score: 0.88 };
  if (containsAny(text, ["inicio da vida adulta", "jovem adulto", "jovem adulta"])) return { code: "YOUNG_ADULT", score: 0.90 };
  if (containsAny(text, ["vida adulta", "quando adulto", "quando adulta"])) return { code: "ADULT_LIFE", score: 0.88 };
  if (containsAny(text, ["maturidade", "meia idade"])) return { code: "MATURITY", score: 0.86 };
  if (containsAny(text, ["velhice", "terceira idade", "idoso", "idosa"])) return { code: "LATER_LIFE", score: 0.90 };
  return { code: null, score: 0 };
}

function inferContext(memory) {
  const text = memoryText(memory);

  const familySignal = containsAny(text, [
    "minha mae", "meu pai", "mama", "mamae", "papai", "meus pais", "minha familia",
    "meu filho", "minha filha", "meus filhos", "minhas filhas", "felipe", "zezo"
  ]);
  const affectionSignal = containsAny(text, [
    "grato", "gratidao", "carinho", "afeto", "presente", "ao meu lado", "cuidou", "cuidado", "amor"
  ]);

  if (familySignal && affectionSignal) return { code: "FAMILY_AFFECTION", score: 0.90 };
  if (familySignal) return { code: "FAMILY", score: 0.84 };
  if (containsAny(text, ["bruna", "namoro", "esposa", "marido", "casamento", "relacionamento amoroso"])) return { code: "LOVE", score: 0.88 };
  if (containsAny(text, ["hdud", "historias de um desconhecido", "plataforma hdud"])) return { code: "HDUD", score: 0.95 };
  if (containsAny(text, ["hospital", "cirurgia", "internacao", "saude", "coluna", "l5", "diagnostico", "tratamento"])) return { code: "HEALTH", score: 0.93 };
  if (containsAny(text, ["sql", "dba", "trabalho", "empresa", "emprego", "profissao", "carreira"])) return { code: "WORK", score: 0.88 };
  if (containsAny(text, ["escola", "colegio", "faculdade", "universidade", "professor", "curso", "estudo"])) return { code: "EDUCATION", score: 0.88 };
  if (containsAny(text, ["futebol", "cbf", "jogo", "time", "campeonato"])) return { code: "SPORT", score: 0.90 };
  if (containsAny(text, ["viagem", "viajei", "hotel", "aviao", "ferias"])) return { code: "TRAVEL", score: 0.84 };
  if (containsAny(text, ["luto", "morreu", "morte", "despedida", "perda de"])) return { code: "LOSS", score: 0.90 };
  if (containsAny(text, ["identidade", "quem eu fui", "quem sou", "autoconhecimento"])) return { code: "IDENTITY", score: 0.88 };
  if (containsAny(text, ["proposito", "missao de vida", "sentido da vida"])) return { code: "PURPOSE", score: 0.88 };
  if (containsAny(text, ["conquista", "vitoria", "aprovacao", "certificacao", "premio"])) return { code: "ACHIEVEMENT", score: 0.86 };

  return { code: null, score: 0 };
}

function inferNarrativeRole(memory, contextCode) {
  const text = memoryText(memory);
  if (containsAny(text, ["primeira vez", "origem", "onde tudo comecou", "como tudo comecou"])) return { code: "ORIGIN", score: 0.90 };
  if (containsAny(text, ["decidi", "decisao", "escolhi", "resolvi"])) return { code: "DECISION", score: 0.92 };
  if (containsAny(text, ["descobri", "percebi", "entendi", "me dei conta"])) return { code: "DISCOVERY", score: 0.90 };
  if (containsAny(text, ["dificuldade", "obstaculo", "barreira"])) return { code: "OBSTACLE", score: 0.88 };
  if (containsAny(text, ["briga", "conflito", "tensao", "disputa"])) return { code: "CONFLICT", score: 0.90 };
  if (containsAny(text, ["crise", "internacao", "cirurgia", "hospital"])) return { code: "CRISIS", score: 0.90 };
  if (containsAny(text, ["mudou minha vida", "transformou", "ponto de virada", "renasci"])) return { code: "TRANSFORMATION", score: 0.92 };
  if (containsAny(text, ["aprendi", "licao", "ensinou", "aprendizado"])) return { code: "LEARNING", score: 0.90 };
  if (containsAny(text, ["legado", "ser lembrado", "ser lembrada", "preservar minha historia"])) return { code: "LEGACY", score: 0.90 };
  if (containsAny(text, ["prova", "evidencia", "registro", "documento", "fotografia"])) return { code: "EVIDENCE", score: 0.86 };
  if (containsAny(text, ["grato", "gratidao", "refletindo", "olhando para tras"])) return { code: "REFLECTION", score: 0.86 };

  // Contexto simples pode legitimamente exercer papel de contextualização.
  if (contextCode === "FAMILY_AFFECTION") return { code: "REFLECTION", score: 0.80 };
  if (contextCode === "FAMILY" || contextCode === "LOVE" || contextCode === "WORK" || contextCode === "EDUCATION") {
    return { code: "CONTEXT", score: 0.76 };
  }
  if (contextCode === "HDUD") return { code: "DISCOVERY", score: 0.78 };
  if (contextCode === "HEALTH") return { code: "CRISIS", score: 0.76 };

  return { code: null, score: 0 };
}

function confidenceFromSignals(signals) {
  const scores = signals.filter((x) => x?.code).map((x) => Number(x.score || 0)).filter(Number.isFinite);
  if (!scores.length) return 0.35;
  return clampConfidence(scores.reduce((a, b) => a + b, 0) / scores.length, 0.35);
}

function certaintyFromConfidence(confidence) {
  if (confidence >= 0.88) return "HIGH";
  if (confidence >= 0.68) return "MEDIUM";
  return "LOW";
}

function deterministicInterpretation(memory, reason = "Classificação editorial automática local da HDUD — sem consumo de IA externa.") {
  const result = classifyLocalMemoryV2(memory, reason);
  const { _signals, ...payload } = result;
  return normalizeEditorialPayload(payload);
}

export function classifyLocalMemory(memory, reason = "Classificação editorial automática local da HDUD — sem consumo de IA externa.") {
  return deterministicInterpretation(memory, reason);
}

function normalizeEditorialPayload(input = {}) {
  const context = normalizeCode(input.context_code ?? input.editorial_context ?? input.context, EDITORIAL_CONTEXTS, null, 40);
  const role = normalizeCode(input.narrative_role_code ?? input.narrative_role, NARRATIVE_ROLES, null, 40);
  const life = normalizeCode(input.life_period_code ?? input.life_period, LIFE_PERIODS, null, 40);
  const certainty = normalizeCode(input.editorial_certainty, CERTAINTY, "MEDIUM", 20);
  const arc = normalizeFreeCode(input.narrative_arc_code ?? input.narrative_arc, null, 80);
  const canonicalKey = normalizeFreeCode(input.canonical_story_key, null, 120);
  return {
    life_period_code: life,
    narrative_arc_code: arc,
    context_code: context,
    narrative_role_code: role,
    historical_importance: clampInt(input.historical_importance ?? input.historicalImportance ?? input.importance, 1, 5, 3),
    narrative_importance: clampInt(input.narrative_importance ?? input.narrativeImportance ?? input.importance, 1, 5, 3),
    emotional_intensity: clampInt(input.emotional_intensity ?? input.emotionalIntensity ?? input.emotional_weight, 1, 5, 3),
    emotional_valence: clampInt(input.emotional_valence ?? input.emotionalValence, -2, 2, 0),
    canonical_story_key: canonicalKey,
    canonical_story_title: normalizeNullableText(input.canonical_story_title, 240),
    editorial_notes: normalizeNullableText(input.editorial_notes, 1000),
    ai_confidence: clampConfidence(input.ai_confidence, 0.35),
    editorial_certainty: certainty,
    interpretation_source: normalizeFreeCode(input.interpretation_source, "AI_LOCAL", 40),
    classified_by: normalizeFreeCode(input.classified_by, "HDUD_LOCAL", 40),
    classification_version: normalizeFreeCode(input.classification_version, MEI_ENGINE_VERSION, 40),
  };
}

function normalizeNarrativePathCode(value, maxLen = 120) {
  return normalizeFreeCode(value, null, maxLen);
}

function buildNarrativePathText(lifePeriodCode, contextCode, narrativeRoleCode) {
  const parts = [lifePeriodCode, contextCode, narrativeRoleCode]
    .map((value) => normalizeNarrativePathCode(value))
    .filter(Boolean);
  return parts.length === 3 ? parts.join(" > ") : null;
}

function mapNarrativePathRow(row) {
  if (!row) return null;
  return {
    depth: Number(row.depth || 0),
    source_domain: row.source_domain || null,
    source_code: row.source_code || null,
    target_domain: row.target_domain || null,
    target_code: row.target_code || null,
    node_path: row.node_path || null,
    relation_path: row.relation_path || null,
    path_weight: row.path_weight != null ? Number(row.path_weight) : null,
  };
}

async function validateNarrativePath(_pool, {
  lifePeriodCode,
  contextCode,
  narrativeRoleCode,
} = {}) {
  const life = normalizeNarrativePathCode(lifePeriodCode);
  const context = normalizeNarrativePathCode(contextCode);
  const role = normalizeNarrativePathCode(narrativeRoleCode);

  if (!life || !context || !role) {
    return {
      valid: false,
      complete: false,
      reason: "NARRATIVE_PATH_INCOMPLETE",
      path: buildNarrativePathText(life, context, role),
      graph_path: null,
    };
  }

  try {
    // Fonte única de verdade: exatamente o mesmo runtime NTG consumido por
    // GET /api/taxonomy/path. Não reproduzir a regra com SQL paralelo.
    const payload = await getNtgPath({
      lifePeriodCode: life,
      contextCode: context,
      narrativeRoleCode: role,
      locale: "pt-BR",
    });

    const explicitValid =
      payload?.valid ??
      payload?.is_valid ??
      payload?.found ??
      payload?.compatible ??
      payload?.path?.found;

    const valid = Boolean(explicitValid);

    return {
      valid,
      complete: true,
      reason: valid ? null : (payload?.reason || payload?.code || "NARRATIVE_PATH_INVALID"),
      path: buildNarrativePathText(life, context, role),
      graph_path: payload?.path ?? payload?.graph_path ?? payload ?? null,
    };
  } catch (err) {
    return {
      valid: false,
      complete: true,
      reason:
        err?.code ||
        err?.details?.code ||
        err?.cause?.code ||
        "NARRATIVE_PATH_INVALID",
      path: buildNarrativePathText(life, context, role),
      graph_path: null,
    };
  }
}

function mapEditorialRow(row) {
  if (!row) return null;
  return { memory_id: Number(row.memory_id), author_id: Number(row.author_id), version_number: Number(row.version_number || 1), life_period_code: row.life_period_code || null, life_period: row.life_period_code || null, narrative_path: buildNarrativePathText(row.life_period_code, row.context_code, row.narrative_role_code), narrative_arc_code: row.narrative_arc_code || null, narrative_arc: row.narrative_arc_code || null, context_code: row.context_code || null, editorial_context: row.context_code || null, narrative_role_code: row.narrative_role_code || null, narrative_role: row.narrative_role_code || null, historical_importance: row.historical_importance ?? row.importance ?? 3, narrative_importance: row.narrative_importance ?? row.importance ?? 3, emotional_intensity: row.emotional_intensity ?? row.emotional_weight ?? 3, emotional_valence: row.emotional_valence ?? 0, importance: row.importance ?? row.narrative_importance ?? 3, emotional_weight: row.emotional_weight ?? row.emotional_intensity ?? 3, story_candidate: !!row.story_candidate, chapter_candidate: !!row.chapter_candidate, book_candidate: !!row.book_candidate, canonical_story_key: row.canonical_story_key || null, canonical_story_title: row.canonical_story_title || null, editorial_notes: row.editorial_notes || null, ai_confidence: row.ai_confidence != null ? Number(row.ai_confidence) : null, editorial_certainty: row.editorial_certainty || "MEDIUM", interpretation_source: row.interpretation_source || row.classified_by || "AI", classified_by: row.classified_by || "AI", classification_version: row.classification_version || MEI_ENGINE_VERSION, created_by: row.created_by || null, created_at: row.created_at || null, updated_by: row.updated_by || null, updated_at: row.updated_at || null, last_change_reason: row.last_change_reason || null, is_current: row.is_current !== false && row.is_current !== 0 };
}

function mapAffinityRow(row) {
  if (!row) return null;
  return { memory_id: Number(row.memory_id), author_id: Number(row.author_id), story_affinity: Number(row.story_affinity || 0), chapter_affinity: Number(row.chapter_affinity || 0), book_affinity: Number(row.book_affinity || 0), engine_version: row.engine_version || MEI_ENGINE_VERSION, calculated_at: row.calculated_at || null };
}

async function fetchMemory(pool, memoryId, authorId = null) {
  const result = await pool.request().input("memory_id", sql.Int, Number(memoryId)).input("author_id", sql.Int, authorId == null ? null : Number(authorId)).query(`
      SELECT TOP 1 memory_id, author_id, title, content, created_at, version_number, phase_id, publication_status
      FROM dbo.identity_memory
      WHERE memory_id = @memory_id
        AND ISNULL(is_deleted, 0) = 0
        AND (@author_id IS NULL OR author_id = @author_id);
    `);
  return result.recordset?.[0] || null;
}

async function loadActiveNtgVocabulary(pool) {
  const result = await pool.request().query(`
    SELECT
      UPPER(LTRIM(RTRIM(t.domain))) AS domain,
      UPPER(LTRIM(RTRIM(t.code))) AS code,
      COALESCE(NULLIF(LTRIM(RTRIM(tr.label)), ''), t.code) AS label
    FROM dbo.mei_taxonomy t
    OUTER APPLY (
      SELECT TOP 1 label
      FROM dbo.mei_taxonomy_translation x
      WHERE x.taxonomy_id = t.taxonomy_id
        AND LOWER(LTRIM(RTRIM(x.locale))) = 'pt-br'
      ORDER BY x.translation_id DESC
    ) tr
    WHERE ISNULL(t.is_active,1)=1
      AND UPPER(LTRIM(RTRIM(t.domain))) IN ('LIFE_PERIOD','EDITORIAL_CONTEXT','NARRATIVE_ROLE')
    ORDER BY t.domain, t.sort_order, t.code;
  `);
  const rows = result.recordset || [];
  const compact = (domain) => rows.filter(r => r.domain === domain).map(r => `${r.code}=${r.label}`).join(' | ');
  return {
    lifePeriods: compact('LIFE_PERIOD'),
    contexts: compact('EDITORIAL_CONTEXT'),
    roles: compact('NARRATIVE_ROLE'),
  };
}

async function callOpenAiForEditorial(memory) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const content = String(memory?.content || "").trim();
  if (!content && !String(memory?.title || "").trim()) return null;

  const pool = await getPool();
  const vocab = await loadActiveNtgVocabulary(pool);
  const prompt = `Você é a IA Editorial da HDUD. Interprete semanticamente a memória, sem inventar fatos. Não classifique por uma palavra isolada: considere quem é o sujeito, a relação descrita, o acontecimento e o sentido global do texto. Exemplo de regra semântica: mencionar a palavra "pai" não significa automaticamente FATHERHOOD; uma lembrança sobre a mãe não deve virar paternidade apenas por heurística lexical.

Use SOMENTE códigos existentes no vocabulário NTG abaixo. Devolva APENAS JSON válido com os campos: life_period_code, narrative_arc_code, context_code, narrative_role_code, historical_importance, narrative_importance, emotional_intensity, emotional_valence, canonical_story_key, canonical_story_title, editorial_notes, ai_confidence, editorial_certainty.

LIFE_PERIOD: ${vocab.lifePeriods}
EDITORIAL_CONTEXT: ${vocab.contexts}
NARRATIVE_ROLE: ${vocab.roles}

Título: ${String(memory?.title || "").slice(0, 500)}
Conteúdo: ${content.slice(0, 12000)}`;
  await assertExternalAIAllowed({ pool, authorId: memory?.author_id });
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: DEFAULT_MODEL, input: prompt, temperature: 0.1, max_output_tokens: 1400 }) });
  if (!response.ok) return null;
  const data = await response.json();
  await recordExternalAIUsage({
    pool,
    authorId: memory?.author_id,
    operationCode: "MEI_EXTERNAL_REGENERATE",
    model: data?.model || DEFAULT_MODEL,
    ...extractOpenAIUsage(data),
    entityType: "MEMORY",
    entityId: memory?.memory_id,
    metadata: { explicit_opt_in: true },
  });
  const text = data?.output_text || data?.output?.[0]?.content?.[0]?.text || data?.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object") return null;
  return normalizeEditorialPayload({ ...parsed, interpretation_source: "AI_OPENAI", classified_by: "AI", classification_version: MEI_ENGINE_VERSION });
}

async function upsertEditorial(params = {}) {
  const pool = params.pool || await getPool();
  const payload = normalizeEditorialPayload(params.payload || {});
  const result = await pool.request()
    .input("memory_id", sql.Int, Number(params.memoryId)).input("author_id", sql.Int, Number(params.authorId))
    .input("life_period_code", sql.VarChar(40), payload.life_period_code).input("narrative_arc_code", sql.VarChar(80), payload.narrative_arc_code)
    .input("context_code", sql.VarChar(40), payload.context_code).input("narrative_role_code", sql.VarChar(40), payload.narrative_role_code)
    .input("historical_importance", sql.TinyInt, payload.historical_importance).input("narrative_importance", sql.TinyInt, payload.narrative_importance)
    .input("emotional_intensity", sql.TinyInt, payload.emotional_intensity).input("emotional_valence", sql.SmallInt, payload.emotional_valence)
    .input("canonical_story_key", sql.VarChar(120), payload.canonical_story_key).input("canonical_story_title", sql.NVarChar(240), payload.canonical_story_title)
    .input("editorial_notes", sql.NVarChar(1000), payload.editorial_notes).input("ai_confidence", sql.Decimal(5, 4), payload.ai_confidence)
    .input("editorial_certainty", sql.VarChar(20), payload.editorial_certainty).input("interpretation_source", sql.VarChar(40), payload.interpretation_source)
    .input("classified_by", sql.VarChar(40), payload.classified_by).input("classification_version", sql.VarChar(40), payload.classification_version)
    .input("change_reason", sql.NVarChar(500), normalizeNullableText(params.changeReason, 500)).input("changed_by", sql.NVarChar(200), normalizeNullableText(params.changedBy, 200))
    .execute("dbo.p_MemoryEditorial_Upsert");
  const editorial = mapEditorialRow(result.recordset?.[0] || null);
  await recalculateAffinity({ memoryId: params.memoryId, authorId: params.authorId });
  return editorial;
}


export async function resolveNarrativeContextForMemory({
  memoryId,
  authorId = null,
  requireValidPath = true,
} = {}) {
  const pool = await getPool();
  const memory = await fetchMemory(pool, memoryId, authorId);

  if (!memory) {
    const err = new Error("Memória não encontrada ou sem permissão.");
    err.status = 404;
    throw err;
  }

  const currentResult = await pool.request()
    .input("memory_id", sql.Int, Number(memory.memory_id))
    .input("author_id", sql.Int, Number(memory.author_id))
    .execute("dbo.p_MemoryEditorial_Get");

  const editorial = mapEditorialRow(currentResult.recordset?.[0] || null);

  if (!editorial) {
    return {
      ok: true,
      memory_id: Number(memory.memory_id),
      author_id: Number(memory.author_id),
      configured: false,
      valid: false,
      reason: "NARRATIVE_CURATION_NOT_CONFIGURED",
      narrative_context: null,
    };
  }

  const validation = await validateNarrativePath(pool, {
    lifePeriodCode: editorial.life_period_code,
    contextCode: editorial.context_code,
    narrativeRoleCode: editorial.narrative_role_code,
  });

  const legacyPath = validation.complete === true && validation.valid === false;

  // Compatibilidade com memórias classificadas antes do NTG atual.
  // O caminho legado é preservado como contexto editorial e nunca bloqueia a IA.
  // requireValidPath é mantido no contrato por compatibilidade, mas a soberania
  // autoral prevalece: nenhuma classificação persistida é alterada automaticamente.
  void requireValidPath;

  return {
    ok: true,
    memory_id: Number(memory.memory_id),
    author_id: Number(memory.author_id),
    configured: true,
    valid: validation.valid,
    legacy_path: legacyPath,
    reason: legacyPath ? "LEGACY_NARRATIVE_PATH" : validation.reason,
    narrative_context: {
      life_period: {
        code: editorial.life_period_code,
        label: editorial.life_period_code,
      },
      editorial_context: {
        code: editorial.context_code,
        label: editorial.context_code,
      },
      narrative_role: {
        code: editorial.narrative_role_code,
        label: editorial.narrative_role_code,
      },
      narrative_path: validation.path,
      graph_path: validation.graph_path,
      valid: validation.valid,
      legacy_path: legacyPath,
      validation_reason: legacyPath ? "LEGACY_NARRATIVE_PATH" : validation.reason,
      classification_source: editorial.classified_by || editorial.interpretation_source || "AUTHOR",
      classification_version: editorial.classification_version || MEI_ENGINE_VERSION,
      author_sovereignty: true,
      immutable_for_ai: true,
    },
  };
}

export async function getEditorial({ memoryId, authorId = null, createIfMissing = true, changedBy = null } = {}) {
  const pool = await getPool();
  const memory = await fetchMemory(pool, memoryId, authorId);
  if (!memory) { const err = new Error("Memória não encontrada ou sem permissão."); err.status = 404; throw err; }
  const result = await pool.request().input("memory_id", sql.Int, Number(memoryId)).input("author_id", sql.Int, Number(memory.author_id)).execute("dbo.p_MemoryEditorial_Get");
  const existing = mapEditorialRow(result.recordset?.[0] || null);
  if (existing) {
    const validation = await validateNarrativePath(pool, {
      lifePeriodCode: existing.life_period_code,
      contextCode: existing.context_code,
      narrativeRoleCode: existing.narrative_role_code,
    });
    return {
      ok: true,
      created: false,
      memory: { memory_id: Number(memory.memory_id), author_id: Number(memory.author_id), title: memory.title || null },
      editorial: existing,
      narrative_path: validation,
    };
  }
  if (!createIfMissing) return { ok: true, created: false, memory: { memory_id: Number(memory.memory_id), author_id: Number(memory.author_id), title: memory.title || null }, editorial: null };
  const initial = deterministicInterpretation(memory, "Interpretação editorial inicial criada automaticamente ao abrir a memória.");
  const created = await upsertEditorial({ pool, memoryId: Number(memory.memory_id), authorId: Number(memory.author_id), payload: initial, changeReason: "Interpretação editorial inicial", changedBy });
  return { ok: true, created: true, memory: { memory_id: Number(memory.memory_id), author_id: Number(memory.author_id), title: memory.title || null }, editorial: created };
}

export async function updateEditorial({ memoryId, authorId = null, payload = {}, changedBy = null, changeReason = null } = {}) {
  const pool = await getPool();
  const memory = await fetchMemory(pool, memoryId, authorId);
  if (!memory) { const err = new Error("Memória não encontrada ou sem permissão."); err.status = 404; throw err; }
  const currentResult = await pool.request().input("memory_id", sql.Int, Number(memory.memory_id)).input("author_id", sql.Int, Number(memory.author_id)).execute("dbo.p_MemoryEditorial_Get");
  const current = mapEditorialRow(currentResult.recordset?.[0] || null) || {};
  const merged = { ...current, ...payload, interpretation_source: payload.interpretation_source || "AUTHOR", classified_by: payload.classified_by || "AUTHOR", classification_version: payload.classification_version || MEI_ENGINE_VERSION };
  // Curadoria autoral: salvar uma alteração parcial (por exemplo, somente
  // life_period_code) não deve ser bloqueado por um caminho NTG legado ou
  // ainda incompleto. O NTG continua sendo calculado/consultado para leitura,
  // descoberta e validação informativa, mas não é uma trava de persistência.
  // Isso também preserva contexto/papel já existentes quando o autor altera
  // apenas o período da vida.
  const editorial = await upsertEditorial({ pool, memoryId: Number(memory.memory_id), authorId: Number(memory.author_id), payload: merged, changeReason: changeReason || "Curadoria editorial autoral", changedBy });
  return { ok: true, memory: { memory_id: Number(memory.memory_id), author_id: Number(memory.author_id), title: memory.title || null }, editorial };
}

export async function regenerateEditorial({ memoryId, authorId = null, changedBy = null, useExternalAi = false, forceLocal = false } = {}) {
  const pool = await getPool();
  const memory = await fetchMemory(pool, memoryId, authorId);
  if (!memory) { const err = new Error("Memória não encontrada ou sem permissão."); err.status = 404; throw err; }
  let generated = null;
  // Classificação automática HDUD: custo zero de LLM.
  // IA externa é opt-in explícito; salvar/criar memória nunca a chama por padrão.
  if (useExternalAi === true && forceLocal !== true) {
    try {
      generated = await callOpenAiForEditorial(memory);
      if (generated) {
        const validation = await validateNarrativePath(pool, {
          lifePeriodCode: generated.life_period_code,
          contextCode: generated.context_code,
          narrativeRoleCode: generated.narrative_role_code,
        });
        if (!validation.valid) {
          console.warn("[MEI] IA retornou caminho fora do NTG; usando fallback seguro:", validation.reason, validation.path);
          generated = null;
        }
      }
    } catch (err) {
      console.warn("[MEI] Falha ao regenerar com IA externa:", err?.message || err);
    }
  }
  if (!generated) generated = deterministicInterpretation(memory, useExternalAi ? "Classificação editorial local após indisponibilidade ou classificação NTG inválida da IA." : "Classificação editorial automática local da HDUD — sem consumo de IA externa.");

  const currentResult = await pool.request()
    .input("memory_id", sql.Int, Number(memory.memory_id))
    .input("author_id", sql.Int, Number(memory.author_id))
    .execute("dbo.p_MemoryEditorial_Get");
  const current = mapEditorialRow(currentResult.recordset?.[0] || null) || {};

  const currentIsAuthor =
    String(current.interpretation_source || "").toUpperCase() === "AUTHOR" ||
    String(current.classified_by || "").toUpperCase() === "AUTHOR";

  const preservedAuthorCuration = currentIsAuthor
    ? {
        ...generated,
        life_period_code: current.life_period_code ?? generated.life_period_code,
        context_code: current.context_code ?? generated.context_code,
        narrative_role_code: current.narrative_role_code ?? generated.narrative_role_code,
        narrative_arc_code: current.narrative_arc_code ?? generated.narrative_arc_code,
        canonical_story_key: current.canonical_story_key ?? generated.canonical_story_key,
        canonical_story_title: current.canonical_story_title ?? generated.canonical_story_title,
        interpretation_source: "AUTHOR",
        classified_by: "AUTHOR",
      }
    : generated;

  const editorial = await upsertEditorial({ pool, memoryId: Number(memory.memory_id), authorId: Number(memory.author_id), payload: preservedAuthorCuration, changeReason: "Regeneração silenciosa da interpretação editorial", changedBy });
  return { ok: true, provider: generated.interpretation_source || "AI_LOCAL", model: generated.interpretation_source === "AI_OPENAI" ? DEFAULT_MODEL : "HDUD_LOCAL_MEI", memory: { memory_id: Number(memory.memory_id), author_id: Number(memory.author_id), title: memory.title || null }, editorial };
}

export async function listEditorialHistory({ memoryId, authorId = null } = {}) {
  const pool = await getPool();
  const memory = await fetchMemory(pool, memoryId, authorId);
  if (!memory) { const err = new Error("Memória não encontrada ou sem permissão."); err.status = 404; throw err; }
  const result = await pool.request().input("memory_id", sql.Int, Number(memory.memory_id)).input("author_id", sql.Int, Number(memory.author_id)).execute("dbo.p_MemoryEditorial_History");
  return { ok: true, memory_id: Number(memory.memory_id), author_id: Number(memory.author_id), history: (result.recordset || []).map(mapEditorialRow) };
}

export async function recalculateAffinity({ memoryId, authorId = null } = {}) {
  const pool = await getPool();
  const result = await pool.request().input("memory_id", sql.Int, Number(memoryId)).input("author_id", sql.Int, authorId == null ? null : Number(authorId)).input("engine_version", sql.VarChar(40), MEI_ENGINE_VERSION).execute("dbo.p_MemoryAffinity_Recalculate");
  return { ok: true, affinity: mapAffinityRow(result.recordset?.[0] || null) };
}

export async function getAffinity({ memoryId, authorId = null, recalculateIfMissing = true } = {}) {
  const pool = await getPool();
  const result = await pool.request().input("memory_id", sql.Int, Number(memoryId)).input("author_id", sql.Int, authorId == null ? null : Number(authorId)).execute("dbo.p_MemoryAffinity_Get");
  const found = mapAffinityRow(result.recordset?.[0] || null);
  if (found || !recalculateIfMissing) return { ok: true, affinity: found };
  return recalculateAffinity({ memoryId, authorId });
}

export const MemoryEditorialIntelligenceService = { getEditorial, updateEditorial, regenerateEditorial, listEditorialHistory, recalculateAffinity, getAffinity, resolveNarrativeContextForMemory };
