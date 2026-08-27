import { round, safeArray } from './narrative-graph-utils.service.js';

const ENGINE_VERSION = 'narrative-centrality-v6.4.3';

function adjacency(ids, links) {
  const map = new Map(ids.map((id) => [id, []]));
  safeArray(links).forEach((link) => {
    map.get(link.source_arc_id)?.push({ id: link.target_arc_id, weight: link.score });
    map.get(link.target_arc_id)?.push({ id: link.source_arc_id, weight: link.score });
  });
  return map;
}

function shortestDistances(start, graph) {
  const distances = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    const distance = distances.get(current);
    for (const neighbor of graph.get(current) || []) {
      if (!distances.has(neighbor.id)) {
        distances.set(neighbor.id, distance + 1);
        queue.push(neighbor.id);
      }
    }
  }
  return distances;
}

export function calculateNarrativeCentrality({ descriptors = [], links = [] } = {}) {
  const ids = safeArray(descriptors).map((descriptor) => descriptor.arc_id);
  const graph = adjacency(ids, links);
  const denominator = Math.max(1, ids.length - 1);

  const centrality = ids.map((arcId) => {
    const neighbors = graph.get(arcId) || [];
    const weightedDegree = neighbors.reduce((sum, neighbor) => sum + neighbor.weight, 0);
    const distances = shortestDistances(arcId, graph);
    const reachable = [...distances.values()].filter((distance) => distance > 0);
    const closeness = reachable.length
      ? (reachable.length / denominator) * (reachable.length / reachable.reduce((sum, distance) => sum + distance, 0))
      : 0;
    const degree = neighbors.length / denominator;
    const normalizedWeight = weightedDegree / Math.max(1, denominator * 100);
    const score = Math.round((degree * 0.45 + normalizedWeight * 0.35 + closeness * 0.2) * 100);

    return {
      arc_id: arcId,
      degree: round(degree, 4),
      weighted_degree: weightedDegree,
      closeness: round(closeness, 4),
      centrality_score: score,
      connected_arc_count: neighbors.length,
      connected_arc_ids: neighbors.map((neighbor) => neighbor.id),
    };
  }).sort((a, b) => b.centrality_score - a.centrality_score || b.weighted_degree - a.weighted_degree);

  return {
    engine: ENGINE_VERSION,
    centrality,
    central_arc_id: centrality[0]?.arc_id || null,
    statistics: {
      analyzed_arc_count: ids.length,
      connected_arc_count: centrality.filter((item) => item.connected_arc_count > 0).length,
      isolated_arc_count: centrality.filter((item) => item.connected_arc_count === 0).length,
      maximum_centrality_score: centrality[0]?.centrality_score || 0,
    },
  };
}

export const NarrativeCentrality = { calculateNarrativeCentrality };
