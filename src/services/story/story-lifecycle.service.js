// C:\HDUD_DATA\hdud-api-node\src\services\story\story-lifecycle.service.js

import { discoverStoryHypothesesForAuthor } from "./story-discovery-orchestrator.service.js";
import {
  listActiveNarrativeStories,
  clearAuthorNarrativeDiscovery,
  saveNarrativeStories,
  setNarrativeStoryStatus,
} from "./story-repository.sql.service.js";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeConfidence(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  if (n <= 1) {
    return Math.max(0, Math.min(100, Math.round(n * 100)));
  }

  return Math.max(0, Math.min(100, Math.round(n)));
}

function safeYear(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    const n = Math.trunc(value);
    if (n >= 1800 && n <= 2200) return n;
  }

  const text = String(value || "").trim();
  if (!text) return null;

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    if (y >= 1800 && y <= 2200) return y;
  }

  const match = text.match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2}|2200)\b/);
  return match ? Number(match[1]) : null;
}

function normalizeString(value) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function getStoryId(story) {
  return (
    toPositiveInt(story?.story_id) ||
    toPositiveInt(story?.id) ||
    toPositiveInt(story?.narrative_story_id) ||
    null
  );
}

function getMemoryCount(story) {
  const direct =
    story?.memory_count ??
    story?.memories_count ??
    story?.related_memory_count ??
    story?.evidence_count ??
    null;

  const n = Number(direct);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);

  const memories =
    story?.memories ||
    story?.related_memories ||
    story?.memory_items ||
    story?.evidence ||
    [];

  return Array.isArray(memories) ? memories.length : 0;
}

