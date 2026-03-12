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
    return (items || []).filter((x) => String(x?.type || "").toLowerCase() === "memory");
  }

  if (type === "chapter") {
    return (items || []).filter((x) => String(x?.type || "").toLowerCase() === "chapter");
  }

  return items || [];
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

    const warnings = buildTimelineWarnings({
      q,
      narrativeTableExists: narrativePack.exists,
      narrativeRowsCount: eventItems.length,
      fallbackActive: memoryFallbackItems.length > 0 || chapterFallbackItems.length > 0,
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
        source_mode: "TIMELINE_HYBRID_vNEXT_CONTEXTUAL",
        query: {
          q,
          type,
          limit,
          contextual_memory_search: true,
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
        },
        breakdown: {
          narrative_events_raw: eventItems.length,
          fallback_memories_raw: memoryFallbackItems.length,
          fallback_chapters_raw: chapterFallbackItems.length,
          memory_direct_match_raw: directMemoryMatches,
          memory_chapter_context_raw: contextMemoryMatches,
          hybrid_result_before_limit: typedAll.length,
          hybrid_result_visible: visibleItems.length,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}