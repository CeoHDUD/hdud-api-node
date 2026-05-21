// C:\HDUD_DATA\hdud-api-node\src\services\narrative\narrative-continuity.service.js

import { getPool, sql } from "../../db.js";

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

function inferContinuityState(score) {
  if (score >= 80) return "STRONG_AUTOBIOGRAPHICAL_CONTINUITY";
  if (score >= 60) return "ACTIVE_NARRATIVE_CONTINUITY";
  if (score >= 40) return "EMERGING_CONTINUITY";
  if (score > 0) return "INITIAL_CONTINUITY";
  return "INSUFFICIENT_GRAPH_DENSITY";
}

function inferTransitionType(row) {
  const emotionalDelta = safeNumber(row.emotional_delta);
  const narrativeDelta = safeNumber(row.narrative_delta);

  if (emotionalDelta >= 5 && narrativeDelta >= 5) return "MAJOR_TRAJECTORY_SHIFT";
  if (emotionalDelta >= 5) return "EMOTIONAL_SHIFT";
  if (narrativeDelta >= 5) return "NARRATIVE_IMPORTANCE_SHIFT";
  if (emotionalDelta <= 1 && narrativeDelta <= 1) return "STABLE_CONTINUITY";

  return "GRADUAL_TRANSITION";
}

function buildContinuitySummary({
  totalMemories,
  totalSymbols,
  totalRelationships,
  totalTimelineEvents,
  continuityScore,
}) {
  return {
    total_memories: totalMemories,
    total_symbols: totalSymbols,
    total_relationships: totalRelationships,
    total_timeline_events: totalTimelineEvents,
    continuity_score: continuityScore,
    continuity_state: inferContinuityState(continuityScore),
    interpretation:
      continuityScore >= 80
        ? "O autor possui continuidade autobiográfica forte e persistente no grafo narrativo."
        : continuityScore >= 60
          ? "O autor possui continuidade narrativa ativa, com padrões simbólicos e relacionais em consolidação."
          : continuityScore >= 40
            ? "O autor possui continuidade autobiográfica emergente, ainda dependente de maior densidade longitudinal."
            : totalMemories > 0
              ? "O grafo possui sinais iniciais de continuidade, mas ainda não há densidade suficiente para leitura longitudinal forte."
              : "Ainda não há dados suficientes para continuidade autobiográfica.",
  };
}

