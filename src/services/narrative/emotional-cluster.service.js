// C:\HDUD_DATA\hdud-api-node\src\services\narrative\emotional-cluster.service.js

import { getPool, sql } from "../../db.js";

const CLUSTER_RULES = [
  {
    code: "LOVE_BOND",
    label: "Amor e vínculo afetivo",
    keywords: ["AMOR", "AFETO", "SAUDADE", "ESPOSA", "NAMORO", "CASAMENTO", "PARTNER", "SPOUSE"],
  },
  {
    code: "FAMILY_ROOTS",
    label: "Família e origem",
    keywords: ["FAMILIA", "PAI", "MAE", "FILHO", "FILHA", "CHILD", "PARENT", "FAMILY"],
  },
  {
    code: "LOSS_AND_ABSENCE",
    label: "Perda e ausência",
    keywords: ["PERDA", "LUTO", "AUSENCIA", "SAUDADE", "DISTANCIA", "FIM"],
  },
  {
    code: "RUPTURE",
    label: "Ruptura e virada",
    keywords: ["RUPTURA", "SEPARACAO", "MUDANCA", "CRISE", "QUEBRA", "VIRADA"],
  },
  {
    code: "RECONSTRUCTION",
    label: "Reconstrução",
    keywords: ["RECONSTRUCAO", "SUPERAÇÃO", "SUPERA", "RECOMECO", "RENASCIMENTO", "CURA"],
  },
  {
    code: "TRANSFORMATION",
    label: "Transformação",
    keywords: ["TRANSFORMACAO", "MUDANCA", "EVOLUCAO", "CRESCIMENTO", "DESCOBERTA"],
  },
  {
    code: "IDENTITY",
    label: "Identidade",
    keywords: ["IDENTIDADE", "EU", "SELF_AUTHOR", "AUTOR", "NARRADOR", "QUEM SOU"],
  },
  {
    code: "DISPLACEMENT",
    label: "Deslocamento e território",
    keywords: ["VIAGEM", "CIDADE", "CASA", "LUGAR", "PLACE_ASSOCIATION", "MUDANCA"],
  },
];

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function clampScore(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function classifyMemoryCluster(row) {
  const haystack = normalizeKey([
    row.memory_title,
    row.memory_content,
    row.timeline_type,
    row.timeline_title,
    row.timeline_description,
    row.relationship_type,
    row.source_entity_name,
    row.target_entity_name,
    row.entity_name,
    row.entity_type,
  ].filter(Boolean).join(" "));

  const matches = [];

  for (const rule of CLUSTER_RULES) {
    const score = rule.keywords.reduce((total, keyword) => {
      return haystack.includes(normalizeKey(keyword)) ? total + 1 : total;
    }, 0);

    if (score > 0) {
      matches.push({
        code: rule.code,
        label: rule.label,
        raw_score: score,
      });
    }
  }

  if (!matches.length) {
    return {
      code: "UNCLASSIFIED_EMOTIONAL_THREAD",
      label: "Fio emocional ainda não classificado",
      raw_score: 0,
    };
  }

  matches.sort((a, b) => b.raw_score - a.raw_score);

  return matches[0];
}

function calculateClusterStrength({ totalMemories, avgEmotionalWeight, avgNarrativeImportance, relationshipDensity }) {
  return clampScore(
    Math.min(totalMemories * 10, 35) +
      Math.min((avgEmotionalWeight || 0) * 4, 30) +
      Math.min((avgNarrativeImportance || 0) * 3, 25) +
      Math.min((relationshipDensity || 0) * 2, 10)
  );
}

export async function buildEmotionalClusters({ authorId, limit = 200 }) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .input("limit", sql.Int, Math.max(10, Math.min(Number(limit) || 200, 500)))
    .query(`
      SELECT TOP (@limit)
        m.memory_id,
        m.title AS memory_title,
        CONVERT(NVARCHAR(MAX), m.content) AS memory_content,
        m.created_at AS memory_created_at,
        m.published_at,
        p.phase_code,

        nt.timeline_event_id,
        nt.timeline_type,
        nt.title AS timeline_title,
        nt.description AS timeline_description,
        nt.event_date,
        nt.emotional_weight AS timeline_emotional_weight,
        nt.narrative_importance,

        ne.entity_id,
        ne.entity_type,
        ne.entity_name,
        ne.emotional_relevance,
        ne.importance_score,
        ne.recurrence_count,

        nr.relationship_id,
        nr.relationship_type,
        nr.emotional_strength,
        nr.narrative_weight,

        se.entity_name AS source_entity_name,
        te.entity_name AS target_entity_name
      FROM dbo.identity_memory m
      LEFT JOIN dbo.identity_phase p
        ON p.phase_id = m.phase_id
      LEFT JOIN dbo.identity_narrative_timeline nt
        ON nt.memory_id = m.memory_id
       AND nt.author_id = @author_id
      LEFT JOIN dbo.identity_memory_entity me
        ON me.memory_id = m.memory_id
      LEFT JOIN dbo.identity_narrative_entity ne
        ON ne.entity_id = me.entity_id
       AND ne.author_id = @author_id
      LEFT JOIN dbo.identity_memory_relationship mr
        ON mr.memory_id = m.memory_id
      LEFT JOIN dbo.identity_narrative_relationship nr
        ON nr.relationship_id = mr.relationship_id
       AND nr.author_id = @author_id
      LEFT JOIN dbo.identity_narrative_entity se
        ON se.entity_id = nr.source_entity_id
      LEFT JOIN dbo.identity_narrative_entity te
        ON te.entity_id = nr.target_entity_id
      WHERE m.author_id = @author_id
        AND ISNULL(m.is_deleted, 0) = 0
      ORDER BY
        COALESCE(m.published_at, m.created_at) DESC,
        m.memory_id DESC;
    `);

  const rows = result.recordset || [];
  const clusterMap = new Map();

  for (const row of rows) {
    const cluster = classifyMemoryCluster(row);

    if (!clusterMap.has(cluster.code)) {
      clusterMap.set(cluster.code, {
        cluster_code: cluster.code,
        cluster_label: cluster.label,
        memories: new Map(),
        entities: new Map(),
        relationships: new Map(),
        timeline_events: new Map(),
        emotional_weights: [],
        narrative_importances: [],
      });
    }

    const bucket = clusterMap.get(cluster.code);

    if (row.memory_id && !bucket.memories.has(Number(row.memory_id))) {
      bucket.memories.set(Number(row.memory_id), {
        memory_id: Number(row.memory_id),
        title: row.memory_title || null,
        phase_code: row.phase_code || null,
        occurred_at: row.published_at || row.memory_created_at || null,
      });
    }

    if (row.entity_id && !bucket.entities.has(Number(row.entity_id))) {
      bucket.entities.set(Number(row.entity_id), {
        entity_id: Number(row.entity_id),
        entity_type: row.entity_type || null,
        entity_name: row.entity_name || null,
        recurrence_count: row.recurrence_count ?? null,
        importance_score: row.importance_score ?? null,
      });
    }

    if (row.relationship_id && !bucket.relationships.has(Number(row.relationship_id))) {
      bucket.relationships.set(Number(row.relationship_id), {
        relationship_id: Number(row.relationship_id),
        relationship_type: row.relationship_type || null,
        source_entity_name: row.source_entity_name || null,
        target_entity_name: row.target_entity_name || null,
        emotional_strength: row.emotional_strength ?? null,
        narrative_weight: row.narrative_weight ?? null,
      });
    }

    if (row.timeline_event_id && !bucket.timeline_events.has(Number(row.timeline_event_id))) {
      bucket.timeline_events.set(Number(row.timeline_event_id), {
        timeline_event_id: Number(row.timeline_event_id),
        timeline_type: row.timeline_type || null,
        title: row.timeline_title || null,
        event_date: row.event_date || null,
        emotional_weight: row.timeline_emotional_weight ?? null,
        narrative_importance: row.narrative_importance ?? null,
      });
    }

    if (Number.isFinite(Number(row.timeline_emotional_weight))) {
      bucket.emotional_weights.push(Number(row.timeline_emotional_weight));
    }

    if (Number.isFinite(Number(row.emotional_strength))) {
      bucket.emotional_weights.push(Number(row.emotional_strength));
    }

    if (Number.isFinite(Number(row.narrative_importance))) {
      bucket.narrative_importances.push(Number(row.narrative_importance));
    }

    if (Number.isFinite(Number(row.narrative_weight))) {
      bucket.narrative_importances.push(Number(row.narrative_weight));
    }
  }

  const clusters = [...clusterMap.values()].map((bucket) => {
    const memories = [...bucket.memories.values()].sort((a, b) => {
      const da = a.occurred_at ? new Date(a.occurred_at).getTime() : 0;
      const db = b.occurred_at ? new Date(b.occurred_at).getTime() : 0;
      return da - db;
    });

    const emotionalAvg =
      bucket.emotional_weights.length > 0
        ? bucket.emotional_weights.reduce((a, b) => a + b, 0) / bucket.emotional_weights.length
        : 0;

    const narrativeAvg =
      bucket.narrative_importances.length > 0
        ? bucket.narrative_importances.reduce((a, b) => a + b, 0) / bucket.narrative_importances.length
        : 0;

    const relationshipDensity = bucket.relationships.size;

    return {
      cluster_code: bucket.cluster_code,
      cluster_label: bucket.cluster_label,
      total_memories: memories.length,
      total_entities: bucket.entities.size,
      total_relationships: bucket.relationships.size,
      total_timeline_events: bucket.timeline_events.size,
      avg_emotional_weight: Number(emotionalAvg.toFixed(2)),
      avg_narrative_importance: Number(narrativeAvg.toFixed(2)),
      cluster_strength: calculateClusterStrength({
        totalMemories: memories.length,
        avgEmotionalWeight: emotionalAvg,
        avgNarrativeImportance: narrativeAvg,
        relationshipDensity,
      }),
      first_seen_at: memories[0]?.occurred_at || null,
      last_seen_at: memories[memories.length - 1]?.occurred_at || null,
      memories,
      entities: [...bucket.entities.values()],
      relationships: [...bucket.relationships.values()],
      timeline_events: [...bucket.timeline_events.values()],
    };
  });

  clusters.sort((a, b) => {
    if (b.cluster_strength !== a.cluster_strength) {
      return b.cluster_strength - a.cluster_strength;
    }
    return b.total_memories - a.total_memories;
  });

  return {
    ok: true,
    engine: "HDUD Emotional Cluster Engine v1",
    mode: "deterministic_graph",
    author_id: Number(authorId),
    total_clusters: clusters.length,
    clusters,
    meta: {
      generated_at: new Date().toISOString(),
      source_policy: "Somente dados reais já persistidos no grafo narrativo. Sem fake data.",
    },
  };
}