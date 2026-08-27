import { safeArray, unique } from './narrative-graph-utils.service.js';

const ENGINE_VERSION = 'narrative-family-detection-v6.4.3';

function createUnionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    const current = parent.get(id);
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  return { find, union };
}

function familyLabel(members) {
  const contexts = unique(members.flatMap((member) => member.contexts));
  const periods = unique(members.flatMap((member) => member.life_periods));
  const keys = unique(members.flatMap((member) => member.canonical_story_keys));
  return contexts[0] || keys[0] || periods[0] || 'LIFE_JOURNEY';
}

export function detectNarrativeFamilies({ descriptors = [], links = [], minimumFamilyScore = 35 } = {}) {
  const items = safeArray(descriptors);
  const ids = items.map((item) => item.arc_id);
  const unionFind = createUnionFind(ids);

  safeArray(links)
    .filter((link) => link.score >= minimumFamilyScore)
    .forEach((link) => unionFind.union(link.source_arc_id, link.target_arc_id));

  const groups = new Map();
  items.forEach((item) => {
    const root = unionFind.find(item.arc_id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });

  const families = [...groups.values()].map((members, index) => {
    const memberIds = members.map((member) => member.arc_id);
    const familyLinks = safeArray(links).filter((link) => memberIds.includes(link.source_arc_id) && memberIds.includes(link.target_arc_id));
    const averageScore = familyLinks.length
      ? Math.round(familyLinks.reduce((sum, link) => sum + link.score, 0) / familyLinks.length)
      : 0;

    return {
      family_id: `narrative-family:${index + 1}`,
      label: familyLabel(members),
      arc_ids: memberIds,
      arc_count: members.length,
      memory_ids: unique(members.flatMap((member) => member.memory_ids)),
      life_periods: unique(members.flatMap((member) => member.life_periods)),
      contexts: unique(members.flatMap((member) => member.contexts)),
      narrative_roles: unique(members.flatMap((member) => member.narrative_roles)),
      canonical_story_keys: unique(members.flatMap((member) => member.canonical_story_keys)),
      cohesion_score: averageScore,
      status: members.length > 1 ? 'CONNECTED_FAMILY' : 'INDIVIDUAL_ARC',
    };
  });

  return {
    engine: ENGINE_VERSION,
    families,
    arc_family_index: Object.fromEntries(families.flatMap((family) => family.arc_ids.map((arcId) => [arcId, family.family_id]))),
    statistics: {
      family_count: families.length,
      connected_family_count: families.filter((family) => family.arc_count > 1).length,
      individual_arc_family_count: families.filter((family) => family.arc_count === 1).length,
      largest_family_arc_count: Math.max(0, ...families.map((family) => family.arc_count)),
    },
  };
}

export const NarrativeFamilyDetection = { detectNarrativeFamilies };
