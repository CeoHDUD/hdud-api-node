// C:\HDUD_DATA\hdud-api-node\src\services\narrative\narrative-arc.service.js

import { getPool, sql } from "../../db.js";

const ARC_TYPES = [
  {
    code: "ORIGIN",
    label: "Origem",
    keywords: [
      "INFANCIA",
      "COMECO",
      "INICIO",
      "PRIMEIRA",
      "ORIGEM",
      "FAMILIA",
    ],
  },
  {
    code: "ASCENSION",
    label: "Ascensão",
    keywords: [
      "CRESCIMENTO",
      "EVOLUCAO",
      "CONQUISTA",
      "ASCENSAO",
      "VITORIA",
      "SUPERAÇÃO",
      "SUPERA",
    ],
  },
  {
    code: "LOVE_BOND",
    label: "Vínculo Afetivo",
    keywords: [
      "AMOR",
      "CASAMENTO",
      "NAMORO",
      "ESPOSA",
      "PARCEIRO",
      "PARTNER",
      "SPOUSE",
      "AFETO",
      "SAUDADE",
    ],
  },
  {
    code: "CRISIS",
    label: "Crise",
    keywords: [
      "CRISE",
      "MEDO",
      "COLAPSO",
      "DOR",
      "ANGUSTIA",
      "SOFRIMENTO",
      "HERIDA",
    ],
  },
  {
    code: "RUPTURE",
    label: "Ruptura",
    keywords: [
      "SEPARACAO",
      "FIM",
      "RUPTURA",
      "QUEBRA",
      "PERDA",
      "LUTO",
      "AUSENCIA",
    ],
  },
  {
    code: "DISPLACEMENT",
    label: "Deslocamento",
    keywords: [
      "MUDANCA",
      "VIAGEM",
      "CIDADE",
      "LUGAR",
      "DISTANCIA",
      "CASA",
      "PLACE_ASSOCIATION",
    ],
  },
  {
    code: "RECONSTRUCTION",
    label: "Reconstrução",
    keywords: [
      "RECOMECO",
      "RECONSTRUCAO",
      "CURA",
      "SUPERAÇÃO",
      "SUPERA",
      "REERGUER",
      "RENASCIMENTO",
    ],
  },
  {
    code: "TRANSFORMATION",
    label: "Transformação",
    keywords: [
      "TRANSFORMACAO",
      "MUDANCA",
      "DESCOBERTA",
      "IDENTIDADE",
      "EVOLUCAO",
      "CRESCIMENTO",
    ],
  },
  {
    code: "REBIRTH",
    label: "Renascimento",
    keywords: [
      "RENASCIMENTO",
      "NOVA VIDA",
      "NOVO COMECO",
      "RENASCER",
      "RECOMECO",
    ],
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

  if (!Number.isFinite(n)) {
    return 0;
  }

  return Math.max(
    min,
    Math.min(max, Math.round(n))
  );
}

function detectArc(row) {
  const haystack = normalizeKey([
    row.memory_title,
    row.memory_content,
    row.phase_code,
    row.timeline_type,
    row.timeline_title,
    row.timeline_description,
    row.relationship_type,
    row.entity_name,
    row.entity_type,
  ].filter(Boolean).join(" "));

  let best = null;

  for (const arc of ARC_TYPES) {
    const score =
      arc.keywords.reduce(
        (acc, keyword) => {
          return haystack.includes(
            normalizeKey(keyword)
          )
            ? acc + 1
            : acc;
        },
        0
      );

    if (
      !best ||
      score > best.score
    ) {
      best = {
        code: arc.code,
        label: arc.label,
        score,
      };
    }
  }

  if (
    !best ||
    best.score <= 0
  ) {
    return {
      code: "UNCLASSIFIED_ARC",
      label:
        "Arco ainda não classificado",
      score: 0,
    };
  }

  return best;
}

function calculateArcStrength({
  memoryCount,
  avgEmotion,
  avgNarrative,
  relationshipCount,
  timelineCount,
}) {
  return clampScore(
    Math.min(memoryCount * 10, 35) +
    Math.min((avgEmotion || 0) * 4, 30) +
    Math.min((avgNarrative || 0) * 3, 25) +
    Math.min(relationshipCount * 2, 6) +
    Math.min(timelineCount * 2, 4)
  );
}

export async function buildNarrativeArcs({
  authorId,
  limit = 300,
}) {
  const pool =
    await getPool();

  const result =
    await pool
      .request()
      .input(
        "author_id",
        sql.BigInt,
        authorId
      )
      .input(
        "limit",
        sql.Int,
        Math.max(
          50,
          Math.min(
            Number(limit) || 300,
            1000
          )
        )
      )
      .query(`
        SELECT TOP (@limit)

          m.memory_id,
          m.title AS memory_title,
          CONVERT(NVARCHAR(MAX), m.content)
            AS memory_content,

          m.created_at,
          m.published_at,
          m.publication_status,

          p.phase_code,

          nt.timeline_event_id,
          nt.timeline_type,
          nt.title AS timeline_title,
          nt.description AS timeline_description,
          nt.event_date,
          nt.emotional_weight,
          nt.narrative_importance,

          nr.relationship_id,
          nr.relationship_type,
          nr.emotional_strength,
          nr.narrative_weight,

          ne.entity_id,
          ne.entity_type,
          ne.entity_name,
          ne.recurrence_count,
          ne.importance_score

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
          ON nr.relationship_id =
             mr.relationship_id
         AND nr.author_id = @author_id

        WHERE
          m.author_id = @author_id
          AND ISNULL(m.is_deleted,0) = 0

        ORDER BY
          COALESCE(
            m.published_at,
            m.created_at
          ) ASC,
          m.memory_id ASC
      `);

  const rows =
    result.recordset || [];

  const arcMap =
    new Map();

  for (const row of rows) {
    const arc =
      detectArc(row);

    if (
      !arcMap.has(arc.code)
    ) {
      arcMap.set(
        arc.code,
        {
          arc_code:
            arc.code,

          arc_label:
            arc.label,

          memories:
            new Map(),

          relationships:
            new Map(),

          entities:
            new Map(),

          timeline_events:
            new Map(),

          emotional_values:
            [],

          narrative_values:
            [],
        }
      );
    }

    const bucket =
      arcMap.get(arc.code);

    if (
      row.memory_id &&
      !bucket.memories.has(
        Number(row.memory_id)
      )
    ) {
      bucket.memories.set(
        Number(row.memory_id),
        {
          memory_id:
            Number(row.memory_id),

          title:
            row.memory_title || null,

          occurred_at:
            row.published_at ||
            row.created_at ||
            null,

          phase_code:
            row.phase_code || null,

          publication_status:
            row.publication_status || null,
        }
      );
    }

    if (
      row.entity_id &&
      !bucket.entities.has(
        Number(row.entity_id)
      )
    ) {
      bucket.entities.set(
        Number(row.entity_id),
        {
          entity_id:
            Number(row.entity_id),

          entity_type:
            row.entity_type || null,

          entity_name:
            row.entity_name || null,

          recurrence_count:
            row.recurrence_count ?? null,

          importance_score:
            row.importance_score ?? null,
        }
      );
    }

    if (
      row.relationship_id &&
      !bucket.relationships.has(
        Number(row.relationship_id)
      )
    ) {
      bucket.relationships.set(
        Number(row.relationship_id),
        {
          relationship_id:
            Number(row.relationship_id),

          relationship_type:
            row.relationship_type || null,

          emotional_strength:
            row.emotional_strength ?? null,

          narrative_weight:
            row.narrative_weight ?? null,
        }
      );
    }

    if (
      row.timeline_event_id &&
      !bucket.timeline_events.has(
        Number(row.timeline_event_id)
      )
    ) {
      bucket.timeline_events.set(
        Number(row.timeline_event_id),
        {
          timeline_event_id:
            Number(row.timeline_event_id),

          timeline_type:
            row.timeline_type || null,

          title:
            row.timeline_title || null,

          event_date:
            row.event_date || null,

          emotional_weight:
            row.emotional_weight ?? null,

          narrative_importance:
            row.narrative_importance ?? null,
        }
      );
    }

    if (
      Number.isFinite(
        Number(row.emotional_weight)
      )
    ) {
      bucket.emotional_values.push(
        Number(row.emotional_weight)
      );
    }

    if (
      Number.isFinite(
        Number(row.emotional_strength)
      )
    ) {
      bucket.emotional_values.push(
        Number(row.emotional_strength)
      );
    }

    if (
      Number.isFinite(
        Number(row.narrative_importance)
      )
    ) {
      bucket.narrative_values.push(
        Number(row.narrative_importance)
      );
    }

    if (
      Number.isFinite(
        Number(row.narrative_weight)
      )
    ) {
      bucket.narrative_values.push(
        Number(row.narrative_weight)
      );
    }
  }

  const arcs =
    [...arcMap.values()]
      .map((bucket) => {
        const memories =
          [...bucket.memories.values()]
            .sort((a, b) => {
              const da =
                a.occurred_at
                  ? new Date(
                      a.occurred_at
                    ).getTime()
                  : 0;

              const db =
                b.occurred_at
                  ? new Date(
                      b.occurred_at
                    ).getTime()
                  : 0;

              return da - db;
            });

        const avgEmotion =
          bucket
            .emotional_values
            .length > 0

            ? bucket
                .emotional_values
                .reduce(
                  (a, b) => a + b,
                  0
                ) /
              bucket
                .emotional_values
                .length

            : 0;

        const avgNarrative =
          bucket
            .narrative_values
            .length > 0

            ? bucket
                .narrative_values
                .reduce(
                  (a, b) => a + b,
                  0
                ) /
              bucket
                .narrative_values
                .length

            : 0;

        return {
          arc_code:
            bucket.arc_code,

          arc_label:
            bucket.arc_label,

          total_memories:
            memories.length,

          total_entities:
            bucket.entities.size,

          total_relationships:
            bucket.relationships.size,

          total_timeline_events:
            bucket.timeline_events.size,

          avg_emotional_intensity:
            Number(
              avgEmotion.toFixed(2)
            ),

          avg_narrative_importance:
            Number(
              avgNarrative.toFixed(2)
            ),

          arc_strength:
            calculateArcStrength({
              memoryCount:
                memories.length,

              avgEmotion,

              avgNarrative,

              relationshipCount:
                bucket.relationships
                  .size,

              timelineCount:
                bucket.timeline_events
                  .size,
            }),

          first_seen_at:
            memories[0]
              ?.occurred_at || null,

          last_seen_at:
            memories[
              memories.length - 1
            ]?.occurred_at || null,

          memories,

          entities:
            [
              ...bucket.entities
                .values()
            ],

          relationships:
            [
              ...bucket.relationships
                .values()
            ],

          timeline_events:
            [
              ...bucket.timeline_events
                .values()
            ],
        };
      })

      .sort((a, b) => {
        if (
          b.arc_strength !==
          a.arc_strength
        ) {
          return (
            b.arc_strength -
            a.arc_strength
          );
        }

        return (
          b.total_memories -
          a.total_memories
        );
      });

  return {
    ok: true,

    engine:
      "HDUD Narrative Arc Engine v1",

    mode:
      "deterministic_autobiographical_arc_detection",

    author_id:
      Number(authorId),

    total_arcs:
      arcs.length,

    arcs,

    meta: {
      generated_at:
        new Date().toISOString(),

      source_policy:
        "Somente dados reais persistidos no Living Narrative Graph.",

      cognition_layer:
        "AUTOBIOGRAPHICAL_TRAJECTORY",
    },
  };
}
