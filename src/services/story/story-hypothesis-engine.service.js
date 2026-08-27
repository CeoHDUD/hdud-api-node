// C:\HDUD_DATA\hdud-api-node\src\services\story\story-hypothesis-engine.service.js
//
// GO LIVE 006.4.3 — Story Hypothesis Calibration
// Responsabilidade: descobrir múltiplas histórias humanas independentes
// antes de Seed, Candidate, Blueprint, Narrative Arc e NGI.
//
// Princípios:
// - Narrative Path / Narrative Family são a estrutura primária;
// - texto e sinais narrativos validam e qualificam;
// - nenhuma hipótese global pode engolir famílias independentes;
// - cada hipótese precisa de pelo menos duas memórias;
// - memórias sem par permanecem sem hipótese;
// - nenhuma história é escrita ou persistida aqui.

import {
  compareMemoryDate,
  extractNarrativeSignals,
  memoryCanonicalDate,
  memoryIdOf,
  memoryText,
  normalizeKey,
  safeYear,
} from "./story-continuity.service.js";
import { extractNarrativePath } from "./story-narrative-path.service.js";

const ENGINE_VERSION = "story-hypothesis-engine-v6.4.3-narrative-family-first";

const MIN_MEMORIES_PER_STORY = 2;
const DEFAULT_MAX_HYPOTHESES = 6;
const MAX_MEMORIES_PER_STORY = 12;
const MIN_VISIBLE_CONFIDENCE = 52;

const FAMILY_BY_CONTEXT = new Map([
  ["love", "relationships"],
  ["relationship", "relationships"],
  ["romance", "relationships"],
  ["marriage", "relationships"],
  ["partnership", "relationships"],

  ["child_birth", "paternity"],
  ["fatherhood", "paternity"],
  ["paternity", "paternity"],
  ["maternity", "maternity"],

  ["hdud", "hdud"],

  ["technology", "career"],
  ["work", "career"],
  ["career", "career"],
  ["profession", "career"],
  ["leadership", "career"],

  ["education", "education"],
  ["school", "education"],
  ["school_change", "education"],

  ["health", "health"],
  ["hospital", "health"],
  ["recovery", "health"],

  ["family", "family"],
  ["sport", "sport"],
  ["travel", "travel"],
  ["culture", "culture"],
]);

const FAMILY_BY_LIFE_PERIOD = new Map([
  ["relationship", "relationships"],
  ["relationships", "relationships"],
  ["marriage", "relationships"],

  ["paternity", "paternity"],
  ["fatherhood", "paternity"],
  ["maternity", "maternity"],

  ["hdud", "hdud"],
  ["hdud_era", "hdud"],

  ["career", "career"],
  ["professional_life", "career"],
  ["first_job", "career"],

  ["education", "education"],
  ["school", "education"],

  ["health_crisis", "health"],
  ["recovery", "health"],

  ["childhood", "childhood"],
]);

