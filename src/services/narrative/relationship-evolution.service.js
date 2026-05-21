// C:\HDUD_DATA\hdud-api-node\src\services\narrative\relationship-evolution.service.js

import { getPool, sql } from "../../db.js";

function clampScore(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function classifyEvolution({ totalMemories, avgStrength, maxStrength, avgWeight }) {
  if (totalMemories >= 10 && avgStrength >= 8) return "DEEP_RECURRING_BOND";
  if (totalMemories >= 5 && avgStrength >= 7) return "STRONG_RECURRING_BOND";
  if (maxStrength >= 9 && avgWeight >= 7) return "INTENSE_MARKER";
  if (totalMemories >= 3) return "RECURRING_PRESENCE";
  return "EMERGING_CONNECTION";
}

function calculateBondScore({ totalMemories, avgStrength, maxStrength, avgWeight, maxWeight }) {
  const recurrenceScore = Math.min(totalMemories * 8, 40);
  const strengthScore = ((avgStrength || 0) * 3) + ((maxStrength || 0) * 2);
  const weightScore = ((avgWeight || 0) * 2) + (maxWeight || 0);

  return clampScore(recurrenceScore + strengthScore + weightScore);
}

export async function getRelationshipEvolution({ authorId, relationshipId }) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .input("relationship_id", sql.BigInt, relationshipId)
    .query(`
      SELECT
        r.relationship_id,
        r.relationship_type,
        r.emotional_strength AS global_emotional_strength,
        r.narrative_weight AS global_narrative_weight,
        r.first_memory_id,
        r.created_at AS relationship_created_at,
        r.updated_at AS relationship_updated_at,

        s.entity_id AS source_entity_id,
        s.entity_type AS source_entity_type,
        s.entity_name AS source_entity_name,

        t.entity_id AS target_entity_id,
        t.entity_type AS target_entity_type,
        t.entity_name AS target_entity_name,

        mr.memory_relationship_id,
        mr.memory_id,
        mr.emotional_strength,
        mr.narrative_weight,
        mr.created_at AS memory_relationship_created_at,

        m.title AS memory_title,
        m.created_at AS memory_created_at,
        m.published_at,
        p.phase_code
      FROM dbo.identity_narrative_relationship r
      INNER JOIN dbo.identity_narrative_entity s
        ON s.entity_id = r.source_entity_id
      INNER JOIN dbo.identity_narrative_entity t
        ON t.entity_id = r.target_entity_id
      LEFT JOIN dbo.identity_memory_relationship mr
        ON mr.relationship_id = r.relationship_id
      LEFT JOIN dbo.identity_memory m
        ON m.memory_id = mr.memory_id
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      WHERE r.author_id = @author_id
        AND r.relationship_id = @relationship_id
      ORDER BY
        COALESCE(m.published_at, m.created_at, mr.created_at) ASC,
        mr.memory_relationship_id ASC;
    `);

  const rows = result.recordset || [];

  if (!rows.length) {
    return {
      ok: false,
      reason: "Relação narrativa não encontrada.",
    };
  }

  const first = rows[0];

  const timeline = rows
    .filter((row) => row.memory_relationship_id)
    .map((row, index) => ({
      order: index + 1,
      memory_relationship_id: Number(row.memory_relationship_id),
      memory_id: Number(row.memory_id),
      memory_title: row.memory_title || null,
      phase_code: row.phase_code || null,
      emotional_strength: row.emotional_strength ?? null,
      narrative_weight: row.narrative_weight ?? null,
      occurred_at:
        row.published_at ||
        row.memory_created_at ||
        row.memory_relationship_created_at ||
        null,
    }));

  const totalMemories = timeline.length;

  const strengths = timeline
    .map((item) => Number(item.emotional_strength))
    .filter(Number.isFinite);

  const weights = timeline
    .map((item) => Number(item.narrative_weight))
    .filter(Number.isFinite);

  const avgStrength =
    strengths.length > 0
      ? strengths.reduce((a, b) => a + b, 0) / strengths.length
      : Number(first.global_emotional_strength || 0);

  const maxStrength =
    strengths.length > 0
      ? Math.max(...strengths)
      : Number(first.global_emotional_strength || 0);

  const avgWeight =
    weights.length > 0
      ? weights.reduce((a, b) => a + b, 0) / weights.length
      : Number(first.global_narrative_weight || 0);

  const maxWeight =
    weights.length > 0
      ? Math.max(...weights)
      : Number(first.global_narrative_weight || 0);

  const evolutionLabel = classifyEvolution({
    totalMemories,
    avgStrength,
    maxStrength,
    avgWeight,
  });

  const bondScore = calculateBondScore({
    totalMemories,
    avgStrength,
    maxStrength,
    avgWeight,
    maxWeight,
  });

  return {
    ok: true,
    relationship: {
      relationship_id: Number(first.relationship_id),
      relationship_type: first.relationship_type || null,
      source_entity: {
        entity_id: Number(first.source_entity_id),
        entity_type: first.source_entity_type || null,
        entity_name: first.source_entity_name || null,
      },
      target_entity: {
        entity_id: Number(first.target_entity_id),
        entity_type: first.target_entity_type || null,
        entity_name: first.target_entity_name || null,
      },
      first_memory_id: first.first_memory_id ? Number(first.first_memory_id) : null,
      created_at: first.relationship_created_at || null,
      updated_at: first.relationship_updated_at || null,
    },
    evolution: {
      total_memories: totalMemories,
      first_seen_at: timeline[0]?.occurred_at || first.relationship_created_at || null,
      last_seen_at:
        timeline[timeline.length - 1]?.occurred_at ||
        first.relationship_updated_at ||
        first.relationship_created_at ||
        null,
      avg_emotional_strength: Number(avgStrength.toFixed(2)),
      max_emotional_strength: maxStrength,
      avg_narrative_weight: Number(avgWeight.toFixed(2)),
      max_narrative_weight: maxWeight,
      bond_score: bondScore,
      evolution_label: evolutionLabel,
    },
    timeline,
  };
}

