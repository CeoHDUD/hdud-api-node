// C:\HDUD_DATA\hdud-api-node\src\services\story\story-discovery-orchestrator.service.js
//
// GO LIVE 006 — Story Discovery Orchestrator
// Responsabilidade: descobrir histórias humanas antes de qualquer Blueprint/Runtime.
//
// Fluxo oficial:
//   Memórias reais
//     ↓
//   Story Hypotheses
//     ↓
//   Compatibility Seeds
//     ↓
//   Story Candidates / Blueprints
//     ↓
//   Truth Selection
//
// A pergunta central deixou de ser "qual seed possui potencial?".
// Agora é:
//   "Qual é a história que estas memórias estão tentando contar?"

import { getPool, sql } from "../../db.js";
import { discoverStoryHypotheses } from "./story-hypothesis-engine.service.js";
import { buildStorySeeds } from "./story-seed-engine.service.js";
import { buildStoryCandidatesFromSeeds } from "./story-candidate-engine.service.js";
import { compareMemoryDate, memoryIdOf } from "./story-continuity.service.js";
import { loadNarrativeTaxonomyGraph, summarizeNarrativePaths } from "./story-narrative-path.service.js";
import { buildNarrativeGraphIntelligence } from "./narrative-graph-intelligence.service.js";

const ENGINE_VERSION = "story-discovery-orchestrator-v6.4.3-family-hypothesis-first";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.max(min, Math.min(max, safe));
}

async function fetchAuthorMemoriesFromDatabase({ authorId, limit = 300 } = {}) {
  const safeAuthorId = toPositiveInt(authorId);
  if (!safeAuthorId) return [];

  const safeLimit = clampInt(limit, 300, 1, 1000);
  const pool = await getPool();

  const result = await pool
    .request()
    .input("author_id", sql.Int, safeAuthorId)
    .input("limit", sql.Int, safeLimit)
    .query(`
      SELECT TOP (@limit)
        m.memory_id,
        m.author_id,
        m.title,
        m.content,
        m.memory_created_at AS created_at,
        NULL AS version_number,
        NULL AS phase_id,
        NULL AS origin_type,
        m.publication_status,
        NULL AS published_at,
        NULL AS archived_at,
        NULL AS published_version_number,
        m.life_period_code,
        m.context_code,
        m.narrative_role_code,
        m.narrative_arc_code,
        m.historical_importance,
        m.narrative_importance,
        m.emotional_intensity,
        m.emotional_valence,
        m.canonical_story_key,
        m.canonical_story_title,
        m.editorial_notes,
        m.ai_confidence,
        m.editorial_certainty,
        m.interpretation_source,
        m.classification_version,
        m.story_affinity,
        m.chapter_affinity,
        m.book_affinity
      FROM dbo.vw_MemoryNarrativeIntelligence m
      WHERE m.author_id = @author_id
        AND (
          NULLIF(LTRIM(RTRIM(ISNULL(m.title, ''))), '') IS NOT NULL
          OR NULLIF(LTRIM(RTRIM(ISNULL(m.content, ''))), '') IS NOT NULL
        )
      ORDER BY
        m.memory_created_at ASC,
        m.memory_id ASC;
    `);

  return safeArray(result.recordset).map((row) => ({
    memory_id: Number(row.memory_id),
    id: Number(row.memory_id),
    author_id: Number(row.author_id),
    title: row.title,
    content: row.content,
    description: null,
    memory_date: row.created_at,
    narrative_date: null,
    created_at: row.created_at,
    published_at: row.published_at,
    version_number: row.version_number,
    phase_id: row.phase_id,
    origin_type: row.origin_type,
    publication_status: row.publication_status,
    published_version_number: row.published_version_number,
    life_period_code: row.life_period_code,
    context_code: row.context_code,
    narrative_role_code: row.narrative_role_code,
    narrative_arc_code: row.narrative_arc_code,
    historical_importance: row.historical_importance,
    narrative_importance: row.narrative_importance,
    emotional_intensity: row.emotional_intensity,
    emotional_valence: row.emotional_valence,
    canonical_story_key: row.canonical_story_key,
    canonical_story_title: row.canonical_story_title,
    editorial_notes: row.editorial_notes,
    ai_confidence: row.ai_confidence,
    editorial_certainty: row.editorial_certainty,
    interpretation_source: row.interpretation_source,
    classification_version: row.classification_version,
    story_affinity: row.story_affinity,
    chapter_affinity: row.chapter_affinity,
    book_affinity: row.book_affinity,
  }));
}

