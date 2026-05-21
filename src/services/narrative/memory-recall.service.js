// C:\HDUD_DATA\hdud-api-node\src\services\narrative\memory-recall.service.js

import { getPool, sql } from "../../db.js";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function buildSimilarityScore({
  sharedEntities = 0,
  sharedRelationships = 0,
  emotionalDelta = 0,
  narrativeDelta = 0,
}) {

  const entityScore =
    Math.min(sharedEntities * 15, 45);

  const relationshipScore =
    Math.min(sharedRelationships * 20, 40);

  const emotionalScore =
    Math.max(0, 10 - emotionalDelta);

  const narrativeScore =
    Math.max(0, 5 - narrativeDelta);

  return Math.max(
    0,
    Math.min(
      100,
      entityScore +
      relationshipScore +
      emotionalScore +
      narrativeScore
    )
  );
}

function classifyRecallType(score) {
  if (score >= 85) {
    return "STRONG_AUTOBIOGRAPHICAL_RECALL";
  }

  if (score >= 65) {
    return "EMOTIONAL_RECALL";
  }

  if (score >= 45) {
    return "NARRATIVE_RECALL";
  }

  return "WEAK_RECALL";
}

export async function recallConnectedMemories({
  authorId,
  memoryId,
  limit = 20,
}) {

  const pool =
    await getPool();

  // =====================================
  // BASE MEMORY
  // =====================================

  const baseMemoryResult =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .input(
        "memory_id",
        sql.BigInt,
        memoryId
      )
      .query(`
        SELECT
          m.memory_id,
          m.title,
          CONVERT(NVARCHAR(MAX), m.content)
            AS content,
          m.created_at,
          m.published_at
        FROM dbo.identity_memory m
        WHERE m.author_id = @author_id
          AND m.memory_id = @memory_id
          AND ISNULL(m.is_deleted,0)=0
      `);

  const baseMemory =
    baseMemoryResult.recordset?.[0];

  if (!baseMemory) {
    return {
      ok: false,
      reason:
        "Memória base não encontrada.",
    };
  }

  // =====================================
  // BASE ENTITIES
  // =====================================

  const baseEntitiesResult =
    await pool
      .request()
      .input(
        "memory_id",
        sql.BigInt,
        memoryId
      )
      .query(`
        SELECT
          e.entity_id,
          e.entity_name,
          e.entity_type
        FROM dbo.identity_memory_entity me
        INNER JOIN dbo.identity_narrative_entity e
          ON e.entity_id = me.entity_id
        WHERE me.memory_id = @memory_id
      `);

  const baseEntities =
    baseEntitiesResult.recordset || [];

  const baseEntityIds =
    new Set(
      baseEntities.map(
        (e) => Number(e.entity_id)
      )
    );

  // =====================================
  // BASE RELATIONSHIPS
  // =====================================

  const baseRelationshipsResult =
    await pool
      .request()
      .input(
        "memory_id",
        sql.BigInt,
        memoryId
      )
      .query(`
        SELECT
          mr.relationship_id,
          mr.emotional_strength,
          mr.narrative_weight
        FROM dbo.identity_memory_relationship mr
        WHERE mr.memory_id = @memory_id
      `);

  const baseRelationships =
    baseRelationshipsResult.recordset || [];

  const baseRelationshipIds =
    new Set(
      baseRelationships.map(
        (r) =>
          Number(r.relationship_id)
      )
    );

  const avgEmotion =
    baseRelationships.length
      ? baseRelationships.reduce(
          (a, b) =>
            a +
            Number(
              b.emotional_strength || 0
            ),
          0
        ) /
        baseRelationships.length
      : 0;

  const avgNarrative =
    baseRelationships.length
      ? baseRelationships.reduce(
          (a, b) =>
            a +
            Number(
              b.narrative_weight || 0
            ),
          0
        ) /
        baseRelationships.length
      : 0;

  // =====================================
  // CANDIDATE MEMORIES
  // =====================================

  const candidateResult =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .input(
        "memory_id",
        sql.BigInt,
        memoryId
      )
      .query(`
        SELECT
          m.memory_id,
          m.title,
          CONVERT(NVARCHAR(MAX), m.content)
            AS content,
          m.created_at,
          m.published_at
        FROM dbo.identity_memory m
        WHERE m.author_id = @author_id
          AND ISNULL(m.is_deleted,0)=0
          AND m.memory_id <> @memory_id
      `);

  const candidates =
    candidateResult.recordset || [];

  const recalls = [];

  for (const candidate of candidates) {

    // =========================
    // ENTITIES
    // =========================

    const entityResult =
      await pool
        .request()
        .input(
          "memory_id",
          sql.BigInt,
          candidate.memory_id
        )
        .query(`
          SELECT
            entity_id
          FROM dbo.identity_memory_entity
          WHERE memory_id = @memory_id
        `);

    const candidateEntityIds =
      new Set(
        entityResult.recordset.map(
          (r) =>
            Number(r.entity_id)
        )
      );

    const sharedEntities =
      [...candidateEntityIds]
        .filter((id) =>
          baseEntityIds.has(id)
        );

    // =========================
    // RELATIONSHIPS
    // =========================

    const relationshipResult =
      await pool
        .request()
        .input(
          "memory_id",
          sql.BigInt,
          candidate.memory_id
        )
        .query(`
          SELECT
            relationship_id,
            emotional_strength,
            narrative_weight
          FROM dbo.identity_memory_relationship
          WHERE memory_id = @memory_id
        `);

    const candidateRelationships =
      relationshipResult.recordset || [];

    const candidateRelationshipIds =
      new Set(
        candidateRelationships.map(
          (r) =>
            Number(r.relationship_id)
        )
      );

    const sharedRelationships =
      [...candidateRelationshipIds]
        .filter((id) =>
          baseRelationshipIds.has(id)
        );

    const candidateEmotion =
      candidateRelationships.length
        ? candidateRelationships.reduce(
            (a, b) =>
              a +
              Number(
                b.emotional_strength || 0
              ),
            0
          ) /
          candidateRelationships.length
        : 0;

    const candidateNarrative =
      candidateRelationships.length
        ? candidateRelationships.reduce(
            (a, b) =>
              a +
              Number(
                b.narrative_weight || 0
              ),
            0
          ) /
          candidateRelationships.length
        : 0;

    const emotionalDelta =
      Math.abs(
        avgEmotion -
        candidateEmotion
      );

    const narrativeDelta =
      Math.abs(
        avgNarrative -
        candidateNarrative
      );

    const similarityScore =
      buildSimilarityScore({
        sharedEntities:
          sharedEntities.length,

        sharedRelationships:
          sharedRelationships.length,

        emotionalDelta,

        narrativeDelta,
      });

    if (similarityScore < 25) {
      continue;
    }

    recalls.push({

      memory_id:
        Number(
          candidate.memory_id
        ),

      title:
        candidate.title || null,

      created_at:
        candidate.created_at || null,

      published_at:
        candidate.published_at || null,

      recall_type:
        classifyRecallType(
          similarityScore
        ),

      similarity_score:
        similarityScore,

      shared_entities:
        sharedEntities.length,

      shared_relationships:
        sharedRelationships.length,

      emotional_delta:
        Number(
          emotionalDelta.toFixed(2)
        ),

      narrative_delta:
        Number(
          narrativeDelta.toFixed(2)
        ),

      autobiographical_signal:
        similarityScore >= 65,

      recall_summary:
        similarityScore >= 85
          ? "Memória altamente conectada autobiograficamente."
          : similarityScore >= 65
          ? "Memória emocionalmente conectada."
          : "Memória narrativamente relacionada.",
    });
  }

  recalls.sort(
    (a, b) =>
      b.similarity_score -
      a.similarity_score
  );

  return {
    ok: true,

    engine:
      "HDUD Memory Recall Engine v1",

    author_id:
      Number(authorId),

    source_memory: {
      memory_id:
        Number(
          baseMemory.memory_id
        ),

      title:
        baseMemory.title || null,
    },

    total_recalls:
      recalls.length,

    recalls:
      recalls.slice(
        0,
        Math.max(
          1,
          Math.min(
            Number(limit) || 20,
            100
          )
        )
      ),

    meta: {
      generated_at:
        new Date().toISOString(),

      cognition_layer:
        "AUTOBIOGRAPHICAL_MEMORY_RECALL",

      source_policy:
        "Somente memórias reais persistidas no Living Narrative Graph.",
    },
  };
}