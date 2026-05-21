// C:\HDUD_DATA\hdud-api-node\src\services\narrative\narrative-orchestrator.service.js

import { getPool, sql } from "../../db.js";
import { buildEmotionalClusters } from "./emotional-cluster.service.js";
import { buildNarrativeArcs } from "./narrative-arc.service.js";
import { listRelationshipEvolutions } from "./relationship-evolution.service.js";

function normalizeMemoryIds(value) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0)
    ),
  ].slice(0, 100);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean) return [];

    try {
      const parsed = JSON.parse(clean);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [clean];
    }
  }

  return [];
}

async function loadAuthor(pool, authorId) {
  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .query(`
      SELECT TOP 1
        author_id,
        author_code,
        name_public,
        avatar_url,
        bio
      FROM dbo.identity_author
      WHERE author_id = @author_id;
    `);

  const row = result.recordset?.[0] || null;

  if (!row) return null;

  return {
    author_id: Number(row.author_id),
    author_code: row.author_code || null,
    name_public: row.name_public || null,
    avatar_url: row.avatar_url || null,
    bio: row.bio || null,
  };
}

async function loadVoiceProfile(pool, authorId) {
  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .query(`
      SELECT TOP 1
        voice_profile_id,
        writing_style,
        emotional_tone,
        narrative_density,
        sentence_length_avg,
        emotional_intensity,
        preferred_language,
        ai_observations,
        sample_size_memories,
        created_at,
        updated_at
      FROM dbo.identity_author_voice_profile
      WHERE author_id = @author_id
      ORDER BY
        created_at DESC,
        voice_profile_id DESC;
    `);

  const row = result.recordset?.[0] || null;

  if (!row) {
    return {
      loaded: false,
    };
  }

  return {
    loaded: true,
    voice_profile_id: Number(row.voice_profile_id),
    writing_style: row.writing_style || null,
    emotional_tone: row.emotional_tone || null,
    narrative_density: row.narrative_density ?? null,
    sentence_length_avg: row.sentence_length_avg ?? null,
    emotional_intensity: row.emotional_intensity ?? null,
    preferred_language: row.preferred_language || null,
    ai_observations: parseJsonArray(row.ai_observations),
    sample_size_memories: row.sample_size_memories ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function loadMemories(pool, authorId, memoryIds = []) {
  const ids = normalizeMemoryIds(memoryIds);

  if (!ids.length) {
    const result = await pool
      .request()
      .input("author_id", sql.BigInt, authorId)
      .query(`
        SELECT TOP 50
          m.memory_id,
          m.title,
          m.content,
          m.created_at,
          m.published_at,
          m.publication_status,
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

  const request = pool
    .request()
    .input("author_id", sql.BigInt, authorId);

  ids.forEach((id, index) => {
    request.input(`memory_id_${index}`, sql.BigInt, id);
  });

  const placeholders = ids.map((_, index) => `@memory_id_${index}`).join(",");

  const result = await request.query(`
    SELECT
      m.memory_id,
      m.title,
      m.content,
      m.created_at,
      m.published_at,
      m.publication_status,
      p.phase_code
    FROM dbo.identity_memory m
    LEFT JOIN dbo.identity_phase p
      ON p.phase_id = m.phase_id
    WHERE m.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0
      AND m.memory_id IN (${placeholders})
    ORDER BY
      COALESCE(m.published_at, m.created_at) ASC,
      m.memory_id ASC;
  `);

  const found = result.recordset || [];
  const byId = new Map(found.map((memory) => [Number(memory.memory_id), memory]));

  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function loadMemoryGraph(pool, authorId, memoryIds = []) {
  const ids = normalizeMemoryIds(memoryIds);

  const request = pool
    .request()
    .input("author_id", sql.BigInt, authorId);

  let memoryFilter = "";

  if (ids.length) {
    ids.forEach((id, index) => {
      request.input(`memory_id_${index}`, sql.BigInt, id);
    });

    memoryFilter = `AND m.memory_id IN (${ids.map((_, index) => `@memory_id_${index}`).join(",")})`;
  }

  const result = await request.query(`
    SELECT
      m.memory_id,
      m.title AS memory_title,

      e.entity_id,
      e.entity_type,
      e.entity_name,
      e.recurrence_count,
      e.importance_score,

      r.relationship_id,
      r.relationship_type,
      r.emotional_strength,
      r.narrative_weight,

      se.entity_name AS source_entity_name,
      te.entity_name AS target_entity_name,

      nt.timeline_event_id,
      nt.timeline_type,
      nt.title AS timeline_title,
      nt.event_date,
      nt.emotional_weight,
      nt.narrative_importance
    FROM dbo.identity_memory m
    LEFT JOIN dbo.identity_memory_entity me
      ON me.memory_id = m.memory_id
    LEFT JOIN dbo.identity_narrative_entity e
      ON e.entity_id = me.entity_id
     AND e.author_id = @author_id
    LEFT JOIN dbo.identity_memory_relationship mr
      ON mr.memory_id = m.memory_id
    LEFT JOIN dbo.identity_narrative_relationship r
      ON r.relationship_id = mr.relationship_id
     AND r.author_id = @author_id
    LEFT JOIN dbo.identity_narrative_entity se
      ON se.entity_id = r.source_entity_id
    LEFT JOIN dbo.identity_narrative_entity te
      ON te.entity_id = r.target_entity_id
    LEFT JOIN dbo.identity_narrative_timeline nt
      ON nt.memory_id = m.memory_id
     AND nt.author_id = @author_id
    WHERE m.author_id = @author_id
      AND ISNULL(m.is_deleted, 0) = 0
      ${memoryFilter}
    ORDER BY
      COALESCE(m.published_at, m.created_at) ASC,
      m.memory_id ASC;
  `);

  const rows = result.recordset || [];

  const entities = new Map();
  const relationships = new Map();
  const timeline = new Map();

  for (const row of rows) {
    if (row.entity_id && !entities.has(Number(row.entity_id))) {
      entities.set(Number(row.entity_id), {
        entity_id: Number(row.entity_id),
        entity_type: row.entity_type || null,
        entity_name: row.entity_name || null,
        recurrence_count: row.recurrence_count ?? null,
        importance_score: row.importance_score ?? null,
      });
    }

    if (row.relationship_id && !relationships.has(Number(row.relationship_id))) {
      relationships.set(Number(row.relationship_id), {
        relationship_id: Number(row.relationship_id),
        relationship_type: row.relationship_type || null,
        source_entity_name: row.source_entity_name || null,
        target_entity_name: row.target_entity_name || null,
        emotional_strength: row.emotional_strength ?? null,
        narrative_weight: row.narrative_weight ?? null,
      });
    }

    if (row.timeline_event_id && !timeline.has(Number(row.timeline_event_id))) {
      timeline.set(Number(row.timeline_event_id), {
        timeline_event_id: Number(row.timeline_event_id),
        timeline_type: row.timeline_type || null,
        title: row.timeline_title || null,
        event_date: row.event_date || null,
        emotional_weight: row.emotional_weight ?? null,
        narrative_importance: row.narrative_importance ?? null,
      });
    }
  }

  return {
    entities: [...entities.values()],
    relationships: [...relationships.values()],
    timeline: [...timeline.values()],
  };
}

function pickTop(items, key, limit = 5) {
  return [...(items || [])]
    .sort((a, b) => Number(b?.[key] || 0) - Number(a?.[key] || 0))
    .slice(0, limit);
}

function buildCognitionSummary({ clusters, arcs, relationshipEvolution, graph }) {
  const dominantClusters = pickTop(clusters?.clusters || [], "cluster_strength", 5);
  const dominantArcs = pickTop(arcs?.arcs || [], "arc_strength", 5);
  const dominantRelationships = pickTop(
    relationshipEvolution?.relationships || [],
    "bond_score",
    5
  );

  return {
    dominant_clusters: dominantClusters.map((cluster) => ({
      cluster_code: cluster.cluster_code,
      cluster_label: cluster.cluster_label,
      cluster_strength: cluster.cluster_strength,
      total_memories: cluster.total_memories,
    })),

    dominant_arcs: dominantArcs.map((arc) => ({
      arc_code: arc.arc_code,
      arc_label: arc.arc_label,
      arc_strength: arc.arc_strength,
      total_memories: arc.total_memories,
    })),

    dominant_relationships: dominantRelationships.map((rel) => ({
      relationship_id: rel.relationship_id,
      relationship_type: rel.relationship_type,
      source_entity_name: rel.source_entity_name,
      target_entity_name: rel.target_entity_name,
      bond_score: rel.bond_score,
      total_memories: rel.total_memories,
    })),

    graph_density: {
      total_entities: graph.entities.length,
      total_relationships: graph.relationships.length,
      total_timeline_events: graph.timeline.length,
    },
  };
}

export async function loadAuthorNarrativeContext({
  authorId,
  memoryIds = [],
}) {
  const pool = await getPool();

  const author = await loadAuthor(pool, authorId);

  if (!author) {
    return {
      ok: false,
      reason: "Autor não encontrado.",
    };
  }

  const memories = await loadMemories(pool, authorId, memoryIds);
  const graph = await loadMemoryGraph(pool, authorId, memoryIds);
  const voiceProfile = await loadVoiceProfile(pool, authorId);

  const clusters = await buildEmotionalClusters({
    authorId,
    limit: 300,
  });

  const arcs = await buildNarrativeArcs({
    authorId,
    limit: 500,
  });

  const relationshipEvolution = await listRelationshipEvolutions({
    authorId,
    limit: 50,
  });

  const cognition = buildCognitionSummary({
    clusters,
    arcs,
    relationshipEvolution,
    graph,
  });

  return {
    ok: true,
    engine: "HDUD Narrative Orchestrator Engine v1",
    author,
    memories,
    graph,
    voice_profile: voiceProfile,
    emotional_clusters: clusters,
    narrative_arcs: arcs,
    relationship_evolution: relationshipEvolution,
    cognition,
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Somente dados reais persistidos no Living Narrative Graph.",
      orchestration_layer:
        "AUTHOR_NARRATIVE_CONTEXT",
    },
  };
}