export async function listRelationshipEvolutions({ authorId, limit = 25 }) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .input("limit", sql.Int, Math.max(1, Math.min(Number(limit) || 25, 100)))
    .query(`
      SELECT TOP (@limit)
        r.relationship_id,
        r.relationship_type,

        s.entity_name AS source_entity_name,
        s.entity_type AS source_entity_type,

        t.entity_name AS target_entity_name,
        t.entity_type AS target_entity_type,

        COUNT(mr.memory_relationship_id) AS total_memories,
        AVG(CAST(ISNULL(mr.emotional_strength, r.emotional_strength) AS FLOAT)) AS avg_emotional_strength,
        MAX(ISNULL(mr.emotional_strength, r.emotional_strength)) AS max_emotional_strength,
        AVG(CAST(ISNULL(mr.narrative_weight, r.narrative_weight) AS FLOAT)) AS avg_narrative_weight,
        MAX(ISNULL(mr.narrative_weight, r.narrative_weight)) AS max_narrative_weight,
        MIN(mr.created_at) AS first_seen_at,
        MAX(mr.created_at) AS last_seen_at
      FROM dbo.identity_narrative_relationship r
      INNER JOIN dbo.identity_narrative_entity s
        ON s.entity_id = r.source_entity_id
      INNER JOIN dbo.identity_narrative_entity t
        ON t.entity_id = r.target_entity_id
      LEFT JOIN dbo.identity_memory_relationship mr
        ON mr.relationship_id = r.relationship_id
      WHERE r.author_id = @author_id
      GROUP BY
        r.relationship_id,
        r.relationship_type,
        s.entity_name,
        s.entity_type,
        t.entity_name,
        t.entity_type
      ORDER BY
        COUNT(mr.memory_relationship_id) DESC,
        MAX(ISNULL(mr.emotional_strength, r.emotional_strength)) DESC,
        r.relationship_id DESC;
    `);

  const items = (result.recordset || []).map((row) => {
    const totalMemories = Number(row.total_memories || 0);
    const avgStrength = Number(row.avg_emotional_strength || 0);
    const maxStrength = Number(row.max_emotional_strength || 0);
    const avgWeight = Number(row.avg_narrative_weight || 0);
    const maxWeight = Number(row.max_narrative_weight || 0);

    return {
      relationship_id: Number(row.relationship_id),
      relationship_type: row.relationship_type || null,
      source_entity_name: row.source_entity_name || null,
      source_entity_type: row.source_entity_type || null,
      target_entity_name: row.target_entity_name || null,
      target_entity_type: row.target_entity_type || null,
      total_memories: totalMemories,
      first_seen_at: row.first_seen_at || null,
      last_seen_at: row.last_seen_at || null,
      avg_emotional_strength: Number(avgStrength.toFixed(2)),
      max_emotional_strength: maxStrength,
      avg_narrative_weight: Number(avgWeight.toFixed(2)),
      max_narrative_weight: maxWeight,
      bond_score: calculateBondScore({
        totalMemories,
        avgStrength,
        maxStrength,
        avgWeight,
        maxWeight,
      }),
      evolution_label: classifyEvolution({
        totalMemories,
        avgStrength,
        maxStrength,
        avgWeight,
      }),
    };
  });

  return {
    ok: true,
    total: items.length,
    relationships: items,
  };
}