function normalizeMemoryInput(memories = [], limit = 300) {
  const safeLimit = clampInt(limit, 300, 1, 1000);
  const map = new Map();

  for (const memory of safeArray(memories)) {
    const id = memoryIdOf(memory);
    if (id && !map.has(id)) map.set(id, memory);
  }

  return [...map.values()].sort(compareMemoryDate).slice(0, safeLimit);
}

function normalizeHypothesisForPublicContract(hypothesis = {}) {
  return {
    question: hypothesis.question || hypothesis.central_question || "Que história estas memórias estão tentando contar?",
    title: hypothesis.title || hypothesis.suggested_title || "História em descoberta",
    confidence: Math.max(0, Math.min(100, Math.round(Number(hypothesis.confidence || hypothesis.story_score || 0)))),
    memories: safeArray(hypothesis.memories || hypothesis.memory_ids).map(Number).filter(Boolean),
    hypothesis_id: hypothesis.hypothesis_id || null,
    code: hypothesis.code || null,
    transformation: hypothesis.transformation || null,
    evidence: hypothesis.evidence || [],
    source_policy: hypothesis.source_policy || "Hipótese narrativa humana descoberta antes de Blueprint e antes de escrita.",
  };
}


function candidateMemoryIds(candidate = {}) {
  return [...new Set([
    ...safeArray(candidate?.memory_ids),
    ...safeArray(candidate?.memoryIds),
    ...safeArray(candidate?.memories).map((memory) => memory?.memory_id ?? memory?.id ?? memory),
    ...safeArray(candidate?.related_memories).map((memory) => memory?.memory_id ?? memory?.id ?? memory),
  ].map(toPositiveInt).filter(Boolean))];
}

function hydrateCandidateMemories(candidate = {}, sourceMemories = []) {
  const ids = new Set(candidateMemoryIds(candidate));
  if (!ids.size) return [];
  return safeArray(sourceMemories).filter((memory) => ids.has(toPositiveInt(memory?.memory_id ?? memory?.id)));
}

function canonicalNarrativePathGate(candidate = {}) {
  const validation = candidate?.story_blueprint?.narrative_path_validation
    || candidate?.blueprint?.narrative_path_validation
    || candidate?.narrative_path_validation
    || candidate?.narrative_compatibility
    || null;

  if (!validation) {
    return { approved: false, status: "NTG_PATH_MISSING", reason: "Candidate sem validação canônica de Narrative Path." };
  }

  const incompatible = Boolean(
    validation.blocking_incompatibility
    || Number(validation.incompatible_pair_count || 0) > 0
    || candidate.ntg_incompatible
  );
  const completeEnough = validation.complete_enough !== false
    && Number(validation.complete_path_count || 0) >= 2;
  const graphScore = Number(validation.average_graph_score || candidate.graph_narrative_score || 0);
  const coherent = validation.coherent === true || (!incompatible && completeEnough && graphScore >= 45);

  return {
    approved: coherent && !incompatible,
    status: incompatible ? "NTG_INCOMPATIBLE" : coherent ? "NTG_COHERENT" : "NTG_PATH_WEAK",
    incompatible,
    complete_enough: completeEnough,
    graph_score: graphScore,
    validation,
  };
}

function buildPipelineContract({ authorId, candidate, narrativeGraphIntelligence }) {
  const arc = candidate?.narrative_arc || null;
  const pathGate = canonicalNarrativePathGate(candidate);
  const truthSelection = candidate?.truth_selection || candidate?.truthSelection || null;
  const ngiApproved = Boolean(narrativeGraphIntelligence?.can_proceed_to_truth);
  const arcApproved = Boolean(arc?.can_proceed_to_truth);
  const eligibleForGeneration = pathGate.approved && arcApproved && ngiApproved;

  return {
    contract_version: "GO_LIVE_006_4_3_CHAT_09",
    author_id: authorId,
    candidate_id: candidate?.candidate_id || candidate?.story_id || candidate?.id || null,
    narrative_path_validation: pathGate,
    blueprint: candidate?.story_blueprint || candidate?.blueprint || null,
    narrative_arc: arc,
    narrative_graph_gate: {
      approved: ngiApproved,
      status: narrativeGraphIntelligence?.status || "EMPTY_GRAPH",
      central_arc_id: narrativeGraphIntelligence?.central_arc_id || null,
    },
    truth_selection: truthSelection,
    eligibility: {
      ntg: pathGate.approved,
      arc: arcApproved,
      narrative_graph: ngiApproved,
      story_generation: eligibleForGeneration,
    },
    source_policy: "Contrato canônico do CHAT 09: NTG valida o caminho; Arc organiza; NGI conecta; Truth autoriza evidências; Generation apenas materializa.",
  };
}

