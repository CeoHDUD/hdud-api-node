// C:\HDUD_DATA\hdud-api-node\src\services\story\truth-score.service.js
//
// GO LIVE 003.4 — Truth Score
// Responsabilidade: pontuar aderência factual de cada memória a uma Story Candidate.

import { memoryCanonicalDate, memoryIdOf, safeYear } from "./story-continuity.service.js";

export const TRUTH_SCORE_ENGINE_VERSION = "truth-score-v1.0-go-live-003.4";
export const DEFAULT_TRUTH_KEEP_THRESHOLD = 45;

const CHARACTER_HINTS = [
  "alexandre", "bruna", "felipe", "zezo", "familia", "esposa", "filho", "pai", "mae",
  "hospital", "cirurgia", "dor", "recuperacao", "medico", "hdud", "memoria", "livro",
  "trabalho", "carreira", "dba", "sql", "cbf", "reserva", "dados",
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.length ? text : fallback;
}

function normalizeToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function tokensOf(value) {
  return unique(normalizeToken(value).split(/\s+/).filter((token) => token.length >= 3));
}

function memoryText(memory) {
  return [memory?.title, memory?.content, memory?.description, memory?.summary]
    .map((part) => safeText(part, ""))
    .filter(Boolean)
    .join(" ");
}

function overlapScore(sourceTokens, targetTokens) {
  if (!sourceTokens.length || !targetTokens.length) return 0;
  const target = new Set(targetTokens);
  const hits = sourceTokens.filter((token) => target.has(token)).length;
  return Math.min(100, Math.round((hits / Math.max(1, sourceTokens.length)) * 100));
}

function extractCandidateTokens(candidate = {}) {
  const overview = candidate?.overview || candidate?.editorial_overview || {};
  const continuity = candidate?.continuity || {};

  const raw = [
    candidate?.title,
    candidate?.suggested_title,
    candidate?.central_theme,
    candidate?.summary,
    candidate?.transformation,
    overview?.central_theme,
    overview?.transformation,
    overview?.why_found,
    ...safeArray(overview?.characters),
    ...safeArray(overview?.contexts),
    ...safeArray(continuity?.characters),
    ...safeArray(continuity?.contexts),
    ...safeArray(continuity?.reasons),
  ].join(" ");

  return tokensOf(raw);
}

function extractCharacterTokens(candidate = {}) {
  const overview = candidate?.overview || candidate?.editorial_overview || {};
  const continuity = candidate?.continuity || {};
  const explicit = [
    ...safeArray(overview?.characters),
    ...safeArray(continuity?.characters),
  ].flatMap(tokensOf);

  const fromText = extractCandidateTokens(candidate).filter((token) => CHARACTER_HINTS.includes(token));
  return unique([...explicit, ...fromText]);
}

function extractContextTokens(candidate = {}) {
  const overview = candidate?.overview || candidate?.editorial_overview || {};
  const continuity = candidate?.continuity || {};
  return unique([
    ...safeArray(overview?.contexts).flatMap(tokensOf),
    ...safeArray(continuity?.contexts).flatMap(tokensOf),
    ...extractCandidateTokens(candidate),
  ]);
}

function temporalContinuityScore(memory, candidate = {}, candidateMemories = []) {
  const memoryYear = safeYear(memoryCanonicalDate(memory));
  const firstYear = safeYear(candidate?.first_year || candidate?.period?.start_year);
  const lastYear = safeYear(candidate?.last_year || candidate?.period?.end_year);

  if (memoryYear && firstYear && lastYear) {
    if (memoryYear >= firstYear && memoryYear <= lastYear) return 100;
    if (Math.abs(memoryYear - firstYear) <= 1 || Math.abs(memoryYear - lastYear) <= 1) return 70;
    return 25;
  }

  const years = safeArray(candidateMemories)
    .map((item) => safeYear(memoryCanonicalDate(item)))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!memoryYear || !years.length) return 55;
  const min = years[0];
  const max = years[years.length - 1];
  if (memoryYear >= min && memoryYear <= max) return 90;
  if (Math.abs(memoryYear - min) <= 1 || Math.abs(memoryYear - max) <= 1) return 65;
  return 30;
}

