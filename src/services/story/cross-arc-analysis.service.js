import { safeArray, unique } from './narrative-graph-utils.service.js';

const ENGINE_VERSION = 'cross-arc-analysis-v6.4.3';

export function analyzeCrossArcRelationships({ descriptors = [], links = [] } = {}) {
  const arcMap = new Map(safeArray(descriptors).map((descriptor) => [descriptor.arc_id, descriptor]));
  const sharedEvents = [];
  const convergencePoints = [];
  const continuityChains = [];

  for (const link of safeArray(links)) {
    const source = arcMap.get(link.source_arc_id);
    const target = arcMap.get(link.target_arc_id);
    if (!source || !target) continue;

    if (link.signals.shared_memory_ids.length) {
      sharedEvents.push({
        memory_ids: link.signals.shared_memory_ids,
        arc_ids: [source.arc_id, target.arc_id],
        relationship_type: link.relationship_type,
        score: link.score,
      });
    }

    const convergenceTokens = unique([
      ...link.signals.shared_life_periods,
      ...link.signals.shared_contexts,
      ...link.signals.shared_narrative_roles,
      ...link.signals.shared_canonical_story_keys,
    ]);
    if (convergenceTokens.length) {
      convergencePoints.push({
        arc_ids: [source.arc_id, target.arc_id],
        convergence_tokens: convergenceTokens,
        score: link.score,
      });
    }

    if (['FORWARD', 'BACKWARD'].includes(link.direction)) {
      const orderedArcIds = link.direction === 'FORWARD'
        ? [source.arc_id, target.arc_id]
        : [target.arc_id, source.arc_id];
      continuityChains.push({
        arc_ids: orderedArcIds,
        relationship_type: link.relationship_type,
        gap_days: link.signals.chronology_gap_days,
        score: link.score,
      });
    }
  }

  return {
    engine: ENGINE_VERSION,
    shared_events: sharedEvents,
    convergence_points: convergencePoints.sort((a, b) => b.score - a.score),
    continuity_chains: continuityChains.sort((a, b) => b.score - a.score),
    cross_story_relationships: safeArray(links).map((link) => ({
      source_arc_id: link.source_arc_id,
      target_arc_id: link.target_arc_id,
      type: link.relationship_type,
      strength: link.strength,
      score: link.score,
      evidence: link.signals,
    })),
    statistics: {
      shared_event_count: sharedEvents.length,
      convergence_point_count: convergencePoints.length,
      continuity_chain_count: continuityChains.length,
      relationship_count: safeArray(links).length,
    },
  };
}

export const CrossArcAnalysis = { analyzeCrossArcRelationships };
