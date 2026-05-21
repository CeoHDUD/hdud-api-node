// C:\HDUD_DATA\hdud-api-node\src\services\narrative\symbolic-recurrence.service.js

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

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  const da = safeDate(a);
  const db = safeDate(b);

  if (!da || !db) return 0;

  const diff = Math.abs(db.getTime() - da.getTime());
  return Math.max(0, Math.round(diff / 86400000));
}

function scoreSymbolicRole({
  recurrenceCount,
  totalMemories,
  avgEmotionalWeight,
  avgNarrativeImportance,
  relationshipDensity,
  timelineSpanDays,
}) {
  const recurrenceScore = Math.min(40, recurrenceCount * 8);
  const memoryScore = Math.min(20, totalMemories * 4);
  const emotionScore = Math.min(20, avgEmotionalWeight * 2);
  const narrativeScore = Math.min(10, avgNarrativeImportance);
  const relationshipScore = Math.min(5, relationshipDensity * 5);
  const timeScore = timelineSpanDays >= 180 ? 5 : timelineSpanDays >= 30 ? 3 : 1;

  return clampInt(
    recurrenceScore +
      memoryScore +
      emotionScore +
      narrativeScore +
      relationshipScore +
      timeScore,
    0,
    100,
    0
  );
}

function inferSymbolicRole({
  entityType,
  avgEmotionalWeight,
  avgNarrativeImportance,
  recurrenceScore,
  relationshipDensity,
  timelineSpanDays,
}) {
  const type = normalizeText(entityType, "").toUpperCase();

  if (type === "SELF") return "SELF_IDENTITY_AXIS";

  if (recurrenceScore >= 80 && avgEmotionalWeight >= 7) {
    return "CORE_AUTOBIOGRAPHICAL_SYMBOL";
  }

  if (avgEmotionalWeight >= 8 && relationshipDensity >= 0.6) {
    return "EMOTIONAL_TRIGGER";
  }

  if (avgNarrativeImportance >= 8 && timelineSpanDays >= 180) {
    return "LIFE_TRAJECTORY_MARKER";
  }

  if (relationshipDensity >= 0.7) {
    return "RELATIONAL_SYMBOL";
  }

  if (timelineSpanDays >= 365) {
    return "LONGITUDINAL_CALLBACK";
  }

  return "NARRATIVE_RECURRENCE";
}

