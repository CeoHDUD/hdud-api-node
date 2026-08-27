// C:\HDUD_DATA\hdud-api-node\src\services\story\story-seed-engine.service.js
//
// GO LIVE 006 — Story Seed Engine Compatibility Layer
// Responsabilidade: transformar Story Hypotheses humanas em sementes compatíveis
// com Candidate/Blueprint, sem redescobrir ou fundir hipóteses.

import {
  compareMemoryDate,
  extractNarrativeSignals,
  memoryIdOf,
} from "./story-continuity.service.js";
import { discoverStoryHypotheses } from "./story-hypothesis-engine.service.js";

const ENGINE_VERSION = "story-seed-engine-v6.4.3-family-hypothesis-adapter";
const MIN_SEED_MEMORIES = 2;
const DEFAULT_MAX_SEEDS = 12;

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

function uniqueByMemoryId(memories = []) {
  const map = new Map();
  for (const memory of safeArray(memories)) {
    const id = memoryIdOf(memory);
    if (id && !map.has(Number(id))) map.set(Number(id), memory);
  }
  return [...map.values()].sort(compareMemoryDate);
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
    memory?.phase?.title ||
    memory?.phase?.label,
    memoryPhaseId(memory) ? `Fase ${memoryPhaseId(memory)}` : "Sem fase"
  );
}

function normalizeCode(value) {
  return safeText(value, "story")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "story";
}

function buildNarrativePotential(memory, hypothesis) {
  const evidence = safeArray(hypothesis?.evidence).find(
    (item) => Number(item.memory_id) === Number(memoryIdOf(memory))
  );

  const score = clampScore(
    evidence?.evidence_relevance ??
    hypothesis?.confidence ??
    hypothesis?.story_score ??
    0
  );

  const signalTypes = safeArray(evidence?.signal_types);

  return {
    memory_id: memoryIdOf(memory),
    phase_id: memoryPhaseId(memory),
    phase_name: memoryPhaseName(memory),
    narrative_score: score,
    potential_score: score,
    is_foundation: signalTypes.includes("ORIGIN") || score >= 82,
    is_turning_point:
      signalTypes.includes("TURNING_POINT") ||
      signalTypes.includes("IDENTITY_SHIFT") ||
      score >= 76,
    is_consequence:
      signalTypes.includes("CONSEQUENCE") ||
      signalTypes.includes("RESILIENCE"),
    best_affinity: Number(evidence?.affinity_to_story || 0),
    average_affinity: Number(evidence?.affinity_to_story || 0),
    reasons: safeArray(evidence?.reasons).length
      ? evidence.reasons
      : ["memória selecionada pela hipótese narrativa"],
    signal_types: signalTypes,
    direct_semantic_match: Boolean(evidence?.direct_semantic_match),
    term_hits: Number(evidence?.term_hits || 0),
  };
}

