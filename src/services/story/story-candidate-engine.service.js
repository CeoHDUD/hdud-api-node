// C:\HDUD_DATA\hdud-api-node\src\services\story\story-candidate-engine.service.js
//
// GO LIVE 006 — Story Candidate Engine Compatibility
// Responsabilidade: transformar Story Hypothesis Seeds em Story Blueprints limpos,
// mantendo Truth Engine antes de qualquer geração textual.

import {
  compareMemoryDate,
  memoryCanonicalDate,
  memoryIdOf,
  measureContinuity,
  safeYear,
} from "./story-continuity.service.js";
import { calculateStoryConfidence, isDisplayCandidate } from "./story-confidence.service.js";
import { selectTruthfulMemories } from "./story-truth-engine.service.js";
import { extractNarrativePath, summarizeNarrativePaths, validateNarrativePathSequence } from "./story-narrative-path.service.js";
import { attachNarrativeArc } from "./narrative-arc-engine.service.js";
import { calibrateStorySeeds } from "./story-calibration-engine.service.js";

const ENGINE_VERSION = "story-candidate-engine-v6.4.3-story-calibration-v2";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : fallback;
}


function normalizeEditorialToken(value) {
  return safeText(value, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function firstEditorialValue(memory = {}, keys = []) {
  for (const key of keys) {
    const value = memory?.[key] ?? memory?.editorial?.[key] ?? memory?.taxonomy?.[key];
    if (value !== undefined && value !== null && safeText(value, "")) return value;
  }
  return null;
}

function editorialProfileOf(memory = {}) {
  return {
    life_period: normalizeEditorialToken(firstEditorialValue(memory, ["life_period_code", "life_period", "period_code", "period"])),
    context: normalizeEditorialToken(firstEditorialValue(memory, ["context_code", "editorial_context_code", "editorial_context", "context"])),
    narrative_role: normalizeEditorialToken(firstEditorialValue(memory, ["narrative_role_code", "narrative_role", "story_role"])),
    interpretation: normalizeEditorialToken(firstEditorialValue(memory, ["canonical_story_key", "narrative_arc_code", "editorial_interpretation", "interpretation", "canonical_story_title"])),
    taxonomy: normalizeEditorialToken(firstEditorialValue(memory, ["taxonomy_code", "taxonomy", "taxonomy_key", "domain_code"])),
  };
}

function dominantValue(values = []) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || [null, 0];
}

function dimensionCohesion(profiles = [], key) {
  const values = profiles.map((profile) => profile[key]).filter(Boolean);
  if (!values.length) return { available: false, score: 0, dominant: null, agreement: 0, distinct: 0 };
  const [dominant, count] = dominantValue(values);
  const agreement = count / values.length;
  return {
    available: true,
    score: clampScore(agreement * 100),
    dominant,
    agreement: Number(agreement.toFixed(4)),
    distinct: new Set(values).size,
  };
}

function calculateEditorialAffinity(memories = []) {
  const profiles = safeArray(memories).map(editorialProfileOf);
  const dimensions = {
    life_period: dimensionCohesion(profiles, "life_period"),
    context: dimensionCohesion(profiles, "context"),
    narrative_role: dimensionCohesion(profiles, "narrative_role"),
    interpretation: dimensionCohesion(profiles, "interpretation"),
    taxonomy: dimensionCohesion(profiles, "taxonomy"),
  };

  const weights = { life_period: 0.18, context: 0.24, narrative_role: 0.16, interpretation: 0.27, taxonomy: 0.15 };
  const available = Object.entries(dimensions).filter(([, dimension]) => dimension.available);
  const availableWeight = available.reduce((sum, [key]) => sum + weights[key], 0);
  const weighted = availableWeight
    ? available.reduce((sum, [key, dimension]) => sum + dimension.score * weights[key], 0) / availableWeight
    : 0;

  const matchedDimensions = available.filter(([, dimension]) => dimension.agreement >= 0.67).map(([key]) => key);
  const conflictingDimensions = available.filter(([, dimension]) => dimension.distinct > Math.ceil(memories.length / 2) && dimension.agreement < 0.5).map(([key]) => key);
  const coverage = profiles.length
    ? available.reduce((sum, [, dimension]) => sum + (dimension.available ? 1 : 0), 0) / Object.keys(dimensions).length
    : 0;

  // Nenhuma dimensão isolada autoriza uma história. Com metadados suficientes,
  // são necessários pelo menos dois sinais editoriais convergentes.
  const multidimensional = available.length < 2 || matchedDimensions.length >= 2;
  const conflictPenalty = conflictingDimensions.length * 12;
  const coverageAdjustment = available.length ? (coverage * 10 - 5) : 0;
  const score = available.length ? clampScore(weighted + coverageAdjustment - conflictPenalty) : null;
  const falsePositiveRisk =
    coverage >= 0.6 &&
    available.length >= 2 &&
    (conflictingDimensions.length >= 2 || (!multidimensional && Number(score || 0) < 35));

  return {
    engine: "editorial-affinity-v1.0",
    score,
    available_dimensions: available.map(([key]) => key),
    matched_dimensions: matchedDimensions,
    conflicting_dimensions: conflictingDimensions,
    multidimensional,
    false_positive_risk: falsePositiveRisk,
    metadata_coverage: Number(coverage.toFixed(4)),
    dimensions,
    policy: "Nenhuma dimensão editorial isolada decide uma história.",
  };
}

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeRiskFromScore(score) {
  const safeScore = clampScore(score);
  if (safeScore >= 90) return "VERY_LOW";
  if (safeScore >= 75) return "LOW";
  if (safeScore >= 55) return "MEDIUM";
  return "HIGH";
}

function normalizeQualityFromScore(score) {
  const safeScore = clampScore(score);
  if (safeScore >= 85) return "HIGH";
  if (safeScore >= 65) return "MEDIUM";
  if (safeScore >= 40) return "LOW";
  return "NONE";
}

function normalizeTitleToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function humanizeToken(value) {
  const text = String(value || "").replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "História em descoberta";
}

function normalizeKnowledgeGraphContext(seed = {}) {
  const graphSignals = safeArray(seed.knowledge_graph_signals || seed.graph_signals || seed.signals_from_graph);
  const nodes = safeArray(seed.knowledge_nodes || seed.nodes);
  const edges = safeArray(seed.knowledge_edges || seed.edges);

  return {
    available: Boolean(graphSignals.length || nodes.length || edges.length),
    signal_count: graphSignals.length,
    node_count: nodes.length,
    edge_count: edges.length,
    signals: graphSignals,
    nodes,
    edges,
  };
}


function hypothesisOf(seed = {}) {
  return seed?.narrative_hypothesis || seed?.hypothesis || null;
}

function bestNarrativePotential(seed = {}) {
  return [...safeArray(seed.narrative_potential)]
    .sort((a, b) => Number(b?.narrative_score || 0) - Number(a?.narrative_score || 0))[0] || null;
}

function phaseLabelOf(seed = {}) {
  const label = safeText(seed?.phase_name, "");
  return label && label !== "Sem fase" ? label : null;
}

function memoryTitleById(memories = [], memoryId) {
  const found = safeArray(memories).find((memory) => Number(memoryIdOf(memory)) === Number(memoryId));
  return safeText(found?.title || found?.memory_title, null);
}

function cleanTitle(value) {
  return safeText(value, "")
    .replace(/^uma história sobre\s+/i, "")
    .replace(/^história sobre\s+/i, "")
    .replace(/^fase\s+/i, "")
    .replace(/[.。]+$/g, "")
    .trim();
}

function toNarrativeTitle(value, fallback = "História em descoberta") {
  const cleaned = cleanTitle(value);
  if (!cleaned) return fallback;
  if (cleaned.length <= 72) return cleaned;
  return `${cleaned.slice(0, 69).trim()}...`;
}

function extractContextLabels(continuity = {}) {
  return safeArray(continuity?.contexts).slice(0, 5).map(humanizeToken);
}

function extractCharacterLabels(continuity = {}) {
  return safeArray(continuity?.characters).slice(0, 5).map(humanizeToken);
}

function chooseTitle({ continuity, memories, seed = {} }) {
  const hypothesis = hypothesisOf(seed);
  if (hypothesis?.title) return toNarrativeTitle(hypothesis.title);

  const phaseLabel = phaseLabelOf(seed);
  const bestPotential = bestNarrativePotential(seed);
  const foundationTitle = memoryTitleById(memories, seed.foundation_memory_id || bestPotential?.memory_id);
  const contexts = safeArray(continuity?.contexts);
  const characters = safeArray(continuity?.characters);

  if (phaseLabel && Number(bestPotential?.narrative_score || 0) >= 70) return toNarrativeTitle(phaseLabel);
  if (foundationTitle && Number(bestPotential?.narrative_score || 0) >= 78) return toNarrativeTitle(foundationTitle);

  if (characters.includes("bruna") && contexts.includes("familia")) return "Uma vida compartilhada";
  if (characters.includes("bruna")) return "O encontro que virou parceria";
  if (characters.includes("felipe") || characters.includes("zezo")) return "O que aprendi sendo pai";
  if (contexts.includes("trabalho") || contexts.includes("carreira") || contexts.includes("dba") || contexts.includes("sql")) return "A construção de uma profissão";
  if (contexts.includes("hospital") || contexts.includes("cirurgia") || contexts.includes("recuperacao")) return "Depois da dor";
  if (contexts.includes("hdud")) return "Por que a HDUD nasceu";

  const firstContext = contexts[0];
  if (firstContext) return humanizeToken(firstContext);

  const first = safeArray(memories)[0];
  return first?.title ? toNarrativeTitle(first.title) : "Uma história começando a aparecer";
}

function buildCentralQuestion({ title, continuity, memories, seed = {} }) {
  const hypothesis = hypothesisOf(seed);
  if (hypothesis?.central_question) return hypothesis.central_question;

  const phaseLabel = phaseLabelOf(seed);
  const bestPotential = bestNarrativePotential(seed);
  const contexts = safeArray(continuity?.contexts);
  const characters = safeArray(continuity?.characters);
  const normalizedTitle = normalizeTitleToken(title);
  const joined = `${normalizedTitle} ${contexts.join(" ")} ${characters.join(" ")}`;

  if (phaseLabel && Number(bestPotential?.narrative_score || 0) >= 70) return `Que transformação nasceu em ${phaseLabel}?`;
  if (characters.includes("bruna")) return "Como essa relação transformou minha vida?";
  if (contexts.includes("hdud") || joined.includes("hdud")) return "Por que criei a HDUD?";
  if (contexts.includes("hospital") || contexts.includes("cirurgia") || contexts.includes("recuperacao")) return "Como a dor mudou minha forma de viver?";
  if (contexts.includes("trabalho") || contexts.includes("carreira") || contexts.includes("dba") || contexts.includes("sql")) return "Quando minha profissão passou a fazer parte da minha identidade?";
  if (characters.includes("felipe") || characters.includes("zezo")) return "O que aprendi sendo pai?";
  if (contexts.includes("familia")) return "Como minha família ajudou a formar quem eu sou?";

  const first = safeArray(memories)[0];
  if (first?.title) return `Que transformação existe por trás de ${cleanTitle(first.title)}?`;
  return "Que transformação estas memórias estão tentando revelar?";
}

function buildTransformation({ continuity, memories, seed = {} }) {
  const hypothesis = hypothesisOf(seed);
  if (hypothesis?.transformation) return hypothesis.transformation;

  const phaseLabel = phaseLabelOf(seed);
  const bestPotential = bestNarrativePotential(seed);
  const contexts = safeArray(continuity?.contexts);
  const characters = safeArray(continuity?.characters);

  if (phaseLabel && Number(bestPotential?.narrative_score || 0) >= 70) return `De lembranças dispersas em ${phaseLabel} para uma mudança humana reconhecível.`;
  if (contexts.includes("hospital") || contexts.includes("cirurgia") || contexts.includes("recuperacao")) return "Da ruptura física e emocional para uma nova compreensão da própria força.";
  if (contexts.includes("hdud")) return "Da inquietação íntima para a criação de uma plataforma de legado.";
  if (contexts.includes("trabalho") || contexts.includes("carreira") || contexts.includes("dba") || contexts.includes("sql")) return "Da experiência acumulada para a consciência de uma identidade profissional.";
  if (characters.includes("bruna")) return "Do encontro para a construção de uma vida compartilhada.";
  if (safeArray(memories).length >= 3) return "De fatos separados para uma transformação humana reconhecível.";
  return "Uma transformação ainda emergente entre as memórias selecionadas.";
}

function buildDiscoveryRationale({ continuity, seed = {} }) {
  const hypothesis = hypothesisOf(seed);
  if (hypothesis?.title) return `A hipótese narrativa "${hypothesis.title}" foi escolhida por reunir pergunta humana, transformação e evidências dentro da fase.`;

  const phaseLabel = phaseLabelOf(seed);
  const potentials = safeArray(seed.narrative_potential);
  const bestPotential = bestNarrativePotential(seed);

  if (phaseLabel && potentials.length) {
    return `Dentro da fase ${phaseLabel}, priorizamos memórias com maior potencial narrativo antes de montar o Blueprint.`;
  }

  if (bestPotential) {
    return "A seleção foi guiada pela memória com maior força narrativa e pelas conexões mais consistentes ao redor dela.";
  }

  if (safeArray(continuity?.reasons).length) {
    return `Observamos ${continuity.reasons.join("; ")}. Esses sinais indicam uma história maior em formação.`;
  }

  return "Observamos memórias que parecem se responder ao longo do tempo, com continuidade suficiente para leitura editorial.";
}

function buildPeriodLabel(memories = []) {
  const years = safeArray(memories)
    .map((memory) => safeYear(memoryCanonicalDate(memory)))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (years.length > 1 && years[0] !== years[years.length - 1]) return `${years[0]}–${years[years.length - 1]}`;
  return years[0] ? String(years[0]) : "período ainda em descoberta";
}

function buildOverview({ title, continuity, memories, seed = {} }) {
  const characters = extractCharacterLabels(continuity);
  const contexts = extractContextLabels(continuity);
  const phaseLabel = phaseLabelOf(seed);

  return {
    suggested_title: title,
    central_theme: phaseLabel || contexts[0] || characters[0] || "Continuidade narrativa",
    transformation: buildTransformation({ continuity, memories, seed }),
    characters,
    contexts,
    phase_id: seed?.phase_id ?? null,
    phase_name: seed?.phase_name ?? null,
    period: buildPeriodLabel(memories),
    why_found: buildDiscoveryRationale({ continuity, seed }),
  };
}

function buildTimeline(memories) {
  return safeArray(memories).sort(compareMemoryDate).map((memory, index) => ({
    position: index + 1,
    memory_id: memoryIdOf(memory),
    title: memory?.title || `Memória ${memoryIdOf(memory)}`,
    date: memoryCanonicalDate(memory),
    year: safeYear(memoryCanonicalDate(memory)),
    role: index === 0 ? "origem" : (index === memories.length - 1 ? "consequência" : "continuidade"),
  }));
}

function memorySummary(memory) {
  return {
    memory_id: memoryIdOf(memory),
    title: memory?.title || `Memória ${memoryIdOf(memory)}`,
    memory_date: memoryCanonicalDate(memory),
    phase_id: memory?.phase_id ?? null,
    life_period_code: memory?.life_period_code ?? memory?.editorial?.life_period_code ?? null,
    context_code: memory?.context_code ?? memory?.editorial?.context_code ?? null,
    narrative_role_code: memory?.narrative_role_code ?? memory?.editorial?.narrative_role_code ?? null,
    narrative_arc_code: memory?.narrative_arc_code ?? memory?.editorial?.narrative_arc_code ?? null,
    canonical_story_key: memory?.canonical_story_key ?? memory?.editorial?.canonical_story_key ?? null,
    canonical_story_title: memory?.canonical_story_title ?? memory?.editorial?.canonical_story_title ?? null,
    editorial_notes: memory?.editorial_notes ?? memory?.editorial?.editorial_notes ?? null,
    taxonomy_code: memory?.taxonomy_code ?? memory?.editorial?.taxonomy_code ?? null,
    truth_score: memory?.truth_score ?? memory?.evidence?.truth_score ?? null,
    truth_decision: memory?.truth_decision ?? memory?.evidence?.decision ?? null,
    evidence_quality: memory?.evidence_quality ?? memory?.evidence?.evidence_quality ?? null,
    hallucination_risk: memory?.hallucination_risk ?? memory?.evidence?.hallucination_risk ?? null,
    narrative_path: extractNarrativePath(memory),
  };
}

function buildMissingMemories({ continuity, memories, truthScore, seed = {} }) {
  const contexts = safeArray(continuity?.contexts);
  const missing = [];

  if (safeArray(memories).length < 3) {
    missing.push({ code: "MORE_MEMORIES", label: "mais memórias", reason: "A história ainda precisa de mais evidências para ganhar corpo." });
  }

  if (!phaseLabelOf(seed) && !contexts.includes("familia")) {
    missing.push({ code: "CONTEXT", label: "contexto", reason: "Pode faltar contexto de vida para entender a força dessa história." });
  }

  if (!contexts.includes("consequencia") && safeArray(memories).length < 5) {
    missing.push({ code: "CONSEQUENCES", label: "consequências", reason: "Ainda não está claro o que mudou depois dos acontecimentos." });
  }

  if (Number(truthScore || 0) < 70) {
    missing.push({ code: "EVIDENCE", label: "evidências narrativas", reason: "A aderência das memórias ainda é frágil para uma materialização segura." });
  }

  return missing.slice(0, 5);
}

function buildStoryBlueprint({ candidate, continuity, memories, discardedMemories = [], optionalMemories = [], truthScore, seed = {}, ntgGraph = null }) {
  const used = safeArray(memories).map(memorySummary).filter((memory) => memory.memory_id);
  const discarded = safeArray(discardedMemories).map(memorySummary).filter((memory) => memory.memory_id);
  const optional = safeArray(optionalMemories).map(memorySummary).filter((memory) => memory.memory_id);
  const title = candidate?.title || "História em descoberta";
  const centralQuestion = buildCentralQuestion({ title, continuity, memories, seed });
  const transformation = buildTransformation({ continuity, memories, seed });
  const missingMemories = buildMissingMemories({ continuity, memories, truthScore, seed });
  const pathValidation = validateNarrativePathSequence(memories, ntgGraph, { semanticScore: candidate?.semantic_precision_score });
  if (!pathValidation.complete_enough) missingMemories.push({ code: "NARRATIVE_PATH", label: "caminho narrativo completo", reason: "São necessários Life Period, Editorial Context e Narrative Role em pelo menos duas memórias." });
  if (pathValidation.blocking_incompatibility) missingMemories.push({ code: "NTG_INCOMPATIBLE", label: "compatibilidade NTG", reason: "O NTG identificou relação INCOMPATIBLE_WITH entre memórias do candidato." });
  const canMaterialize = used.length >= 2 && pathValidation.coherent && !missingMemories.some((item) => ["EVIDENCE", "NTG_INCOMPATIBLE"].includes(item.code));

  return {
    type: "STORY_BLUEPRINT",
    status: canMaterialize ? "READY_FOR_AUTHOR_REVIEW" : "NEEDS_MORE_MEMORIES",
    title,
    provisional_title: title,
    central_question: centralQuestion,
    transformation,
    beginning: used[0]
      ? { memory_id: used[0].memory_id, title: used[0].title, role: "início" }
      : null,
    conflict: used.length >= 2
      ? { memory_id: used[Math.floor((used.length - 1) / 2)].memory_id, title: used[Math.floor((used.length - 1) / 2)].title, role: "conflito" }
      : null,
    turning_point: used.length >= 3
      ? { memory_id: used[Math.floor(used.length / 2)].memory_id, title: used[Math.floor(used.length / 2)].title, role: "virada" }
      : null,
    resolution: used.length >= 2
      ? { memory_id: used[used.length - 1].memory_id, title: used[used.length - 1].title, role: "resolução" }
      : null,
    used_memories: used,
    discarded_memories: discarded,
    optional_memories: optional,
    missing_memories: missingMemories,
    confidence: clampScore(candidate?.confidence ?? truthScore ?? 0),
    truth_score: clampScore(truthScore ?? candidate?.truth_score ?? 0),
    maturity: canMaterialize ? "STORY_CAN_BE_WRITTEN" : "STORY_STILL_WEAK",
    author_decision_required: true,
    phase_id: seed?.phase_id ?? null,
    phase_name: seed?.phase_name ?? null,
    narrative_hypothesis: hypothesisOf(seed),
    narrative_potential: safeArray(seed?.narrative_potential),
    narrative_paths: pathValidation.paths,
    narrative_path_keys: pathValidation.path_keys,
    narrative_path_validation: pathValidation,
    graph_narrative_score: pathValidation.average_graph_score,
    hybrid_narrative_score: pathValidation.average_hybrid_score,
    seed_diagnostics: seed?.seed_diagnostics || null,
    source_policy: "Blueprint primeiro. A História só deve ser escrita depois da aprovação do autor.",
  };
}

function semanticStrengthOf(seed = {}) {
  const potentials = safeArray(seed.narrative_potential);
  const strong = potentials.filter((item) =>
    Boolean(item?.direct_semantic_match) ||
    safeArray(item?.signal_types).length > 0 ||
    Number(item?.narrative_score || 0) >= 70
  );
  if (!strong.length) return 0;
  return clampScore(strong.reduce((sum, item) => sum + Number(item?.narrative_score || 0), 0) / strong.length);
}

function deterministicHypothesisFallback(candidate, seedMemories = []) {
  const potentialById = new Map(
    safeArray(candidate?.narrative_potential)
      .map((item) => [Number(item?.memory_id), item])
      .filter(([id]) => Number.isInteger(id) && id > 0)
  );

  const ranked = safeArray(seedMemories)
    .map((memory) => ({ memory, potential: potentialById.get(Number(memoryIdOf(memory))) || null }))
    .filter(({ potential }) => potential)
    .filter(({ potential }) =>
      Number(potential?.narrative_score || 0) >= 52 &&
      (Boolean(potential?.direct_semantic_match) || safeArray(potential?.signal_types).length > 0)
    )
    .sort((a, b) => Number(b.potential?.narrative_score || 0) - Number(a.potential?.narrative_score || 0));

  const keep = ranked.slice(0, 8).map(({ memory }) => memory).sort(compareMemoryDate);
  return keep.length >= 2 ? keep : [];
}


function deterministicNarrativeGraphFallback(candidate, seedMemories = []) {
  const validation = candidate?.narrative_path_validation || candidate?.narrative_compatibility || null;
  const coreIds = new Set(safeArray(validation?.narrative_core_memory_ids).map(Number));
  if (coreIds.size < 2) return [];

  const selected = safeArray(seedMemories)
    .filter((memory) => coreIds.has(Number(memoryIdOf(memory))))
    .filter((memory) => extractNarrativePath(memory).complete)
    .sort(compareMemoryDate);

  return selected.length >= 2 ? selected : [];
}

function buildCandidateBase({ authorId, seed, index, ntgGraph = null }) {
  const memories = safeArray(seed.memories).filter((memory) => memoryIdOf(memory)).sort(compareMemoryDate);
  const signals = safeArray(seed.signals);
  const continuity = measureContinuity(signals);
  const knowledgeGraphContext = normalizeKnowledgeGraphContext(seed);
  const years = memories.map((memory) => safeYear(memoryCanonicalDate(memory))).filter(Boolean).sort((a, b) => a - b);
  const title = chooseTitle({ continuity, memories, seed });
  const editorialAffinity = calculateEditorialAffinity(memories);
  const narrativeCompatibility = summarizeNarrativePaths(memories, ntgGraph, { semanticScore: semanticStrengthOf(seed) });
  const baseConfidence = calculateStoryConfidence({
    memoryCount: memories.length,
    continuity,
    hasTimeSpan: years.length > 1 && years[0] !== years[years.length - 1],
  });
  const hypothesis = hypothesisOf(seed);
  const hypothesisConfidence = clampScore(hypothesis?.story_score ?? baseConfidence.confidence);
  const semanticEditorialScore = editorialAffinity.score === null
    ? hypothesisConfidence
    : clampScore((hypothesisConfidence * 0.72) + (editorialAffinity.score * 0.28));
  const affinityAdjustedConfidence = narrativeCompatibility.compatible_pair_count
    ? clampScore((narrativeCompatibility.sequence_graph_score * 0.78) + (semanticEditorialScore * 0.22))
    : clampScore(semanticEditorialScore * 0.45);
  const confidence = {
    ...baseConfidence,
    confidence: affinityAdjustedConfidence,
  };

  const relatedMemories = memories.map(memoryIdOf).filter(Boolean);
  const titleToken = normalizeTitleToken(title || `candidate_${index + 1}`);

  const semanticStrength = semanticStrengthOf(seed);

  const blueprint = buildStoryBlueprint({
    candidate: { title, confidence: confidence.confidence },
    continuity,
    memories,
    discardedMemories: [],
    optionalMemories: [],
    truthScore: confidence.confidence,
    seed,
    ntgGraph,
  });

  return {
    candidate_id: `candidate_${authorId}_${titleToken}_${relatedMemories.join("_")}`,
    author_id: authorId,
    status: "CANDIDATE",
    title,
    suggested_title: title,
    story_state: "STORY_BLUEPRINT",
    phase_id: seed?.phase_id ?? null,
    phase_name: seed?.phase_name ?? null,
    narrative_hypothesis: hypothesisOf(seed),
    narrative_potential: safeArray(seed?.narrative_potential),
    narrative_paths: blueprint.narrative_paths,
    narrative_path_keys: blueprint.narrative_path_keys,
    narrative_path_validation: blueprint.narrative_path_validation,
    graph_narrative_score: blueprint.graph_narrative_score,
    hybrid_narrative_score: blueprint.hybrid_narrative_score,
    seed_diagnostics: seed?.seed_diagnostics || null,
    foundation_memory_id: seed?.foundation_memory_id ?? null,
    story_blueprint: blueprint,
    blueprint,
    central_question: blueprint.central_question,
    transformation: blueprint.transformation,
    missing_memories: blueprint.missing_memories,
    confidence: confidence.confidence,
    maturity_code: confidence.maturity_code,
    maturity_label: confidence.maturity_label,
    maturity_description: confidence.maturity_description,
    memory_count: relatedMemories.length,
    related_memories: relatedMemories,
    relatedMemories,
    memories: memories.map(memorySummary),
    first_year: years[0] || null,
    last_year: years[years.length - 1] || null,
    timeline: buildTimeline(memories),
    overview: buildOverview({ title, continuity, memories, seed }),
    continuity,
    knowledge_graph: knowledgeGraphContext,
    editorial_affinity_score: editorialAffinity.score,
    editorial_affinity: editorialAffinity,
    false_positive_risk: editorialAffinity.false_positive_risk,
    semantic_precision_score: semanticStrength,
    narrative_compatibility: narrativeCompatibility,
    ntg_incompatible: narrativeCompatibility.incompatible_pair_count > 0,
    editorial_intent: "Blueprint antes de escrita. O título nomeia a história; a explicação fica no overview e nos diagnósticos.",
    engine: ENGINE_VERSION,
    generated_at: new Date().toISOString(),
  };
}

function applyTruthSelection(candidate, seedMemories, { truthThreshold, ntgGraph = null } = {}) {
  const selection = selectTruthfulMemories({
    candidate,
    memories: seedMemories,
    threshold: truthThreshold,
  });

  let usedMemories = safeArray(selection.used_memories || selection.selected || []);
  let discardedMemories = safeArray(selection.discarded_memories || selection.discarded || []);
  let optionalMemories = safeArray(selection.optional_memories || selection.optional || []);
  let fallbackApplied = false;

  // O Truth Engine continua soberano. Quando ele não consegue classificar por falta
  // de metadados legados, ativamos somente evidências diretas já auditadas pela
  // hipótese (termo/sinal compatível + score mínimo). Nunca usamos densidade isolada.
  if (usedMemories.length < 2) {
    // Primeiro respeita a cadeia narrativa construída pelo autor no NTG.
    // A semântica só entra se o grafo ainda não formar um núcleo com duas memórias.
    const graphFallback = deterministicNarrativeGraphFallback(candidate, seedMemories);
    const fallbackKeep = graphFallback.length >= 2
      ? graphFallback
      : deterministicHypothesisFallback(candidate, seedMemories);

    if (fallbackKeep.length >= 2) {
      const keepIds = new Set(fallbackKeep.map(memoryIdOf).map(Number));
      usedMemories = fallbackKeep;
      optionalMemories = safeArray(seedMemories).filter((memory) => {
        const id = Number(memoryIdOf(memory));
        return !keepIds.has(id) && extractNarrativePath(memory).complete;
      });
      discardedMemories = safeArray(seedMemories).filter((memory) => {
        const id = Number(memoryIdOf(memory));
        return !keepIds.has(id) && !extractNarrativePath(memory).complete;
      });
      fallbackApplied = true;
    }
  }
  const relatedMemories = usedMemories.map(memoryIdOf).filter(Boolean);
  const years = usedMemories.map((memory) => safeYear(memoryCanonicalDate(memory))).filter(Boolean).sort((a, b) => a - b);

  const averageTruthScore = clampScore(
    (fallbackApplied
      ? Math.max(
          Number(candidate?.narrative_path_validation?.sequence_graph_score || 0),
          Number(candidate?.graph_narrative_score || 0),
          Number(candidate?.semantic_precision_score || 0),
        )
      : null) ??
    selection.truth_report?.average_truth_score ??
    selection.truth_report?.truth_score ??
    selection.story_evidence_score?.truth_score ??
    candidate.confidence,
    0
  );

  const evidenceQuality =
    selection.story_evidence_score?.evidence_quality ||
    selection.truth_report?.evidence_quality ||
    normalizeQualityFromScore(averageTruthScore);

  const hallucinationRisk =
    selection.story_evidence_score?.hallucination_risk ||
    selection.truth_report?.hallucination_risk ||
    normalizeRiskFromScore(averageTruthScore);

  const editorialAffinity = calculateEditorialAffinity(usedMemories);

  const blueprint = buildStoryBlueprint({
    candidate,
    continuity: candidate.continuity,
    memories: usedMemories,
    discardedMemories,
    optionalMemories,
    truthScore: averageTruthScore,
    seed: candidate,
    ntgGraph,
  });

  const truthSelection = {
    engine: fallbackApplied ? "story-narrative-graph-truth-fallback-v2" : (selection.engine || "story-truth-engine"),
    threshold: selection.threshold ?? truthThreshold ?? null,
    selected: usedMemories.map(memorySummary),
    optional: optionalMemories.map(memorySummary),
    discarded: discardedMemories.map(memorySummary),
    statistics: {
      total: usedMemories.length + optionalMemories.length + discardedMemories.length,
      keep: usedMemories.length,
      optional: optionalMemories.length,
      drop: discardedMemories.length,
    },
    truth_report: selection.truth_report || null,
    story_evidence_score: selection.story_evidence_score || {
      truth_score: averageTruthScore,
      evidence_quality: evidenceQuality,
      hallucination_risk: hallucinationRisk,
    },
    fallback_applied: fallbackApplied,
    source_policy: fallbackApplied
      ? "Fallback determinístico priorizou o núcleo conectado do Narrative Path autoral; semântica foi usada apenas como contingência."
      : (selection.source_policy || "Story Candidate filtrada pelo Truth Memory Selection antes da IA Editorial."),
  };

  return {
    ...candidate,
    story_state: "STORY_BLUEPRINT",
    status: blueprint.status,
    story_blueprint: blueprint,
    blueprint,
    central_question: blueprint.central_question,
    transformation: blueprint.transformation,
    missing_memories: blueprint.missing_memories,
    memory_count: relatedMemories.length,
    related_memories: relatedMemories,
    relatedMemories,
    memories: usedMemories.map(memorySummary),
    discarded_memories: discardedMemories.map(memorySummary),
    optional_memories: optionalMemories.map(memorySummary),
    truth_selection: truthSelection,
    truth: {
      engine: truthSelection.engine,
      threshold: truthSelection.threshold,
      truth_report: truthSelection.truth_report,
      story_evidence_score: truthSelection.story_evidence_score,
      source_policy: truthSelection.source_policy,
      selection: truthSelection,
    },
    truth_score: averageTruthScore,
    evidence_quality: evidenceQuality,
    hallucination_risk: hallucinationRisk,
    editorial_affinity_score: editorialAffinity.score,
    editorial_affinity: editorialAffinity,
    false_positive_risk: editorialAffinity.false_positive_risk,
    first_year: years[0] || candidate.first_year || null,
    last_year: years[years.length - 1] || candidate.last_year || null,
    timeline: buildTimeline(usedMemories),
    editorial_intent: "Blueprint antes de escrita. A IA descobre a pergunta humana, separa memórias usadas e descartadas, e só depois permite materialização.",
    narrative_path_validation: blueprint.narrative_path_validation,
    graph_narrative_score: blueprint.graph_narrative_score,
    hybrid_narrative_score: blueprint.hybrid_narrative_score,
    auditability: {
      candidate_uses_only_keep_memories: true,
      dropped_memories_hidden_from_generation: true,
      evidence_required_before_editorial_runtime: true,
      blueprint_required_before_generation: true,
      ntg_primary_before_embeddings: true,
      incompatible_paths_block_generation: true,
    },
  };
}

export function buildStoryCandidatesFromSeeds({
  authorId,
  seeds = [],
  includeWeak = false,
  truthThreshold,
  enableTruthSelection = true,
  enableCalibration = true,
  calibrationBoundaryThreshold = 58,
  ntgGraph = null,
} = {}) {
  const safeAuthorId = Number(authorId);
  if (!Number.isInteger(safeAuthorId) || safeAuthorId <= 0) return [];

  const calibration = enableCalibration
    ? calibrateStorySeeds({
        seeds,
        authorId: safeAuthorId,
        boundaryThreshold: calibrationBoundaryThreshold,
      })
    : {
        calibrated_seeds: safeArray(seeds),
        diagnostics: [],
        statistics: {
          source_seed_count: safeArray(seeds).length,
          calibrated_seed_count: safeArray(seeds).length,
          multi_arc_ready: safeArray(seeds).length >= 2,
        },
      };

  return safeArray(calibration.calibrated_seeds)
    .map((seed, index) => {
      const seedMemories = safeArray(seed.memories).filter((memory) => memoryIdOf(memory)).sort(compareMemoryDate);
      const candidate = buildCandidateBase({ authorId: safeAuthorId, seed: { ...seed, memories: seedMemories }, index, ntgGraph });

      const finalizedCandidate = enableTruthSelection
        ? applyTruthSelection(candidate, seedMemories, { truthThreshold, ntgGraph })
        : candidate;
      return attachNarrativeArc({
        ...finalizedCandidate,
        calibration: seed.calibration || null,
        story_calibration: {
          engine: calibration.engine || "story-calibration-disabled",
          statistics: calibration.statistics || null,
          segment: seed.calibration || null,
        },
        arc_diversity_score: seed.calibration?.arc_diversity_score ?? null,
        candidate_independence_score: seed.calibration?.independence_score ?? null,
      });
    })
    .filter((candidate) => candidate.memory_count >= 2)
    .filter((candidate) => includeWeak || !candidate.ntg_incompatible)
    .filter((candidate) => includeWeak || !candidate.false_positive_risk || Number(candidate.semantic_precision_score || 0) >= 65)
    .filter((candidate) => includeWeak || isDisplayCandidate(candidate) || (
      candidate.memory_count >= 2 &&
      Number(candidate.truth_score || 0) >= 60 &&
      candidate.story_blueprint?.status === "READY_FOR_AUTHOR_REVIEW"
    ))
    .sort((a, b) =>
      Number(b.graph_narrative_score ?? 0) - Number(a.graph_narrative_score ?? 0) ||
      Number(b.truth_score ?? b.confidence ?? 0) - Number(a.truth_score ?? a.confidence ?? 0) ||
      Number(b.editorial_affinity_score ?? 0) - Number(a.editorial_affinity_score ?? 0) ||
      Number(b.memory_count || 0) - Number(a.memory_count || 0)
    );
}

export const StoryCandidateEngine = {
  buildStoryCandidatesFromSeeds,
};
