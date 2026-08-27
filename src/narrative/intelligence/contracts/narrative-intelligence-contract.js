// C:\HDUD_DATA\hdud-api-node\src\narrative\intelligence\contracts\narrative-intelligence-contract.js

export const NARRATIVE_INTELLIGENCE_VERSION = "narrative-intelligence-pipeline-v1";

export const NARRATIVE_EVIDENCE_TYPES = Object.freeze({
  NARRATIVE_CLUSTER: "NARRATIVE_CLUSTER",
  EMOTIONAL_CLUSTER: "EMOTIONAL_CLUSTER",
  NARRATIVE_ARC: "NARRATIVE_ARC",
  NARRATIVE_CONTINUITY: "NARRATIVE_CONTINUITY",
  SYMBOLIC_RECURRENCE: "SYMBOLIC_RECURRENCE",
  STORY_HYPOTHESIS: "STORY_HYPOTHESIS",
});

export const NARRATIVE_INTELLIGENCE_STATUS = Object.freeze({
  NO_MEMORIES: "NO_MEMORIES",
  OBSERVING: "OBSERVING",
  EMERGING: "EMERGING",
  CONSISTENT: "CONSISTENT",
  STORY_READY: "STORY_READY",
});

export function buildNarrativeIntelligenceContract(payload = {}) {
  return {
    ok: payload.ok !== false,
    engine: payload.engine || NARRATIVE_INTELLIGENCE_VERSION,
    author_id: payload.author_id ?? null,
    status: payload.status || NARRATIVE_INTELLIGENCE_STATUS.OBSERVING,
    confidence: Number.isFinite(Number(payload.confidence))
      ? Number(payload.confidence)
      : 0,
    evidences: Array.isArray(payload.evidences) ? payload.evidences : [],
    hypotheses: Array.isArray(payload.hypotheses) ? payload.hypotheses : [],
    source_engines: payload.source_engines || {},
    meta: {
      generated_at: payload.meta?.generated_at || new Date().toISOString(),
      input_memories: Number(payload.meta?.input_memories || 0),
      source_policy:
        payload.meta?.source_policy ||
        "Narrative Intelligence coordena engines existentes; não cria capítulos automaticamente.",
    },
  };
}