export async function buildNarrativeContinuity({
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
  const pool = await getPool();

  const memoryResult = await pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .input("limit", sql.Int, safeLimit)
    .query(`
      SELECT TOP (@limit)
        m.memory_id,
        m.title,
        m.created_at,
        m.published_at,
        m.publication_status,
        p.phase_code,
        COALESCE(m.published_at, m.created_at) AS memory_at
      FROM dbo.identity_memory m
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY
        COALESCE(m.published_at, m.created_at) ASC,
        m.memory_id ASC;
    `);

  const memories = memoryResult.recordset || [];
  const memoryIds = memories.map((m) => Number(m.memory_id));

  if (!memoryIds.length) {
    return {
      ok: true,
      engine: "HDUD Narrative Continuity Engine v1",
      author_id: safeAuthorId,
      continuity_score: 0,
      identity_stability: {
        score: 0,
        state: "NO_MEMORIES",
      },
      emotional_continuity: {
        score: 0,
        state: "NO_TIMELINE",
      },
      symbolic_persistence: [],
      relationship_continuity: [],
      narrative_loops: [],
      narrative_eras: [],
      trajectory_transitions: [],
      continuity_summary: buildContinuitySummary({
        totalMemories: 0,
        totalSymbols: 0,
        totalRelationships: 0,
        totalTimelineEvents: 0,
        continuityScore: 0,
      }),
      meta: {
        generated_at: new Date().toISOString(),
        source_policy:
          "Somente continuidade calculada a partir de dados reais persistidos no Living Narrative Graph.",
        mode: "deterministic_cognition",
        graph_idempotent: true,
      },
    };
  }

  const symbolsResult = await pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .query(`
      SELECT
        e.entity_id,
        e.entity_type,
        e.entity_name,
        ISNULL(e.recurrence_count, 0) AS recurrence_count,
        ISNULL(e.importance_score, 0) AS importance_score,
        COUNT(DISTINCT me.memory_id) AS total_memories,
        AVG(CAST(ISNULL(me.emotional_weight, 0) AS FLOAT)) AS emotional_weight_avg,
        MIN(COALESCE(m.published_at, m.created_at)) AS first_seen_at,
        MAX(COALESCE(m.published_at, m.created_at)) AS last_seen_at
      FROM dbo.identity_narrative_entity e
      INNER JOIN dbo.identity_memory_entity me
        ON me.entity_id = e.entity_id
      INNER JOIN dbo.identity_memory m
        ON m.memory_id = me.memory_id
       AND m.author_id = e.author_id
       AND ISNULL(m.is_deleted, 0) = 0
      WHERE e.author_id = @author_id
      GROUP BY
        e.entity_id,
        e.entity_type,
        e.entity_name,
        e.recurrence_count,
        e.importance_score
      HAVING COUNT(DISTINCT me.memory_id) >= 1
      ORDER BY
        COUNT(DISTINCT me.memory_id) DESC,
        ISNULL(e.recurrence_count, 0) DESC,
        AVG(CAST(ISNULL(me.emotional_weight, 0) AS FLOAT)) DESC;
    `);

  const relationshipResult = await pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .query(`
      SELECT
        r.relationship_id,
        r.relationship_type,
        se.entity_name AS source_entity_name,
        te.entity_name AS target_entity_name,
        ISNULL(r.emotional_strength, 0) AS emotional_strength,
        ISNULL(r.narrative_weight, 0) AS narrative_weight,
        COUNT(DISTINCT mr.memory_id) AS total_memories,
        MIN(COALESCE(m.published_at, m.created_at)) AS first_seen_at,
        MAX(COALESCE(m.published_at, m.created_at)) AS last_seen_at
      FROM dbo.identity_narrative_relationship r
      INNER JOIN dbo.identity_narrative_entity se
        ON se.entity_id = r.source_entity_id
      INNER JOIN dbo.identity_narrative_entity te
        ON te.entity_id = r.target_entity_id
      LEFT JOIN dbo.identity_memory_relationship mr
        ON mr.relationship_id = r.relationship_id
      LEFT JOIN dbo.identity_memory m
        ON m.memory_id = mr.memory_id
       AND m.author_id = @author_id
       AND ISNULL(m.is_deleted, 0) = 0
      WHERE r.author_id = @author_id
      GROUP BY
        r.relationship_id,
        r.relationship_type,
        se.entity_name,
        te.entity_name,
        r.emotional_strength,
        r.narrative_weight
      ORDER BY
        COUNT(DISTINCT mr.memory_id) DESC,
        ISNULL(r.narrative_weight, 0) DESC,
        ISNULL(r.emotional_strength, 0) DESC;
    `);

  const timelineResult = await pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .query(`
      SELECT
        nt.timeline_event_id,
        nt.memory_id,
        nt.timeline_type,
        nt.title,
        nt.event_date,
        nt.created_at,
        ISNULL(nt.emotional_weight, 0) AS emotional_weight,
        ISNULL(nt.narrative_importance, 0) AS narrative_importance,
        COALESCE(nt.event_date, nt.created_at) AS timeline_at
      FROM dbo.identity_narrative_timeline nt
      WHERE nt.author_id = @author_id
      ORDER BY
        COALESCE(nt.event_date, nt.created_at) ASC,
        nt.timeline_event_id ASC;
    `);

  const symbols = symbolsResult.recordset || [];
  const relationships = relationshipResult.recordset || [];
  const timeline = timelineResult.recordset || [];

  const symbolicPersistence = symbols.slice(0, 20).map((row) => {
    const spanDays = daysBetween(row.first_seen_at, row.last_seen_at);
    const totalMemories = clampInt(row.total_memories, 0, 9999, 0);
    const recurrenceCount = clampInt(row.recurrence_count, 0, 9999, totalMemories);
    const emotionalAvg = safeNumber(row.emotional_weight_avg);
    const importance = safeNumber(row.importance_score);

    const continuityScore = clampInt(
      totalMemories * 18 +
        recurrenceCount * 10 +
        emotionalAvg * 4 +
        importance * 2 +
        (spanDays >= 365 ? 12 : spanDays >= 90 ? 8 : spanDays >= 30 ? 4 : 0),
      0,
      100,
      0
    );

    return {
      entity_id: Number(row.entity_id),
      symbol: normalizeText(row.entity_name, "Símbolo narrativo"),
      entity_type: normalizeText(row.entity_type, null),
      total_memories: totalMemories,
      recurrence_count: recurrenceCount,
      emotional_weight_avg: Number(emotionalAvg.toFixed(2)),
      timeline_span_days: spanDays,
      continuity_score: continuityScore,
      first_seen_at: row.first_seen_at || null,
      last_seen_at: row.last_seen_at || null,
    };
  });

  const relationshipContinuity = relationships.slice(0, 20).map((row) => {
    const spanDays = daysBetween(row.first_seen_at, row.last_seen_at);
    const totalMemories = clampInt(row.total_memories, 0, 9999, 0);
    const emotionalStrength = safeNumber(row.emotional_strength);
    const narrativeWeight = safeNumber(row.narrative_weight);

    const continuityScore = clampInt(
      totalMemories * 22 +
        emotionalStrength * 4 +
        narrativeWeight * 4 +
        (spanDays >= 365 ? 10 : spanDays >= 90 ? 6 : spanDays >= 30 ? 3 : 0),
      0,
      100,
      0
    );

    return {
      relationship_id: Number(row.relationship_id),
      relationship_type: normalizeText(row.relationship_type, null),
      source_entity_name: normalizeText(row.source_entity_name, null),
      target_entity_name: normalizeText(row.target_entity_name, null),
      total_memories: totalMemories,
      emotional_strength: emotionalStrength,
      narrative_weight: narrativeWeight,
      timeline_span_days: spanDays,
      continuity_score: continuityScore,
      first_seen_at: row.first_seen_at || null,
      last_seen_at: row.last_seen_at || null,
    };
  });

  const timelineOrdered = [...timeline].sort((a, b) => {
    const da = safeDate(a.timeline_at)?.getTime() ?? 0;
    const db = safeDate(b.timeline_at)?.getTime() ?? 0;
    if (da !== db) return da - db;
    return Number(a.timeline_event_id) - Number(b.timeline_event_id);
  });

  const trajectoryTransitions = [];

  for (let i = 1; i < timelineOrdered.length; i += 1) {
    const prev = timelineOrdered[i - 1];
    const curr = timelineOrdered[i];

    const emotionalDelta = Math.abs(
      safeNumber(curr.emotional_weight) - safeNumber(prev.emotional_weight)
    );

    const narrativeDelta = Math.abs(
      safeNumber(curr.narrative_importance) - safeNumber(prev.narrative_importance)
    );

    const transition = {
      from_event_id: Number(prev.timeline_event_id),
      to_event_id: Number(curr.timeline_event_id),
      from_title: normalizeText(prev.title, null),
      to_title: normalizeText(curr.title, null),
      emotional_delta: Number(emotionalDelta.toFixed(2)),
      narrative_delta: Number(narrativeDelta.toFixed(2)),
      transition_type: inferTransitionType({
        emotional_delta: emotionalDelta,
        narrative_delta: narrativeDelta,
      }),
      from_at: prev.timeline_at || null,
      to_at: curr.timeline_at || null,
    };

    trajectoryTransitions.push(transition);
  }

  const narrativeEras = memories.reduce((acc, memory) => {
    const key = normalizeText(memory.phase_code, "SEM_FASE");
    if (!acc.has(key)) {
      acc.set(key, {
        phase_code: key === "SEM_FASE" ? null : key,
        total_memories: 0,
        first_memory_at: memory.memory_at || null,
        last_memory_at: memory.memory_at || null,
      });
    }

    const era = acc.get(key);
    era.total_memories += 1;
    era.last_memory_at = memory.memory_at || era.last_memory_at;

    return acc;
  }, new Map());

  const eras = [...narrativeEras.values()].map((era, index) => ({
    era_index: index + 1,
    era_label: era.phase_code || "Sem fase narrativa definida",
    ...era,
    timeline_span_days: daysBetween(era.first_memory_at, era.last_memory_at),
  }));

  const narrativeLoops = symbolicPersistence
    .filter((symbol) => symbol.total_memories >= 2 || symbol.recurrence_count >= 2)
    .slice(0, 10)
    .map((symbol) => ({
      loop_type:
        symbol.timeline_span_days >= 180
          ? "LONGITUDINAL_SYMBOLIC_LOOP"
          : "EMERGING_SYMBOLIC_LOOP",
      symbol: symbol.symbol,
      entity_id: symbol.entity_id,
      total_memories: symbol.total_memories,
      recurrence_count: symbol.recurrence_count,
      continuity_score: symbol.continuity_score,
      timeline_span_days: symbol.timeline_span_days,
    }));

  const topSymbolScore =
    symbolicPersistence.length > 0
      ? Math.max(...symbolicPersistence.map((s) => s.continuity_score))
      : 0;

  const topRelationshipScore =
    relationshipContinuity.length > 0
      ? Math.max(...relationshipContinuity.map((r) => r.continuity_score))
      : 0;

  const avgTransitionStability =
    trajectoryTransitions.length > 0
      ? trajectoryTransitions.filter((t) => t.transition_type === "STABLE_CONTINUITY").length /
        trajectoryTransitions.length
      : 0;

  const emotionalContinuityScore = clampInt(
    timeline.length * 8 + avgTransitionStability * 40,
    0,
    100,
    0
  );

  const identityStabilityScore = clampInt(
    topSymbolScore * 0.45 +
      topRelationshipScore * 0.35 +
      Math.min(memories.length * 6, 20),
    0,
    100,
    0
  );

  const continuityScore = clampInt(
    identityStabilityScore * 0.4 +
      emotionalContinuityScore * 0.25 +
      topSymbolScore * 0.2 +
      topRelationshipScore * 0.15,
    0,
    100,
    0
  );

  return {
    ok: true,
    engine: "HDUD Narrative Continuity Engine v1",
    author_id: safeAuthorId,
    continuity_score: continuityScore,
    identity_stability: {
      score: identityStabilityScore,
      state: inferContinuityState(identityStabilityScore),
    },
    emotional_continuity: {
      score: emotionalContinuityScore,
      total_timeline_events: timeline.length,
      stable_transitions: trajectoryTransitions.filter(
        (t) => t.transition_type === "STABLE_CONTINUITY"
      ).length,
      state: inferContinuityState(emotionalContinuityScore),
    },
    symbolic_persistence: symbolicPersistence,
    relationship_continuity: relationshipContinuity,
    narrative_loops: narrativeLoops,
    narrative_eras: eras,
    trajectory_transitions: trajectoryTransitions.slice(0, 50),
    continuity_summary: buildContinuitySummary({
      totalMemories: memories.length,
      totalSymbols: symbols.length,
      totalRelationships: relationships.length,
      totalTimelineEvents: timeline.length,
      continuityScore,
    }),
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Somente continuidade calculada a partir de memórias, entidades, relações e timeline reais persistidas no Living Narrative Graph.",
      mode: "deterministic_cognition",
      graph_idempotent: true,
    },
  };
}