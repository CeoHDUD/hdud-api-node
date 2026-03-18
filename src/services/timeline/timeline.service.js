// C:\HDUD_DATA\hdud-api-node\src\services\timeline\timeline.service.js

import { getPool } from "../../db.js";
import {
  normalizeTimelineParams,
  buildTimelineWarnings,
  countDistinctKinds,
} from "./timeline.search.js";
import {
  normalizeNarrativeEventRow,
  normalizeMemoryFallbackRow,
  normalizeChapterFallbackRow,
  mergeHybridTimeline,
} from "./timeline.normalize.js";
import {
  fetchNarrativeEventRows,
  fetchMemoryFallbackRows,
  fetchChapterFallbackRows,
  fetchInventoryCounts,
} from "./timeline.sql.js";

function getAuthorIdFromToken(req) {
  const authorId = Number(req.user?.author_id);
  if (!Number.isInteger(authorId) || authorId <= 0) return null;
  return authorId;
}

function applyTypeFilter(items, type) {
  if (type === "memory") {
    return (items || []).filter(
      (x) => String(x?.type || "").toLowerCase() === "memory"
    );
  }

  if (type === "chapter") {
    return (items || []).filter(
      (x) => String(x?.type || "").toLowerCase() === "chapter"
    );
  }

  return items || [];
}

function buildEditorialSummary(items) {
  let maxScore = null;
  let minScore = null;
  let sumScore = 0;

  const scoreBuckets = {
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const item of items || []) {
    const score = Number(item?.meta?.editorial_score || 0);
    sumScore += score;

    if (maxScore == null || score > maxScore) maxScore = score;
    if (minScore == null || score < minScore) minScore = score;

    if (score >= 12) {
      scoreBuckets.high += 1;
    } else if (score >= 7) {
      scoreBuckets.medium += 1;
    } else {
      scoreBuckets.low += 1;
    }
  }

  return {
    score_max: maxScore ?? 0,
    score_min: minScore ?? 0,
    score_avg: (items || []).length
      ? Number((sumScore / items.length).toFixed(2))
      : 0,
    buckets: scoreBuckets,
  };
}

function buildNarrativeThreadSummary(items) {
  const map = new Map();

  for (const item of items || []) {
    const entityKey =
      typeof item?.meta?.entity_key === "string" && item.meta.entity_key.trim()
        ? item.meta.entity_key.trim()
        : `${String(item?.type || "event").toLowerCase()}:${item?.source_id ?? "unknown"}`;

    if (!map.has(entityKey)) {
      map.set(entityKey, []);
    }

    map.get(entityKey).push(item);
  }

  let multiEventThreads = 0;

  for (const list of map.values()) {
    if ((list || []).length > 1) {
      multiEventThreads += 1;
    }
  }

  return {
    total_threads: map.size,
    multi_event_threads: multiEventThreads,
  };
}

