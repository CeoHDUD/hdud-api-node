// C:\HDUD_DATA\hdud-api-node\src\services\story\story-truth-engine.service.js
//
// GO LIVE 003.4 — Story Truth Engine
// Camada entre Story Candidate e Story Editorial Runtime.

import { DEFAULT_TRUTH_KEEP_THRESHOLD, scoreMemoriesForCandidate } from "./truth-score.service.js";
import { buildEvidenceMap, buildEvidencePayload } from "./story-evidence.service.js";
import { validateStoryTruth } from "./truth-validator.service.js";

export const STORY_TRUTH_ENGINE_VERSION = "story-truth-engine-v2.0-ntg-author-path";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function memoryIdOf(memory) {
  return toPositiveInt(memory?.memory_id ?? memory?.id ?? memory?.memoryId);
}

function attachScore(memory, score) {
  return {
    ...memory,
    truth_score: score?.truth_score ?? 0,
    truth_decision: score?.decision || "DROP",
    evidence: score || null,
  };
}

export function selectTruthfulMemories({ candidate = {}, memories = [], threshold = DEFAULT_TRUTH_KEEP_THRESHOLD } = {}) {
  const normalizedMemories = safeArray(memories).filter((memory) => memoryIdOf(memory));
  const truthReport = scoreMemoriesForCandidate({ candidate, memories: normalizedMemories, threshold });
  const scoreMap = new Map(safeArray(truthReport.memory_scores).map((score) => [score.memory_id, score]));
  const keptIds = new Set(truthReport.kept_memory_ids);

  const keptMemories = normalizedMemories
    .filter((memory) => keptIds.has(memoryIdOf(memory)))
    .map((memory) => attachScore(memory, scoreMap.get(memoryIdOf(memory))));

  const droppedMemories = normalizedMemories
    .filter((memory) => !keptIds.has(memoryIdOf(memory)))
    .map((memory) => attachScore(memory, scoreMap.get(memoryIdOf(memory))));

  const narrativeQuality = Math.max(0, Math.min(100, Math.round((Number(candidate?.confidence ?? 0) || 0))));
  const evidenceQuality = truthReport.average_truth_score;
  const hallucinationRisk = Math.max(0, Math.min(100, 100 - evidenceQuality));

  const narrativeCoreIds = new Set(
    safeArray(candidate?.narrative_path_validation?.narrative_core_memory_ids).map(Number),
  );
  const graphCoreAvailable = narrativeCoreIds.size >= 2;

  return {
    ok: keptMemories.length > 0 || graphCoreAvailable,
    engine: STORY_TRUTH_ENGINE_VERSION,
    threshold,
    candidate_id: candidate?.candidate_id ?? candidate?.story_id ?? null,
    used_memories: keptMemories,
    discarded_memories: droppedMemories,
    truth_report: truthReport,
    story_evidence_score: {
      narrative_quality: narrativeQuality,
      evidence_quality: evidenceQuality,
      hallucination_risk: hallucinationRisk,
    },
    narrative_graph: {
      graph_primary: Boolean(candidate?.narrative_path_validation?.graph_primary),
      coherent: Boolean(candidate?.narrative_path_validation?.coherent),
      sequence_graph_score: Number(candidate?.narrative_path_validation?.sequence_graph_score || 0),
      core_memory_ids: [...narrativeCoreIds],
      graph_core_available: graphCoreAvailable,
    },
    source_policy: "Story Truth Engine preserva evidência factual e reconhece o núcleo narrativo classificado pelo autor no NTG.",
  };
}

export function buildTruthEvidenceMap({ narrativeContent = "", usedMemories = [], truthReport = null } = {}) {
  return buildEvidenceMap({
    narrativeContent,
    memories: usedMemories,
    memoryScores: truthReport?.memory_scores || [],
  });
}

export function validateGeneratedStoryTruth({ narrativeContent = "", usedMemories = [], truthReport = null } = {}) {
  return validateStoryTruth({
    narrativeContent,
    memories: usedMemories,
    memoryScores: truthReport?.memory_scores || [],
  });
}

export function buildStoryTruthPayload({ selection, evidenceMap = null, validation = null } = {}) {
  const payload = buildEvidencePayload({
    usedMemories: selection?.used_memories || [],
    discardedMemories: selection?.discarded_memories || [],
    truthReport: selection?.truth_report || null,
    evidenceMap,
  });

  return {
    ...payload,
    engine: STORY_TRUTH_ENGINE_VERSION,
    validation,
    story_evidence_score: {
      ...(selection?.story_evidence_score || {}),
      evidence_quality: validation?.evidence_quality ?? selection?.story_evidence_score?.evidence_quality ?? 0,
      hallucination_risk: validation?.hallucination_risk ?? selection?.story_evidence_score?.hallucination_risk ?? 100,
    },
  };
}

export const StoryTruthEngine = {
  selectTruthfulMemories,
  buildTruthEvidenceMap,
  validateGeneratedStoryTruth,
  buildStoryTruthPayload,
};