function extractMemoriesFromStory(story) {
  const candidates = [
    story?.memories,
    story?.related_memories,
    story?.memory_items,
    story?.evidence,
    story?.items,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function extractYearsFromStory(story) {
  const explicitFirst = safeYear(
    story?.first_year ??
      story?.start_year ??
      story?.year_start ??
      story?.from_year ??
      story?.period_start
  );

  const explicitLast = safeYear(
    story?.last_year ??
      story?.end_year ??
      story?.year_end ??
      story?.to_year ??
      story?.period_end
  );

  if (explicitFirst || explicitLast) {
    return {
      first_year: explicitFirst || explicitLast,
      last_year: explicitLast || explicitFirst,
    };
  }

  const memories = extractMemoriesFromStory(story);
  const years = memories
    .map((memory) =>
      safeYear(
        memory?.memory_date ??
          memory?.narrative_date ??
          memory?.event_date ??
          memory?.occurred_at ??
          memory?.created_at ??
          memory?.year
      )
    )
    .filter((year) => Number.isInteger(year))
    .sort((a, b) => a - b);

  if (!years.length) {
    const fallbackYear = safeYear(
      story?.created_at ??
        story?.updated_at ??
        story?.discovered_at ??
        story?.generated_at
    );

    return {
      first_year: fallbackYear,
      last_year: fallbackYear,
    };
  }

  return {
    first_year: years[0],
    last_year: years[years.length - 1],
  };
}

function buildDominantTheme(story) {
  return normalizeString(
    story?.dominant_theme ??
      story?.theme ??
      story?.theme_label ??
      story?.primary_theme ??
      story?.category ??
      story?.narrative_theme
  );
}

function buildOneLineSummary(story) {
  const existing = normalizeString(
    story?.one_line_summary ??
      story?.summary_line ??
      story?.short_summary ??
      story?.headline ??
      story?.insight
  );

  if (existing) return existing;

  const transformation = normalizeString(
    story?.transformation ??
      story?.transformation_summary ??
      story?.perceived_transformation ??
      story?.narrative_transformation
  );

  if (transformation) return transformation;

  const centralQuestion = normalizeString(
    story?.central_question ??
      story?.guiding_question ??
      story?.question
  );

  if (centralQuestion) return centralQuestion;

  const memoryCount = getMemoryCount(story);

  if (memoryCount > 1) {
    return `Encontramos ${memoryCount} memórias que parecem formar uma transformação importante.`;
  }

  return "Percebemos uma história começando a surgir entre suas memórias.";
}

function enrichStoryForUi(story = {}) {
  const confidence = normalizeConfidence(story?.confidence ?? story?.confidence_score);
  const years = extractYearsFromStory(story);
  const memoryCount = getMemoryCount(story);

  return {
    ...story,
    story_id: getStoryId(story) ?? story?.story_id ?? story?.id ?? story?.narrative_story_id,
    title:
      normalizeString(story?.title ?? story?.name ?? story?.label) ||
      "História descoberta",
    status: normalizeString(story?.status) || "EMERGING",
    confidence,
    confidence_score: confidence,
    memory_count: memoryCount,
    memories_count: memoryCount,
    one_line_summary: buildOneLineSummary(story),
    dominant_theme: buildDominantTheme(story),
    first_year: years.first_year,
    last_year: years.last_year,
  };
}

function enrichStoryPayloadForUi(payload) {
  if (Array.isArray(payload)) {
    return payload.map(enrichStoryForUi);
  }

  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (Array.isArray(payload.stories)) {
    return {
      ...payload,
      stories: payload.stories.map(enrichStoryForUi),
    };
  }

  if (Array.isArray(payload.items)) {
    return {
      ...payload,
      items: payload.items.map(enrichStoryForUi),
    };
  }

  if (Array.isArray(payload.data)) {
    return {
      ...payload,
      data: payload.data.map(enrichStoryForUi),
    };
  }

  return enrichStoryForUi(payload);
}


function uniqueValidMemories(memories = []) {
  const seen = new Set();

  return safeArray(memories).filter((memory) => {
    const memoryId = toPositiveInt(memory?.memory_id ?? memory?.id ?? memory);
    if (!memoryId || seen.has(memoryId)) return false;
    seen.add(memoryId);
    return true;
  });
}

function truthKeepMemories(candidate = {}) {
  const truthSelection = candidate?.truth_selection || candidate?.truthSelection || null;
  const selected = safeArray(
    truthSelection?.selected ||
      truthSelection?.used_memories ||
      truthSelection?.keep_memories
  );

  return uniqueValidMemories(selected);
}

function candidateDiscoveryMemories(candidate = {}) {
  const directSources = [
    candidate?.related_memories,
    candidate?.memories,
    candidate?.memory_items,
    candidate?.used_memories,
    candidate?.evidence,
    candidate?.items,
    candidate?.story_blueprint?.used_memories,
    candidate?.blueprint?.used_memories,
  ];

  for (const source of directSources) {
    const memories = uniqueValidMemories(source);
    if (memories.length) return memories;
  }

  const memoryIds = uniqueValidMemories(
    safeArray(candidate?.memory_ids).map((memoryId) => ({ memory_id: memoryId }))
  );

  return memoryIds;
}

function persistenceMemories(candidate = {}) {
  const truthMemories = truthKeepMemories(candidate);
  if (truthMemories.length) {
    return {
      memories: truthMemories,
      selectionSource: "TRUTH_KEEP",
    };
  }

  const discoveryMemories = candidateDiscoveryMemories(candidate);
  return {
    memories: discoveryMemories,
    selectionSource: discoveryMemories.length ? "DISCOVERY_CANDIDATE" : "NONE",
  };
}

function collectPersistenceCandidates(discovery = {}) {
  const sources = [
    discovery?.visible_candidates,
    discovery?.candidates,
    discovery?.stories,
    discovery?.story_discovery,
    discovery?.hypotheses,
  ];

  const output = [];
  const seen = new Set();

  for (const source of sources) {
    for (const candidate of safeArray(source)) {
      if (!candidate || typeof candidate !== "object") continue;

      const candidateKey = String(
        candidate?.candidate_id ??
          candidate?.story_id ??
          candidate?.id ??
          candidate?.hypothesis_id ??
          `${normalizeString(candidate?.title) || "story"}:${output.length}`
      );

      if (seen.has(candidateKey)) continue;
      seen.add(candidateKey);
      output.push(candidate);
    }
  }

  return output;
}

function buildCurrentPersistenceStories(discovery = {}) {
  const candidates = collectPersistenceCandidates(discovery);

  return candidates
    .map((candidate) => {
      const { memories, selectionSource } = persistenceMemories(candidate);
      if (!memories.length) return null;

      const memoryIds = memories
        .map((memory) => toPositiveInt(memory?.memory_id ?? memory?.id ?? memory))
        .filter(Boolean);

      return {
        ...candidate,
        related_memories: memories,
        memory_ids: memoryIds,
        memory_count: memories.length,
        memories_count: memories.length,
        source_payload: {
          ...(candidate?.source_payload && typeof candidate.source_payload === "object"
            ? candidate.source_payload
            : {}),
          candidate_id: candidate?.candidate_id || candidate?.story_id || candidate?.id || null,
          hypothesis_id: candidate?.hypothesis_id || null,
          truth_selection: candidate?.truth_selection || candidate?.truthSelection || null,
          persistence_memory_source: selectionSource,
          selected_memory_ids: memoryIds,
        },
      };
    })
    .filter(Boolean);
}

export async function discoverAndPersistStoriesForAuthor({
  authorId,
  memories = [],
  limit = 300,
} = {}) {
  const safeAuthorId = toPositiveInt(authorId);

  if (!safeAuthorId) {
    return {
      ok: false,
      reason: "authorId inválido.",
      hypotheses: [],
      persisted: {
        ok: false,
        saved_count: 0,
        results: [],
      },
    };
  }

  const discovery = await discoverStoryHypothesesForAuthor({
    authorId: safeAuthorId,
    memories: safeArray(memories),
    limit,
  });

  const hypotheses = safeArray(discovery?.hypotheses ?? discovery);
  const enrichedHypotheses = hypotheses.map(enrichStoryForUi);
  const currentStories = buildCurrentPersistenceStories(discovery);

  // Regra de segurança: uma descoberta vazia nunca pode apagar o acervo atual.
  // Mantemos as histórias materializadas até existir um novo conjunto válido.
  if (!currentStories.length) {
    const existing = await listActiveNarrativeStories({
      authorId: safeAuthorId,
      limit: 300,
      includeSnoozed: true,
    });

    return {
      ...discovery,
      ok: discovery?.ok !== false,
      engine: "HDUD Story Lifecycle Service v1",
      discovery_engine: discovery?.engine || null,
      author_id: safeAuthorId,
      hypotheses: enrichedHypotheses,
      stories: safeArray(existing?.stories ?? existing?.items ?? existing?.data ?? existing),
      persisted: {
        ok: true,
        saved_count: 0,
        preserved_existing: true,
        reason: "A descoberta atual não produziu histórias KEEP válidas; o acervo anterior foi preservado.",
        results: [],
      },
      cleared: {
        ok: true,
        skipped: true,
        reason: "Nenhuma nova história válida para substituir o acervo atual.",
      },
      meta: {
        ...(discovery?.meta || {}),
        generated_at: new Date().toISOString(),
        persistence_policy: "Descobertas vazias nunca removem histórias materializadas existentes.",
      },
    };
  }

  const cleared = await clearAuthorNarrativeDiscovery({
    authorId: safeAuthorId,
  });

  const persisted = await saveNarrativeStories(currentStories, {
    authorId: safeAuthorId,
    sourceEngine: discovery?.engine || "story-discovery-orchestrator",
    sourceVersion: discovery?.version || null,
  });

  return {
    ...discovery,
    ok: discovery?.ok !== false && persisted?.ok !== false,
    engine: "HDUD Story Lifecycle Service v1",
    discovery_engine: discovery?.engine || null,
    author_id: safeAuthorId,
    hypotheses: enrichedHypotheses,
    story_discovery: safeArray(discovery?.story_discovery).length
      ? safeArray(discovery.story_discovery).map(enrichStoryForUi)
      : enrichedHypotheses,
    candidates: safeArray(discovery?.candidates),
    visible_candidates: safeArray(discovery?.visible_candidates),
    stories: safeArray(discovery?.stories),
    blueprints: safeArray(discovery?.blueprints),
    narrative_arcs: safeArray(discovery?.narrative_arcs),
    validated_arcs: safeArray(discovery?.validated_arcs),
    seed_diagnostics: safeArray(discovery?.seed_diagnostics),
    truth_summary: discovery?.truth_summary || null,
    persisted,
    cleared,
    meta: {
      ...(discovery?.meta || {}),
      generated_at: new Date().toISOString(),
      discovery_engine: discovery?.engine || null,
      lifecycle_engine: "HDUD Story Lifecycle Service v1",
      persistence_policy: "As histórias só são reconstruídas por ação explícita do autor e apenas quando a descoberta atual produz histórias KEEP válidas.",
      narrative_arc_summary: discovery?.meta?.narrative_arc_summary || null,
      source_policy:
        "Histórias descobertas são persistidas como hipóteses narrativas. A IA propõe; o autor decide.",
    },
  };
}

export async function listAuthorActiveStories({
  authorId,
  limit = 20,
  includeSnoozed = false,
} = {}) {
  const result = await listActiveNarrativeStories({
    authorId,
    limit,
    includeSnoozed,
  });

  return enrichStoryPayloadForUi(result);
}

export async function acceptNarrativeStory({ authorId, storyId } = {}) {
  return setNarrativeStoryStatus({
    authorId,
    storyId,
    status: "ACCEPTED",
  });
}

export async function discardNarrativeStory({ authorId, storyId } = {}) {
  return setNarrativeStoryStatus({
    authorId,
    storyId,
    status: "DISCARDED",
  });
}

export async function snoozeNarrativeStory({
  authorId,
  storyId,
  snoozedUntil,
} = {}) {
  return setNarrativeStoryStatus({
    authorId,
    storyId,
    status: "SNOOZED",
    snoozedUntil,
  });
}

export async function markNarrativeStoryConvertedToChapter({
  authorId,
  storyId,
  chapterId,
} = {}) {
  return setNarrativeStoryStatus({
    authorId,
    storyId,
    status: "CONVERTED_TO_CHAPTER",
    chapterId,
  });
}
