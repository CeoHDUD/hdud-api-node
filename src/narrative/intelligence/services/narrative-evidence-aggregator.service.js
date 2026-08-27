// C:\HDUD_DATA\hdud-api-node\src\narrative\intelligence\services\narrative-evidence-aggregator.service.js

import { NARRATIVE_EVIDENCE_TYPES } from "../contracts/narrative-intelligence-contract.js";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value, fallback = "") {
  if (value == null) return fallback;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length ? s : fallback;
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function readArray(obj, candidates = []) {
  for (const key of candidates) {
    if (Array.isArray(obj?.[key])) return obj[key];
  }
  return [];
}

function addEvidence(out, item) {
  if (!item || !item.type) return;
  out.push({
    type: item.type,
    label: normalizeText(item.label, item.type),
    reason: normalizeText(item.reason, "Evidência narrativa detectada."),
    weight: Number(clamp(item.weight ?? 0.5, 0, 1).toFixed(2)),
    source: normalizeText(item.source, "narrative_intelligence"),
    payload: item.payload || null,
  });
}

export function aggregateNarrativeEvidence({
  clusters = [],
  emotional = null,
  arcs = null,
  continuity = null,
  symbolic = null,
  story = null,
} = {}) {
  const evidences = [];

  for (const cluster of safeArray(clusters)) {
    const memories = safeArray(cluster);
    if (!memories.length) continue;

    addEvidence(evidences, {
      type: NARRATIVE_EVIDENCE_TYPES.NARRATIVE_CLUSTER,
      label: "Cluster narrativo",
      reason: `${memories.length} memória(s) apresentam proximidade narrativa inicial.`,
      weight: Math.min(0.82, 0.42 + memories.length * 0.08),
      source: "narrative-cluster.service",
      payload: {
        memory_ids: memories
          .map((m) => Number(m?.memory_id ?? m?.id ?? 0))
          .filter((n) => Number.isInteger(n) && n > 0),
      },
    });
  }

  const emotionalClusters = readArray(emotional, ["clusters", "emotional_clusters", "items"]);
  for (const item of emotionalClusters.slice(0, 12)) {
    addEvidence(evidences, {
      type: NARRATIVE_EVIDENCE_TYPES.EMOTIONAL_CLUSTER,
      label: item?.label || item?.cluster_label || item?.code || "Cluster emocional",
      reason: "A engine emocional encontrou um fio afetivo persistente.",
      weight: clamp((Number(item?.strength ?? item?.score ?? item?.cluster_strength ?? 55) || 55) / 100, 0.42, 0.9),
      source: "emotional-cluster.service",
      payload: item,
    });
  }

  const narrativeArcs = readArray(arcs, ["arcs", "narrative_arcs", "items"]);
  for (const arc of narrativeArcs.slice(0, 12)) {
    addEvidence(evidences, {
      type: NARRATIVE_EVIDENCE_TYPES.NARRATIVE_ARC,
      label: arc?.label || arc?.arc_label || arc?.code || "Arco narrativo",
      reason: "A engine de arcos encontrou uma trajetória narrativa possível.",
      weight: clamp((Number(arc?.strength ?? arc?.score ?? arc?.arc_strength ?? 58) || 58) / 100, 0.44, 0.92),
      source: "narrative-arc.service",
      payload: arc,
    });
  }

  if (continuity?.ok !== false && continuity?.continuity_score != null) {
    addEvidence(evidences, {
      type: NARRATIVE_EVIDENCE_TYPES.NARRATIVE_CONTINUITY,
      label: continuity?.continuity_summary?.continuity_state || "Continuidade narrativa",
      reason:
        continuity?.continuity_summary?.interpretation ||
        "A engine de continuidade identificou densidade autobiográfica no grafo narrativo.",
      weight: clamp(Number(continuity.continuity_score) / 100, 0.3, 0.95),
      source: "narrative-continuity.service",
      payload: {
        continuity_score: continuity.continuity_score,
        continuity_summary: continuity.continuity_summary || null,
      },
    });
  }

  const symbolicPatterns = readArray(symbolic, ["symbolic_patterns", "patterns", "items"]);
  for (const pattern of symbolicPatterns.slice(0, 12)) {
    addEvidence(evidences, {
      type: NARRATIVE_EVIDENCE_TYPES.SYMBOLIC_RECURRENCE,
      label: pattern?.symbol || pattern?.label || pattern?.symbolic_role || "Recorrência simbólica",
      reason: "A engine simbólica encontrou recorrência capaz de conectar memórias.",
      weight: clamp((Number(pattern?.recurrence_score ?? pattern?.score ?? 60) || 60) / 100, 0.4, 0.94),
      source: "symbolic-recurrence.service",
      payload: pattern,
    });
  }

  const hypotheses = readArray(story, ["hypotheses", "stories", "items"]);
  for (const hypothesis of hypotheses.slice(0, 12)) {
    addEvidence(evidences, {
      type: NARRATIVE_EVIDENCE_TYPES.STORY_HYPOTHESIS,
      label: hypothesis?.title || hypothesis?.suggested_title || "Hipótese narrativa",
      reason:
        hypothesis?.summary ||
        hypothesis?.description ||
        "A Story Discovery encontrou uma hipótese narrativa a partir das memórias.",
      weight: clamp(Number(hypothesis?.confidence ?? 0.6), 0.35, 0.95),
      source: "story-discovery-orchestrator.service",
      payload: hypothesis,
    });
  }

  return evidences.sort((a, b) => b.weight - a.weight);
}

export const NarrativeEvidenceAggregator = {
  aggregateNarrativeEvidence,
};
