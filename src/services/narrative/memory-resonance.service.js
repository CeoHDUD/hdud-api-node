// C:\HDUD_DATA\hdud-api-node\src\services\narrative\memory-resonance.service.js

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

function scoreResonance(row) {
  const sharedEntities = safeNumber(row.shared_entities);
  const sharedRelationships = safeNumber(row.shared_relationships);
  const emotionalSimilarity = safeNumber(row.emotional_similarity);
  const narrativeSimilarity = safeNumber(row.narrative_similarity);

  return clampInt(
    sharedEntities * 18 +
      sharedRelationships * 22 +
      emotionalSimilarity * 3 +
      narrativeSimilarity * 3,
    0,
    100,
    0
  );
}

function inferResonanceType(row, score) {
  const sharedRelationships = safeNumber(row.shared_relationships);
  const sharedEntities = safeNumber(row.shared_entities);
  const emotionalSimilarity = safeNumber(row.emotional_similarity);
  const narrativeSimilarity = safeNumber(row.narrative_similarity);

  if (score >= 80 && sharedRelationships >= 1) return "DEEP_AUTOBIOGRAPHICAL_RESONANCE";
  if (sharedRelationships >= 1) return "RELATIONAL_RESONANCE";
  if (sharedEntities >= 2 && emotionalSimilarity >= 7) return "EMOTIONAL_ECHO";
  if (sharedEntities >= 2 && narrativeSimilarity >= 7) return "NARRATIVE_PARALLEL";
  if (sharedEntities >= 1) return "SYMBOLIC_CALLBACK";

  return "WEAK_RESONANCE";
}

function normalizeMemoryPair(row) {
  const resonanceScore = scoreResonance(row);

  return {
    source_memory: {
      memory_id: Number(row.source_memory_id),
      title: normalizeText(row.source_title, "Memória sem título"),
      phase_code: normalizeText(row.source_phase_code, null),
      memory_at: row.source_memory_at || null,
    },
    target_memory: {
      memory_id: Number(row.target_memory_id),
      title: normalizeText(row.target_title, "Memória sem título"),
      phase_code: normalizeText(row.target_phase_code, null),
      memory_at: row.target_memory_at || null,
    },
    resonance_type: inferResonanceType(row, resonanceScore),
    resonance_score: resonanceScore,
    shared_entities: clampInt(row.shared_entities, 0, 999, 0),
    shared_relationships: clampInt(row.shared_relationships, 0, 999, 0),
    emotional_similarity: Number(safeNumber(row.emotional_similarity).toFixed(2)),
    narrative_similarity: Number(safeNumber(row.narrative_similarity).toFixed(2)),
  };
}

function buildSummary(pairs) {
  const totalPairs = pairs.length;
  const strongPairs = pairs.filter((p) => p.resonance_score >= 70).length;
  const relationalPairs = pairs.filter((p) => p.resonance_type === "RELATIONAL_RESONANCE" || p.resonance_type === "DEEP_AUTOBIOGRAPHICAL_RESONANCE").length;
  const emotionalEchoes = pairs.filter((p) => p.resonance_type === "EMOTIONAL_ECHO").length;

  const avgScore =
    totalPairs > 0
      ? pairs.reduce((acc, p) => acc + p.resonance_score, 0) / totalPairs
      : 0;

  return {
    total_pairs: totalPairs,
    strong_pairs: strongPairs,
    relational_pairs: relationalPairs,
    emotional_echoes: emotionalEchoes,
    resonance_score: clampInt(avgScore, 0, 100, 0),
    interpretation:
      totalPairs === 0
        ? "Ainda não há pares de memórias com ressonância suficiente no grafo narrativo."
        : strongPairs >= 3
          ? "O autor possui memórias com forte ressonância autobiográfica entre si."
          : relationalPairs >= 2
            ? "O autor possui memórias conectadas por relações persistentes."
            : "O autor possui ressonâncias iniciais entre memórias, ainda em consolidação.",
  };
}