function buildDiscoveryTruthSummary(candidates = []) {
  const visible = safeArray(candidates);
  const scores = visible.map((candidate) => Number(candidate.truth_score || candidate.confidence || 0)).filter((score) => Number.isFinite(score));

  const averageTruthScore = scores.length
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : 0;

  return {
    candidate_truth_score: averageTruthScore,
    evidence_quality: averageTruthScore >= 85 ? "HIGH" : averageTruthScore >= 65 ? "MEDIUM" : averageTruthScore >= 40 ? "LOW" : "NONE",
    hallucination_risk: averageTruthScore >= 90 ? "VERY_LOW" : averageTruthScore >= 75 ? "LOW" : averageTruthScore >= 55 ? "MEDIUM" : "HIGH",
    truth_memory_selection_applied: true,
    keep_memory_count: visible.reduce((sum, candidate) => sum + Number(candidate.truth_selection?.statistics?.keep || candidate.memory_count || 0), 0),
    drop_memory_count: visible.reduce((sum, candidate) => sum + Number(candidate.truth_selection?.statistics?.drop || candidate.discarded_memories?.length || 0), 0),
  };
}

function buildEmptyResponse({ authorId, reason, providedMemories = 0, dbMemories = 0 } = {}) {
  return {
    ok: Boolean(authorId),
    reason,
    engine: ENGINE_VERSION,
    version: ENGINE_VERSION,
    author_id: authorId || null,
    story_discovery: [],
    hypotheses: [],
    candidates: [],
    blueprints: [],
    stories: [],
    visible_candidates: [],
    meta: {
      generated_at: new Date().toISOString(),
      input_memories: providedMemories,
      db_memories: dbMemories,
      hypothesis_count: 0,
      seed_count: 0,
      candidate_count: 0,
      visible_count: 0,
      hidden_count: 0,
      max_visible: 6,
      source_policy: "Story Discovery descobre histórias humanas. Nenhuma História é escrita ou persistida sem Blueprint, Truth e aprovação explícita do autor.",
      truth_policy: "Sem hipóteses suficientes para aplicar Truth Memory Selection.",
    },
  };
}

export function buildStoryHypothesisFromCluster(cluster, options = {}) {
  const memories = Array.isArray(cluster)
    ? cluster
    : (Array.isArray(cluster?.memories) ? cluster.memories : []);

  const authorId = toPositiveInt(options.authorId ?? options.author_id ?? cluster?.author_id ?? cluster?.authorId);
  if (!authorId) return null;

  const hypotheses = discoverStoryHypotheses({
    authorId,
    memories,
    maxHypotheses: 1,
    includeWeak: true,
  });

  const hypothesis = hypotheses[0] || null;
  if (!hypothesis) return null;

  const seeds = buildStorySeeds(hypothesis.selected_memories || memories, { authorId, includeWeak: true, maxSeeds: 1 });
  const candidates = buildStoryCandidatesFromSeeds({ authorId, seeds, includeWeak: true });
  return candidates[0] || hypothesis;
}

