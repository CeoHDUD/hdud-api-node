// C:\HDUD_DATA\hdud-api-node\src\services\narrative\life-timeline-orchestrator.service.js

import { getPool, sql } from "../../db.js";
import { buildNarrativeContinuity } from "./narrative-continuity.service.js";
import { buildSymbolicRecurrence } from "./symbolic-recurrence.service.js";
import { buildMemoryResonance } from "./memory-resonance.service.js";
import { buildAuthorCognitiveProfile } from "./author-cognitive-profile.service.js";
import { orchestrateAutobiographicalBook } from "./book-orchestrator.service.js";
import { listRelationshipEvolutions } from "./relationship-evolution.service.js";
import { buildEmotionalClusters } from "./emotional-cluster.service.js";

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

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  const da = safeDate(a);
  const db = safeDate(b);
  if (!da || !db) return 0;
  return Math.max(0, Math.round(Math.abs(db.getTime() - da.getTime()) / 86400000));
}

async function loadTimelineEvents(authorId, limit) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .input("limit", sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        nt.timeline_event_id,
        nt.memory_id,
        nt.timeline_type,
        nt.title,
        nt.description,
        nt.event_date,
        nt.created_at,
        nt.emotional_weight,
        nt.narrative_importance,
        COALESCE(nt.event_date, nt.created_at) AS timeline_at,
        m.title AS memory_title,
        m.publication_status,
        p.phase_code
      FROM dbo.identity_narrative_timeline nt
      LEFT JOIN dbo.identity_memory m
        ON m.memory_id = nt.memory_id
       AND m.author_id = nt.author_id
       AND ISNULL(m.is_deleted, 0) = 0
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE nt.author_id = @author_id
      ORDER BY
        COALESCE(nt.event_date, nt.created_at) ASC,
        nt.timeline_event_id ASC;
    `);

  return result.recordset || [];
}

async function loadMemoryAnchors(authorId, limit) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .input("limit", sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        m.memory_id,
        m.title,
        m.content,
        m.publication_status,
        m.created_at,
        m.published_at,
        COALESCE(m.published_at, m.created_at) AS memory_at,
        p.phase_code
      FROM dbo.identity_memory m
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY
        COALESCE(m.published_at, m.created_at) ASC,
        m.memory_id ASC;
    `);

  return result.recordset || [];
}