const FAMILY_CONTRACTS = {
  relationships: {
    code: "RELATIONSHIPS",
    title: "Relacionamentos e amor",
    question: "Como meus relacionamentos transformaram minha vida?",
    transformation: "Do encontro à construção de vínculos que mudaram minha trajetória.",
  },
  paternity: {
    code: "PATERNITY",
    title: "Tornando-me pai",
    question: "Como a paternidade transformou quem eu sou?",
    transformation: "Do nascimento de um filho à formação de uma identidade paterna.",
  },
  maternity: {
    code: "MATERNITY",
    title: "Tornando-me mãe",
    question: "Como a maternidade transformou quem eu sou?",
    transformation: "Do nascimento de um filho à formação de uma identidade materna.",
  },
  hdud: {
    code: "HDUD_ORIGIN_AND_GROWTH",
    title: "O nascimento da HDUD",
    question: "Como a HDUD nasceu e começou a crescer?",
    transformation: "Da inquietação íntima sobre legado à construção de uma plataforma narrativa.",
  },
  career: {
    code: "CAREER",
    title: "A construção da minha carreira",
    question: "Como minha profissão passou a fazer parte da minha identidade?",
    transformation: "Das primeiras experiências à consciência de uma identidade profissional.",
  },
  education: {
    code: "EDUCATION",
    title: "Educação e formação",
    question: "Como minha formação ajudou a construir quem eu sou?",
    transformation: "Das experiências de aprendizagem à formação de uma identidade.",
  },
  health: {
    code: "HEALTH_AND_RECOVERY",
    title: "Saúde e superação",
    question: "Como a dor mudou minha forma de viver?",
    transformation: "Da ruptura física ou emocional para uma nova compreensão da própria força.",
  },
  childhood: {
    code: "CHILDHOOD",
    title: "Infância",
    question: "Que experiências da infância ajudaram a formar quem eu sou?",
    transformation: "Das primeiras experiências à formação da identidade.",
  },
  family: {
    code: "FAMILY",
    title: "Família",
    question: "Como minha família ajudou a formar quem eu sou?",
    transformation: "Dos vínculos familiares à construção de pertencimento e continuidade.",
  },
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function clampScore(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function toPositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeToken(value) {
  const normalized = normalizeKey ? normalizeKey(value) : safeText(value).toLowerCase();
  return safeText(normalized, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function unique(values = []) {
  return [...new Set(safeArray(values).filter(Boolean))];
}

function uniqueByMemoryId(memories = []) {
  const map = new Map();
  for (const memory of safeArray(memories)) {
    const id = memoryIdOf(memory);
    if (id && !map.has(Number(id))) map.set(Number(id), memory);
  }
  return [...map.values()].sort(compareMemoryDate);
}

function storyCodeToken(value) {
  return safeText(value, "story")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase() || "STORY";
}

function firstValue(memory = {}, keys = []) {
  for (const key of keys) {
    const value = memory?.[key] ?? memory?.editorial?.[key] ?? memory?.taxonomy?.[key];
    if (value !== undefined && value !== null && safeText(value, "")) return value;
  }
  return null;
}

function memoryTitle(memory = {}) {
  const id = memoryIdOf(memory);
  return safeText(memory?.title || memory?.memory_title, id ? `Memória ${id}` : "Memória");
}

function memoryContent(memory = {}) {
  return safeText(
    memory?.content ||
    memory?.description ||
    memory?.summary ||
    memory?.transcription_text,
    ""
  );
}

function memoryPhaseId(memory = {}) {
  const raw =
    memory?.phase_id ??
    memory?.phaseId ??
    memory?.life_phase_id ??
    memory?.phase?.phase_id ??
    memory?.phase?.id;
  const number = Number(raw);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function memoryPhaseName(memory = {}) {
  return safeText(
    memory?.phase_name ||
    memory?.phase_label ||
    memory?.phase?.name ||
    memory?.phase?.title,
    memoryPhaseId(memory) ? `Fase ${memoryPhaseId(memory)}` : null
  );
}

function narrativeFamilyOf(memory = {}) {
  const path = extractNarrativePath(memory);

  const lifePeriod = normalizeToken(
    path?.life_period_code ||
    path?.life_period ||
    firstValue(memory, ["life_period_code", "life_period", "period_code", "period"])
  );

  const context = normalizeToken(
    path?.context_code ||
    path?.editorial_context_code ||
    path?.context ||
    firstValue(memory, ["context_code", "editorial_context_code", "editorial_context", "context"])
  );

  const canonical = normalizeToken(
    firstValue(memory, [
      "canonical_story_key",
      "narrative_arc_code",
      "canonical_story_title",
    ])
  );

  if (context && FAMILY_BY_CONTEXT.has(context)) {
    return { family: FAMILY_BY_CONTEXT.get(context), life_period: lifePeriod, context, path };
  }

  if (lifePeriod && FAMILY_BY_LIFE_PERIOD.has(lifePeriod)) {
    return { family: FAMILY_BY_LIFE_PERIOD.get(lifePeriod), life_period: lifePeriod, context, path };
  }

  if (canonical) {
    for (const [token, family] of FAMILY_BY_CONTEXT.entries()) {
      if (canonical.includes(token)) return { family, life_period: lifePeriod, context, path };
    }
    for (const [token, family] of FAMILY_BY_LIFE_PERIOD.entries()) {
      if (canonical.includes(token)) return { family, life_period: lifePeriod, context, path };
    }
  }

  return {
    family: context || lifePeriod || canonical || "unclassified",
    life_period: lifePeriod,
    context,
    path,
  };
}

function signalTypesOf(signal = {}) {
  return unique([
    ...safeArray(signal?.signal_types),
    ...safeArray(signal?.narrativeSignals).map((item) => item?.type),
  ]);
}

function enrichMemory(memory = {}) {
  const signal = extractNarrativeSignals(memory);
  const familyInfo = narrativeFamilyOf(memory);
  const text = memoryText
    ? memoryText(memory)
    : `${memoryTitle(memory)}. ${memoryContent(memory)}`;

  return {
    memory,
    memory_id: memoryIdOf(memory),
    title: memoryTitle(memory),
    content: memoryContent(memory),
    date: memoryCanonicalDate(memory),
    year: safeYear(memoryCanonicalDate(memory)),
    phase_id: memoryPhaseId(memory),
    phase_name: memoryPhaseName(memory),
    text,
    signal,
    signal_types: signalTypesOf(signal),
    characters: safeArray(signal?.characters),
    contexts: safeArray(signal?.contexts),
    keywords: safeArray(signal?.keywords),
    narrative_density: clampScore(
      signal?.narrative_density ||
      signal?.narrative_signal_score ||
      0
    ),
    narrative_family: familyInfo.family,
    life_period_code: familyInfo.life_period,
    context_code: familyInfo.context,
    narrative_path: familyInfo.path,
  };
}

function evidenceRelevance(item, familySize) {
  let score = 48;
  if (item.narrative_path?.complete) score += 18;
  if (item.life_period_code) score += 6;
  if (item.context_code) score += 8;
  score += Math.round(Number(item.narrative_density || 0) * 0.12);
  if (memoryContent(item.memory).length >= 450) score += 5;
  if (familySize >= 3) score += 5;
  return clampScore(score);
}

function evidenceSummary(item = {}, familySize = 0) {
  return {
    memory_id: item.memory_id,
    title: item.title,
    memory_date: item.date,
    year: item.year,
    phase_id: item.phase_id,
    phase_name: item.phase_name,
    publication_status: item.memory?.publication_status ?? null,
    evidence_relevance: evidenceRelevance(item, familySize),
    affinity_to_story: 1,
    signal_types: item.signal_types,
    reasons: [
      "Narrative Path pertence à mesma família narrativa",
      item.narrative_path?.complete ? "Narrative Path completo" : null,
      item.narrative_density >= 55 ? "densidade narrativa" : null,
    ].filter(Boolean),
    direct_semantic_match: true,
    term_hits: 0,
    matched_signal_types: item.signal_types,
    narrative_family: item.narrative_family,
    narrative_path: item.narrative_path,
  };
}

function contractForFamily(family) {
  const contract = FAMILY_CONTRACTS[family];
  if (contract) return contract;

  const label = safeText(family, "História em descoberta")
    .replace(/_/g, " ")
    .trim();

  return {
    code: storyCodeToken(family),
    title: label.charAt(0).toUpperCase() + label.slice(1),
    question: `Que transformação existe nas memórias sobre ${label}?`,
    transformation: "De memórias relacionadas para uma transformação humana reconhecível.",
  };
}

function scoreFamilyHypothesis(items = []) {
  const familySize = safeArray(items).length;
  const completePaths = safeArray(items).filter((item) => item.narrative_path?.complete).length;
  const distinctRoles = unique(
    safeArray(items).map((item) =>
      normalizeToken(
        item.narrative_path?.narrative_role_code ||
        item.memory?.narrative_role_code ||
        item.memory?.editorial?.narrative_role_code
      )
    )
  ).length;
  const averageDensity = familySize
    ? safeArray(items).reduce((sum, item) => sum + Number(item.narrative_density || 0), 0) / familySize
    : 0;

  let score = 45;
  score += Math.min(20, familySize * 5);
  score += Math.round((completePaths / Math.max(1, familySize)) * 18);
  score += Math.min(8, distinctRoles * 3);
  score += Math.round(averageDensity * 0.08);

  return clampScore(score);
}

function buildFamilyHypothesis({ authorId, family, items, index, allItems }) {
  const selected = [...safeArray(items)]
    .sort((a, b) => compareMemoryDate(a.memory, b.memory))
    .slice(0, MAX_MEMORIES_PER_STORY);

  if (selected.length < MIN_MEMORIES_PER_STORY) return null;

  const contract = contractForFamily(family);
  const score = scoreFamilyHypothesis(selected);
  const selectedIds = selected.map((item) => item.memory_id).filter(Boolean);
  const selectedIdSet = new Set(selectedIds.map(Number));
  const discarded = safeArray(allItems).filter((item) => !selectedIdSet.has(Number(item.memory_id)));
  const years = selected.map((item) => item.year).filter(Boolean).sort((a, b) => a - b);

  return {
    type: "STORY_HYPOTHESIS",
    engine: ENGINE_VERSION,
    code: contract.code,
    hypothesis_id: `hypothesis_${authorId || "author"}_${storyCodeToken(contract.code)}_${selectedIds.join("_") || index}`,
    author_id: authorId || null,
    title: contract.title,
    suggested_title: contract.title,
    question: contract.question,
    central_question: contract.question,
    transformation: contract.transformation,
    confidence: score,
    story_score: score,
    memories: selectedIds,
    memory_ids: selectedIds,
    selected_memories: selected.map((item) => item.memory),
    discarded_memories: discarded.map((item) => item.memory),
    evidence: selected.map((item) => evidenceSummary(item, selected.length)),
    discarded_evidence: discarded.map((item) => evidenceSummary(item, selected.length)),
    first_year: years[0] || null,
    last_year: years[years.length - 1] || null,
    phase_id: selected[0]?.phase_id ?? null,
    phase_name: selected[0]?.phase_name ?? null,
    foundation_memory_id: selected[0]?.memory_id ?? null,
    signal_types: unique(selected.flatMap((item) => item.signal_types)).slice(0, 8),
    characters: unique(selected.flatMap((item) => item.characters)).slice(0, 8),
    contexts: unique(selected.flatMap((item) => item.contexts)).slice(0, 8),
    narrative_family: family,
    narrative_path_keys: unique(
      selected.map((item) => item.narrative_path?.key).filter(Boolean)
    ),
    source: "narrative_family_first",
    source_policy: "Narrative Path estrutura a hipótese; texto e sinais narrativos apenas validam e qualificam.",
    diagnostics: {
      selected_count: selected.length,
      discarded_count: discarded.length,
      complete_path_count: selected.filter((item) => item.narrative_path?.complete).length,
      family,
      hypothesis_priority: "NARRATIVE_FAMILY_PRIMARY",
    },
  };
}

function groupByNarrativeFamily(enriched = []) {
  const groups = new Map();

  for (const item of safeArray(enriched)) {
    const family = item.narrative_family || "unclassified";
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(item);
  }

  return groups;
}

function resolveFamilyHypotheses(hypotheses = [], maxHypotheses = DEFAULT_MAX_HYPOTHESES) {
  // As famílias são mutuamente exclusivas por construção.
  // Não existe mais hipótese dinâmica global reivindicando todas as memórias.
  return safeArray(hypotheses)
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.confidence || right.story_score || 0) -
        Number(left.confidence || left.story_score || 0) ||
      safeArray(right.memories).length - safeArray(left.memories).length ||
      String(left.title || "").localeCompare(String(right.title || ""), "pt-BR")
    )
    .slice(0, Math.max(1, Math.min(Number(maxHypotheses) || DEFAULT_MAX_HYPOTHESES, 12)));
}

export function discoverStoryHypotheses({
  authorId = null,
  memories = [],
  maxHypotheses = DEFAULT_MAX_HYPOTHESES,
  includeWeak = false,
} = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  const orderedMemories = uniqueByMemoryId(memories);

  if (orderedMemories.length < MIN_MEMORIES_PER_STORY) return [];

  const enriched = orderedMemories.map(enrichMemory).filter((item) => item.memory_id);
  const groups = groupByNarrativeFamily(enriched);
  const hypotheses = [];

  let index = 0;
  for (const [family, items] of groups.entries()) {
    if (items.length < MIN_MEMORIES_PER_STORY) continue;

    const hypothesis = buildFamilyHypothesis({
      authorId: safeAuthorId,
      family,
      items,
      index,
      allItems: enriched,
    });

    index += 1;

    if (!hypothesis) continue;
    if (!includeWeak && Number(hypothesis.confidence || 0) < MIN_VISIBLE_CONFIDENCE) continue;
    hypotheses.push(hypothesis);
  }

  return resolveFamilyHypotheses(hypotheses, maxHypotheses);
}

export function buildNarrativeHypothesesForPhase({ group = {}, enriched = [] } = {}) {
  const memories = safeArray(enriched)
    .map((item) => item?.memory || item)
    .filter((memory) => memoryIdOf(memory));

  return discoverStoryHypotheses({
    authorId: group?.author_id || group?.authorId || null,
    memories: memories.length ? memories : safeArray(group?.memories),
    maxHypotheses: 6,
    includeWeak: true,
  }).map((hypothesis) => ({
    ...hypothesis,
    phase_id: group?.phase_id ?? hypothesis.phase_id ?? null,
    phase_name: group?.phase_name ?? hypothesis.phase_name ?? null,
  }));
}

export function discoverStoryHypothesesByPhase({
  authorId = null,
  memories = [],
  includeWeak = false,
} = {}) {
  return discoverStoryHypotheses({
    authorId,
    memories,
    maxHypotheses: DEFAULT_MAX_HYPOTHESES,
    includeWeak,
  });
}

export const StoryHypothesisEngine = {
  discoverStoryHypotheses,
  discoverStoryHypothesesByPhase,
  buildNarrativeHypothesesForPhase,
  version: ENGINE_VERSION,
};
