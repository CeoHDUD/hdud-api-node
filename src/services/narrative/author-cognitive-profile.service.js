// C:\HDUD_DATA\hdud-api-node\src\services\narrative\author-cognitive-profile.service.js

import { buildSymbolicRecurrence } from "./symbolic-recurrence.service.js";
import { buildMemoryResonance } from "./memory-resonance.service.js";
import { buildNarrativeContinuity } from "./narrative-continuity.service.js";
import { buildEmotionalClusters } from "./emotional-cluster.service.js";
import { listRelationshipEvolutions } from "./relationship-evolution.service.js";
import { buildAutobiographicalCognition } from "./autobiographical-cognition.service.js";
import { getPool, sql } from "../../db.js";

function clampInt(value, min = 0, max = 100, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

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

function buildIdentitySignature({
  continuity,
  symbolic,
  resonance,
  cognition,
}) {
  const continuityScore =
    safeNumber(continuity?.continuity_score);

  const resonanceScore =
    safeNumber(
      resonance?.resonance_summary?.resonance_score
    );

  const symbolicScore =
    safeNumber(
      symbolic?.narrative_resonance?.resonance_score
    );

  const cognitionScore =
    safeNumber(
      cognition?.cognition_summary?.cognition_score
    );

  const identityStability = clampInt(
    continuityScore * 0.4 +
      symbolicScore * 0.25 +
      resonanceScore * 0.15 +
      cognitionScore * 0.2,
    0,
    100,
    0
  );

  let coreAxis =
    "EMERGING_AUTOBIOGRAPHICAL_IDENTITY";

  if (identityStability >= 80) {
    coreAxis =
      "PERSISTENT_AUTOBIOGRAPHICAL_IDENTITY";
  } else if (identityStability >= 60) {
    coreAxis =
      "ACTIVE_NARRATIVE_IDENTITY";
  } else if (identityStability >= 40) {
    coreAxis =
      "EVOLVING_AUTOBIOGRAPHICAL_IDENTITY";
  }

  return {
    core_axis: coreAxis,
    identity_stability: identityStability,
    emotional_consistency: clampInt(
      continuityScore * 0.6 +
        symbolicScore * 0.4
    ),
    narrative_continuity:
      continuityScore,
    symbolic_resonance:
      symbolicScore,
    autobiographical_resonance:
      resonanceScore,
    cognitive_density:
      cognitionScore,
  };
}

function buildDominantSymbols(symbolic) {
  const symbols =
    symbolic?.dominant_symbols || [];

  return symbols
    .slice(0, 10)
    .map((symbol) => ({
      symbol: symbol.symbol,
      entity_type:
        symbol.entity_type,
      symbolic_role:
        symbol.symbolic_role,
      recurrence_score:
        symbol.recurrence_score,
      continuity_score:
        symbol.recurrence_score,
      emotional_weight_avg:
        symbol.emotional_weight_avg,
      identity_axis:
        symbol.identity_axis,
    }));
}

function buildEmotionalIdentity(
  clusters,
  continuity
) {
  const emotionalContinuity =
    continuity?.emotional_continuity ||
    {};

  const clusterList =
    clusters?.clusters || [];

  const dominantCluster =
    clusterList[0] || null;

  return {
    dominant_emotional_cluster:
      dominantCluster?.cluster_label ||
      null,

    emotional_continuity_score:
      emotionalContinuity?.score || 0,

    emotional_state:
      emotionalContinuity?.state ||
      "UNKNOWN",

    emotional_density:
      clusterList.length,

    dominant_transition_patterns:
      dominantCluster?.transition_patterns ||
      [],
  };
}

function buildRelationshipIdentity(
  relationshipEvolution,
  continuity
) {
  const relationships =
    relationshipEvolution?.relationships ||
    [];

  const topRelationship =
    relationships[0] || null;

  const continuityRelationships =
    continuity?.relationship_continuity ||
    [];

  return {
    dominant_relationship:
      topRelationship?.target_entity_name ||
      null,

    dominant_relationship_type:
      topRelationship?.relationship_type ||
      null,

    relationship_density:
      continuityRelationships.length,

    relational_continuity_score:
      continuityRelationships.length
        ? clampInt(
            continuityRelationships.reduce(
              (acc, rel) =>
                acc +
                safeNumber(
                  rel.continuity_score
                ),
              0
            ) /
              continuityRelationships.length
          )
        : 0,
  };
}

function buildNarrativeIdentity(
  continuity,
  resonance
) {
  return {
    continuity_state:
      continuity?.continuity_summary
        ?.continuity_state || null,

    resonance_state:
      resonance?.resonance_summary
        ?.interpretation || null,

    narrative_loops:
      continuity?.narrative_loops
        ?.length || 0,

    autobiographical_callbacks:
      resonance
        ?.autobiographical_callbacks
        ?.length || 0,

    narrative_eras:
      continuity?.narrative_eras
        ?.length || 0,
  };
}

function buildVoiceIdentity(
  voiceProfile
) {
  if (!voiceProfile) {
    return {
      loaded: false,
    };
  }

  return {
    loaded: true,

    writing_style:
      voiceProfile.writing_style,

    emotional_tone:
      voiceProfile.emotional_tone,

    narrative_density:
      voiceProfile.narrative_density,

    emotional_intensity:
      voiceProfile.emotional_intensity,

    preferred_language:
      voiceProfile.preferred_language,

    sample_size_memories:
      voiceProfile.sample_size_memories,
  };
}

function buildAutobiographicalAxes(
  symbolic,
  continuity
) {
  const axes = new Map();

  for (const symbol of symbolic?.identity_symbols ||
    []) {
    const axis =
      normalizeText(
        symbol.identity_axis,
        "NARRATIVE_MEMORY"
      );

    if (!axes.has(axis)) {
      axes.set(axis, {
        axis,
        total_symbols: 0,
        continuity_score: 0,
      });
    }

    const item = axes.get(axis);

    item.total_symbols += 1;

    item.continuity_score +=
      safeNumber(
        symbol.continuity_score
      );
  }

  for (const rel of continuity?.relationship_continuity ||
    []) {
    if (
      safeNumber(
        rel.continuity_score
      ) >= 70
    ) {
      const axis = "RELATIONSHIP";

      if (!axes.has(axis)) {
        axes.set(axis, {
          axis,
          total_symbols: 0,
          continuity_score: 0,
        });
      }

      const item = axes.get(axis);

      item.total_symbols += 1;

      item.continuity_score +=
        safeNumber(
          rel.continuity_score
        );
    }
  }

  return [...axes.values()]
    .map((axis) => ({
      axis: axis.axis,
      total_symbols:
        axis.total_symbols,

      continuity_score:
        clampInt(
          axis.continuity_score /
            Math.max(
              axis.total_symbols,
              1
            )
        ),
    }))
    .sort(
      (a, b) =>
        b.continuity_score -
        a.continuity_score
    );
}

function buildTrajectoryProfile({
  continuity,
  symbolic,
  resonance,
}) {
  return {
    continuity_score:
      continuity?.continuity_score ||
      0,

    symbolic_density:
      symbolic?.symbolic_patterns
        ?.length || 0,

    resonance_density:
      resonance?.resonance_pairs
        ?.length || 0,

    trajectory_state:
      continuity?.continuity_summary
        ?.continuity_state ||
      "UNKNOWN",

    identity_maturity:
      continuity?.continuity_score >=
      80
        ? "HIGH"
        : continuity
              ?.continuity_score >=
            60
          ? "MEDIUM"
          : "EMERGING",
  };
}

function buildCognitiveSummary({
  identitySignature,
  symbolic,
  resonance,
  continuity,
}) {
  return {
    identity_stability:
      identitySignature.identity_stability,

    symbolic_recurrence_density:
      symbolic?.symbolic_patterns
        ?.length || 0,

    autobiographical_resonance_density:
      resonance?.resonance_pairs
        ?.length || 0,

    continuity_score:
      continuity?.continuity_score ||
      0,

    interpretation:
      identitySignature.identity_stability >=
      80
        ? "O autor possui identidade autobiográfica persistente e longitudinalmente consolidada."
        : identitySignature.identity_stability >=
            60
          ? "O autor possui identidade narrativa ativa em consolidação contínua."
          : identitySignature.identity_stability >=
              40
            ? "O autor possui sinais emergentes de identidade autobiográfica persistente."
            : "O autor ainda possui baixa densidade cognitiva longitudinal.",
  };
}

async function loadLatestVoiceProfile(
  authorId
) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input(
      "author_id",
      sql.BigInt,
      authorId
    )
    .query(`
      SELECT TOP 1
        voice_profile_id,
        writing_style,
        emotional_tone,
        narrative_density,
        emotional_intensity,
        preferred_language,
        sample_size_memories
      FROM dbo.identity_author_voice_profile
      WHERE author_id = @author_id
      ORDER BY
        created_at DESC,
        voice_profile_id DESC;
    `);

  return (
    result.recordset?.[0] || null
  );
}