function makePreview(text, maxLen = 180) {
  const clean = normalizeText(text, "")?.replace(/\s+/g, " ").trim() || "";
  if (!clean) return null;
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function scoreTimelineEvent(event) {
  const emotional = safeNumber(event.emotional_weight);
  const narrative = safeNumber(event.narrative_importance);

  return clampInt(emotional * 5 + narrative * 5, 0, 100, 0);
}

function inferTimelineRole(event) {
  const score = scoreTimelineEvent(event);
  const type = normalizeText(event.timeline_type, "").toUpperCase();

  if (score >= 85) return "MAJOR_LIFE_MARKER";
  if (score >= 70) return "TURNING_POINT_CANDIDATE";
  if (type.includes("RELATIONSHIP")) return "RELATIONAL_EVENT";
  if (type.includes("LOSS") || type.includes("RUPTURE")) return "RUPTURE_EVENT";
  if (type.includes("BEGIN") || type.includes("START") || type.includes("ORIGIN")) return "ORIGIN_EVENT";
  if (score >= 50) return "SIGNIFICANT_MEMORY_EVENT";

  return "CONTEXTUAL_EVENT";
}

function buildLifeTimeline(events, memories) {
  const eventItems = events.map((event, index) => ({
    order: index + 1,
    item_type: "TIMELINE_EVENT",
    timeline_event_id: Number(event.timeline_event_id),
    memory_id: event.memory_id ? Number(event.memory_id) : null,
    title: normalizeText(event.title, "Evento narrativo"),
    description: normalizeText(event.description, null),
    timeline_type: normalizeText(event.timeline_type, null),
    memory_title: normalizeText(event.memory_title, null),
    phase_code: normalizeText(event.phase_code, null),
    emotional_weight: safeNumber(event.emotional_weight),
    narrative_importance: safeNumber(event.narrative_importance),
    timeline_at: event.timeline_at || event.event_date || event.created_at || null,
    timeline_role: inferTimelineRole(event),
    life_impact_score: scoreTimelineEvent(event),
  }));

  if (eventItems.length) return eventItems;

  return memories.map((memory, index) => ({
    order: index + 1,
    item_type: "MEMORY_ANCHOR",
    timeline_event_id: null,
    memory_id: Number(memory.memory_id),
    title: normalizeText(memory.title, "Memória sem título"),
    description: makePreview(memory.content),
    timeline_type: "MEMORY_FALLBACK",
    memory_title: normalizeText(memory.title, null),
    phase_code: normalizeText(memory.phase_code, null),
    emotional_weight: 0,
    narrative_importance: 0,
    timeline_at: memory.memory_at || memory.published_at || memory.created_at || null,
    timeline_role: "MEMORY_ANCHOR",
    life_impact_score: 0,
  }));
}

function buildTurningPoints(lifeTimeline, symbolic, relationships) {
  const symbolicNames = new Set(
    (symbolic?.dominant_symbols || []).map((s) =>
      normalizeText(s.symbol, "").toUpperCase()
    )
  );

  const relationshipNames = new Set();

  for (const rel of relationships?.relationships || []) {
    if (rel.source_entity_name) relationshipNames.add(String(rel.source_entity_name).toUpperCase());
    if (rel.target_entity_name) relationshipNames.add(String(rel.target_entity_name).toUpperCase());
  }

  return lifeTimeline
    .filter((item) => {
      const title = normalizeText(item.title, "").toUpperCase();
      const hasSymbol = [...symbolicNames].some((symbol) => symbol && title.includes(symbol));
      const hasRelationship = [...relationshipNames].some((name) => name && title.includes(name));

      return (
        item.life_impact_score >= 70 ||
        item.timeline_role === "TURNING_POINT_CANDIDATE" ||
        item.timeline_role === "MAJOR_LIFE_MARKER" ||
        hasSymbol ||
        hasRelationship
      );
    })
    .slice(0, 20)
    .map((item, index) => ({
      turning_point_index: index + 1,
      timeline_event_id: item.timeline_event_id,
      memory_id: item.memory_id,
      title: item.title,
      timeline_at: item.timeline_at,
      phase_code: item.phase_code,
      turning_point_type:
        item.life_impact_score >= 85
          ? "HIGH_IMPACT_TURNING_POINT"
          : item.timeline_role === "RELATIONAL_EVENT"
            ? "RELATIONAL_TURNING_POINT"
            : "EMERGING_TURNING_POINT",
      life_impact_score: item.life_impact_score,
      source_policy: "Derivado somente de evento/memória real persistida.",
    }));
}

function buildIdentityTransitions(lifeTimeline) {
  const transitions = [];

  for (let i = 1; i < lifeTimeline.length; i += 1) {
    const prev = lifeTimeline[i - 1];
    const curr = lifeTimeline[i];

    const emotionalDelta = Math.abs(
      safeNumber(curr.emotional_weight) - safeNumber(prev.emotional_weight)
    );

    const narrativeDelta = Math.abs(
      safeNumber(curr.narrative_importance) - safeNumber(prev.narrative_importance)
    );

    const deltaScore = clampInt(emotionalDelta * 6 + narrativeDelta * 6, 0, 100, 0);

    if (deltaScore <= 0 && prev.phase_code === curr.phase_code) continue;

    transitions.push({
      from_order: prev.order,
      to_order: curr.order,
      from_title: prev.title,
      to_title: curr.title,
      from_at: prev.timeline_at,
      to_at: curr.timeline_at,
      from_phase_code: prev.phase_code,
      to_phase_code: curr.phase_code,
      emotional_delta: Number(emotionalDelta.toFixed(2)),
      narrative_delta: Number(narrativeDelta.toFixed(2)),
      identity_shift_score: deltaScore,
      transition_type:
        prev.phase_code !== curr.phase_code
          ? "LIFE_PHASE_TRANSITION"
          : deltaScore >= 60
            ? "IDENTITY_SHIFT"
            : deltaScore >= 30
              ? "GRADUAL_IDENTITY_MOVEMENT"
              : "MICRO_CONTINUITY_SHIFT",
    });
  }

  return transitions.slice(0, 50);
}

function buildIrreversibleEvents(turningPoints, continuity) {
  const continuityLoops = continuity?.narrative_loops || [];
  const loopSymbols = new Set(
    continuityLoops.map((loop) => normalizeText(loop.symbol, "").toUpperCase())
  );

  return turningPoints
    .filter((point) => {
      const title = normalizeText(point.title, "").toUpperCase();
      const matchedLoop = [...loopSymbols].some((symbol) => symbol && title.includes(symbol));

      return point.life_impact_score >= 85 || matchedLoop;
    })
    .slice(0, 12)
    .map((point, index) => ({
      irreversible_index: index + 1,
      timeline_event_id: point.timeline_event_id,
      memory_id: point.memory_id,
      title: point.title,
      timeline_at: point.timeline_at,
      irreversible_type:
        point.life_impact_score >= 85
          ? "HIGH_IMPACT_AUTOBIOGRAPHICAL_MARKER"
          : "SYMBOLIC_PERSISTENCE_MARKER",
      identity_shift_score: point.life_impact_score,
      source_policy:
        "Evento marcado como irreversível apenas por alta importância/persistência simbólica real no grafo.",
    }));
}

function buildCausalityChains(lifeTimeline) {
  const chains = [];

  for (let i = 0; i < lifeTimeline.length - 1; i += 1) {
    const source = lifeTimeline[i];
    const target = lifeTimeline[i + 1];

    const gapDays = daysBetween(source.timeline_at, target.timeline_at);
    const emotionalDelta = Math.abs(
      safeNumber(target.emotional_weight) - safeNumber(source.emotional_weight)
    );
    const narrativeDelta = Math.abs(
      safeNumber(target.narrative_importance) - safeNumber(source.narrative_importance)
    );

    const chainStrength = clampInt(
      Math.max(0, 30 - Math.min(gapDays, 30)) +
        emotionalDelta * 5 +
        narrativeDelta * 5,
      0,
      100,
      0
    );

    chains.push({
      chain_index: chains.length + 1,
      source: {
        timeline_event_id: source.timeline_event_id,
        memory_id: source.memory_id,
        title: source.title,
        timeline_at: source.timeline_at,
      },
      consequence: {
        timeline_event_id: target.timeline_event_id,
        memory_id: target.memory_id,
        title: target.title,
        timeline_at: target.timeline_at,
      },
      gap_days: gapDays,
      emotional_delta: Number(emotionalDelta.toFixed(2)),
      narrative_delta: Number(narrativeDelta.toFixed(2)),
      causality_strength: chainStrength,
      causality_type:
        chainStrength >= 70
          ? "STRONG_TEMPORAL_CONTINUITY"
          : chainStrength >= 40
            ? "TEMPORAL_ASSOCIATION"
            : "WEAK_TEMPORAL_SEQUENCE",
      source_policy:
        "Cadeia temporal determinística; não afirma causalidade factual absoluta.",
    });
  }

  return chains
    .filter((chain) => chain.causality_strength >= 30)
    .slice(0, 50);
}

function buildLifePeriods(memories, book) {
  const eras = book?.narrative_eras || [];

  if (eras.length) {
    return eras.map((era, index) => ({
      period_index: index + 1,
      period_label: era.era_label || "Período autobiográfico",
      phase_code: era.phase_code || null,
      total_memories: era.total_memories || 0,
      first_at: era.first_memory_at || null,
      last_at: era.last_memory_at || null,
      timeline_span_days: era.timeline_span_days || 0,
      period_role: era.book_function || "LIFE_PERIOD",
    }));
  }

  if (!memories.length) return [];

  return [
    {
      period_index: 1,
      period_label: "Período inicial da narrativa",
      phase_code: null,
      total_memories: memories.length,
      first_at: memories[0]?.memory_at || null,
      last_at: memories[memories.length - 1]?.memory_at || null,
      timeline_span_days: daysBetween(memories[0]?.memory_at, memories[memories.length - 1]?.memory_at),
      period_role: "INITIAL_LIFE_PERIOD",
    },
  ];
}

function buildTrajectoryMap({ turningPoints, transitions, symbolic, continuity }) {
  const symbols = symbolic?.symbolic_patterns || [];
  const loops = continuity?.narrative_loops || [];

  return {
    dominant_symbols: symbols.slice(0, 8).map((symbol) => ({
      symbol: symbol.symbol,
      recurrence_score: symbol.recurrence_score,
      identity_axis: symbol.identity_axis,
    })),
    dominant_loops: loops.slice(0, 8),
    turning_point_count: turningPoints.length,
    identity_transition_count: transitions.length,
    trajectory_density_score: clampInt(
      turningPoints.length * 10 + transitions.length * 4 + loops.length * 8,
      0,
      100,
      0
    ),
  };
}

function buildContinuityTimeline(lifeTimeline, continuity) {
  const loops = continuity?.narrative_loops || [];
  const loopSymbols = loops.map((loop) => normalizeText(loop.symbol, "").toUpperCase());

  return lifeTimeline
    .map((item) => {
      const title = normalizeText(item.title, "").toUpperCase();

      const matchedSymbols = loopSymbols.filter(
        (symbol) => symbol && title.includes(symbol)
      );

      return {
        order: item.order,
        timeline_event_id: item.timeline_event_id,
        memory_id: item.memory_id,
        title: item.title,
        timeline_at: item.timeline_at,
        continuity_role:
          matchedSymbols.length > 0
            ? "SYMBOLIC_CONTINUITY_NODE"
            : item.life_impact_score >= 70
              ? "HIGH_IMPACT_CONTINUITY_NODE"
              : "TIMELINE_NODE",
        matched_symbols: matchedSymbols,
        continuity_score: clampInt(
          item.life_impact_score + matchedSymbols.length * 15,
          0,
          100,
          0
        ),
      };
    })
    .filter((item) => item.continuity_score > 0)
    .slice(0, 80);
}

function buildTemporalIdentity({ profile, continuity, lifeTimeline, turningPoints }) {
  const first = lifeTimeline[0] || null;
  const last = lifeTimeline[lifeTimeline.length - 1] || null;

  const spanDays = first && last ? daysBetween(first.timeline_at, last.timeline_at) : 0;

  return {
    identity_axis: profile?.identity_signature?.core_axis || null,
    identity_stability: profile?.identity_signature?.identity_stability || 0,
    continuity_score: continuity?.continuity_score || 0,
    total_timeline_nodes: lifeTimeline.length,
    total_turning_points: turningPoints.length,
    timeline_span_days: spanDays,
    temporal_state:
      spanDays >= 365 && turningPoints.length >= 3
        ? "LONG_TERM_TEMPORAL_IDENTITY"
        : turningPoints.length >= 2
          ? "ACTIVE_TEMPORAL_IDENTITY"
          : lifeTimeline.length > 0
            ? "EMERGING_TEMPORAL_IDENTITY"
            : "NO_TEMPORAL_IDENTITY",
  };
}

function buildTimelineSummary({ lifeTimeline, turningPoints, transitions, irreversibleEvents, chains, temporalIdentity }) {
  const temporalScore = clampInt(
    Math.min(lifeTimeline.length * 5, 30) +
      turningPoints.length * 10 +
      transitions.length * 4 +
      irreversibleEvents.length * 8 +
      chains.length * 2,
    0,
    100,
    0
  );

  return {
    total_timeline_nodes: lifeTimeline.length,
    total_turning_points: turningPoints.length,
    total_identity_transitions: transitions.length,
    total_irreversible_events: irreversibleEvents.length,
    total_causality_chains: chains.length,
    temporal_identity_state: temporalIdentity.temporal_state,
    temporal_cognition_score: temporalScore,
    interpretation:
      temporalScore >= 80
        ? "A linha da vida possui densidade temporal forte para leitura autobiográfica longitudinal."
        : temporalScore >= 60
          ? "A linha da vida já possui estrutura temporal ativa, com marcos e transições relevantes."
          : temporalScore >= 40
            ? "A linha da vida possui sinais temporais emergentes, ainda em consolidação."
            : "A linha da vida ainda possui baixa densidade temporal para cognição longitudinal robusta.",
  };
}

export async function orchestrateLifeTimeline({
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
    timelineEvents,
    memories,
    continuity,
    symbolic,
    resonance,
    cognitiveProfile,
    book,
    relationshipEvolution,
    emotionalClusters,
  ] = await Promise.all([
    loadTimelineEvents(safeAuthorId, safeLimit),
    loadMemoryAnchors(safeAuthorId, safeLimit),
    buildNarrativeContinuity({ authorId: safeAuthorId, limit: safeLimit }),
    buildSymbolicRecurrence({ authorId: safeAuthorId, limit: 200 }),
    buildMemoryResonance({ authorId: safeAuthorId, limit: 100 }),
    buildAuthorCognitiveProfile({ authorId: safeAuthorId }),
    orchestrateAutobiographicalBook({ authorId: safeAuthorId, limit: safeLimit }),
    listRelationshipEvolutions({ authorId: safeAuthorId, limit: 100 }),
    buildEmotionalClusters({ authorId: safeAuthorId, limit: 300 }),
  ]);

  const lifeTimeline = buildLifeTimeline(timelineEvents, memories);
  const turningPoints = buildTurningPoints(lifeTimeline, symbolic, relationshipEvolution);
  const identityTransitions = buildIdentityTransitions(lifeTimeline);
  const irreversibleEvents = buildIrreversibleEvents(turningPoints, continuity);
  const causalityChains = buildCausalityChains(lifeTimeline);
  const lifePeriods = buildLifePeriods(memories, book);

  const trajectoryMap = buildTrajectoryMap({
    turningPoints,
    transitions: identityTransitions,
    symbolic,
    continuity,
  });

  const continuityTimeline = buildContinuityTimeline(lifeTimeline, continuity);

  const temporalIdentity = buildTemporalIdentity({
    profile: cognitiveProfile,
    continuity,
    lifeTimeline,
    turningPoints,
  });

  return {
    ok: true,
    engine: "HDUD Life Timeline Orchestrator v1",
    author_id: safeAuthorId,
    life_timeline: lifeTimeline,
    turning_points: turningPoints,
    identity_transitions: identityTransitions,
    irreversible_events: irreversibleEvents,
    causality_chains: causalityChains,
    life_periods: lifePeriods,
    trajectory_map: trajectoryMap,
    continuity_timeline: continuityTimeline,
    temporal_identity: temporalIdentity,
    emotional_temporal_context: {
      total_emotional_clusters: emotionalClusters?.clusters?.length || 0,
      dominant_cluster: emotionalClusters?.clusters?.[0]?.cluster_label || null,
      emotional_continuity_state: continuity?.emotional_continuity?.state || null,
    },
    timeline_summary: buildTimelineSummary({
      lifeTimeline,
      turningPoints,
      transitions: identityTransitions,
      irreversibleEvents,
      chains: causalityChains,
      temporalIdentity,
    }),
    source_inventory: {
      total_timeline_events: timelineEvents.length,
      total_memories: memories.length,
      total_symbols: symbolic?.symbolic_patterns?.length || 0,
      total_relationships: relationshipEvolution?.relationships?.length || 0,
      total_resonance_pairs: resonance?.resonance_pairs?.length || 0,
      book_orchestration_loaded: Boolean(book?.ok),
      cognitive_profile_loaded: Boolean(cognitiveProfile?.ok),
    },
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Linha da vida derivada somente de timeline, memórias, relações, símbolos e cognição real persistidos. Sem causalidade inventada.",
      mode: "deterministic_cognition",
      graph_idempotent: true,
      causality_policy:
        "Cadeias temporais representam associação determinística, não afirmação factual absoluta.",
    },
  };
}