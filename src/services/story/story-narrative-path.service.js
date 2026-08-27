// C:\HDUD_DATA\hdud-api-node\src\services\story\story-narrative-path.service.js
//
// GO LIVE 006.4.3 — CHAT 05 — Narrative Path Compatibility
// Responsabilidade: transformar a taxonomia editorial de cada memória em caminho
// narrativo completo e calcular compatibilidade usando o NTG como fonte principal.

const ENGINE_VERSION = "story-narrative-path-v2.0-author-graph-chain";

const RELATION_EFFECT = Object.freeze({
  SAME_FAMILY: 0.88,
  ALLOWS: 0.92,
  TRANSITIONS_TO: 0.86,
  RECOMMENDS: 0.72,
  INCOMPATIBLE_WITH: -1,
});

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function normalizeCode(value) {
  const code = safeText(value, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  return code === "RELATIONSHIPS" ? "RELATIONSHIP" : code || null;
}

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function firstValue(memory = {}, keys = []) {
  for (const key of keys) {
    const value = memory?.[key] ?? memory?.editorial?.[key] ?? memory?.taxonomy?.[key] ?? memory?.narrative_path?.[key];
    if (value !== undefined && value !== null && safeText(value, "")) return value;
  }
  return null;
}

export function extractNarrativePath(memory = {}) {
  const lifePeriod = normalizeCode(firstValue(memory, ["life_period_code", "life_period", "period_code"]));
  const context = normalizeCode(firstValue(memory, ["context_code", "editorial_context_code", "editorial_context", "context"]));
  const narrativeRole = normalizeCode(firstValue(memory, ["narrative_role_code", "narrative_role", "story_role"]));

  const nodes = [
    lifePeriod ? { domain: "LIFE_PERIOD", code: lifePeriod } : null,
    context ? { domain: "EDITORIAL_CONTEXT", code: context } : null,
    narrativeRole ? { domain: "NARRATIVE_ROLE", code: narrativeRole } : null,
  ].filter(Boolean);

  return {
    life_period_code: lifePeriod,
    context_code: context,
    narrative_role_code: narrativeRole,
    nodes,
    key: nodes.map((node) => `${node.domain}:${node.code}`).join(" > ") || null,
    complete: Boolean(lifePeriod && context && narrativeRole),
    completeness_score: clampScore((nodes.length / 3) * 100),
  };
}

export function buildNarrativePathKey(memoryOrPath = {}) {
  const path = memoryOrPath?.nodes ? memoryOrPath : extractNarrativePath(memoryOrPath);
  return path.key || "UNCLASSIFIED";
}

function nodeKey(domain, code) {
  const d = normalizeCode(domain);
  const c = normalizeCode(code);
  return d && c ? `${d}:${c}` : null;
}

function edgeKey(sourceDomain, sourceCode, targetDomain, targetCode) {
  const source = nodeKey(sourceDomain, sourceCode);
  const target = nodeKey(targetDomain, targetCode);
  return source && target ? `${source}->${target}` : null;
}

export async function loadNarrativeTaxonomyGraph({ getPool, sql } = {}) {
  if (typeof getPool !== "function" || !sql) {
    return { engine: ENGINE_VERSION, available: false, nodes: [], edges: [], adjacency: new Map(), reason: "database_provider_unavailable" };
  }

  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT
      source_node.domain AS source_domain,
      source_node.code AS source_code,
      target_node.domain AS target_domain,
      target_node.code AS target_code,
      edge.relation_type,
      edge.weight,
      edge.sort_order
    FROM dbo.mei_taxonomy_edge edge
    INNER JOIN dbo.mei_taxonomy source_node
      ON source_node.taxonomy_id = edge.source_taxonomy_id
     AND ISNULL(source_node.is_active, 1) = 1
    INNER JOIN dbo.mei_taxonomy target_node
      ON target_node.taxonomy_id = edge.target_taxonomy_id
     AND ISNULL(target_node.is_active, 1) = 1
    WHERE edge.is_active = 1
      AND edge.relation_type IN ('SAME_FAMILY', 'ALLOWS', 'TRANSITIONS_TO', 'RECOMMENDS', 'INCOMPATIBLE_WITH');
  `);

  const edges = safeArray(result.recordset).map((row) => ({
    source_domain: normalizeCode(row.source_domain),
    source_code: normalizeCode(row.source_code),
    target_domain: normalizeCode(row.target_domain),
    target_code: normalizeCode(row.target_code),
    relation_type: normalizeCode(row.relation_type),
    weight: Number(row.weight ?? 0),
    sort_order: Number(row.sort_order ?? 0),
  }));

  const adjacency = new Map();
  const adjacencyBySource = new Map();
  for (const edge of edges) {
    const key = edgeKey(edge.source_domain, edge.source_code, edge.target_domain, edge.target_code);
    if (key) adjacency.set(key, edge);
    const sourceKey = nodeKey(edge.source_domain, edge.source_code);
    if (sourceKey) {
      const list = adjacencyBySource.get(sourceKey) || [];
      list.push(edge);
      adjacencyBySource.set(sourceKey, list);
    }
  }

  return {
    engine: ENGINE_VERSION,
    available: edges.length > 0,
    edges,
    adjacency,
    adjacencyBySource,
    edge_count: edges.length,
    loaded_at: new Date().toISOString(),
  };
}

function lookupRelation(graph, sourceNode, targetNode) {
  const adjacency = graph?.adjacency instanceof Map ? graph.adjacency : new Map();
  const direct = adjacency.get(edgeKey(sourceNode?.domain, sourceNode?.code, targetNode?.domain, targetNode?.code));
  if (direct) return direct;

  const reverse = adjacency.get(edgeKey(targetNode?.domain, targetNode?.code, sourceNode?.domain, sourceNode?.code));
  if (reverse && ["SAME_FAMILY", "INCOMPATIBLE_WITH"].includes(reverse.relation_type)) return reverse;
  return null;
}


function shortestGraphDistance(graph, sourceNode, targetNode, maxDepth = 8) {
  const source = nodeKey(sourceNode?.domain, sourceNode?.code);
  const target = nodeKey(targetNode?.domain, targetNode?.code);
  if (!source || !target) return null;
  if (source === target) return 0;

  const adjacencyBySource = graph?.adjacencyBySource instanceof Map ? graph.adjacencyBySource : new Map();
  const queue = [{ key: source, depth: 0 }];
  const visited = new Set([source]);

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    for (const edge of safeArray(adjacencyBySource.get(current.key))) {
      if (edge.relation_type === "INCOMPATIBLE_WITH") continue;
      const next = nodeKey(edge.target_domain, edge.target_code);
      if (!next || visited.has(next)) continue;
      if (next === target) return current.depth + 1;
      visited.add(next);
      queue.push({ key: next, depth: current.depth + 1 });
    }
  }

  return null;
}

function compareDimension({ graph, domain, leftCode, rightCode, compatibleRelations }) {
  if (!leftCode || !rightCode) return { available: false, score: 0, relation: null, incompatible: false };
  if (leftCode === rightCode) return { available: true, score: 100, relation: "EXACT", incompatible: false };

  const sourceNode = { domain, code: leftCode };
  const targetNode = { domain, code: rightCode };
  const relation = lookupRelation(graph, sourceNode, targetNode);
  const distance = shortestGraphDistance(graph, sourceNode, targetNode);

  if (!relation) {
    const distanceScore = distance === null ? 0 : clampScore(80 - ((distance - 1) * 15));
    return { available: true, score: distanceScore, relation: distance ? "GRAPH_DISTANCE" : null, incompatible: false, distance };
  }
  if (relation.relation_type === "INCOMPATIBLE_WITH") {
    return { available: true, score: 0, relation: relation.relation_type, incompatible: true, weight: relation.weight, distance };
  }

  const allowed = compatibleRelations.includes(relation.relation_type);
  const effect = RELATION_EFFECT[relation.relation_type] ?? 0;
  return {
    available: true,
    score: allowed ? clampScore(Math.max(0, Number(relation.weight || 100)) * effect) : 0,
    relation: relation.relation_type,
    incompatible: false,
    weight: relation.weight,
    distance: distance ?? 1,
  };
}

function crossPathRelations(graph, leftPath, rightPath) {
  const relations = [];
  for (const leftNode of safeArray(leftPath.nodes)) {
    for (const rightNode of safeArray(rightPath.nodes)) {
      const relation = lookupRelation(graph, leftNode, rightNode);
      if (relation) relations.push(relation);
    }
  }
  return relations;
}

export function scoreNarrativeCompatibility(leftMemory = {}, rightMemory = {}, graph = null, options = {}) {
  const left = leftMemory?.nodes ? leftMemory : extractNarrativePath(leftMemory);
  const right = rightMemory?.nodes ? rightMemory : extractNarrativePath(rightMemory);

  const lifePeriod = compareDimension({
    graph,
    domain: "LIFE_PERIOD",
    leftCode: left.life_period_code,
    rightCode: right.life_period_code,
    compatibleRelations: ["SAME_FAMILY", "TRANSITIONS_TO", "RECOMMENDS"],
  });
  const context = compareDimension({
    graph,
    domain: "EDITORIAL_CONTEXT",
    leftCode: left.context_code,
    rightCode: right.context_code,
    compatibleRelations: ["SAME_FAMILY", "TRANSITIONS_TO", "RECOMMENDS"],
  });
  const role = compareDimension({
    graph,
    domain: "NARRATIVE_ROLE",
    leftCode: left.narrative_role_code,
    rightCode: right.narrative_role_code,
    compatibleRelations: ["ALLOWS", "TRANSITIONS_TO", "RECOMMENDS", "SAME_FAMILY"],
  });

  const crossRelations = crossPathRelations(graph, left, right);
  const incompatibleRelations = crossRelations.filter((relation) => relation.relation_type === "INCOMPATIBLE_WITH");
  const transitionRelations = crossRelations.filter((relation) => relation.relation_type === "TRANSITIONS_TO");
  const recommendationRelations = crossRelations.filter((relation) => relation.relation_type === "RECOMMENDS");
  const sameFamilyRelations = crossRelations.filter((relation) => relation.relation_type === "SAME_FAMILY");
  const allowsRelations = crossRelations.filter((relation) => relation.relation_type === "ALLOWS");

  const incompatible = Boolean(lifePeriod.incompatible || context.incompatible || role.incompatible || incompatibleRelations.length);
  const completePair = left.complete && right.complete;
  const weighted = (lifePeriod.score * 0.30) + (context.score * 0.38) + (role.score * 0.32);
  const relationBonus = Math.min(18,
    transitionRelations.length * 6 +
    recommendationRelations.length * 3 +
    sameFamilyRelations.length * 4 +
    allowsRelations.length * 5,
  );
  const completenessAdjustment = completePair ? 5 : -10;
  const graphScore = incompatible ? 0 : clampScore(weighted + relationBonus + completenessAdjustment);
  const embeddingScore = clampScore(options.embeddingScore ?? options.semanticScore ?? 0);
  const hybridScore = incompatible ? 0 : clampScore((graphScore * 0.78) + (embeddingScore * 0.22));

  return {
    engine: ENGINE_VERSION,
    graph_primary: true,
    left_path: left,
    right_path: right,
    graph_score: graphScore,
    embedding_score: embeddingScore,
    hybrid_score: hybridScore,
    incompatible,
    complete_pair: completePair,
    dimensions: { life_period: lifePeriod, context, narrative_role: role },
    relations: {
      transitions_to: transitionRelations,
      recommends: recommendationRelations,
      same_family: sameFamilyRelations,
      allows: allowsRelations,
      incompatible_with: incompatibleRelations,
    },
    policy: "NTG 78% + embeddings 22%. INCOMPATIBLE_WITH zera a compatibilidade.",
  };
}

export function summarizeNarrativePaths(memories = [], graph = null, options = {}) {
  const ordered = safeArray(memories);
  const paths = ordered.map((memory) => ({
    memory_id: Number(memory?.memory_id ?? memory?.id) || null,
    title: memory?.title || null,
    narrative_path: extractNarrativePath(memory),
  }));

  const pairs = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      pairs.push({
        left_memory_id: Number(ordered[i]?.memory_id ?? ordered[i]?.id) || null,
        right_memory_id: Number(ordered[j]?.memory_id ?? ordered[j]?.id) || null,
        left_position: i,
        right_position: j,
        ...scoreNarrativeCompatibility(ordered[i], ordered[j], graph, options),
      });
    }
  }

  const compatiblePairs = pairs.filter((pair) => !pair.incompatible);
  const averageGraphScore = compatiblePairs.length
    ? clampScore(compatiblePairs.reduce((sum, pair) => sum + pair.graph_score, 0) / compatiblePairs.length)
    : 0;
  const averageHybridScore = compatiblePairs.length
    ? clampScore(compatiblePairs.reduce((sum, pair) => sum + pair.hybrid_score, 0) / compatiblePairs.length)
    : 0;

  // O arco não é a média de todos os pares. Uma história é uma cadeia conectada.
  // Pares distantes e memórias de apoio não podem derrubar uma sequência autoral válida.
  const minimumChainScore = clampScore(options.minimumChainScore ?? 45);
  const chainPairs = compatiblePairs.filter((pair) => pair.graph_score >= minimumChainScore);
  const adjacency = new Map();
  for (const item of paths) {
    if (item.memory_id) adjacency.set(item.memory_id, []);
  }
  for (const pair of chainPairs) {
    adjacency.get(pair.left_memory_id)?.push({ id: pair.right_memory_id, score: pair.graph_score });
    adjacency.get(pair.right_memory_id)?.push({ id: pair.left_memory_id, score: pair.graph_score });
  }

  const components = [];
  const visited = new Set();
  for (const item of paths) {
    const startId = item.memory_id;
    if (!startId || visited.has(startId)) continue;
    const queue = [startId];
    const ids = [];
    visited.add(startId);
    while (queue.length) {
      const current = queue.shift();
      ids.push(current);
      for (const edge of safeArray(adjacency.get(current))) {
        if (!visited.has(edge.id)) {
          visited.add(edge.id);
          queue.push(edge.id);
        }
      }
    }
    const idSet = new Set(ids);
    const componentPairs = chainPairs.filter(
      (pair) => idSet.has(pair.left_memory_id) && idSet.has(pair.right_memory_id),
    );
    const score = componentPairs.length
      ? clampScore(componentPairs.reduce((sum, pair) => sum + pair.graph_score, 0) / componentPairs.length)
      : 0;
    components.push({ memory_ids: ids, memory_count: ids.length, score, pair_count: componentPairs.length });
  }

  components.sort((a, b) => b.memory_count - a.memory_count || b.score - a.score);
  const primaryComponent = components[0] || { memory_ids: [], memory_count: 0, score: 0, pair_count: 0 };
  const primaryIds = new Set(primaryComponent.memory_ids);

  const memorySupport = paths.map((item) => {
    const related = compatiblePairs.filter(
      (pair) => pair.left_memory_id === item.memory_id || pair.right_memory_id === item.memory_id,
    );
    const strong = related.filter((pair) => pair.graph_score >= minimumChainScore);
    return {
      memory_id: item.memory_id,
      max_graph_score: related.length ? Math.max(...related.map((pair) => pair.graph_score)) : 0,
      average_graph_score: related.length
        ? clampScore(related.reduce((sum, pair) => sum + pair.graph_score, 0) / related.length)
        : 0,
      strong_connection_count: strong.length,
      in_primary_component: primaryIds.has(item.memory_id),
    };
  });

  const orderedAdjacentPairs = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    orderedAdjacentPairs.push({
      left_memory_id: Number(ordered[i]?.memory_id ?? ordered[i]?.id) || null,
      right_memory_id: Number(ordered[i + 1]?.memory_id ?? ordered[i + 1]?.id) || null,
      ...scoreNarrativeCompatibility(ordered[i], ordered[i + 1], graph, options),
    });
  }
  const strongAdjacentPairs = orderedAdjacentPairs.filter(
    (pair) => !pair.incompatible && pair.graph_score >= minimumChainScore,
  );
  const sequenceGraphScore = strongAdjacentPairs.length
    ? clampScore(strongAdjacentPairs.reduce((sum, pair) => sum + pair.graph_score, 0) / strongAdjacentPairs.length)
    : primaryComponent.score;

  return {
    engine: ENGINE_VERSION,
    graph_primary: true,
    paths,
    path_keys: [...new Set(paths.map((item) => item.narrative_path.key).filter(Boolean))],
    complete_path_count: paths.filter((item) => item.narrative_path.complete).length,
    incomplete_path_count: paths.filter((item) => !item.narrative_path.complete).length,
    incompatible_pair_count: pairs.filter((pair) => pair.incompatible).length,
    compatible_pair_count: compatiblePairs.length,
    average_graph_score: averageGraphScore,
    average_hybrid_score: averageHybridScore,
    sequence_graph_score: sequenceGraphScore,
    minimum_chain_score: minimumChainScore,
    narrative_components: components,
    narrative_core_memory_ids: primaryComponent.memory_ids,
    narrative_outlier_memory_ids: paths
      .map((item) => item.memory_id)
      .filter((memoryId) => memoryId && !primaryIds.has(memoryId)),
    memory_support: memorySupport,
    adjacent_pairs: orderedAdjacentPairs,
    pairs,
    policy: "A coerência é calculada pela melhor cadeia narrativa autoral, não pela média indiscriminada de todos os pares.",
  };
}

export function validateNarrativePathSequence(memories = [], graph = null, options = {}) {
  const summary = summarizeNarrativePaths(memories, graph, options);
  const blockingIncompatibility = summary.incompatible_pair_count > 0;
  const minimumCompletePaths = safeArray(memories).length >= 2 ? 2 : 1;
  const completeEnough = summary.complete_path_count >= minimumCompletePaths;
  const coreMemoryCount = safeArray(summary.narrative_core_memory_ids).length;
  const minimumCoreMemories = safeArray(memories).length >= 2 ? 2 : 1;
  const chainCoherent = coreMemoryCount >= minimumCoreMemories && summary.sequence_graph_score >= 45;
  const coherent = !blockingIncompatibility && completeEnough && chainCoherent;

  return {
    ...summary,
    coherent,
    chain_coherent: chainCoherent,
    core_memory_count: coreMemoryCount,
    blocking_incompatibility: blockingIncompatibility,
    complete_enough: completeEnough,
    status: coherent ? "COHERENT" : blockingIncompatibility ? "INCOMPATIBLE" : "INCOMPLETE_OR_WEAK",
    source_policy: "O Truth materializa a Story quando existe uma cadeia autoral coerente, completa e sem INCOMPATIBLE_WITH.",
  };
}

export const StoryNarrativePathService = {
  version: ENGINE_VERSION,
  extractNarrativePath,
  buildNarrativePathKey,
  loadNarrativeTaxonomyGraph,
  scoreNarrativeCompatibility,
  summarizeNarrativePaths,
  validateNarrativePathSequence,
};
