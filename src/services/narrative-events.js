// C:\HDUD_DATA\hdud-api-node\src\services\narrative-events.js

import { getPool, sql } from "../db.js";

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
  const pool = await getPool();

  const req = pool.request();

  req.input("author_id", sql.Int, authorId);
  req.input("event_type", sql.VarChar(64), eventType);
  req.input("memory_id", sql.Int, memoryId);
  req.input("chapter_id", sql.Int, chapterId);
  req.input("event_key", sql.VarChar(300), eventKey);
  req.input(
    "metadata_json",
    sql.NVarChar(sql.MAX),
    metadata ? JSON.stringify(metadata) : null
  );

  await req.execute("dbo.p_CreateNarrativeEvent");
}

/**
 * Utilitário para gerar event_key consistente
 */
export function buildEventKey(type, parts = []) {
  return [type, ...parts].join(":");
}