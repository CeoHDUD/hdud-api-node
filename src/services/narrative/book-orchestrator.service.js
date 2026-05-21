// C:\HDUD_DATA\hdud-api-node\src\services\narrative\book-orchestrator.service.js

import { buildAuthorCognitiveProfile } from "./author-cognitive-profile.service.js";
import { buildNarrativeContinuity } from "./narrative-continuity.service.js";
import { buildSymbolicRecurrence } from "./symbolic-recurrence.service.js";
import { buildMemoryResonance } from "./memory-resonance.service.js";
import { buildEmotionalClusters } from "./emotional-cluster.service.js";
import { buildNarrativeArcs } from "./narrative-arc.service.js";
import { listRelationshipEvolutions } from "./relationship-evolution.service.js";
import { buildAutobiographicalCognition } from "./autobiographical-cognition.service.js";
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

async function loadAuthorMemories(authorId, limit = 300) {
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.BigInt, authorId)
    .input("limit", sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        m.memory_id,
        m.title,
        m.content,
        m.publication_status,
        m.created_at,
        m.published_at,
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

  return result.recordset || [];
}

function makePreview(text, maxLen = 180) {
  const clean = normalizeText(text, "")?.replace(/\s+/g, " ").trim() || "";
  if (!clean) return null;
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function inferBookTitle(profile) {
  const axis = normalizeText(profile?.identity_signature?.core_axis, "");

  if (axis.includes("PERSISTENT")) return "A continuidade de uma vida";
  if (axis.includes("ACTIVE")) return "Memórias em movimento";
  if (axis.includes("EVOLVING")) return "A vida em reconstrução";

  return "Histórias de uma vida em formação";
}

function inferBookThesis(profile, continuity) {
  const identity = profile?.identity_signature?.core_axis || "EMERGING_AUTOBIOGRAPHICAL_IDENTITY";
  const state = continuity?.continuity_summary?.continuity_state || "INSUFFICIENT_GRAPH_DENSITY";

  return {
    identity_axis: identity,
    continuity_state: state,
    thesis:
      state === "STRONG_AUTOBIOGRAPHICAL_CONTINUITY"
        ? "A trajetória do autor apresenta continuidade autobiográfica forte, com símbolos, relações e transições recorrentes ao longo do tempo."
        : state === "ACTIVE_NARRATIVE_CONTINUITY"
          ? "A trajetória do autor já revela uma estrutura narrativa ativa, sustentada por recorrências simbólicas e emocionais."
          : state === "EMERGING_CONTINUITY"
            ? "A trajetória do autor possui sinais emergentes de continuidade autobiográfica, ainda em consolidação longitudinal."
            : "A trajetória do autor ainda possui baixa densidade longitudinal, mas já apresenta sinais iniciais de organização narrativa.",
  };
}

function buildBookIdentity({ profile, continuity, symbolic, resonance }) {
  return {
    title_suggestion: inferBookTitle(profile),
    book_thesis: inferBookThesis(profile, continuity),
    identity_stability: profile?.identity_signature?.identity_stability || 0,
    continuity_score: continuity?.continuity_score || 0,
    symbolic_resonance: symbolic?.narrative_resonance?.resonance_score || 0,
    autobiographical_resonance: resonance?.resonance_summary?.resonance_score || 0,
    source_policy: "Estrutura derivada apenas de memórias, símbolos, relações, timeline e cognição persistidos.",
  };
}

function buildNarrativeEras(memories, continuity) {
  const existingEras = continuity?.narrative_eras || [];

  if (existingEras.length) {
    return existingEras.map((era, index) => ({
      era_index: index + 1,
      era_label: era.era_label || era.phase_code || "Era narrativa",
      phase_code: era.phase_code || null,
      total_memories: era.total_memories || 0,
      first_memory_at: era.first_memory_at || null,
      last_memory_at: era.last_memory_at || null,
      timeline_span_days: era.timeline_span_days || 0,
      book_function:
        index === 0
          ? "ABERTURA_DA_TRAJETORIA"
          : index === existingEras.length - 1
            ? "CONTINUIDADE_ATUAL"
            : "DESENVOLVIMENTO_AUTOBIOGRAFICO",
    }));
  }

  if (!memories.length) return [];

  return [
    {
      era_index: 1,
      era_label: "Primeira era narrativa",
      phase_code: null,
      total_memories: memories.length,
      first_memory_at: memories[0]?.memory_at || null,
      last_memory_at: memories[memories.length - 1]?.memory_at || null,
      timeline_span_days: daysBetween(memories[0]?.memory_at, memories[memories.length - 1]?.memory_at),
      book_function: "BASE_INICIAL_DA_TRAJETORIA",
    },
  ];
}

function buildCoreArcs(arcs) {
  const list = arcs?.arcs || [];

  return list.slice(0, 10).map((arc, index) => ({
    arc_index: index + 1,
    arc_code: arc.arc_code || null,
    arc_label: arc.arc_label || "Arco narrativo",
    arc_strength: arc.arc_strength || 0,
    total_memories: arc.total_memories || 0,
    book_role:
      index === 0
        ? "EIXO_NARRATIVO_PRINCIPAL"
        : arc.arc_strength >= 70
          ? "ARCO_ESTRUTURAL"
          : "ARCO_SECUNDARIO",
  }));
}

function buildSymbolicBackbone(symbolic) {
  const symbols = symbolic?.dominant_symbols?.length
    ? symbolic.dominant_symbols
    : symbolic?.symbolic_patterns || [];

  return symbols.slice(0, 12).map((symbol, index) => ({
    order: index + 1,
    symbol: symbol.symbol,
    entity_type: symbol.entity_type || null,
    symbolic_role: symbol.symbolic_role || null,
    identity_axis: symbol.identity_axis || null,
    recurrence_score: symbol.recurrence_score || 0,
    book_function:
      symbol.recurrence_score >= 75
        ? "SIMBOLO_ESTRUTURAL_DO_LIVRO"
        : symbol.recurrence_score >= 50
          ? "SIMBOLO_DE_CONTINUIDADE"
          : "SIMBOLO_EMERGENTE",
  }));
}

function buildRelationshipBackbone(relationshipEvolution, continuity) {
  const relationships =
    relationshipEvolution?.relationships?.length
      ? relationshipEvolution.relationships
      : continuity?.relationship_continuity || [];

  return relationships.slice(0, 12).map((rel, index) => ({
    order: index + 1,
    relationship_id: rel.relationship_id || null,
    relationship_type: rel.relationship_type || null,
    source_entity_name: rel.source_entity_name || null,
    target_entity_name: rel.target_entity_name || null,
    bond_score: rel.bond_score || rel.continuity_score || 0,
    total_memories: rel.total_memories || 0,
    book_function:
      index === 0
        ? "RELACAO_CENTRAL_DA_TRAJETORIA"
        : safeNumber(rel.bond_score || rel.continuity_score) >= 70
          ? "RELACAO_ESTRUTURAL"
          : "RELACAO_DE_CONTEXTO",
  }));
}

function buildEmotionalJourney(clusters, continuity) {
  const clusterList = clusters?.clusters || [];
  const emotionalContinuity = continuity?.emotional_continuity || {};

  return {
    emotional_continuity_score: emotionalContinuity.score || 0,
    emotional_state: emotionalContinuity.state || "UNKNOWN",
    total_emotional_clusters: clusterList.length,
    dominant_clusters: clusterList.slice(0, 8).map((cluster, index) => ({
      order: index + 1,
      cluster_code: cluster.cluster_code || null,
      cluster_label: cluster.cluster_label || null,
      cluster_strength: cluster.cluster_strength || 0,
      total_memories: cluster.total_memories || 0,
      journey_role:
        index === 0
          ? "TONALIDADE_EMOCIONAL_DOMINANTE"
          : "CAMADA_EMOCIONAL_SECUNDARIA",
    })),
  };
}

function buildContinuityMap(continuity, resonance) {
  const loops = continuity?.narrative_loops || [];
  const callbacks = resonance?.autobiographical_callbacks || [];

  return [
    ...loops.slice(0, 8).map((loop, index) => ({
      map_index: index + 1,
      continuity_type: loop.loop_type || "NARRATIVE_LOOP",
      symbol: loop.symbol || null,
      score: loop.continuity_score || 0,
      timeline_span_days: loop.timeline_span_days || 0,
      book_role: "LOOP_AUTOBIOGRAFICO",
    })),
    ...callbacks.slice(0, 8).map((callback, index) => ({
      map_index: loops.length + index + 1,
      continuity_type: callback.callback_type || "AUTOBIOGRAPHICAL_CALLBACK",
      symbol: callback.symbol || null,
      score: callback.recurrence_score || 0,
      timeline_span_days: callback.timeline_span_days || 0,
      book_role: "CALLBACK_AUTOBIOGRAFICO",
    })),
  ];
}

function buildChapterCandidates(memories, eras, symbolic, arcs) {
  const symbols = symbolic?.dominant_symbols || [];
  const arcList = arcs?.arcs || [];

  const candidates = [];

  for (const era of eras) {
    const eraMemories = memories.filter((memory) => {
      if (!era.phase_code) return !memory.phase_code;
      return memory.phase_code === era.phase_code;
    });

    if (!eraMemories.length) continue;

    candidates.push({
      candidate_type: "ERA_BASED_CHAPTER",
      suggested_title: era.era_label,
      narrative_intent: `Organizar ${eraMemories.length} memórias da era narrativa "${era.era_label}".`,
      source_memory_ids: eraMemories.map((m) => Number(m.memory_id)).slice(0, 30),
      total_memories: eraMemories.length,
      anchor_symbols: symbols.slice(0, 5).map((s) => s.symbol),
      source_policy: "Somente memórias reais do autor. Sem criação de fatos.",
    });
  }

  for (const arc of arcList.slice(0, 5)) {
    candidates.push({
      candidate_type: "ARC_BASED_CHAPTER",
      suggested_title: arc.arc_label || "Arco narrativo",
      narrative_intent: "Organizar um capítulo a partir de um arco narrativo detectado no grafo.",
      source_memory_ids: [],
      total_memories: arc.total_memories || 0,
      anchor_symbols: symbols.slice(0, 5).map((s) => s.symbol),
      source_policy: "Candidato estrutural. Exige seleção real de memórias antes de gerar texto editorial.",
    });
  }

  return candidates.slice(0, 20);
}

function buildBookStructure({ eras, coreArcs, symbolicBackbone, relationshipBackbone }) {
  const structure = [];

  structure.push({
    section_index: 1,
    section_role: "ABERTURA",
    suggested_title: "Onde a história começa",
    purpose: "Apresentar o autor, o eixo inicial da trajetória e os primeiros sinais de continuidade narrativa.",
    anchors: {
      symbols: symbolicBackbone.slice(0, 3).map((s) => s.symbol),
      relationships: relationshipBackbone.slice(0, 2).map((r) => r.target_entity_name).filter(Boolean),
    },
  });

  eras.forEach((era, index) => {
    structure.push({
      section_index: structure.length + 1,
      section_role: "ERA_AUTOBIOGRAFICA",
      suggested_title: era.era_label,
      purpose:
        index === 0
          ? "Organizar a base inicial da trajetória autobiográfica."
          : index === eras.length - 1
            ? "Organizar a continuidade atual da vida narrada."
            : "Organizar uma fase intermediária de desenvolvimento autobiográfico.",
      anchors: {
        phase_code: era.phase_code,
        total_memories: era.total_memories,
      },
    });
  });

  coreArcs.slice(0, 5).forEach((arc) => {
    structure.push({
      section_index: structure.length + 1,
      section_role: "ARCO_NARRATIVO",
      suggested_title: arc.arc_label,
      purpose: "Aprofundar um arco narrativo persistente detectado no Living Narrative Graph.",
      anchors: {
        arc_code: arc.arc_code,
        arc_strength: arc.arc_strength,
      },
    });
  });

  structure.push({
    section_index: structure.length + 1,
    section_role: "FECHAMENTO_CONTINUIDADE",
    suggested_title: "O que permanece",
    purpose: "Consolidar símbolos, relações e continuidades que permanecem na identidade autobiográfica do autor.",
    anchors: {
      symbols: symbolicBackbone.slice(0, 5).map((s) => s.symbol),
      relationships: relationshipBackbone.slice(0, 3).map((r) => r.target_entity_name).filter(Boolean),
    },
  });

  return structure;
}

function buildBookSummary({ memories, profile, continuity, symbolic, resonance, chapterCandidates }) {
  const totalMemories = memories.length;
  const identityScore = profile?.identity_signature?.identity_stability || 0;
  const continuityScore = continuity?.continuity_score || 0;
  const symbolicScore = symbolic?.narrative_resonance?.resonance_score || 0;
  const resonanceScore = resonance?.resonance_summary?.resonance_score || 0;

  const readinessScore = clampInt(
    Math.min(totalMemories * 6, 30) +
      identityScore * 0.25 +
      continuityScore * 0.25 +
      symbolicScore * 0.1 +
      resonanceScore * 0.1,
    0,
    100,
    0
  );

  return {
    total_source_memories: totalMemories,
    chapter_candidates: chapterCandidates.length,
    book_readiness_score: readinessScore,
    readiness_state:
      readinessScore >= 80
        ? "READY_FOR_EDITORIAL_BOOK_ORCHESTRATION"
        : readinessScore >= 60
          ? "READY_FOR_STRUCTURED_CHAPTER_SEQUENCE"
          : readinessScore >= 40
            ? "EMERGING_BOOK_STRUCTURE"
            : "INSUFFICIENT_LONGITUDINAL_DENSITY",
    interpretation:
      readinessScore >= 80
        ? "O autor já possui densidade autobiográfica forte para organização editorial de livro."
        : readinessScore >= 60
          ? "O autor já possui estrutura suficiente para uma sequência inicial de capítulos."
          : readinessScore >= 40
            ? "O autor possui estrutura emergente de livro, ainda dependente de mais memórias conectadas."
            : "Ainda não há densidade longitudinal suficiente para orquestração robusta de livro.",
  };
}

export async function orchestrateAutobiographicalBook({
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

  const [
    memories,
    cognitiveProfile,
    continuity,
    symbolic,
    resonance,
    emotionalClusters,
    narrativeArcs,
    relationshipEvolution,
    autobiographicalCognition,
  ] = await Promise.all([
    loadAuthorMemories(safeAuthorId, safeLimit),
    buildAuthorCognitiveProfile({ authorId: safeAuthorId }),
    buildNarrativeContinuity({ authorId: safeAuthorId, limit: safeLimit }),
    buildSymbolicRecurrence({ authorId: safeAuthorId, limit: 200 }),
    buildMemoryResonance({ authorId: safeAuthorId, limit: 100 }),
    buildEmotionalClusters({ authorId: safeAuthorId, limit: 300 }),
    buildNarrativeArcs({ authorId: safeAuthorId, limit: 500 }),
    listRelationshipEvolutions({ authorId: safeAuthorId, limit: 100 }),
    buildAutobiographicalCognition({ authorId: safeAuthorId }),
  ]);

  const bookIdentity = buildBookIdentity({
    profile: cognitiveProfile,
    continuity,
    symbolic,
    resonance,
  });

  const narrativeEras = buildNarrativeEras(memories, continuity);
  const coreArcs = buildCoreArcs(narrativeArcs);
  const symbolicBackbone = buildSymbolicBackbone(symbolic);
  const relationshipBackbone = buildRelationshipBackbone(relationshipEvolution, continuity);
  const emotionalJourney = buildEmotionalJourney(emotionalClusters, continuity);
  const continuityMap = buildContinuityMap(continuity, resonance);

  const chapterCandidates = buildChapterCandidates(
    memories,
    narrativeEras,
    symbolic,
    narrativeArcs
  );

  const bookStructure = buildBookStructure({
    eras: narrativeEras,
    coreArcs,
    symbolicBackbone,
    relationshipBackbone,
  });

  return {
    ok: true,
    engine: "HDUD Book Orchestrator Engine v1",
    author_id: safeAuthorId,
    book_identity: bookIdentity,
    book_structure: bookStructure,
    narrative_eras: narrativeEras,
    core_arcs: coreArcs,
    symbolic_backbone: symbolicBackbone,
    relationship_backbone: relationshipBackbone,
    emotional_journey: emotionalJourney,
    continuity_map: continuityMap,
    chapter_candidates: chapterCandidates,
    book_summary: buildBookSummary({
      memories,
      profile: cognitiveProfile,
      continuity,
      symbolic,
      resonance,
      chapterCandidates,
    }),
    source_inventory: {
      total_memories: memories.length,
      total_symbols: symbolic?.symbolic_patterns?.length || 0,
      total_resonance_pairs: resonance?.resonance_pairs?.length || 0,
      total_arcs: narrativeArcs?.arcs?.length || 0,
      total_emotional_clusters: emotionalClusters?.clusters?.length || 0,
      autobiographical_cognition_loaded: Boolean(autobiographicalCognition?.ok),
    },
    sample_memories: memories.slice(0, 20).map((memory) => ({
      memory_id: Number(memory.memory_id),
      title: normalizeText(memory.title, "Memória sem título"),
      preview: makePreview(memory.content),
      phase_code: memory.phase_code || null,
      publication_status: memory.publication_status || null,
      memory_at: memory.memory_at || null,
    })),
    meta: {
      generated_at: new Date().toISOString(),
      source_policy:
        "Somente estrutura de livro derivada de memórias reais e dados persistidos no Living Narrative Graph. Nenhum fato autobiográfico inventado.",
      mode: "deterministic_cognition",
      graph_idempotent: true,
      editorial_generation: false,
    },
  };
}