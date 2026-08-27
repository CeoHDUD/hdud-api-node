import { safeArray, unique } from './narrative-graph-utils.service.js';

const ENGINE_VERSION = 'life-journey-graph-v6.4.3';

export function buildLifeJourneyGraph({ descriptors = [], links = [], families = [], centrality = [] } = {}) {
  const centralityMap = new Map(safeArray(centrality).map((item) => [item.arc_id, item]));
  const familyMap = new Map(safeArray(families).flatMap((family) => family.arc_ids.map((arcId) => [arcId, family])));

  const nodes = safeArray(descriptors).map((descriptor) => ({
    node_id: descriptor.arc_id,
    node_type: 'NARRATIVE_ARC',
    title: descriptor.title,
    status: descriptor.status,
    family_id: familyMap.get(descriptor.arc_id)?.family_id || null,
    family_label: familyMap.get(descriptor.arc_id)?.label || null,
    centrality_score: centralityMap.get(descriptor.arc_id)?.centrality_score || 0,
    memory_ids: descriptor.memory_ids,
    life_periods: descriptor.life_periods,
    contexts: descriptor.contexts,
    narrative_roles: descriptor.narrative_roles,
    dramatic_stages: descriptor.dramatic_stages,
    date_range: descriptor.date_range,
    arc_completion_score: descriptor.completion_score,
    arc_score: descriptor.arc_score,
  }));

  const edges = safeArray(links).map((link) => ({
    edge_id: link.edge_id,
    source: link.source_arc_id,
    target: link.target_arc_id,
    edge_type: link.relationship_type,
    score: link.score,
    strength: link.strength,
    direction: link.direction,
    bidirectional: link.bidirectional,
    evidence: link.signals,
  }));

  const connectedIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const allMemoryIds = unique(nodes.flatMap((node) => node.memory_ids));

  return {
    type: 'LIFE_JOURNEY_GRAPH',
    engine: ENGINE_VERSION,
    graph_id: 'runtime:life-journey-graph',
    status: nodes.length < 2
      ? 'INSUFFICIENT_ARCS'
      : connectedIds.size === nodes.length
        ? 'CONNECTED_LIFE_JOURNEY'
        : connectedIds.size > 0
          ? 'PARTIALLY_CONNECTED_LIFE_JOURNEY'
          : 'DISCONNECTED_LIFE_JOURNEY',
    nodes,
    edges,
    families: safeArray(families),
    journey_sequence: [...nodes]
      .sort((left, right) => {
        const leftDate = left.date_range.start ? new Date(left.date_range.start).getTime() : Number.MAX_SAFE_INTEGER;
        const rightDate = right.date_range.start ? new Date(right.date_range.start).getTime() : Number.MAX_SAFE_INTEGER;
        return leftDate - rightDate || right.centrality_score - left.centrality_score;
      })
      .map((node, index) => ({ position: index + 1, arc_id: node.node_id, title: node.title })),
    statistics: {
      node_count: nodes.length,
      edge_count: edges.length,
      family_count: safeArray(families).length,
      connected_node_count: connectedIds.size,
      isolated_node_count: nodes.filter((node) => !connectedIds.has(node.node_id)).length,
      unique_memory_count: allMemoryIds.length,
      graph_density: nodes.length > 1 ? Number((edges.length / ((nodes.length * (nodes.length - 1)) / 2)).toFixed(4)) : 0,
    },
    runtime_persistence: {
      mode: 'IN_MEMORY',
      persisted: false,
      generated_at: new Date().toISOString(),
    },
    source_policy: 'O Life Journey Graph conecta arcos já validados sem fundi-los, reescrevê-los ou criar fatos novos.',
  };
}

export const LifeJourneyGraph = { buildLifeJourneyGraph };
