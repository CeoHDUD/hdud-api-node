import {
  buildArcDescriptor,
  candidateForArc,
  clamp,
  daysBetween,
  jaccard,
  round,
  safeArray,
  setIntersection,
  unique,
} from './narrative-graph-utils.service.js';

const ENGINE_VERSION = 'arc-linking-engine-v6.4.3-chat08-contract-fix';

function chronologySignal(left, right) {
  const leftEnd = left.date_range.end;
  const rightStart = right.date_range.start;
  const rightEnd = right.date_range.end;
  const leftStart = left.date_range.start;

  const forwardGap = daysBetween(leftEnd, rightStart);
  const backwardGap = daysBetween(rightEnd, leftStart);
  const gap = [forwardGap, backwardGap].filter((value) => value !== null).sort((a, b) => a - b)[0];

  if (gap === undefined) return { score: 0, gap_days: null, direction: 'UNDATED' };
  const score = gap <= 30 ? 100 : gap <= 180 ? 85 : gap <= 365 ? 70 : gap <= 1095 ? 45 : 20;
  const direction = leftEnd && rightStart && new Date(leftEnd) <= new Date(rightStart)
    ? 'FORWARD'
    : rightEnd && leftStart && new Date(rightEnd) <= new Date(leftStart)
      ? 'BACKWARD'
      : 'OVERLAPPING';

  return { score, gap_days: round(gap), direction };
}

function relationshipType(signals = {}) {
  const sharedMemoryIds = safeArray(signals.shared_memory_ids);
  const sharedCanonicalStoryKeys = safeArray(signals.shared_canonical_story_keys);
  const sharedContexts = safeArray(signals.shared_contexts);
  const sharedRoles = safeArray(signals.shared_narrative_roles ?? signals.shared_roles);
  const sharedLifePeriods = safeArray(signals.shared_life_periods);

  const chronologyScore = Number(signals.chronology_score || 0);
  const semanticScore = Number(signals.semantic_score || 0);

  if (sharedMemoryIds.length) return 'SHARED_EVENT';
  if (sharedCanonicalStoryKeys.length) return 'SAME_CANONICAL_STORY';
  if (sharedContexts.length && sharedRoles.length) return 'NARRATIVE_CONTINUITY';
  if (sharedLifePeriods.length || sharedContexts.length) return 'SAME_NARRATIVE_FAMILY';
  if (chronologyScore >= 70 && semanticScore >= 25) return 'LIFE_JOURNEY_CONTINUITY';
  if (semanticScore >= 45) return 'THEMATIC_RESONANCE';
  return 'WEAK_ASSOCIATION';
}

function linkPair(left, right, minimumScore) {
  const sharedMemoryIds = setIntersection(left.memory_ids, right.memory_ids);
  const sharedLifePeriods = setIntersection(left.life_periods, right.life_periods);
  const sharedContexts = setIntersection(left.contexts, right.contexts);
  const sharedRoles = setIntersection(left.narrative_roles, right.narrative_roles);
  const sharedStages = setIntersection(left.dramatic_stages, right.dramatic_stages);
  const sharedCanonicalStoryKeys = setIntersection(left.canonical_story_keys, right.canonical_story_keys);
  const chronology = chronologySignal(left, right);
  const semanticScore = round(jaccard(left.text_tokens, right.text_tokens) * 100);

  const score = clamp(round(
    Math.min(35, sharedMemoryIds.length * 35)
      + Math.min(18, sharedCanonicalStoryKeys.length * 18)
      + Math.min(14, sharedContexts.length * 10)
      + Math.min(10, sharedLifePeriods.length * 8)
      + Math.min(10, sharedRoles.length * 4)
      + Math.min(4, sharedStages.length)
      + semanticScore * 0.06
      + chronology.score * 0.03,
  ));

  if (score < minimumScore) return null;

  const signals = {
    shared_memory_ids: sharedMemoryIds,
    shared_life_periods: sharedLifePeriods,
    shared_contexts: sharedContexts,
    shared_narrative_roles: sharedRoles,
    shared_dramatic_stages: sharedStages,
    shared_canonical_story_keys: sharedCanonicalStoryKeys,
    semantic_score: semanticScore,
    chronology_score: chronology.score,
    chronology_gap_days: chronology.gap_days,
  };

  return {
    edge_id: `${left.arc_id}=>${right.arc_id}`,
    source_arc_id: left.arc_id,
    target_arc_id: right.arc_id,
    relationship_type: relationshipType(signals),
    strength: score >= 75 ? 'STRONG' : score >= 50 ? 'MODERATE' : 'WEAK',
    score,
    direction: chronology.direction,
    bidirectional: chronology.direction === 'OVERLAPPING' || sharedMemoryIds.length > 0,
    signals,
    source_policy: 'A ligação nasce exclusivamente de evidências compartilhadas, classificação NTG existente, semântica textual limitada e continuidade temporal observável.',
  };
}

export function linkNarrativeArcs({ arcs = [], candidates = [], minimumScore = 20 } = {}) {
  const descriptors = safeArray(arcs).map((arc, index) => buildArcDescriptor(arc, candidateForArc(arc, candidates, index), index));
  const links = [];

  for (let leftIndex = 0; leftIndex < descriptors.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < descriptors.length; rightIndex += 1) {
      const link = linkPair(descriptors[leftIndex], descriptors[rightIndex], minimumScore);
      if (link) links.push(link);
    }
  }

  return {
    engine: ENGINE_VERSION,
    descriptors,
    links: links.sort((a, b) => b.score - a.score || a.edge_id.localeCompare(b.edge_id)),
    statistics: {
      arc_count: descriptors.length,
      possible_link_count: descriptors.length > 1 ? (descriptors.length * (descriptors.length - 1)) / 2 : 0,
      detected_link_count: links.length,
      strong_link_count: links.filter((link) => link.strength === 'STRONG').length,
      shared_event_link_count: links.filter((link) => link.relationship_type === 'SHARED_EVENT').length,
      connected_arc_ids: unique(links.flatMap((link) => [link.source_arc_id, link.target_arc_id])),
    },
  };
}

export const ArcLinkingEngine = { linkNarrativeArcs };