export async function buildMemoryResonance({
  authorId,
  memoryId = null,
  limit = 50,
} = {}) {
  const safeAuthorId = Number(authorId);

  if (!Number.isInteger(safeAuthorId) || safeAuthorId <= 0) {
    return {
      ok: false,
      reason: "authorId inválido.",
    };
  }

  const safeMemoryId = Number(memoryId);
  const hasMemoryFilter = Number.isInteger(safeMemoryId) && safeMemoryId > 0;
  const safeLimit = clampInt(limit, 5, 200, 50);

  const pool = await getPool();

  const request = pool
    .request()
    .input("author_id", sql.BigInt, safeAuthorId)
    .input("limit", sql.Int, safeLimit);

  if (hasMemoryFilter) {
    request.input("memory_id", sql.BigInt, safeMemoryId);
  }

  const result = await request.query(`
    WITH author_memories AS (
      SELECT
        m.memory_id,
        m.title,
        m.created_at,
        m.published_at,
        p.phase_code,
        COALESCE(m.published_at, m.created_at) AS memory_at
      FROM dbo.identity_memory m
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
    ),
    memory_entity_score AS (
      SELECT
        me.memory_id,
        me.entity_id,
        AVG(CAST(ISNULL(me.emotional_weight, 0) AS FLOAT)) AS emotional_weight
      FROM dbo.identity_memory_entity me
      INNER JOIN author_memories am
        ON am.memory_id = me.memory_id
      GROUP BY
        me.memory_id,
        me.entity_id
    ),
    memory_timeline_score AS (
      SELECT
        nt.memory_id,
        AVG(CAST(ISNULL(nt.emotional_weight, 0) AS FLOAT)) AS emotional_avg,
        AVG(CAST(ISNULL(nt.narrative_importance, 0) AS FLOAT)) AS narrative_avg
      FROM dbo.identity_narrative_timeline nt
      INNER JOIN author_memories am
        ON am.memory_id = nt.memory_id
      WHERE nt.author_id = @author_id
      GROUP BY nt.memory_id
    ),
    memory_relationship_score AS (
      SELECT
        mr.memory_id,
        mr.relationship_id
      FROM dbo.identity_memory_relationship mr
      INNER JOIN author_memories am
        ON am.memory_id = mr.memory_id
    ),
    pairs AS (
      SELECT
        a.memory_id AS source_memory_id,
        b.memory_id AS target_memory_id,

        COUNT(DISTINCT CASE
          WHEN ae.entity_id = be.entity_id THEN ae.entity_id
        END) AS shared_entities,

        COUNT(DISTINCT CASE
          WHEN ar.relationship_id = br.relationship_id THEN ar.relationship_id
        END) AS shared_relationships,

        10 - ABS(
          ISNULL(MAX(ats.emotional_avg), 0) -
          ISNULL(MAX(bts.emotional_avg), 0)
        ) AS emotional_similarity,

        10 - ABS(
          ISNULL(MAX(ats.narrative_avg), 0) -
          ISNULL(MAX(bts.narrative_avg), 0)
        ) AS narrative_similarity
      FROM author_memories a
      INNER JOIN author_memories b
        ON b.memory_id > a.memory_id
      LEFT JOIN memory_entity_score ae
        ON ae.memory_id = a.memory_id
      LEFT JOIN memory_entity_score be
        ON be.memory_id = b.memory_id
      LEFT JOIN memory_relationship_score ar
        ON ar.memory_id = a.memory_id
      LEFT JOIN memory_relationship_score br
        ON br.memory_id = b.memory_id
      LEFT JOIN memory_timeline_score ats
        ON ats.memory_id = a.memory_id
      LEFT JOIN memory_timeline_score bts
        ON bts.memory_id = b.memory_id
      WHERE
        (
          ${hasMemoryFilter ? "(a.memory_id = @memory_id OR b.memory_id = @memory_id)" : "1 = 1"}
        )
      GROUP BY
        a.memory_id,
        b.memory_id
    )
    SELECT TOP (@limit)
      p.source_memory_id,
      sm.title AS source_title,
      sm.phase_code AS source_phase_code,
      sm.memory_at AS source_memory_at,

      p.target_memory_id,
      tm.title AS target_title,
      tm.phase_code AS target_phase_code,
      tm.memory_at AS target_memory_at,

      ISNULL(p.shared_entities, 0) AS shared_entities,
      ISNULL(p.shared_relationships, 0) AS shared_relationships,
      CASE
        WHEN ISNULL(p.emotional_similarity, 0) < 0 THEN 0
        ELSE ISNULL(p.emotional_similarity, 0)
      END AS emotional_similarity,
      CASE
        WHEN ISNULL(p.narrative_similarity, 0) < 0 THEN 0
        ELSE ISNULL(p.narrative_similarity, 0)
      END AS narrative_similarity
    FROM pairs p
    INNER JOIN author_memories sm
      ON sm.memory_id = p.source_memory_id
    INNER JOIN author_memories tm
      ON tm.memory_id = p.target_memory_id
    WHERE
      ISNULL(p.shared_entities, 0) > 0
      OR ISNULL(p.shared_relationships, 0) > 0
    ORDER BY
      ISNULL(p.shared_relationships, 0) DESC,
      ISNULL(p.shared_entities, 0) DESC,
      ISNULL(p.emotional_similarity, 0) DESC,
      ISNULL(p.narrative_similarity, 0) DESC;
  `);

  const resonancePairs = (result.recordset || [])
    .map(normalizeMemoryPair)
    .sort((a, b) => b.resonance_score - a.resonance_score);

  return {
    ok: true,
    engine: "HDUD Memory Resonance Engine v1",
    author_id: safeAuthorId,
    memory_id: hasMemoryFilter ? safeMemoryId : null,
    resonance_pairs: resonancePairs,
    dominant_resonances: resonancePairs
      .filter((pair) => pair.resonance_score >= 60)
      .slice(0, 10),
    autobiographical_callbacks: resonancePairs
      .filter((pair) =>
        ["DEEP_AUTOBIOGRAPHICAL_RESONANCE", "RELATIONAL_RESONANCE", "EMOTIONAL_ECHO"].includes(
          pair.resonance_type
        )
      )
      .slice(0, 10),
    resonance_summary: buildSummary(resonancePairs),
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Somente ressonâncias calculadas a partir de memórias, entidades, relações e timeline reais persistidas.",
      mode: "deterministic_cognition",
      graph_idempotent: true,
    },
  };
}