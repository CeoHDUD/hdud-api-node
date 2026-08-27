// C:\HDUD_DATA\hdud-api-node\src\services\story\story-calibration-engine.service.js
//
// GO LIVE 006.4.3 — CHAT 08 — Story Calibration
// Responsabilidade: separar seeds amplas em trajetórias narrativas independentes
// antes da criação de Candidates, Blueprints e Narrative Arcs.
//
// Política:
// - Narrative Path é a fronteira primária;
// - famílias narrativas representam trajetórias humanas, não simples igualdade de código;
// - tempo, papel dramático e canonical story são sinais auxiliares;
// - memórias sem par permanecem fora, sem candidato artificial;
// - nenhuma regra de linking é adicionada ao NGI.

import {
  compareMemoryDate,
  memoryCanonicalDate,
  memoryIdOf,
  safeYear,
} from "./story-continuity.service.js";
import { extractNarrativePath } from "./story-narrative-path.service.js";

const ENGINE_VERSION = "story-calibration-engine-v2.0-narrative-family";

const MIN_CANDIDATE_MEMORIES = 2;
const MAX_CANDIDATE_MEMORIES = 8;

const FAMILY_BY_CONTEXT = new Map([
  ["love", "relationships"],
  ["relationship", "relationships"],
  ["romance", "relationships"],
  ["marriage", "relationships"],
  ["partnership", "relationships"],

  ["child_birth", "paternity"],
  ["fatherhood", "paternity"],
  ["paternity", "paternity"],
  ["maternity", "maternity"],

  ["hdud", "hdud"],
  ["technology", "career"],
  ["work", "career"],
  ["career", "career"],
  ["profession", "career"],
  ["leadership", "career"],

  ["education", "education"],
  ["school", "education"],
  ["school_change", "education"],

  ["health", "health"],
  ["hospital", "health"],
  ["recovery", "health"],

  ["family", "family"],
  ["sport", "sport"],
  ["travel", "travel"],
  ["culture", "culture"],
]);