function emotionalContinuityScore(memoryTokens, candidateTokens) {
  const emotionalTokens = [
    "amor", "medo", "dor", "alegria", "saudade", "familia", "perda", "recomeço", "recomeco",
    "orgulho", "vergonha", "coragem", "silencio", "presenca", "cuidado", "esperanca", "culpa",
  ];
  const source = memoryTokens.filter((token) => emotionalTokens.includes(token));
  const target = candidateTokens.filter((token) => emotionalTokens.includes(token));
  if (!source.length && !target.length) return 55;
  if (!source.length || !target.length) return 40;
  return overlapScore(source, target);
}

function transformationRelevanceScore(memoryTokens, candidateTokens) {
  const transformationTokens = [
    "mudanca", "transformacao", "travessia", "recuperacao", "nascimento", "inicio", "fim", "decisao",
    "virada", "consequencia", "permanencia", "continuidade", "aprendizado", "crescimento", "queda", "retorno",
  ];
  const source = memoryTokens.filter((token) => transformationTokens.includes(token));
  const target = candidateTokens.filter((token) => transformationTokens.includes(token));
  if (!source.length && !target.length) return 50;
  if (!source.length || !target.length) return 35;
  return overlapScore(source, target);
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function scoreMemoryTruth({ memory, candidate = {}, candidateMemories = [] } = {}) {
  const memoryId = memoryIdOf(memory);
  const text = memoryText(memory);
  const memoryTokens = tokensOf(text);
  const candidateTokens = extractCandidateTokens(candidate);
  const characterTokens = extractCharacterTokens(candidate);
  const contextTokens = extractContextTokens(candidate);

  const narrativeRelevance = overlapScore(candidateTokens, memoryTokens);
  const characterContinuity = characterTokens.length ? overlapScore(characterTokens, memoryTokens) : 55;
  const contextContinuity = contextTokens.length ? overlapScore(contextTokens, memoryTokens) : 55;
  const temporalContinuity = temporalContinuityScore(memory, candidate, candidateMemories);
  const emotionalContinuity = emotionalContinuityScore(memoryTokens, candidateTokens);
  const transformationRelevance = transformationRelevanceScore(memoryTokens, candidateTokens);

  const storyConfidence = clampScore(candidate?.confidence ?? candidate?.confidence_score ?? 50);

  const truthScore = clampScore(
    narrativeRelevance * 0.26 +
    characterContinuity * 0.18 +
    contextContinuity * 0.14 +
    temporalContinuity * 0.14 +
    emotionalContinuity * 0.10 +
    transformationRelevance * 0.10 +
    storyConfidence * 0.08
  );

  const decision = truthScore >= DEFAULT_TRUTH_KEEP_THRESHOLD ? "KEEP" : "DROP";

  return {
    memory_id: memoryId,
    title: safeText(memory?.title, memoryId ? `Memória ${memoryId}` : "Memória"),
    truth_score: truthScore,
    decision,
    narrative_relevance: clampScore(narrativeRelevance),
    character_continuity: clampScore(characterContinuity),
    temporal_continuity: clampScore(temporalContinuity),
    emotional_continuity: clampScore(emotionalContinuity),
    transformation_relevance: clampScore(transformationRelevance),
    story_confidence: storyConfidence,
    reasons: [
      narrativeRelevance >= 35 ? "aderência narrativa" : null,
      characterContinuity >= 35 ? "continuidade de personagens/contexto" : null,
      temporalContinuity >= 55 ? "continuidade temporal" : null,
      emotionalContinuity >= 45 ? "continuidade emocional" : null,
      transformationRelevance >= 45 ? "relevância para transformação" : null,
    ].filter(Boolean),
    engine: TRUTH_SCORE_ENGINE_VERSION,
  };
}

export function scoreMemoriesForCandidate({ candidate = {}, memories = [], threshold = DEFAULT_TRUTH_KEEP_THRESHOLD } = {}) {
  const scored = safeArray(memories).map((memory) => scoreMemoryTruth({ memory, candidate, candidateMemories: memories }));
  const keep = scored.filter((item) => item.truth_score >= threshold);
  const drop = scored.filter((item) => item.truth_score < threshold);

  return {
    engine: TRUTH_SCORE_ENGINE_VERSION,
    threshold,
    memory_scores: scored,
    kept_memory_ids: keep.map((item) => item.memory_id).filter(Boolean),
    dropped_memory_ids: drop.map((item) => item.memory_id).filter(Boolean),
    kept_count: keep.length,
    dropped_count: drop.length,
    average_truth_score: scored.length
      ? clampScore(scored.reduce((sum, item) => sum + item.truth_score, 0) / scored.length)
      : 0,
  };
}

export const TruthScoreService = {
  scoreMemoryTruth,
  scoreMemoriesForCandidate,
};
