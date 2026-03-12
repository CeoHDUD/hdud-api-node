// C:\HDUD_DATA\hdud-api-node\src\services\timeline\timeline.sql.js

import { sql } from "../../db.js";

function hasColumn(columnSet, name) {
  return columnSet.has(String(name || "").toLowerCase());
}

function firstExisting(columnSet, candidates) {
  for (const c of candidates || []) {
    if (hasColumn(columnSet, c)) return c;
  }
  return null;
}

async function getTableColumns(pool, schemaName, tableName) {
  const r = await pool
    .request()
    .input("schema_name", sql.NVarChar(128), schemaName)
    .input("table_name", sql.NVarChar(128), tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema_name
        AND TABLE_NAME = @table_name;
    `);

  return new Set((r.recordset || []).map((x) => String(x.COLUMN_NAME || "").toLowerCase()));
}

async function tableExists(pool, schemaName, tableName) {
  const r = await pool
    .request()
    .input("schema_name", sql.NVarChar(128), schemaName)
    .input("table_name", sql.NVarChar(128), tableName)
    .query(`
      SELECT 1 AS ok
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = @schema_name
        AND TABLE_NAME = @table_name;
    `);

  return Boolean(r.recordset?.[0]?.ok);
}

function buildLikePredicate({ q, expressions }) {
  if (!q) return "";
  const valid = (expressions || []).filter(Boolean);
  if (!valid.length) return "";
  return ` AND (${valid.map((x) => `${x} LIKE @q_like`).join(" OR ")}) `;
}

function buildAnyLikeExpr(expressions) {
  const valid = (expressions || []).filter(Boolean);
  if (!valid.length) return "1 = 0";
  return valid.map((x) => `${x} LIKE @q_like`).join(" OR ");
}

export async function fetchNarrativeEventRows(pool, { authorId, q, limit }) {
  const exists = await tableExists(pool, "dbo", "identity_narrative_event");
  if (!exists) {
    return { exists: false, rows: [] };
  }

  const cols = await getTableColumns(pool, "dbo", "identity_narrative_event");

  const authorCol = firstExisting(cols, ["author_id"]);
  const eventIdCol = firstExisting(cols, ["narrative_event_id", "event_id", "id"]);
  const typeCol = firstExisting(cols, ["event_type", "type", "kind", "entity_type", "target_type"]);
  const memoryIdCol = firstExisting(cols, ["memory_id"]);
  const chapterIdCol = firstExisting(cols, ["chapter_id"]);
  const titleCol = firstExisting(cols, ["title", "name", "headline", "label"]);
  const noteCol = firstExisting(cols, ["note", "summary", "preview", "description"]);
  const metadataCol = firstExisting(cols, ["metadata_json", "metadata"]);
  const eventAtCol = firstExisting(cols, ["event_at", "occurred_at", "activity_at", "updated_at", "created_at"]);
  const createdAtCol = firstExisting(cols, ["created_at"]);
  const updatedAtCol = firstExisting(cols, ["updated_at"]);

  if (!authorCol) {
    return { exists: true, rows: [] };
  }

  const whereSearch = buildLikePredicate({
    q,
    expressions: [
      titleCol ? `CAST(ne.[${titleCol}] AS NVARCHAR(MAX))` : null,
      noteCol ? `CAST(ne.[${noteCol}] AS NVARCHAR(MAX))` : null,
      metadataCol ? `CAST(ne.[${metadataCol}] AS NVARCHAR(MAX))` : null,
    ],
  });

  const orderExpr =
    eventAtCol
      ? `ne.[${eventAtCol}]`
      : updatedAtCol
      ? `ne.[${updatedAtCol}]`
      : createdAtCol
      ? `ne.[${createdAtCol}]`
      : eventIdCol
      ? `ne.[${eventIdCol}]`
      : "GETUTCDATE()";

  const query = `
    SELECT TOP (@limit)
      ${eventIdCol ? `ne.[${eventIdCol}]` : "NULL"} AS narrative_event_id,
      ${typeCol ? `ne.[${typeCol}]` : "NULL"} AS event_type,
      ${memoryIdCol ? `ne.[${memoryIdCol}]` : "NULL"} AS memory_id,
      ${chapterIdCol ? `ne.[${chapterIdCol}]` : "NULL"} AS chapter_id,
      ${titleCol ? `ne.[${titleCol}]` : "NULL"} AS title,
      ${noteCol ? `ne.[${noteCol}]` : "NULL"} AS note,
      ${metadataCol ? `ne.[${metadataCol}]` : "NULL"} AS metadata_json,
      ${eventAtCol ? `ne.[${eventAtCol}]` : "NULL"} AS event_at,
      ${createdAtCol ? `ne.[${createdAtCol}]` : "NULL"} AS created_at,
      ${updatedAtCol ? `ne.[${updatedAtCol}]` : "NULL"} AS updated_at
    FROM dbo.identity_narrative_event ne
    WHERE ne.[${authorCol}] = @author_id
      ${whereSearch}
    ORDER BY ${orderExpr} DESC, ${eventIdCol ? `ne.[${eventIdCol}] DESC` : orderExpr};
  `;

  const req = pool.request();
  req.input("author_id", sql.Int, authorId);
  req.input("limit", sql.Int, limit);
  if (q) req.input("q_like", sql.NVarChar(sql.MAX), `%${q}%`);

  const r = await req.query(query);
  return { exists: true, rows: r.recordset || [] };
}

export async function fetchMemoryFallbackRows(pool, { authorId, q, limit }) {
  const memCols = await getTableColumns(pool, "dbo", "identity_memory");

  const mapExists = await tableExists(pool, "dbo", "identity_memory_chapter");
  const mapCols = mapExists
    ? await getTableColumns(pool, "dbo", "identity_memory_chapter")
    : new Set();

  const verExists = await tableExists(pool, "dbo", "identity_memory_versions");
  const verCols = verExists
    ? await getTableColumns(pool, "dbo", "identity_memory_versions")
    : new Set();

  const chapterExists = await tableExists(pool, "dbo", "identity_chapter");
  const chapterCols = chapterExists
    ? await getTableColumns(pool, "dbo", "identity_chapter")
    : new Set();

  const memUpdatedAtCol = firstExisting(memCols, ["updated_at"]);
  const memDeletedCol = firstExisting(memCols, ["is_deleted"]);
  const memTitleCol = firstExisting(memCols, ["title"]);
  const memContentCol = firstExisting(memCols, ["content"]);
  const memCreatedAtCol = firstExisting(memCols, ["created_at"]);

  const chapterDeletedCol = firstExisting(chapterCols, ["is_deleted"]);
  const chapterTitleCol = firstExisting(chapterCols, ["title"]);
  const chapterDescCol = firstExisting(chapterCols, ["description", "summary", "content"]);

  const versionNumberCol = firstExisting(verCols, ["version_number"]);
  const mapAuthorCol = hasColumn(mapCols, "author_id");
  const chapterAuthorCol = hasColumn(chapterCols, "author_id");

  const linkedChapterApply =
    mapExists && chapterExists
      ? `
        OUTER APPLY (
          SELECT TOP 1
            mc.chapter_id,
            ${chapterTitleCol ? `c.[${chapterTitleCol}]` : "NULL"} AS chapter_title,
            ${chapterDescCol ? `c.[${chapterDescCol}]` : "NULL"} AS chapter_description
          FROM dbo.identity_memory_chapter mc
          LEFT JOIN dbo.identity_chapter c
            ON c.chapter_id = mc.chapter_id
            ${chapterAuthorCol ? "AND c.author_id = m.author_id" : ""}
          WHERE mc.memory_id = m.memory_id
            ${mapAuthorCol ? "AND mc.author_id = m.author_id" : ""}
            ${chapterDeletedCol ? `AND ISNULL(c.[${chapterDeletedCol}], 0) = 0` : ""}
          ORDER BY
            ${mapCols.has("is_primary") ? "ISNULL(mc.is_primary, 0) DESC," : ""}
            ${mapCols.has("sort_order") ? "ISNULL(mc.sort_order, 2147483647)," : ""}
            mc.chapter_id
        ) linked
      `
      : `
        OUTER APPLY (
          SELECT
            CAST(NULL AS INT) AS chapter_id,
            CAST(NULL AS NVARCHAR(MAX)) AS chapter_title,
            CAST(NULL AS NVARCHAR(MAX)) AS chapter_description
        ) linked
      `;

  const versionApply =
    verExists
      ? `
        OUTER APPLY (
          SELECT TOP 1
            vv.created_at AS last_version_at
          FROM dbo.identity_memory_versions vv
          WHERE vv.memory_id = m.memory_id
          ORDER BY
            ${versionNumberCol ? `vv.[${versionNumberCol}] DESC,` : ""}
            vv.created_at DESC
        ) versioning
      `
      : `
        OUTER APPLY (
          SELECT CAST(NULL AS DATETIME2) AS last_version_at
        ) versioning
      `;

  const directMatchExpr = buildAnyLikeExpr([
    memTitleCol ? `CAST(m.[${memTitleCol}] AS NVARCHAR(MAX))` : null,
    memContentCol ? `CAST(m.[${memContentCol}] AS NVARCHAR(MAX))` : null,
  ]);

  const chapterContextExistsExpr =
    mapExists && chapterExists
      ? `
        EXISTS (
          SELECT 1
          FROM dbo.identity_memory_chapter mcx
          JOIN dbo.identity_chapter cx
            ON cx.chapter_id = mcx.chapter_id
            ${chapterAuthorCol ? "AND cx.author_id = m.author_id" : ""}
          WHERE mcx.memory_id = m.memory_id
            ${mapAuthorCol ? "AND mcx.author_id = m.author_id" : ""}
            ${chapterDeletedCol ? `AND ISNULL(cx.[${chapterDeletedCol}], 0) = 0` : ""}
            AND (
              ${buildAnyLikeExpr([
                chapterTitleCol ? `CAST(cx.[${chapterTitleCol}] AS NVARCHAR(MAX))` : null,
                chapterDescCol ? `CAST(cx.[${chapterDescCol}] AS NVARCHAR(MAX))` : null,
              ])}
            )
        )
      `
      : `1 = 0`;

  const searchPredicate = q
    ? `AND ((${directMatchExpr}) OR (${chapterContextExistsExpr}))`
    : "";

  const deletedPredicate = memDeletedCol ? `AND ISNULL(m.[${memDeletedCol}], 0) = 0` : "";

  const activityExpr =
    memUpdatedAtCol
      ? `COALESCE(versioning.last_version_at, m.[${memUpdatedAtCol}], m.[${memCreatedAtCol}])`
      : `COALESCE(versioning.last_version_at, m.[${memCreatedAtCol}])`;

  const directMatchScoreExpr = q
    ? `CASE WHEN (${directMatchExpr}) THEN 1 ELSE 0 END`
    : `CAST(0 AS INT)`;

  const chapterContextScoreExpr = q
    ? `CASE WHEN (NOT (${directMatchExpr}) AND (${chapterContextExistsExpr})) THEN 1 ELSE 0 END`
    : `CAST(0 AS INT)`;

  const matchReasonExpr = q
    ? `
      CASE
        WHEN (${directMatchExpr}) THEN 'direct'
        WHEN (${chapterContextExistsExpr}) THEN 'chapter_context'
        ELSE NULL
      END
    `
    : `CAST(NULL AS NVARCHAR(40))`;

  const query = `
    SELECT TOP (@limit)
      m.memory_id,
      ${memTitleCol ? `m.[${memTitleCol}]` : "NULL"} AS title,
      ${memContentCol ? `m.[${memContentCol}]` : "NULL"} AS content,
      ${memCreatedAtCol ? `m.[${memCreatedAtCol}]` : "NULL"} AS created_at,
      ${memUpdatedAtCol ? `m.[${memUpdatedAtCol}]` : "NULL"} AS updated_at,
      versioning.last_version_at,
      linked.chapter_id,
      linked.chapter_title,
      linked.chapter_description,
      ${directMatchScoreExpr} AS direct_match_score,
      ${chapterContextScoreExpr} AS chapter_context_score,
      ${matchReasonExpr} AS match_reason,
      ${activityExpr} AS activity_at
    FROM dbo.identity_memory m
    ${linkedChapterApply}
    ${versionApply}
    WHERE m.author_id = @author_id
      ${deletedPredicate}
      ${searchPredicate}
    ORDER BY
      ${q ? "direct_match_score DESC, chapter_context_score DESC," : ""}
      ${activityExpr} DESC,
      m.memory_id DESC;
  `;

  const req = pool.request();
  req.input("author_id", sql.Int, authorId);
  req.input("limit", sql.Int, limit);
  if (q) req.input("q_like", sql.NVarChar(sql.MAX), `%${q}%`);

  const r = await req.query(query);
  return r.recordset || [];
}

export async function fetchChapterFallbackRows(pool, { authorId, q, limit }) {
  const cols = await getTableColumns(pool, "dbo", "identity_chapter");

  const deletedCol = firstExisting(cols, ["is_deleted"]);
  const titleCol = firstExisting(cols, ["title"]);
  const descCol = firstExisting(cols, ["description", "summary", "content"]);
  const createdAtCol = firstExisting(cols, ["created_at"]);
  const updatedAtCol = firstExisting(cols, ["updated_at"]);
  const publishedAtCol = firstExisting(cols, ["published_at"]);
  const statusCol = firstExisting(cols, ["status"]);

  const searchPredicate = buildLikePredicate({
    q,
    expressions: [
      titleCol ? `CAST(c.[${titleCol}] AS NVARCHAR(MAX))` : null,
      descCol ? `CAST(c.[${descCol}] AS NVARCHAR(MAX))` : null,
    ],
  });

  const deletedPredicate = deletedCol ? `AND ISNULL(c.[${deletedCol}], 0) = 0` : "";

  const activityExpr =
    publishedAtCol
      ? updatedAtCol
        ? createdAtCol
          ? `COALESCE(c.[${publishedAtCol}], c.[${updatedAtCol}], c.[${createdAtCol}])`
          : `COALESCE(c.[${publishedAtCol}], c.[${updatedAtCol}])`
        : createdAtCol
        ? `COALESCE(c.[${publishedAtCol}], c.[${createdAtCol}])`
        : `c.[${publishedAtCol}]`
      : updatedAtCol
      ? createdAtCol
        ? `COALESCE(c.[${updatedAtCol}], c.[${createdAtCol}])`
        : `c.[${updatedAtCol}]`
      : createdAtCol
      ? `c.[${createdAtCol}]`
      : "GETUTCDATE()";

  const query = `
    SELECT TOP (@limit)
      c.chapter_id,
      ${titleCol ? `c.[${titleCol}]` : "NULL"} AS title,
      ${descCol ? `c.[${descCol}]` : "NULL"} AS description,
      ${createdAtCol ? `c.[${createdAtCol}]` : "NULL"} AS created_at,
      ${updatedAtCol ? `c.[${updatedAtCol}]` : "NULL"} AS updated_at,
      ${publishedAtCol ? `c.[${publishedAtCol}]` : "NULL"} AS published_at,
      ${statusCol ? `c.[${statusCol}]` : "NULL"} AS status,
      ${q ? `'direct'` : "CAST(NULL AS NVARCHAR(40))"} AS match_reason,
      ${activityExpr} AS activity_at
    FROM dbo.identity_chapter c
    WHERE c.author_id = @author_id
      ${deletedPredicate}
      ${searchPredicate}
    ORDER BY ${activityExpr} DESC, c.chapter_id DESC;
  `;

  const req = pool.request();
  req.input("author_id", sql.Int, authorId);
  req.input("limit", sql.Int, limit);
  if (q) req.input("q_like", sql.NVarChar(sql.MAX), `%${q}%`);

  const r = await req.query(query);
  return r.recordset || [];
}

export async function fetchInventoryCounts(pool, { authorId, q }) {
  const memCols = await getTableColumns(pool, "dbo", "identity_memory");
  const chapCols = await getTableColumns(pool, "dbo", "identity_chapter");

  const mapExists = await tableExists(pool, "dbo", "identity_memory_chapter");
  const mapCols = mapExists
    ? await getTableColumns(pool, "dbo", "identity_memory_chapter")
    : new Set();

  const memDeletedCol = firstExisting(memCols, ["is_deleted"]);
  const chapDeletedCol = firstExisting(chapCols, ["is_deleted"]);

  const memTitleCol = firstExisting(memCols, ["title"]);
  const memContentCol = firstExisting(memCols, ["content"]);

  const chapTitleCol = firstExisting(chapCols, ["title"]);
  const chapDescCol = firstExisting(chapCols, ["description", "summary", "content"]);

  const mapAuthorCol = hasColumn(mapCols, "author_id");
  const chapterAuthorCol = hasColumn(chapCols, "author_id");

  const memSearchPredicate = q
    ? `
      AND (
        (${buildAnyLikeExpr([
          memTitleCol ? `CAST(m.[${memTitleCol}] AS NVARCHAR(MAX))` : null,
          memContentCol ? `CAST(m.[${memContentCol}] AS NVARCHAR(MAX))` : null,
        ])})
        OR
        EXISTS (
          SELECT 1
          FROM dbo.identity_memory_chapter mcx
          JOIN dbo.identity_chapter cx
            ON cx.chapter_id = mcx.chapter_id
            ${chapterAuthorCol ? "AND cx.author_id = m.author_id" : ""}
          WHERE mcx.memory_id = m.memory_id
            ${mapAuthorCol ? "AND mcx.author_id = m.author_id" : ""}
            ${chapDeletedCol ? `AND ISNULL(cx.[${chapDeletedCol}], 0) = 0` : ""}
            AND (
              ${buildAnyLikeExpr([
                chapTitleCol ? `CAST(cx.[${chapTitleCol}] AS NVARCHAR(MAX))` : null,
                chapDescCol ? `CAST(cx.[${chapDescCol}] AS NVARCHAR(MAX))` : null,
              ])}
            )
        )
      )
    `
    : "";

  const chapSearchPredicate = q
    ? `
      AND (
        ${buildAnyLikeExpr([
          chapTitleCol ? `CAST(c.[${chapTitleCol}] AS NVARCHAR(MAX))` : null,
          chapDescCol ? `CAST(c.[${chapDescCol}] AS NVARCHAR(MAX))` : null,
        ])}
      )
    `
    : "";

  const req = pool.request();
  req.input("author_id", sql.Int, authorId);
  if (q) req.input("q_like", sql.NVarChar(sql.MAX), `%${q}%`);

  const r = await req.query(`
    SELECT
      (
        SELECT COUNT_BIG(1)
        FROM dbo.identity_memory m
        WHERE m.author_id = @author_id
          ${memDeletedCol ? `AND ISNULL(m.[${memDeletedCol}], 0) = 0` : ""}
          ${memSearchPredicate}
      ) AS memories,
      (
        SELECT COUNT_BIG(1)
        FROM dbo.identity_chapter c
        WHERE c.author_id = @author_id
          ${chapDeletedCol ? `AND ISNULL(c.[${chapDeletedCol}], 0) = 0` : ""}
          ${chapSearchPredicate}
      ) AS chapters;
  `);

  const row = r.recordset?.[0] || {};
  return {
    memories: Number(row.memories || 0),
    chapters: Number(row.chapters || 0),
  };
}