export async function buildAuthorCognitiveProfile({
  authorId,
} = {}) {
  const safeAuthorId =
    Number(authorId);

  if (
    !Number.isInteger(
      safeAuthorId
    ) ||
    safeAuthorId <= 0
  ) {
    return {
      ok: false,
      reason:
        "authorId inválido.",
    };
  }

  const [
    symbolic,
    resonance,
    continuity,
    emotionalClusters,
    relationshipEvolution,
    cognition,
    voiceProfile,
  ] = await Promise.all([
    buildSymbolicRecurrence({
      authorId: safeAuthorId,
    }),

    buildMemoryResonance({
      authorId: safeAuthorId,
    }),

    buildNarrativeContinuity({
      authorId: safeAuthorId,
    }),

    buildEmotionalClusters({
      authorId: safeAuthorId,
    }),

    listRelationshipEvolutions({
      authorId: safeAuthorId,
      limit: 50,
    }),

    buildAutobiographicalCognition({
      authorId: safeAuthorId,
    }),

    loadLatestVoiceProfile(
      safeAuthorId
    ),
  ]);

  const identitySignature =
    buildIdentitySignature({
      continuity,
      symbolic,
      resonance,
      cognition,
    });

  return {
    ok: true,

    engine:
      "HDUD Author Cognitive Profile Engine v1",

    author_id:
      safeAuthorId,

    identity_signature:
      identitySignature,

    dominant_symbols:
      buildDominantSymbols(
        symbolic
      ),

    emotional_identity:
      buildEmotionalIdentity(
        emotionalClusters,
        continuity
      ),

    relationship_identity:
      buildRelationshipIdentity(
        relationshipEvolution,
        continuity
      ),

    narrative_identity:
      buildNarrativeIdentity(
        continuity,
        resonance
      ),

    continuity_identity: {
      continuity_score:
        continuity?.continuity_score ||
        0,

      continuity_state:
        continuity
          ?.continuity_summary
          ?.continuity_state ||
        null,
    },

    voice_identity:
      buildVoiceIdentity(
        voiceProfile
      ),

    autobiographical_axes:
      buildAutobiographicalAxes(
        symbolic,
        continuity
      ),

    trajectory_profile:
      buildTrajectoryProfile({
        continuity,
        symbolic,
        resonance,
      }),

    cognitive_summary:
      buildCognitiveSummary({
        identitySignature,
        symbolic,
        resonance,
        continuity,
      }),

    meta: {
      generated_at:
        new Date().toISOString(),

      source_policy:
        "Somente cognição autobiográfica derivada de dados reais persistidos no Living Narrative Graph.",

      mode:
        "deterministic_cognition",

      graph_idempotent:
        true,
    },
  };
}