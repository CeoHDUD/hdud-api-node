// C:\HDUD_DATA\hdud-api-node\src\services\narrative-events.js

import { getPool, sql } from "../db.js";

const ALLOWED_EVENT_TYPES = new Set([
  "memory_unlinked_from_chapter",
  "timeline_milestone",
  "chapter_unpublished",
  "chapter_published",
  "memory_edited",
  "chapter_evolved",
  "chapter_created",
  "memory_reordered",
  "memory_linked_to_chapter",
  "memory_created",
]);

const EVENT_TYPE_ALIASES = {
  chapter_ai_suggestion_generated: "chapter_evolved",
};

function normalizeNarrativeEventType(eventType) {
  const raw = String(eventType || "").trim();
  if (!raw) return "timeline_milestone";

  if (ALLOWED_EVENT_TYPES.has(raw)) return raw;

  const alias = EVENT_TYPE_ALIASES[raw];
  if (alias && ALLOWED_EVENT_TYPES.has(alias)) return alias;

  return "timeline_milestone";
}

/**
 * Cria evento narrativo no HDUD
 */
export async function createNarrativeEvent({
  authorId,
  eventType,
  memoryId = null,
  chapterId = null,
  eventKey = null,
  metadata = null,
}) {
  const normalizedEventType = normalizeNarrativeEventType(eventType);

  const mergedMetadata = {
    ...(metadata && typeof metadata === "object" ? metadata : {}),
    original_event_type: eventType ?? null,
    normalized_event_type: normalizedEventType,
  };

  const pool = await getPool();
  const req = pool.request();

  req.input("author_id", sql.Int, authorId);
  req.input("event_type", sql.VarChar(64), normalizedEventType);
  req.input("memory_id", sql.Int, memoryId);
  req.input("chapter_id", sql.Int, chapterId);
  req.input("event_key", sql.VarChar(300), eventKey);
  req.input(
    "metadata_json",
    sql.NVarChar(sql.MAX),
    JSON.stringify(mergedMetadata)
  );

  await req.execute("dbo.p_CreateNarrativeEvent");
}

/**
 * Utilitário para gerar event_key consistente
 */
export function buildEventKey(type, parts = []) {
  return [type, ...parts].join(":");
}