function buildSeedFromHypothesis(seedId, hypothesis) {
  const memories = uniqueByMemoryId(hypothesis.selected_memories || []);
  const discardedMemories = uniqueByMemoryId(hypothesis.discarded_memories || []);
  const signals = memories.map(extractNarrativeSignals);
  const firstMemory = memories[0] || null;

  return {
    seed_id: seedId,
    engine: ENGINE_VERSION,
    strategy: "NARRATIVE_FAMILY_HYPOTHESIS_FIRST",
    phase_id: hypothesis.phase_id ?? memoryPhaseId(firstMemory) ?? null,
    phase_name: hypothesis.phase_name ?? memoryPhaseName(firstMemory),
    narrative_family: hypothesis.narrative_family || null,
    narrative_hypothesis: {
      code: hypothesis.code,
      hypothesis_id: hypothesis.hypothesis_id || null,
      title: hypothesis.title,
      question: hypothesis.question,
      central_question: hypothesis.central_question || hypothesis.question,
      transformation: hypothesis.transformation,
      story_score: hypothesis.story_score || hypothesis.confidence,
      confidence: hypothesis.confidence || hypothesis.story_score,
      diagnostics: hypothesis.diagnostics || null,
      evidence: hypothesis.evidence || [],
      source_policy: hypothesis.source_policy,
      narrative_family: hypothesis.narrative_family || null,
    },
    hypothesis_code: hypothesis.code,
    hypothesis_title: hypothesis.title,
    central_question: hypothesis.central_question || hypothesis.question,
    transformation: hypothesis.transformation,
    memories,
    signals,
    foundation_memory_id:
      hypothesis.foundation_memory_id ||
      memoryIdOf(firstMemory),
    narrative_potential: memories.map((memory) =>
      buildNarrativePotential(memory, hypothesis)
    ),
    discarded_memories: discardedMemories.map((memory) => ({
      memory_id: memoryIdOf(memory),
      title: safeText(
        memory?.title || memory?.memory_title,
        `Memória ${memoryIdOf(memory)}`
      ),
      phase_id: memoryPhaseId(memory),
      phase_name: memoryPhaseName(memory),
      narrative_potential: buildNarrativePotential(memory, hypothesis),
    })),
    score: clampScore(hypothesis.story_score || hypothesis.confidence || 0),
    source_policy: "Seed adapta uma hipótese independente; não redescobre, amplia ou funde famílias.",
    explainability: {
      rule: "memories → narrative_family_hypothesis → compatibility_seed",
      hypothesis_id: hypothesis.hypothesis_id || null,
      narrative_family: hypothesis.narrative_family || null,
      selected_count: memories.length,
      discarded_count: discardedMemories.length,
      story_score: clampScore(
        hypothesis.story_score ||
        hypothesis.confidence ||
        0
      ),
    },
    seed_diagnostics: {
      phase_id: hypothesis.phase_id ?? null,
      phase_name: hypothesis.phase_name ?? null,
      hypothesis_code: hypothesis.code,
      hypothesis_title: hypothesis.title,
      central_question: hypothesis.central_question || hypothesis.question,
      transformation: hypothesis.transformation,
      story_score: clampScore(
        hypothesis.story_score ||
        hypothesis.confidence ||
        0
      ),
      evidence: hypothesis.evidence || [],
      narrative_family: hypothesis.narrative_family || null,
    },
  };
}

export function buildStorySeeds(memories = [], options = {}) {
  const ordered = uniqueByMemoryId(memories);
  if (ordered.length < MIN_SEED_MEMORIES) return [];

  const suppliedHypotheses = safeArray(options.hypotheses).filter(Boolean);
  const hypotheses = suppliedHypotheses.length
    ? suppliedHypotheses
    : discoverStoryHypotheses({
        authorId: options.authorId ?? options.author_id ?? null,
        memories: ordered,
        maxHypotheses:
          options.maxSeeds ??
          options.max_seeds ??
          DEFAULT_MAX_SEEDS,
        includeWeak: Boolean(options.includeWeak),
      });

  return safeArray(hypotheses)
    .filter(
      (hypothesis) =>
        safeArray(hypothesis.selected_memories).length >= MIN_SEED_MEMORIES
    )
    .sort((left, right) =>
      Number(right.confidence || right.story_score || 0) -
        Number(left.confidence || left.story_score || 0) ||
      safeArray(right.selected_memories).length -
        safeArray(left.selected_memories).length ||
      String(left.title || "").localeCompare(
        String(right.title || ""),
        "pt-BR"
      )
    )
    .map((hypothesis, index) =>
      buildSeedFromHypothesis(
        `seed_${index + 1}_story_${normalizeCode(
          hypothesis.code ||
          hypothesis.title ||
          hypothesis.question
        )}`,
        hypothesis
      )
    );
}

export const StorySeedEngine = {
  buildStorySeeds,
  version: ENGINE_VERSION,
};
