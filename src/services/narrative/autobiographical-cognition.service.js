// C:\HDUD_DATA\hdud-api-node\src\services\narrative\autobiographical-cognition.service.js

import { getPool, sql } from "../../db.js";

function clamp(value, min = 0, max = 100) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return min;
  }

  return Math.max(
    min,
    Math.min(max, Math.round(n))
  );
}

function calculateEvolutionScore({
  emotionalVariance = 0,
  relationshipVariance = 0,
  arcTransitions = 0,
  clusterTransitions = 0,
}) {

  return clamp(
    emotionalVariance * 3 +
    relationshipVariance * 4 +
    arcTransitions * 6 +
    clusterTransitions * 5
  );
}

function classifyLifePattern(score) {

  if (score >= 80) {
    return "DEEP_TRANSFORMATION";
  }

  if (score >= 60) {
    return "STRONG_EVOLUTION";
  }

  if (score >= 40) {
    return "MODERATE_TRANSFORMATION";
  }

  if (score >= 20) {
    return "GRADUAL_EVOLUTION";
  }

  return "STABLE_CONTINUITY";
}

function classifyNarrativeComplexity({
  totalArcs,
  totalRelationships,
  totalClusters,
}) {

  const complexity =
    totalArcs * 2 +
    totalRelationships * 1.5 +
    totalClusters * 2;

  if (complexity >= 60) {
    return "HIGH_COMPLEXITY";
  }

  if (complexity >= 35) {
    return "MEDIUM_COMPLEXITY";
  }

  return "LOW_COMPLEXITY";
}

export async function buildAutobiographicalCognition({
  authorId,
}) {

  const pool =
    await getPool();

  // ==========================================
  // ARCS
  // ==========================================

  const arcsResult =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .query(`
        SELECT
          relationship_type,
          emotional_strength,
          narrative_weight
        FROM dbo.identity_narrative_relationship
        WHERE author_id = @author_id
      `);

  const relationships =
    arcsResult.recordset || [];

  // ==========================================
  // TIMELINE
  // ==========================================

  const timelineResult =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .query(`
        SELECT
          timeline_type,
          emotional_weight,
          narrative_importance
        FROM dbo.identity_narrative_timeline
        WHERE author_id = @author_id
      `);

  const timeline =
    timelineResult.recordset || [];

  // ==========================================
  // ENTITIES
  // ==========================================

  const entityResult =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .query(`
        SELECT
          entity_type,
          recurrence_count,
          importance_score
        FROM dbo.identity_narrative_entity
        WHERE author_id = @author_id
      `);

  const entities =
    entityResult.recordset || [];

  // ==========================================
  // EMOTIONAL VARIANCE
  // ==========================================

  const emotionalValues =
    [
      ...relationships.map(
        (r) =>
          Number(
            r.emotional_strength || 0
          )
      ),

      ...timeline.map(
        (t) =>
          Number(
            t.emotional_weight || 0
          )
      ),
    ];

  const emotionalAvg =
    emotionalValues.length
      ? emotionalValues.reduce(
          (a, b) => a + b,
          0
        ) /
        emotionalValues.length
      : 0;

  const emotionalVariance =
    emotionalValues.length
      ? emotionalValues.reduce(
          (acc, val) => {
            return (
              acc +
              Math.pow(
                val - emotionalAvg,
                2
              )
            );
          },
          0
        ) /
        emotionalValues.length
      : 0;

  // ==========================================
  // RELATIONSHIP VARIANCE
  // ==========================================

  const relationshipTypes =
    new Set(
      relationships.map(
        (r) =>
          r.relationship_type
      )
    );

  const relationshipVariance =
    relationshipTypes.size;

  // ==========================================
  // ARC TRANSITIONS
  // ==========================================

  const arcTransitions =
    Math.max(
      1,
      Math.floor(
        timeline.length / 5
      )
    );

  // ==========================================
  // CLUSTER TRANSITIONS
  // ==========================================

  const clusterTransitions =
    Math.max(
      1,
      Math.floor(
        entities.length / 8
      )
    );

  // ==========================================
  // EVOLUTION SCORE
  // ==========================================

  const evolutionScore =
    calculateEvolutionScore({

      emotionalVariance,

      relationshipVariance,

      arcTransitions,

      clusterTransitions,
    });

  // ==========================================
  // LIFE PATTERN
  // ==========================================

  const lifePattern =
    classifyLifePattern(
      evolutionScore
    );

  // ==========================================
  // NARRATIVE COMPLEXITY
  // ==========================================

  const narrativeComplexity =
    classifyNarrativeComplexity({

      totalArcs:
        arcTransitions,

      totalRelationships:
        relationshipTypes.size,

      totalClusters:
        clusterTransitions,
    });

  // ==========================================
  // RECURRING SIGNALS
  // ==========================================

  const recurringSignals =
    entities
      .filter(
        (e) =>
          Number(
            e.recurrence_count || 0
          ) >= 3
      )
      .sort(
        (a, b) =>
          Number(
            b.recurrence_count || 0
          ) -
          Number(
            a.recurrence_count || 0
          )
      )
      .slice(0, 15);

  // ==========================================
  // RETURN
  // ==========================================

  return {

    ok: true,

    engine:
      "HDUD Autobiographical Cognition Engine v1",

    author_id:
      Number(authorId),

    cognition: {

      evolution_score:
        evolutionScore,

      life_pattern:
        lifePattern,

      narrative_complexity:
        narrativeComplexity,

      emotional_variance:
        Number(
          emotionalVariance.toFixed(2)
        ),

      emotional_average:
        Number(
          emotionalAvg.toFixed(2)
        ),

      relationship_variance:
        relationshipVariance,

      arc_transitions:
        arcTransitions,

      cluster_transitions:
        clusterTransitions,

      recurring_signals:
        recurringSignals.map(
          (signal) => ({
            entity_type:
              signal.entity_type,

            recurrence_count:
              signal.recurrence_count,

            importance_score:
              signal.importance_score,
          })
        ),
    },

    meta: {

      generated_at:
        new Date().toISOString(),

      cognition_layer:
        "AUTOBIOGRAPHICAL_COGNITION",

      source_policy:
        "Somente dados reais persistidos no Living Narrative Graph.",
    },
  };
}