const FAMILY_BY_LIFE_PERIOD = new Map([
  ["relationship", "relationships"],
  ["relationships", "relationships"],
  ["marriage", "relationships"],

  ["paternity", "paternity"],
  ["fatherhood", "paternity"],
  ["maternity", "maternity"],

  ["hdud", "hdud"],
  ["hdud_era", "hdud"],

  ["career", "career"],
  ["professional_life", "career"],
  ["first_job", "career"],

  ["education", "education"],
  ["school", "education"],

  ["health_crisis", "health"],
  ["recovery", "health"],

  ["childhood", "childhood"],
]);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function clampScore(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeToken(value) {
  return safeText(value, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function firstValue(memory = {}, keys = []) {
  for (const key of keys) {
    const value = memory?.[key] ?? memory?.editorial?.[key] ?? memory?.taxonomy?.[key];
    if (value !== undefined && value !== null && safeText(value, "")) return value;
  }
  return null;
}

function narrativeFamilyOf({ life_period, context, canonical_story }) {
  if (context && FAMILY_BY_CONTEXT.has(context)) return FAMILY_BY_CONTEXT.get(context);
  if (life_period && FAMILY_BY_LIFE_PERIOD.has(life_period)) return FAMILY_BY_LIFE_PERIOD.get(life_period);

  if (canonical_story) {
    for (const [token, family] of FAMILY_BY_CONTEXT.entries()) {
      if (canonical_story.includes(token)) return family;
    }
    for (const [token, family] of FAMILY_BY_LIFE_PERIOD.entries()) {
      if (canonical_story.includes(token)) return family;
    }
  }

  return context || life_period || canonical_story || "unclassified";
}

function profileOf(memory = {}) {
  const path = extractNarrativePath(memory);
  const lifePeriod = normalizeToken(
    path?.life_period_code ||
    path?.life_period ||
    firstValue(memory, ["life_period_code", "life_period", "period_code", "period"])
  );
  const context = normalizeToken(
    path?.context_code ||
    path?.editorial_context_code ||
    path?.context ||
    firstValue(memory, ["context_code", "editorial_context_code", "editorial_context", "context"])
  );
  const role = normalizeToken(
    path?.narrative_role_code ||
    path?.narrative_role ||
    firstValue(memory, ["narrative_role_code", "narrative_role", "story_role"])
  );
  const canonical = normalizeToken(
    firstValue(memory, ["canonical_story_key", "narrative_arc_code", "canonical_story_title"])
  );
  const phase = normalizeToken(firstValue(memory, ["phase_id", "phase_name"]));
  const year = safeYear(memoryCanonicalDate(memory));

  const base = {
    memory,
    memory_id: memoryIdOf(memory),
    life_period: lifePeriod,
    context,
    narrative_role: role,
    canonical_story: canonical,
    phase,
    year,
    path_complete: Boolean(path?.complete),
  };

  return {
    ...base,
    narrative_family: narrativeFamilyOf(base),
  };
}

function same(left, right, key) {
  return Boolean(left?.[key] && right?.[key] && left[key] === right[key]);
}

function yearsApart(left, right) {
  if (!left?.year || !right?.year) return null;
  return Math.abs(Number(left.year) - Number(right.year));
}

function pairAffinity(left, right) {
  let score = 0;
  const reasons = [];

  if (same(left, right, "narrative_family")) {
    score += 42;
    reasons.push("narrative_family");
  } else if (left?.narrative_family && right?.narrative_family) {
    score -= 34;
    reasons.push("different_narrative_family");
  }

  if (same(left, right, "context")) {
    score += 24;
    reasons.push("context");
  }
  if (same(left, right, "life_period")) {
    score += 16;
    reasons.push("life_period");
  }
  if (same(left, right, "canonical_story")) {
    score += 20;
    reasons.push("canonical_story");
  }
  if (same(left, right, "narrative_role")) {
    score += 5;
    reasons.push("narrative_role");
  }

  const gap = yearsApart(left, right);
  if (gap === 0) {
    score += 5;
    reasons.push("same_year");
  } else if (gap === 1) {
    score += 4;
    reasons.push("adjacent_year");
  } else if (gap !== null && gap <= 3) {
    score += 2;
    reasons.push("near_time");
  } else if (gap !== null && gap >= 10) {
    score -= 8;
    reasons.push("large_time_gap");
  }

  if (left.path_complete && right.path_complete) score += 3;

  return {
    score: clampScore(score),
    raw_score: score,
    reasons,
    explicit_conflict:
      Boolean(left?.narrative_family && right?.narrative_family) &&
      left.narrative_family !== right.narrative_family,
  };
}

function dominantValue(profiles = [], key) {
  const counts = new Map();
  for (const profile of safeArray(profiles)) {
    const value = profile?.[key];
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

function segmentIdentity(profiles = []) {
  return (
    dominantValue(profiles, "narrative_family") ||
    dominantValue(profiles, "canonical_story") ||
    dominantValue(profiles, "context") ||
    dominantValue(profiles, "life_period") ||
    "trajectory"
  );
}

function segmentCohesion(profiles = []) {
  const safeProfiles = safeArray(profiles);
  if (safeProfiles.length <= 1) return 100;

  let total = 0;
  let pairs = 0;

  for (let leftIndex = 0; leftIndex < safeProfiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < safeProfiles.length; rightIndex += 1) {
      total += pairAffinity(safeProfiles[leftIndex], safeProfiles[rightIndex]).score;
      pairs += 1;
    }
  }

  return pairs ? clampScore(total / pairs) : 0;
}

function externalAffinity(segment, other) {
  const scores = [];
  for (const left of segment.profiles) {
    for (const right of other.profiles) {
      scores.push(pairAffinity(left, right).score);
    }
  }
  return scores.length ? Math.max(...scores) : 0;
}

function independenceScore(segment, others = []) {
  const safeOthers = safeArray(others);
  if (!safeOthers.length) return 100;

  const strongestExternalAffinity = Math.max(
    ...safeOthers.map((other) => externalAffinity(segment, other)),
    0
  );

  const ownCohesion = segmentCohesion(segment.profiles);
  return clampScore((ownCohesion * 0.62) + ((100 - strongestExternalAffinity) * 0.38));
}

function createSegment(profiles = [], sourceIndex = 0, splitIndex = 0) {
  const sorted = [...safeArray(profiles)].sort((a, b) => compareMemoryDate(a.memory, b.memory));
  const years = sorted.map((profile) => profile.year).filter(Boolean).sort((a, b) => a - b);

  return {
    segment_id: `segment_${sourceIndex + 1}_${splitIndex + 1}`,
    profiles: sorted,
    memories: sorted.map((profile) => profile.memory),
    trajectory_key: segmentIdentity(sorted),
    cohesion_score: segmentCohesion(sorted),
    first_year: years[0] || null,
    last_year: years[years.length - 1] || null,
  };
}

function groupByNarrativeFamily(profiles = [], sourceIndex = 0) {
  const families = new Map();

  for (const profile of safeArray(profiles)) {
    const family = profile.narrative_family || "unclassified";
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(profile);
  }

  const segments = [];
  const unresolved = [];

  for (const [family, members] of families.entries()) {
    const sorted = [...members].sort((a, b) => compareMemoryDate(a.memory, b.memory));

    if (sorted.length < MIN_CANDIDATE_MEMORIES) {
      unresolved.push(...sorted);
      continue;
    }

    for (let offset = 0; offset < sorted.length; offset += MAX_CANDIDATE_MEMORIES) {
      const slice = sorted.slice(offset, offset + MAX_CANDIDATE_MEMORIES);
      if (slice.length >= MIN_CANDIDATE_MEMORIES) {
        const segment = createSegment(slice, sourceIndex, segments.length);
        segment.trajectory_key = family;
        segments.push(segment);
      } else {
        unresolved.push(...slice);
      }
    }
  }

  return { segments, unresolved };
}

function bestMergeTarget(profile, segments = []) {
  let best = null;

  for (const segment of safeArray(segments)) {
    if (segment.memories.length >= MAX_CANDIDATE_MEMORIES) continue;

    const sameFamily = segment.trajectory_key === profile.narrative_family;
    const affinity = Math.max(
      ...segment.profiles.map((candidate) => pairAffinity(profile, candidate).score),
      0
    );

    const score = affinity + (sameFamily ? 30 : 0);
    if (!best || score > best.score) best = { segment, score, affinity, sameFamily };
  }

  return best;
}

function rebalanceUnresolved(segments = [], unresolvedProfiles = []) {
  const remaining = [];

  for (const profile of safeArray(unresolvedProfiles)) {
    const target = bestMergeTarget(profile, segments);

    // Uma memória órfã só entra em um candidato quando pertence à mesma
    // família narrativa e possui afinidade concreta. Caso contrário, fica fora.
    if (target?.sameFamily && target.affinity >= 38) {
      target.segment.profiles.push(profile);
      target.segment.profiles.sort((a, b) => compareMemoryDate(a.memory, b.memory));
      target.segment.memories = target.segment.profiles.map((item) => item.memory);
      target.segment.cohesion_score = segmentCohesion(target.segment.profiles);
      target.segment.rebalanced = true;
      target.segment.rebalanced_memory_ids = [
        ...safeArray(target.segment.rebalanced_memory_ids),
        profile.memory_id,
      ];
    } else {
      remaining.push(profile);
    }
  }

  return { segments, unresolved: remaining };
}

function titleForSegment(segment, hypothesis = null) {
  const family = segment.trajectory_key;

  const canonicalTitle = segment.memories
    .map((memory) => safeText(memory?.canonical_story_title, ""))
    .find(Boolean);

  if (canonicalTitle) return canonicalTitle;

  const labels = {
    relationships: "Relacionamentos e amor",
    paternity: "Paternidade",
    maternity: "Maternidade",
    hdud: "A origem da HDUD",
    career: "A construção da carreira",
    education: "Educação e formação",
    health: "Saúde e superação",
    childhood: "Infância",
    family: "Família",
  };

  return labels[family] || safeText(family.replace(/_/g, " "), hypothesis?.title || "História em descoberta");
}

function seedForSegment(seed = {}, segment, sourceIndex, segmentIndex, allSegments) {
  const memoryIds = new Set(segment.memories.map(memoryIdOf).map(Number));
  const potentials = safeArray(seed.narrative_potential)
    .filter((item) => memoryIds.has(Number(item?.memory_id)));
  const hypothesis = seed.narrative_hypothesis || seed.hypothesis || null;
  const independence = independenceScore(
    segment,
    allSegments.filter((item) => item.segment_id !== segment.segment_id)
  );
  const segmentTitle = titleForSegment(segment, hypothesis);

  return {
    ...seed,
    memories: segment.memories,
    foundation_memory_id: memoryIds.has(Number(seed.foundation_memory_id))
      ? seed.foundation_memory_id
      : (segment.memories[0] ? memoryIdOf(segment.memories[0]) : null),
    narrative_potential: potentials,
    narrative_hypothesis: hypothesis
      ? {
          ...hypothesis,
          title: segmentTitle,
          memory_ids: segment.memories.map(memoryIdOf).filter(Boolean),
          memories: segment.memories.map(memoryIdOf).filter(Boolean),
          calibration_source_hypothesis_id: hypothesis.hypothesis_id || null,
          calibration_trajectory_key: segment.trajectory_key,
        }
      : null,
    calibration: {
      engine: ENGINE_VERSION,
      calibrated: allSegments.length > 1,
      source_seed_index: sourceIndex,
      segment_index: segmentIndex,
      segment_id: segment.segment_id,
      trajectory_key: segment.trajectory_key,
      memory_ids: segment.memories.map(memoryIdOf).filter(Boolean),
      memory_count: segment.memories.length,
      cohesion_score: segment.cohesion_score,
      independence_score: independence,
      arc_diversity_score: independence,
      first_year: segment.first_year,
      last_year: segment.last_year,
      rebalanced: Boolean(segment.rebalanced),
      rebalanced_memory_ids: safeArray(segment.rebalanced_memory_ids),
      boundary_strategy: "NARRATIVE_FAMILY_PRIMARY",
      policy: "Narrative Path define a família; tempo, papel dramático e canonical story refinam a coerência.",
    },
  };
}

export function calibrateStorySeeds({
  seeds = [],
  authorId = null,
  boundaryThreshold = null,
} = {}) {
  const calibratedSeeds = [];
  const diagnostics = [];
  const unresolvedMemories = [];
  const normalizedSeeds = safeArray(seeds).filter(Boolean);

  normalizedSeeds.forEach((seed, sourceIndex) => {
    const profiles = safeArray(seed?.memories)
      .filter((memory) => memoryIdOf(memory))
      .map(profileOf)
      .sort((a, b) => compareMemoryDate(a.memory, b.memory));

    if (profiles.length < MIN_CANDIDATE_MEMORIES) {
      diagnostics.push({
        source_seed_index: sourceIndex,
        source_memory_count: profiles.length,
        segment_count: 0,
        reason: "INSUFFICIENT_MEMORIES",
      });
      return;
    }

    const grouped = groupByNarrativeFamily(profiles, sourceIndex);
    const rebalanced = rebalanceUnresolved(grouped.segments, grouped.unresolved);
    const usableSegments = rebalanced.segments;

    unresolvedMemories.push(...rebalanced.unresolved.map((profile) => profile.memory));

    usableSegments.forEach((segment, segmentIndex) => {
      calibratedSeeds.push(seedForSegment(seed, segment, sourceIndex, segmentIndex, usableSegments));
    });

    diagnostics.push({
      source_seed_index: sourceIndex,
      source_memory_count: profiles.length,
      boundary_strategy: "NARRATIVE_FAMILY_PRIMARY",
      segment_count: usableSegments.length,
      unresolved_memory_ids: rebalanced.unresolved
        .map((profile) => profile.memory_id)
        .filter(Boolean),
      segments: usableSegments.map((segment) => ({
        segment_id: segment.segment_id,
        trajectory_key: segment.trajectory_key,
        memory_ids: segment.memories.map(memoryIdOf).filter(Boolean),
        memory_count: segment.memories.length,
        cohesion_score: segment.cohesion_score,
        first_year: segment.first_year,
        last_year: segment.last_year,
        rebalanced: Boolean(segment.rebalanced),
      })),
    });
  });

  return {
    engine: ENGINE_VERSION,
    author_id: authorId,
    calibrated_seeds: calibratedSeeds,
    diagnostics,
    unresolved_memories: unresolvedMemories,
    statistics: {
      source_seed_count: normalizedSeeds.length,
      calibrated_seed_count: calibratedSeeds.length,
      source_memory_count: normalizedSeeds.reduce(
        (sum, seed) => sum + safeArray(seed?.memories).length,
        0
      ),
      unresolved_memory_count: unresolvedMemories.length,
      multi_arc_ready: calibratedSeeds.length >= 2,
      boundary_strategy: "NARRATIVE_FAMILY_PRIMARY",
    },
    policy: "Story Calibration separa trajetórias humanas reais e mantém memórias sem par fora de Candidates artificiais.",
  };
}

export const StoryCalibrationEngine = {
  calibrateStorySeeds,
};