export async function handleTimeline(req, res, next) {
  try {
    const authorId = getAuthorIdFromToken(req);
    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const { limit, type, q } = normalizeTimelineParams(req.query || {});
    const fetchLimit = Math.min(Math.max(limit * 3, 300), 2000);

    const pool = await getPool();

    const [
      inventoryTotal,
      inventoryFiltered,
      narrativePack,
      memoryRows,
      chapterRows,
    ] = await Promise.all([
      fetchInventoryCounts(pool, { authorId, q: "" }),
      fetchInventoryCounts(pool, { authorId, q }),
      fetchNarrativeEventRows(pool, { authorId, q, limit: fetchLimit }),
      fetchMemoryFallbackRows(pool, { authorId, q, limit: fetchLimit }),
      fetchChapterFallbackRows(pool, { authorId, q, limit: fetchLimit }),
    ]);

    const contextMemoryMatches = (memoryRows || []).filter(
      (x) => Number(x?.chapter_context_score || 0) > 0
    ).length;

    const directMemoryMatches = (memoryRows || []).filter(
      (x) => Number(x?.direct_match_score || 0) > 0
    ).length;

    const memoryPrimaryChapterResolvedRaw = (memoryRows || []).filter(
      (x) => Number(x?.chapter_is_primary || 0) === 1
    ).length;

    const narrativePrimaryChapterResolvedRaw = (narrativePack.rows || []).filter(
      (x) => Number(x?.chapter_is_primary || 0) === 1
    ).length;

    const metadataTitleRecoveredRaw = (narrativePack.rows || []).filter((x) => {
      const rawTitle = String(x?.title ?? "").trim();
      const metadataJson = String(x?.metadata_json ?? "").trim();
      const resolvedLookup = String(x?.memory_title ?? x?.chapter_title ?? "").trim();
      return !rawTitle && (metadataJson || resolvedLookup);
    }).length;

    const eventItems = (narrativePack.rows || [])
      .map(normalizeNarrativeEventRow)
      .filter(Boolean);

    const memoryFallbackItems = (memoryRows || [])
      .map(normalizeMemoryFallbackRow)
      .filter(Boolean);

    const chapterFallbackItems = (chapterRows || [])
      .map(normalizeChapterFallbackRow)
      .filter(Boolean);

    const hybridAll = mergeHybridTimeline({
      eventItems,
      memoryFallbackItems,
      chapterFallbackItems,
    });

    const typedAll = applyTypeFilter(hybridAll, type);
    const visibleItems = typedAll.slice(0, limit);

    const resultCounts = countDistinctKinds(typedAll);
    const visibleCounts = countDistinctKinds(visibleItems);
    const narrativeThreadsAll = buildNarrativeThreadSummary(typedAll);
    const narrativeThreadsVisible = buildNarrativeThreadSummary(visibleItems);

    const warnings = buildTimelineWarnings({
      q,
      narrativeTableExists: narrativePack.exists,
      narrativeRowsCount: eventItems.length,
      fallbackActive:
        memoryFallbackItems.length > 0 || chapterFallbackItems.length > 0,
      resultCount: typedAll.length,
      limit,
    });

    if (q && contextMemoryMatches > 0) {
      warnings.push(
        `${contextMemoryMatches} memória(s) foram incluídas por contexto de capítulo relacionado à busca.`
      );
    }

    return res.json({
      ok: true,
      items: visibleItems,
      warnings,
      meta: {
        generated_at: new Date().toISOString(),
        source_mode: "TIMELINE_HYBRID_EDITORIAL_v1_PREMIUM",
        query: {
          q,
          type,
          limit,
          contextual_memory_search: true,
          editorial_ranking: true,
          narrative_threads: true,
        },
        inventory: {
          memories: inventoryTotal.memories,
          chapters: inventoryTotal.chapters,
          total: inventoryTotal.memories + inventoryTotal.chapters,
        },
        search_inventory: {
          memories: inventoryFiltered.memories,
          chapters: inventoryFiltered.chapters,
          total: inventoryFiltered.memories + inventoryFiltered.chapters,
        },
        summary: {
          inventory: {
            memories: inventoryTotal.memories,
            chapters: inventoryTotal.chapters,
            total: inventoryTotal.memories + inventoryTotal.chapters,
          },
          search: {
            memories: inventoryFiltered.memories,
            chapters: inventoryFiltered.chapters,
            total: inventoryFiltered.memories + inventoryFiltered.chapters,
          },
          result: resultCounts,
          visible: visibleCounts,
          editorial: buildEditorialSummary(typedAll),
          narrative_threads: {
            total_threads: narrativeThreadsAll.total_threads,
            multi_event_threads: narrativeThreadsAll.multi_event_threads,
            visible_threads: narrativeThreadsVisible.total_threads,
            visible_multi_event_threads:
              narrativeThreadsVisible.multi_event_threads,
          },
        },
        breakdown: {
          narrative_events_raw: eventItems.length,
          fallback_memories_raw: memoryFallbackItems.length,
          fallback_chapters_raw: chapterFallbackItems.length,
          memory_direct_match_raw: directMemoryMatches,
          memory_chapter_context_raw: contextMemoryMatches,
          memory_primary_chapter_resolved_raw: memoryPrimaryChapterResolvedRaw,
          narrative_primary_chapter_resolved_raw:
            narrativePrimaryChapterResolvedRaw,
          metadata_title_recovered_candidate_raw: metadataTitleRecoveredRaw,
          hybrid_result_before_limit: typedAll.length,
          hybrid_result_visible: visibleItems.length,
          narrative_threads_total: narrativeThreadsAll.total_threads,
          narrative_threads_multi_event: narrativeThreadsAll.multi_event_threads,
          narrative_threads_visible: narrativeThreadsVisible.total_threads,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}