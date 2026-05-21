// C:\HDUD_DATA\hdud-api-node\src\services\narrative\life-event-significance.service.js

import { orchestrateLifeTimeline } from "./life-timeline-orchestrator.service.js";
import { buildSymbolicRecurrence } from "./symbolic-recurrence.service.js";
import { buildNarrativeContinuity } from "./narrative-continuity.service.js";
import { buildMemoryResonance } from "./memory-resonance.service.js";
import { listRelationshipEvolutions } from "./relationship-evolution.service.js";
import { buildEmotionalClusters } from "./emotional-cluster.service.js";
import { buildAuthorCognitiveProfile } from "./author-cognitive-profile.service.js";

function clampInt(value, min = 0, max = 100, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeText(value, fallback = null) {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text.length ? text : fallback;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function textIncludesAny(text, values = []) {
  const clean = normalizeText(text, "")?.toUpperCase() || "";
  return values.some((value) => {
    const v = normalizeText(value, "")?.toUpperCase();
    return v && clean.includes(v);
  });
}

function buildSymbolIndex(symbolic) {
  return symbolic?.symbolic_patterns || [];
}

function buildRelationshipIndex(relationshipEvolution) {
  return relationshipEvolution?.relationships || [];
}

function scoreEventSignificance({ event, symbols, relationships, continuity, profile }) {
  const baseImpact = safeNumber(event.life_impact_score);
  const title = normalizeText(event.title, "");

  const matchedSymbols = symbols.filter((symbol) =>
    textIncludesAny(title, [symbol.symbol])
  );

  const matchedRelationships = relationships.filter((rel) =>
    textIncludesAny(title, [
      rel.source_entity_name,
      rel.target_entity_name,
      rel.relationship_type,
    ])
  );

  const symbolicLongevity = clampInt(
    matchedSymbols.reduce((acc, symbol) => acc + safeNumber(symbol.recurrence_score), 0) /
      Math.max(matchedSymbols.length, 1),
    0,
    100,
    0
  );

  const relationshipGravity = clampInt(
    matchedRelationships.reduce(
      (acc, rel) => acc + safeNumber(rel.bond_score || rel.continuity_score),
      0
    ) / Math.max(matchedRelationships.length, 1),
    0,
    100,
    0
  );

  const continuityScore = safeNumber(continuity?.continuity_score);
  const identityStability = safeNumber(profile?.identity_signature?.identity_stability);

  const identityImpact = clampInt(
    baseImpact * 0.45 +
      continuityScore * 0.25 +
      identityStability * 0.2 +
      symbolicLongevity * 0.1,
    0,
    100,
    0
  );

  const emotionalPermanence = clampInt(
    safeNumber(event.emotional_weight) * 7 +
      symbolicLongevity * 0.2 +
      continuityScore * 0.1,
    0,
    100,
    0
  );

  const trajectoryDisruption = clampInt(
    safeNumber(event.narrative_importance) * 7 +
      baseImpact * 0.2 +
      relationshipGravity * 0.1,
    0,
    100,
    0
  );

  const autobiographicalGravity = clampInt(
    identityImpact * 0.3 +
      emotionalPermanence * 0.2 +
      symbolicLongevity * 0.2 +
      relationshipGravity * 0.15 +
      trajectoryDisruption * 0.15,
    0,
    100,
    0
  );

  return {
    identity_impact: identityImpact,
    emotional_persistence: emotionalPermanence,
    symbolic_longevity: symbolicLongevity,
    relationship_gravity: relationshipGravity,
    trajectory_disruption: trajectoryDisruption,
    autobiographical_gravity: autobiographicalGravity,
    matched_symbols: matchedSymbols.map((s) => s.symbol).slice(0, 10),
    matched_relationships: matchedRelationships
      .map((r) => ({
        relationship_id: r.relationship_id || null,
        relationship_type: r.relationship_type || null,
        source_entity_name: r.source_entity_name || null,
        target_entity_name: r.target_entity_name || null,
        bond_score: r.bond_score || r.continuity_score || 0,
      }))
      .slice(0, 10),
  };
}

function classifyGravity(score) {
  if (score >= 85) return "STRUCTURAL_LIFE_EVENT";
  if (score >= 70) return "HIGH_SIGNIFICANCE_EVENT";
  if (score >= 50) return "SIGNIFICANT_AUTOBIOGRAPHICAL_EVENT";
  if (score >= 30) return "EMERGING_SIGNIFICANCE_EVENT";
  return "CONTEXTUAL_EVENT";
}

function buildSignificantEvent(event, scores, index) {
  return {
    significance_index: index + 1,
    timeline_event_id: event.timeline_event_id,
    memory_id: event.memory_id,
    title: event.title,
    timeline_at: event.timeline_at,
    phase_code: event.phase_code,
    timeline_role: event.timeline_role,
    significance_class: classifyGravity(scores.autobiographical_gravity),
    ...scores,
    source_policy:
      "Significância calculada apenas a partir de timeline, símbolos, relações e continuidade reais persistidos.",
  };
}

function buildSummary(significantEvents) {
  const total = significantEvents.length;
  const structural = significantEvents.filter(
    (event) => event.significance_class === "STRUCTURAL_LIFE_EVENT"
  ).length;

  const high = significantEvents.filter(
    (event) =>
      event.significance_class === "HIGH_SIGNIFICANCE_EVENT" ||
      event.significance_class === "STRUCTURAL_LIFE_EVENT"
  ).length;

  const avg =
    total > 0
      ? significantEvents.reduce(
          (acc, event) => acc + safeNumber(event.autobiographical_gravity),
          0
        ) / total
      : 0;

  const score = clampInt(avg, 0, 100, 0);

  return {
    total_significant_events: total,
    structural_life_events: structural,
    high_significance_events: high,
    longitudinal_significance_score: score,
    significance_state:
      score >= 80
        ? "STRONG_AUTOBIOGRAPHICAL_GRAVITY"
        : score >= 60
          ? "ACTIVE_AUTOBIOGRAPHICAL_GRAVITY"
          : score >= 40
            ? "EMERGING_AUTOBIOGRAPHICAL_GRAVITY"
            : "LOW_LONGITUDINAL_SIGNIFICANCE_DENSITY",
    interpretation:
      total === 0
        ? "Ainda não há eventos suficientes para medir significância autobiográfica longitudinal."
        : score >= 80
          ? "A trajetória possui eventos com forte gravidade autobiográfica estrutural."
          : score >= 60
            ? "A trajetória já possui eventos com impacto autobiográfico relevante."
            : score >= 40
              ? "A trajetória possui sinais emergentes de eventos autobiograficamente significativos."
              : "A trajetória ainda possui baixa densidade de significância longitudinal.",
  };
}

export async function buildLifeEventSignificance({
  authorId,
  limit = 300,
} = {}) {
  const safeAuthorId = Number(authorId);

  if (!Number.isInteger(safeAuthorId) || safeAuthorId <= 0) {
    return {
      ok: false,
      reason: "authorId inválido.",
    };
  }

  const safeLimit = clampInt(limit, 20, 1000, 300);

  const [
    lifeTimeline,
    symbolic,
    continuity,
    resonance,
    relationshipEvolution,
    emotionalClusters,
    cognitiveProfile,
  ] = await Promise.all([
    orchestrateLifeTimeline({ authorId: safeAuthorId, limit: safeLimit }),
    buildSymbolicRecurrence({ authorId: safeAuthorId, limit: 200 }),
    buildNarrativeContinuity({ authorId: safeAuthorId, limit: safeLimit }),
    buildMemoryResonance({ authorId: safeAuthorId, limit: 100 }),
    listRelationshipEvolutions({ authorId: safeAuthorId, limit: 100 }),
    buildEmotionalClusters({ authorId: safeAuthorId, limit: 300 }),
    buildAuthorCognitiveProfile({ authorId: safeAuthorId }),
  ]);

  const timelineEvents = lifeTimeline?.life_timeline || [];
  const symbols = buildSymbolIndex(symbolic);
  const relationships = buildRelationshipIndex(relationshipEvolution);

  const significantEvents = timelineEvents
    .map((event, index) => {
      const scores = scoreEventSignificance({
        event,
        symbols,
        relationships,
        continuity,
        profile: cognitiveProfile,
      });

      return buildSignificantEvent(event, scores, index);
    })
    .filter((event) => event.autobiographical_gravity >= 30)
    .sort((a, b) => b.autobiographical_gravity - a.autobiographical_gravity);

  return {
    ok: true,
    engine: "HDUD Life Event Significance Engine v1",
    author_id: safeAuthorId,
    significant_events: significantEvents,
    identity_impact_map: significantEvents
      .filter((event) => event.identity_impact >= 50)
      .slice(0, 20),
    symbolic_persistence: significantEvents
      .filter((event) => event.symbolic_longevity >= 40)
      .slice(0, 20),
    relationship_gravity: significantEvents
      .filter((event) => event.relationship_gravity >= 40)
      .slice(0, 20),
    emotional_persistence: significantEvents
      .filter((event) => event.emotional_persistence >= 50)
      .slice(0, 20),
    trajectory_disruption_events: significantEvents
      .filter((event) => event.trajectory_disruption >= 50)
      .slice(0, 20),
    autobiographical_gravity_map: significantEvents.slice(0, 30),
    longitudinal_significance: {
      symbolic_resonance_score: symbolic?.narrative_resonance?.resonance_score || 0,
      memory_resonance_score: resonance?.resonance_summary?.resonance_score || 0,
      continuity_score: continuity?.continuity_score || 0,
      identity_stability: cognitiveProfile?.identity_signature?.identity_stability || 0,
      emotional_cluster_density: emotionalClusters?.clusters?.length || 0,
    },
    significance_summary: buildSummary(significantEvents),
    source_inventory: {
      total_timeline_events: timelineEvents.length,
      total_symbols: symbols.length,
      total_relationships: relationships.length,
      total_resonance_pairs: resonance?.resonance_pairs?.length || 0,
      cognitive_profile_loaded: Boolean(cognitiveProfile?.ok),
      life_timeline_loaded: Boolean(lifeTimeline?.ok),
    },
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Significância autobiográfica calculada somente a partir de eventos, memórias, símbolos, relações e continuidade reais. Sem interpretação psicológica inventada.",
      mode: "deterministic_cognition",
      graph_idempotent: true,
      clinical_policy:
        "Este engine não realiza diagnóstico, terapia ou avaliação psicológica; calcula apenas peso narrativo/autobiográfico estrutural.",
    },
  };
}