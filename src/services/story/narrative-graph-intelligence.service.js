import { linkNarrativeArcs } from './arc-linking-engine.service.js';
import { analyzeCrossArcRelationships } from './cross-arc-analysis.service.js';
import { detectNarrativeFamilies } from './narrative-family-detection.service.js';
import { calculateNarrativeCentrality } from './narrative-centrality.service.js';
import { buildLifeJourneyGraph } from './life-journey-graph.service.js';
import { safeArray } from './narrative-graph-utils.service.js';

const ENGINE_VERSION = 'narrative-graph-intelligence-v6.4.3';

function emptyResult(
  sourceArcCount = 0,
  reason = 'Ainda não há arcos suficientes para construir inteligência entre histórias.',
) {
  const lifeJourneyGraph = buildLifeJourneyGraph();

  return {
    engine: ENGINE_VERSION,
    status: 'INSUFFICIENT_ARCS',
    reason,
    arc_links: [],
    narrative_families: [],
    arc_family_index: {},
    cross_arc_analysis: {
      shared_events: [],
      convergence_points: [],
      continuity_chains: [],
      cross_story_relationships: [],
    },
    narrative_centrality: [],
    central_arc_id: null,
    life_journey_graph: lifeJourneyGraph,
    can_proceed_to_truth: false,
    statistics: {
      source_arc_count: sourceArcCount,
      descriptor_count: 0,
      link_count: 0,
      family_count: 0,
      centrality_count: 0,
      node_count: Number(lifeJourneyGraph?.statistics?.node_count || 0),
      edge_count: Number(lifeJourneyGraph?.statistics?.edge_count || 0),
      connected_node_count: Number(lifeJourneyGraph?.statistics?.connected_node_count || 0),
      isolated_node_count: Number(lifeJourneyGraph?.statistics?.isolated_node_count || 0),
      unique_memory_count: Number(lifeJourneyGraph?.statistics?.unique_memory_count || 0),
      graph_density: Number(lifeJourneyGraph?.statistics?.graph_density || 0),
    },
    runtime: {
      mode: 'IN_MEMORY',
      persisted: false,
      generated_at: new Date().toISOString(),
      source_arc_count: sourceArcCount,
      source_policy: 'NGI interpreta relações entre arcos existentes; não altera o Arc Engine, não funde histórias e não cria fatos.',
    },
  };
}

export function buildNarrativeGraphIntelligence({ arcs = [], candidates = [], minimumLinkScore = 20 } = {}) {
  const sourceArcs = safeArray(arcs).filter(Boolean);

  if (sourceArcs.length < 2) {
    return emptyResult(sourceArcs.length);
  }

  const linking = linkNarrativeArcs({
    arcs: sourceArcs,
    candidates,
    minimumScore: minimumLinkScore,
  });

  const crossArc = analyzeCrossArcRelationships({
    descriptors: linking.descriptors,
    links: linking.links,
  });

  const familyDetection = detectNarrativeFamilies({
    descriptors: linking.descriptors,
    links: linking.links,
  });

  const centrality = calculateNarrativeCentrality({
    descriptors: linking.descriptors,
    links: linking.links,
  });

  const lifeJourneyGraph = buildLifeJourneyGraph({
    descriptors: linking.descriptors,
    links: linking.links,
    families: familyDetection.families,
    centrality: centrality.centrality,
  });

  return {
    engine: ENGINE_VERSION,
    status: lifeJourneyGraph.status,
    arc_links: linking.links,
    narrative_families: familyDetection.families,
    arc_family_index: familyDetection.arc_family_index,
    cross_arc_analysis: crossArc,
    narrative_centrality: centrality.centrality,
    central_arc_id: centrality.central_arc_id,
    life_journey_graph: lifeJourneyGraph,
    can_proceed_to_truth:
      sourceArcs.every((arc) => arc.can_proceed_to_truth) &&
      lifeJourneyGraph.nodes.length >= 2,
    statistics: {
      ...linking.statistics,
      ...familyDetection.statistics,
      ...centrality.statistics,
      ...lifeJourneyGraph.statistics,
      source_arc_count: sourceArcs.length,
    },
    runtime: {
      mode: 'IN_MEMORY',
      persisted: false,
      generated_at: new Date().toISOString(),
      source_arc_count: sourceArcs.length,
      source_policy: 'NGI interpreta relações entre arcos existentes; não altera o Arc Engine, não funde histórias e não cria fatos.',
    },
  };
}

export const NarrativeGraphIntelligence = { buildNarrativeGraphIntelligence };
