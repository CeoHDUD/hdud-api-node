// C:\HDUD_DATA\hdud-api-node\src\narrative\intelligence\services\narrative-intelligence.service.js

import { buildSimpleNarrativeClusters } from "../../../services/narrative/narrative-cluster.service.js";
import { buildEmotionalClusters } from "../../../services/narrative/emotional-cluster.service.js";
import { buildNarrativeArcs } from "../../../services/narrative/narrative-arc.service.js";
import { buildNarrativeContinuity } from "../../../services/narrative/narrative-continuity.service.js";
import { buildSymbolicRecurrence } from "../../../services/narrative/symbolic-recurrence.service.js";
import { discoverStoryHypothesesForAuthor } from "../../../services/story/story-discovery-orchestrator.service.js";
import {
  buildNarrativeIntelligenceContract,
  NARRATIVE_INTELLIGENCE_STATUS,
  NARRATIVE_INTELLIGENCE_VERSION,
} from "../contracts/narrative-intelligence-contract.js";
import { aggregateNarrativeEvidence } from "./narrative-evidence-aggregator.service.js";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

async function settle(name, promise, fallback = null) {
  try {
    const value = await promise;
    if (Array.isArray(value)) return [name, { ok: true, [fallback || "items"]: value }];
    if (!value || typeof value !== "object") return [name, { ok: false, reason: "NO_RESULT" }];
    return [name, value.ok === false ? value : { ok: true, ...value }];
  } catch (error) {
    return [name, { ok: false, reason: error?.message || "ENGINE_FAILED" }];
  }
}

function inferStatus({ memories, hypotheses, evidences, confidence }) {
  if (!safeArray(memories).length) return NARRATIVE_INTELLIGENCE_STATUS.NO_MEMORIES;
  if (confidence >= 0.78 && safeArray(hypotheses).length) return NARRATIVE_INTELLIGENCE_STATUS.STORY_READY;
  if (confidence >= 0.64) return NARRATIVE_INTELLIGENCE_STATUS.CONSISTENT;
  if (safeArray(evidences).length >= 2) return NARRATIVE_INTELLIGENCE_STATUS.EMERGING;
  return NARRATIVE_INTELLIGENCE_STATUS.OBSERVING;
}

function calculateGlobalConfidence({ evidences, hypotheses }) {
  const evidenceList = safeArray(evidences);
  const hypothesisList = safeArray(hypotheses);

  const evidenceScore = evidenceList.length
    ? evidenceList.reduce((sum, item) => sum + clamp(item?.weight, 0, 1), 0) / evidenceList.length
    : 0;

  const hypothesisScore = hypothesisList.length
    ? hypothesisList.reduce((sum, item) => sum + clamp(item?.confidence, 0, 1), 0) / hypothesisList.length
    : 0;

  const densityBonus = Math.min(0.14, evidenceList.length * 0.012 + hypothesisList.length * 0.025);

  return Number(clamp(0.18 + evidenceScore * 0.48 + hypothesisScore * 0.28 + densityBonus, 0, 0.96).toFixed(2));
}

export async function buildNarrativeIntelligence({ authorId, memories = [], limit = 300 } = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  if (!safeAuthorId) {
    return buildNarrativeIntelligenceContract({
      ok: false,
      status: NARRATIVE_INTELLIGENCE_STATUS.NO_MEMORIES,
      confidence: 0,
      meta: {
        input_memories: safeArray(memories).length,
        source_policy: "authorId inválido; nenhuma engine foi executada.",
      },
    });
  }

  const safeMemories = safeArray(memories).filter(Boolean);
  const clusters = buildSimpleNarrativeClusters(safeMemories);

  const pairs = await Promise.all([
    settle("emotional", buildEmotionalClusters({ authorId: safeAuthorId, limit }), "clusters"),
    settle("arcs", buildNarrativeArcs({ authorId: safeAuthorId, limit }), "arcs"),
    settle("continuity", buildNarrativeContinuity({ authorId: safeAuthorId, limit })),
    settle("symbolic", buildSymbolicRecurrence({ authorId: safeAuthorId, limit }), "symbolic_patterns"),
    settle("story", discoverStoryHypothesesForAuthor({ authorId: safeAuthorId, memories: safeMemories, limit }), "hypotheses"),
  ]);

  const sourceEngines = Object.fromEntries(pairs);
  const hypotheses = safeArray(sourceEngines.story?.hypotheses);
  const evidences = aggregateNarrativeEvidence({
    clusters,
    emotional: sourceEngines.emotional,
    arcs: sourceEngines.arcs,
    continuity: sourceEngines.continuity,
    symbolic: sourceEngines.symbolic,
    story: sourceEngines.story,
  });
  const confidence = calculateGlobalConfidence({ evidences, hypotheses });
  const status = inferStatus({ memories: safeMemories, hypotheses, evidences, confidence });

  return buildNarrativeIntelligenceContract({
    ok: true,
    engine: NARRATIVE_INTELLIGENCE_VERSION,
    author_id: safeAuthorId,
    status,
    confidence,
    evidences,
    hypotheses,
    source_engines: sourceEngines,
    meta: {
      generated_at: new Date().toISOString(),
      input_memories: safeMemories.length,
      source_policy:
        "Narrative Intelligence reutiliza engines persistidas e a Story Discovery; não persiste, não publica e não cria capítulos automaticamente.",
    },
  });
}

export const NarrativeIntelligenceService = {
  buildNarrativeIntelligence,
};