function inferIdentityAxis({ entityType, symbol, symbolicRole }) {
  const text = `${entityType || ""} ${symbol || ""} ${symbolicRole || ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  if (text.includes("SELF")) return "SELFHOOD";
  if (text.includes("CASA") || text.includes("LAR")) return "BELONGING";
  if (text.includes("MAE") || text.includes("PAI") || text.includes("FAMIL")) return "ORIGIN";
  if (text.includes("BRUNA") || text.includes("AMOR")) return "AFFECTION";
  if (text.includes("TRABALHO") || text.includes("CARREIRA")) return "PURPOSE";

  if (symbolicRole === "CORE_AUTOBIOGRAPHICAL_SYMBOL") return "IDENTITY";
  if (symbolicRole === "RELATIONAL_SYMBOL") return "RELATIONSHIP";
  if (symbolicRole === "LIFE_TRAJECTORY_MARKER") return "TRAJECTORY";
  if (symbolicRole === "EMOTIONAL_TRIGGER") return "EMOTION";

  return "NARRATIVE_MEMORY";
}

function buildSymbolicPattern(row) {
  const totalMemories = clampInt(row.total_memories, 0, 9999, 0);
  const recurrenceCount = clampInt(row.recurrence_count, 0, 9999, totalMemories);
  const avgEmotionalWeight = Number(row.avg_emotional_weight || 0);
  const avgNarrativeImportance = Number(row.avg_narrative_importance || 0);
  const relationshipDensity = Number(row.relationship_density || 0);
  const timelineSpanDays = daysBetween(row.first_seen_at, row.last_seen_at);

  const recurrenceScore = scoreSymbolicRole({
    recurrenceCount,
    totalMemories,
    avgEmotionalWeight,
    avgNarrativeImportance,
    relationshipDensity,
    timelineSpanDays,
  });

  const symbolicRole = inferSymbolicRole({
    entityType: row.entity_type,
    avgEmotionalWeight,
    avgNarrativeImportance,
    recurrenceScore,
    relationshipDensity,
    timelineSpanDays,
  });

  return {
    entity_id: Number(row.entity_id),
    symbol: normalizeText(row.entity_name, "Símbolo narrativo"),
    entity_type: normalizeText(row.entity_type, null),
    symbolic_role: symbolicRole,
    recurrence_score: recurrenceScore,
    total_memories: totalMemories,
    recurrence_count: recurrenceCount,
    emotional_weight_avg: Number(avgEmotionalWeight.toFixed(2)),
    narrative_importance_avg: Number(avgNarrativeImportance.toFixed(2)),
    relationship_density: Number(relationshipDensity.toFixed(2)),
    timeline_span_days: timelineSpanDays,
    first_seen_at: row.first_seen_at || null,
    last_seen_at: row.last_seen_at || null,
    identity_axis: inferIdentityAxis({
      entityType: row.entity_type,
      symbol: row.entity_name,
      symbolicRole,
    }),
  };
}

function buildCallback(pattern) {
  let callbackType = "SYMBOLIC_RETURN";

  if (pattern.symbolic_role === "CORE_AUTOBIOGRAPHICAL_SYMBOL") {
    callbackType = "CORE_IDENTITY_RETURN";
  } else if (pattern.symbolic_role === "EMOTIONAL_TRIGGER") {
    callbackType = "EMOTIONAL_CALLBACK";
  } else if (pattern.symbolic_role === "LIFE_TRAJECTORY_MARKER") {
    callbackType = "LIFE_TRANSITION";
  } else if (pattern.symbolic_role === "RELATIONAL_SYMBOL") {
    callbackType = "RELATIONAL_CALLBACK";
  } else if (pattern.timeline_span_days >= 365) {
    callbackType = "LONG_TERM_RESONANCE";
  }

  return {
    symbol: pattern.symbol,
    entity_id: pattern.entity_id,
    callback_type: callbackType,
    recurrence_score: pattern.recurrence_score,
    first_seen_at: pattern.first_seen_at,
    last_seen_at: pattern.last_seen_at,
    timeline_span_days: pattern.timeline_span_days,
    identity_axis: pattern.identity_axis,
  };
}

function buildNarrativeResonance(patterns) {
  const totalSymbols = patterns.length;
  const strongSymbols = patterns.filter((p) => p.recurrence_score >= 70).length;
  const emotionalSymbols = patterns.filter((p) => p.emotional_weight_avg >= 7).length;
  const longTermSymbols = patterns.filter((p) => p.timeline_span_days >= 180).length;

  const avgRecurrence =
    totalSymbols > 0
      ? patterns.reduce((acc, p) => acc + Number(p.recurrence_score || 0), 0) /
        totalSymbols
      : 0;

  return {
    total_symbols: totalSymbols,
    strong_symbols: strongSymbols,
    emotional_symbols: emotionalSymbols,
    long_term_symbols: longTermSymbols,
    resonance_score: clampInt(avgRecurrence, 0, 100, 0),
    interpretation:
      totalSymbols === 0
        ? "Sem recorrências simbólicas suficientes no grafo narrativo atual."
        : strongSymbols >= 3
          ? "O autor possui recorrências simbólicas fortes e persistentes ao longo da própria trajetória."
          : emotionalSymbols >= 3
            ? "O autor possui símbolos emocionais recorrentes que estruturam parte importante da narrativa."
            : "O autor possui recorrências narrativas iniciais, ainda em consolidação longitudinal.",
  };
}

export async function buildSymbolicRecurrence({
  authorId,
  limit = 100,
} = {}) {
  const safeAuthorId = Number(authorId);

  if (!Number.isInteger(safeAuthorId) || safeAuthorId <= 0) {
    return {
      ok: false,
      reason: "authorId inválido.",
    };
  }

  const safeLimit = clampInt(limit, 10, 500, 100);
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .input("limit", sql.Int, safeLimit)
    .query(`
      WITH entity_memory_base AS (
        SELECT
          e.entity_id,
          e.entity_type,
          e.entity_name,
          ISNULL(e.recurrence_count, 0) AS recurrence_count,
          ISNULL(e.importance_score, 0) AS importance_score,
          m.memory_id,
          COALESCE(m.published_at, m.created_at) AS memory_at,
          ISNULL(me.emotional_weight, 0) AS emotional_weight
        FROM dbo.identity_narrative_entity e
        INNER JOIN dbo.identity_memory_entity me
          ON me.entity_id = e.entity_id
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = me.memory_id
         AND m.author_id = e.author_id
         AND ISNULL(m.is_deleted, 0) = 0
        WHERE e.author_id = @author_id
      ),
      timeline_score AS (
        SELECT
          me.entity_id,
          AVG(CAST(ISNULL(nt.narrative_importance, 0) AS FLOAT)) AS avg_narrative_importance
        FROM dbo.identity_memory_entity me
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = me.memory_id
         AND m.author_id = @author_id
         AND ISNULL(m.is_deleted, 0) = 0
        LEFT JOIN dbo.identity_narrative_timeline nt
          ON nt.memory_id = m.memory_id
         AND nt.author_id = @author_id
        GROUP BY me.entity_id
      ),
      relationship_score AS (
        SELECT
          x.entity_id,
          COUNT(DISTINCT x.relationship_id) AS total_relationships
        FROM (
          SELECT
            r.source_entity_id AS entity_id,
            r.relationship_id
          FROM dbo.identity_narrative_relationship r
          WHERE r.author_id = @author_id

          UNION ALL

          SELECT
            r.target_entity_id AS entity_id,
            r.relationship_id
          FROM dbo.identity_narrative_relationship r
          WHERE r.author_id = @author_id
        ) x
        GROUP BY x.entity_id
      )
      SELECT TOP (@limit)
        b.entity_id,
        b.entity_type,
        b.entity_name,
        MAX(b.recurrence_count) AS recurrence_count,
        COUNT(DISTINCT b.memory_id) AS total_memories,
        AVG(CAST(b.emotional_weight AS FLOAT)) AS avg_emotional_weight,
        MAX(b.memory_at) AS last_seen_at,
        MIN(b.memory_at) AS first_seen_at,
        AVG(CAST(ISNULL(ts.avg_narrative_importance, 0) AS FLOAT)) AS avg_narrative_importance,
        CAST(ISNULL(MAX(rs.total_relationships), 0) AS FLOAT)
          / NULLIF(COUNT(DISTINCT b.memory_id), 0) AS relationship_density
      FROM entity_memory_base b
      LEFT JOIN timeline_score ts
        ON ts.entity_id = b.entity_id
      LEFT JOIN relationship_score rs
        ON rs.entity_id = b.entity_id
      GROUP BY
        b.entity_id,
        b.entity_type,
        b.entity_name
      HAVING COUNT(DISTINCT b.memory_id) >= 2
         OR MAX(b.recurrence_count) >= 2
      ORDER BY
        MAX(b.recurrence_count) DESC,
        AVG(CAST(b.emotional_weight AS FLOAT)) DESC,
        COUNT(DISTINCT b.memory_id) DESC;
    `);

  const symbolicPatterns = (result.recordset || [])
    .map(buildSymbolicPattern)
    .sort((a, b) => {
      if (b.recurrence_score !== a.recurrence_score) {
        return b.recurrence_score - a.recurrence_score;
      }

      return b.total_memories - a.total_memories;
    });

  const dominantSymbols = symbolicPatterns
    .filter((pattern) => pattern.recurrence_score >= 60)
    .slice(0, 10);

  const emotionalCallbacks = symbolicPatterns
    .filter(
      (pattern) =>
        pattern.emotional_weight_avg >= 6 ||
        pattern.timeline_span_days >= 180 ||
        pattern.symbolic_role !== "NARRATIVE_RECURRENCE"
    )
    .slice(0, 15)
    .map(buildCallback);

  const identitySymbols = symbolicPatterns
    .filter(
      (pattern) =>
        pattern.symbolic_role === "CORE_AUTOBIOGRAPHICAL_SYMBOL" ||
        pattern.symbolic_role === "SELF_IDENTITY_AXIS" ||
        pattern.recurrence_score >= 75
    )
    .slice(0, 10)
    .map((pattern) => ({
      symbol: pattern.symbol,
      entity_id: pattern.entity_id,
      identity_axis: pattern.identity_axis,
      continuity_score: pattern.recurrence_score,
      total_memories: pattern.total_memories,
      timeline_span_days: pattern.timeline_span_days,
    }));

  return {
    ok: true,
    engine: "HDUD Symbolic Recurrence Engine v1",
    author_id: safeAuthorId,
    symbolic_patterns: symbolicPatterns,
    dominant_symbols: dominantSymbols,
    emotional_callbacks: emotionalCallbacks,
    identity_symbols: identitySymbols,
    narrative_resonance: buildNarrativeResonance(symbolicPatterns),
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Somente recorrências reais persistidas no Living Narrative Graph. Sem símbolos inventados.",
      mode: "deterministic_cognition",
      graph_idempotent: true,
    },
  };
}