export async function discoverStoryHypothesesForAuthor({
  authorId,
  memories = [],
  limit = 300,
  visibleLimit = 6,
  includeWeak = false,
  truthThreshold = null,
  generateStories = false,
} = {}) {
  const safeAuthorId = toPositiveInt(authorId);

  if (!safeAuthorId) {
    return buildEmptyResponse({ reason: "authorId inválido." });
  }

  const safeLimit = clampInt(limit, 300, 1, 1000);
  const maxVisible = clampInt(visibleLimit, 6, 1, 12);
  const providedMemories = normalizeMemoryInput(memories, safeLimit);
  const sourceMemories = providedMemories.length
    ? providedMemories
    : await fetchAuthorMemoriesFromDatabase({ authorId: safeAuthorId, limit: safeLimit });

  const normalizedMemories = normalizeMemoryInput(sourceMemories, safeLimit);

  if (normalizedMemories.length < 2) {
    return buildEmptyResponse({
      authorId: safeAuthorId,
      reason: "Ainda não há memórias suficientes para descobrir histórias humanas.",
      providedMemories: providedMemories.length,
      dbMemories: providedMemories.length ? 0 : normalizedMemories.length,
    });
  }

  const ntgGraph = await loadNarrativeTaxonomyGraph({ getPool, sql });
  const sourceNarrativePaths = summarizeNarrativePaths(normalizedMemories, ntgGraph);

  const hypotheses = safeArray(discoverStoryHypotheses({
    authorId: safeAuthorId,
    memories: normalizedMemories,
    maxHypotheses: maxVisible,
    includeWeak,
  }));

  const seeds = safeArray(buildStorySeeds(normalizedMemories, {
    authorId: safeAuthorId,
    includeWeak,
    maxSeeds: maxVisible,
    // Evita uma segunda descoberta divergente: os candidates nascem exatamente
    // das hipóteses públicas auditadas nesta execução.
    hypotheses,
    ntgGraph,
  }));

  const candidates = safeArray(buildStoryCandidatesFromSeeds({
    authorId: safeAuthorId,
    seeds,
    includeWeak,
    truthThreshold,
    enableTruthSelection: true,
    enableCalibration: true,
    calibrationBoundaryThreshold: 58,
    ntgGraph,
  }));

  const calibrationSegments = candidates
    .map((candidate) => candidate.calibration || candidate.story_calibration?.segment)
    .filter(Boolean);
  const calibrationSummary = {
    applied: true,
    candidate_count: candidates.length,
    calibrated_candidate_count: calibrationSegments.length,
    independent_candidate_count: calibrationSegments.filter((item) => Number(item.independence_score || 0) >= 55).length,
    multi_arc_ready: candidates.length >= 2,
    average_cohesion_score: calibrationSegments.length
      ? Math.round(calibrationSegments.reduce((sum, item) => sum + Number(item.cohesion_score || 0), 0) / calibrationSegments.length)
      : 0,
    average_independence_score: calibrationSegments.length
      ? Math.round(calibrationSegments.reduce((sum, item) => sum + Number(item.independence_score || 0), 0) / calibrationSegments.length)
      : 0,
    trajectories: calibrationSegments.map((item) => ({
      segment_id: item.segment_id,
      trajectory_key: item.trajectory_key,
      memory_ids: item.memory_ids,
      memory_count: item.memory_count,
      cohesion_score: item.cohesion_score,
      independence_score: item.independence_score,
      arc_diversity_score: item.arc_diversity_score,
    })),
    policy: "Narrative Family Segmentation ocorre antes do Truth Selection e do Narrative Arc Engine.",
  };

  const visibleCandidates = candidates.slice(0, maxVisible);
  const blueprints = visibleCandidates.map((candidate) => candidate.story_blueprint || candidate.blueprint).filter(Boolean);
  const narrativeArcs = visibleCandidates.map((candidate) => candidate.narrative_arc).filter(Boolean);
  const validatedArcs = narrativeArcs.filter((arc) => arc.can_proceed_to_truth);
  const narrativeGraphIntelligence = buildNarrativeGraphIntelligence({
    arcs: validatedArcs,
    candidates: visibleCandidates,
    // CHAT 09: arcos de familias distintas raramente compartilham memoria ou
    // contexto. O NGI deve aceitar relacoes fracas, mas observaveis, produzidas
    // pelo proprio Arc Linking Engine (papel, estagio, semantica e cronologia).
    minimumLinkScore: 5,
  }) || {
    status: "EMPTY_GRAPH",
    runtime: { source_arc_count: validatedArcs.length },
    arc_links: [],
    narrative_families: [],
    life_journey_graph: {
      statistics: {
        connected_node_count: 0,
        graph_density: 0,
      },
    },
    can_proceed_to_truth: false,
  };
  const pipelineCandidates = visibleCandidates.map((candidate) => ({
    candidate,
    memories: hydrateCandidateMemories(candidate, normalizedMemories),
    contract: buildPipelineContract({
      authorId: safeAuthorId,
      candidate,
      narrativeGraphIntelligence,
    }),
  }));

  // GO LIVE 008.4 — Story Discovery Recovery
  // A descoberta não materializa manuscrito e não chama Story Generation/GEE.
  // O Story Lifecycle persiste os Candidates descobertos; a geração editorial
  // ocorre somente depois, no fluxo explícito de Revisar História, utilizando
  // selected_memory_ids escolhidos pelo autor.
  const generatedStories = [];
  const materializedStories = [];

  const publicHypotheses = hypotheses.slice(0, maxVisible).map(normalizeHypothesisForPublicContract);
  const discoveredNarrativeFamilies = [...new Set(publicHypotheses
    .map((hypothesis) => {
      const code = String(hypothesis?.code || "").toUpperCase();
      if (code.startsWith("HDUD")) return "hdud";
      if (code.startsWith("RELATIONSHIP")) return "relationships";
      if (code.startsWith("EDUCATION")) return "education";
      if (code.startsWith("PATERNITY") || code.startsWith("FATHERHOOD")) return "paternity";
      if (code.startsWith("MATERNITY")) return "maternity";
      if (code.startsWith("CHILDHOOD")) return "childhood";
      if (code.startsWith("FAMILY")) return "family";
      return code.toLowerCase() || null;
    })
    .filter(Boolean))];

  const seedDiagnostics = visibleCandidates.map((candidate) => ({
    story_id: candidate.story_id || candidate.candidate_id || null,
    title: candidate.title,
    question: candidate.central_question || candidate.story_blueprint?.central_question || null,
    phase_id: candidate.phase_id ?? candidate.story_blueprint?.phase_id ?? null,
    phase_name: candidate.phase_name ?? candidate.story_blueprint?.phase_name ?? null,
    foundation_memory_id: candidate.foundation_memory_id ?? candidate.story_blueprint?.beginning?.memory_id ?? null,
    narrative_hypothesis: candidate.narrative_hypothesis || null,
    narrative_potential: candidate.narrative_potential || candidate.story_blueprint?.narrative_potential || [],
    editorial_affinity_score: candidate.editorial_affinity_score ?? null,
    editorial_affinity: candidate.editorial_affinity || null,
    false_positive_risk: Boolean(candidate.false_positive_risk),
    used_memories: candidate.memories || [],
    discarded_memories: candidate.discarded_memories || [],
  }));

  const truthSummary = buildDiscoveryTruthSummary(candidates);
  const affinityScores = candidates
    .map((candidate) => Number(candidate.editorial_affinity_score))
    .filter((score) => Number.isFinite(score));
  const editorialAffinitySummary = {
    applied: true,
    scored_candidates: affinityScores.length,
    average_score: affinityScores.length
      ? Math.round(affinityScores.reduce((sum, score) => sum + score, 0) / affinityScores.length)
      : null,
    false_positive_count: candidates.filter((candidate) => candidate.false_positive_risk).length,
    policy: "Nenhuma dimensão editorial isolada decide uma história.",
  };

  return {
    ok: true,
    engine: ENGINE_VERSION,
    version: ENGINE_VERSION,
    author_id: safeAuthorId,

    // Sprint 1 — saída explícita do GO LIVE 006
    story_discovery: publicHypotheses,
    hypotheses: publicHypotheses,

    // Compatibilidade com runtime existente
    candidates,
    blueprints,
    narrative_arcs: narrativeArcs,
    validated_arcs: validatedArcs,
    narrative_graph_intelligence: narrativeGraphIntelligence,
    life_journey_graph: narrativeGraphIntelligence?.life_journey_graph || null,
    seed_diagnostics: seedDiagnostics,
    visible_candidates: visibleCandidates,
    stories: visibleCandidates,
    story_generation_results: generatedStories,
    pipeline_contracts: pipelineCandidates.map((item) => item.contract),
    pipeline_contract_summary: {
      contract_version: "GO_LIVE_006_4_3_CHAT_09",
      expected_count: pipelineCandidates.length,
      valid_count: pipelineCandidates.filter((item) =>
        item.contract?.contract_version === "GO_LIVE_006_4_3_CHAT_09"
        && item.contract?.blueprint
        && item.contract?.narrative_arc
        && item.contract?.narrative_path_validation
        && item.contract?.eligibility
      ).length,
      all_valid: pipelineCandidates.length > 0 && pipelineCandidates.every((item) =>
        item.contract?.contract_version === "GO_LIVE_006_4_3_CHAT_09"
        && item.contract?.blueprint
        && item.contract?.narrative_arc
        && item.contract?.narrative_path_validation
        && item.contract?.eligibility
      ),
    },
    discovered_narrative_families: discoveredNarrativeFamilies,
    truth_summary: truthSummary,
    editorial_affinity_summary: editorialAffinitySummary,
    narrative_path_summary: sourceNarrativePaths,
    story_calibration: calibrationSummary,
    meta: {
      generated_at: new Date().toISOString(),
      input_memories: providedMemories.length,
      db_memories: providedMemories.length ? 0 : normalizedMemories.length,
      source: providedMemories.length ? "input" : "database",
      hypothesis_count: hypotheses.length,
      seed_count: seeds.length,
      candidate_count: candidates.length,
      visible_count: visibleCandidates.length,
      materialized_story_count: 0,
      skipped_story_count: 0,
      hidden_count: Math.max(0, candidates.length - visibleCandidates.length),
      max_visible: maxVisible,
      source_policy: "GO LIVE 006: Descoberta de histórias humanas antes de Blueprint, escrita, Truth final e publicação.",
      discovery_policy: "Narrative Path gera hipóteses independentes por família. Seeds e Candidates apenas preservam esses limites.",
      truth_policy: "blueprint → truth_score → KEEP/OPTIONAL/DROP. Apenas memórias KEEP chegam à IA Editorial.",
      truth_summary: truthSummary,
      editorial_affinity_summary: editorialAffinitySummary,
      narrative_path_summary: sourceNarrativePaths,
      story_calibration_summary: {
        ...calibrationSummary,
        discovered_families: discoveredNarrativeFamilies,
      },
      discovered_narrative_families: discoveredNarrativeFamilies,
      narrative_arc_summary: {
        generated_count: narrativeArcs.length,
        validated_count: validatedArcs.length,
        complete_count: narrativeArcs.filter((arc) => arc.completion?.complete).length,
        with_gaps_count: narrativeArcs.filter((arc) => !arc.completion?.complete).length,
        average_completion_score: narrativeArcs.length
          ? Math.round(narrativeArcs.reduce((sum, arc) => sum + Number(arc.completion?.completion_score || 0), 0) / narrativeArcs.length)
          : 0,
      },
      narrative_graph_summary: {
        status: narrativeGraphIntelligence?.status || "EMPTY_GRAPH",
        source_arc_count: narrativeGraphIntelligence?.runtime?.source_arc_count || 0,
        link_count: safeArray(narrativeGraphIntelligence?.arc_links).length,
        family_count: safeArray(narrativeGraphIntelligence?.narrative_families).length,
        central_arc_id: narrativeGraphIntelligence?.central_arc_id || null,
        connected_node_count: narrativeGraphIntelligence?.life_journey_graph?.statistics?.connected_node_count || 0,
        graph_density: narrativeGraphIntelligence?.life_journey_graph?.statistics?.graph_density || 0,
        can_proceed_to_truth: Boolean(narrativeGraphIntelligence?.can_proceed_to_truth),
      },
      ntg: { available: ntgGraph.available, edge_count: ntgGraph.edge_count || 0, engine: ntgGraph.engine },
      affinity_policy: "Narrative Path completo e relações NTG são o critério principal; embeddings são apenas complemento de 22%.",
      seed_strategy: "narrative_family → story_hypothesis → compatibility_seed → story_calibration → candidate_blueprint",
      activation_policy: "Hipótese auditada deve produzir Candidate/Blueprint quando houver ao menos duas evidências semânticas diretas; densidade isolada nunca autoriza inclusão.",
      final_integration: {
        contract_version: "GO_LIVE_006_4_3_CHAT_09",
        generate_stories: false,
        pipeline_contract_count: pipelineCandidates.length,
        materialized_story_count: 0,
        skipped_story_count: 0,
        discovery_persistence_ready: visibleCandidates.length > 0,
        fully_integrated: pipelineCandidates.length > 0,
      },
    },
  };
}

export const StoryDiscoveryOrchestrator = {
  discoverStoryHypothesesForAuthor,
  buildStoryHypothesisFromCluster,
};
