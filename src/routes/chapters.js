// C:\HDUD_DATA\hdud-api-node\src\routes\chapters.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import {
  createNarrativeEvent,
  buildEventKey,
} from "../services/narrative-events.js";
import {
  generateChapterSuggestion,
  getLatestChapterSuggestion,
} from "../services/chapters/chapter-ai.service.js";

const router = express.Router();

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function ensureAuthorId(req, res) {
  const authorId = req?.user?.author_id;
  if (!authorId) {
    res.status(401).json({ error: "Não autenticado." });
    return null;
  }
  return Number(authorId);
}

function normalizePublicationStatus(value) {
  const s = String(value ?? "").trim().toUpperCase();

  if (s === "PUBLISHED" || s === "PUBLIC" || s === "SHARED") {
    return "PUBLIC";
  }

  return "DRAFT";
}

function normalizeChapterRow(r) {
  if (!r) return null;

  const publicationStatus = normalizePublicationStatus(
    r.publication_status ??
      r.publication_status_effective ??
      r.status
  );

  return {
    chapter_id: r.chapter_id,
    author_id: r.author_id,
    title: r.title,
    description: r.description,
    status: publicationStatus,
    publication_status: publicationStatus,
    current_version_id: r.current_version_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published_at: publicationStatus === "PUBLIC" ? r.published_at ?? null : null,
    published_version_number:
      r.published_version_number != null ? Number(r.published_version_number) : null,
  };
}

function normalizeChapterVersionRow(r) {
  if (!r) return null;
  return {
    chapter_version_id: r.chapter_version_id,
    chapter_id: r.chapter_id,
    author_id: r.author_id,
    title_snapshot: r.title_snapshot,
    body: r.body,
    created_at: r.created_at,
  };
}

function normalizeApplyScope(value) {
  const s = String(value ?? "all").trim().toLowerCase();
  if (s === "title" || s === "summary" || s === "all") return s;
  return null;
}

function normalizeOptionalText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function normalizeComparableText(value) {
  if (value == null) return "";
  return String(value).replace(/\r\n/g, "\n").trim();
}

function normalizeBitFlag(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value ? 1 : 0;

  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "sim", "s"].includes(s)) return 1;
  if (["0", "false", "no", "n", "nao", "não"].includes(s)) return 0;

  const n = Number(value);
  if (Number.isFinite(n)) return n ? 1 : 0;

  return fallback;
}

function createRequest(db) {
  return new sql.Request(db);
}

async function assertChapterOwned(pool, authorId, chapterId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1 chapter_id
      FROM dbo.identity_chapter
      WHERE chapter_id = @chapter_id
        AND author_id  = @author_id
        AND ISNULL(is_deleted,0) = 0;
    `);

  return !!r.recordset?.[0]?.chapter_id;
}

async function assertMemoryOwned(pool, authorId, memoryId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .query(`
      SELECT TOP 1 memory_id
      FROM dbo.identity_memory
      WHERE memory_id = @memory_id
        AND author_id = @author_id
        AND ISNULL(is_deleted,0) = 0;
    `);

  return !!r.recordset?.[0]?.memory_id;
}

async function getMemoryLinkInChapter(pool, authorId, chapterId, memoryId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("memory_id", sql.Int, memoryId)
    .query(`
      SELECT TOP 1
        chapter_id,
        memory_id,
        is_primary,
        sort_order,
        created_at AS linked_at,
        created_by AS linked_by
      FROM dbo.identity_memory_chapter
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id
        AND memory_id = @memory_id;
    `);

  return r?.recordset?.[0] || null;
}

async function listMemoryLinks(pool, authorId, memoryId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .query(`
      SELECT
        mc.chapter_id,
        mc.memory_id,
        mc.is_primary,
        mc.sort_order,
        mc.created_at AS linked_at,
        mc.created_by AS linked_by,
        c.title AS chapter_title
      FROM dbo.identity_memory_chapter mc
      INNER JOIN dbo.identity_chapter c
        ON c.chapter_id = mc.chapter_id
       AND c.author_id = mc.author_id
      WHERE mc.author_id = @author_id
        AND mc.memory_id = @memory_id
        AND ISNULL(c.is_deleted,0) = 0
      ORDER BY
        CASE WHEN ISNULL(mc.is_primary,0) = 1 THEN 0 ELSE 1 END ASC,
        CASE WHEN mc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
        mc.sort_order ASC,
        mc.created_at ASC,
        mc.chapter_id ASC;
    `);

  return (r?.recordset || []).map((x) => ({
    chapter_id: Number(x.chapter_id),
    memory_id: Number(x.memory_id),
    chapter_title: x.chapter_title != null ? String(x.chapter_title) : null,
    is_primary: x.is_primary != null ? Number(x.is_primary) : 0,
    sort_order: x.sort_order != null ? Number(x.sort_order) : null,
    linked_at: x.linked_at ?? null,
    linked_by: x.linked_by ?? null,
  }));
}

async function getChapterTitle(pool, authorId, chapterId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1 title
      FROM dbo.identity_chapter
      WHERE chapter_id = @chapter_id
        AND author_id  = @author_id
        AND ISNULL(is_deleted,0) = 0;
    `);

  return r?.recordset?.[0]?.title ? String(r.recordset[0].title) : null;
}

async function listExistingChapters(pool, authorId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .query(`
      SELECT
        chapter_id,
        author_id,
        title,
        description,
        current_version_id,
        status,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
            THEN COALESCE(
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), publication_status))), ''),
              CONVERT(varchar(50), status)
            )
          ELSE CONVERT(varchar(50), status)
        END AS publication_status_effective,
        created_at,
        updated_at,
        published_at,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'published_version_number') IS NOT NULL
            THEN published_version_number
          ELSE NULL
        END AS published_version_number
      FROM dbo.identity_chapter
      WHERE author_id = @author_id
        AND ISNULL(is_deleted,0) = 0
      ORDER BY
        CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END ASC,
        updated_at DESC,
        created_at DESC,
        chapter_id DESC;
    `);

  return (r?.recordset || []).map((x) => normalizeChapterRow(x));
}

async function getChapterDetailForApply(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .execute("dbo.p_Chapter_Get_ById");

  const recordsets = result?.recordsets || [];
  const chapterRows = recordsets[0] || [];
  const versionRows = recordsets[1] || [];

  if (!chapterRows.length) return null;

  const chapter = chapterRows[0] || null;
  const currentVersion = versionRows[0] || null;

  return {
    chapter,
    currentVersion,
  };
}

async function getSuggestionForApply(pool, authorId, chapterId, suggestionId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("suggestion_id", sql.Int, suggestionId)
    .query(`
      SELECT TOP 1
        suggestion_id,
        chapter_id,
        author_id,
        suggestion_status,
        chapter_title_suggestion,
        chapter_summary,
        themes_json,
        sections_json,
        emotional_arc_json,
        confidence_score,
        llm_provider,
        llm_model,
        prompt_version,
        created_at,
        applied_at,
        discarded_at
      FROM dbo.identity_chapter_ai_suggestion
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;
    `);

  return r?.recordset?.[0] || null;
}

async function markSuggestionApplied(pool, authorId, chapterId, suggestionId) {
  await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("suggestion_id", sql.Int, suggestionId)
    .query(`
      UPDATE dbo.identity_chapter_ai_suggestion
      SET
        applied_at = SYSUTCDATETIME(),
        suggestion_status = 'applied'
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;
    `);
}

async function markSuggestionDiscarded(pool, authorId, chapterId, suggestionId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .input("suggestion_id", sql.Int, suggestionId)
    .query(`
      UPDATE dbo.identity_chapter_ai_suggestion
      SET
        discarded_at = ISNULL(discarded_at, SYSUTCDATETIME()),
        suggestion_status = 'discarded'
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;

      SELECT TOP 1
        suggestion_id,
        suggestion_status,
        discarded_at
      FROM dbo.identity_chapter_ai_suggestion
      WHERE suggestion_id = @suggestion_id
        AND chapter_id    = @chapter_id
        AND author_id     = @author_id;
    `);

  return result?.recordset?.[0] || null;
}

async function getNextSortOrder(db, authorId, chapterId) {
  const result = await createRequest(db)
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT ISNULL(MAX(sort_order), 0) + 1 AS next_sort
      FROM dbo.identity_memory_chapter
      WHERE author_id = @author_id
        AND chapter_id = @chapter_id;
    `);

  return Number(result?.recordset?.[0]?.next_sort ?? 1);
}

async function ensureMemoryPrimaryLink(db, authorId, memoryId, preferredChapterId = null) {
  const request = createRequest(db)
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId);

  const preferredSql =
    preferredChapterId != null
      ? `
        CASE WHEN chapter_id = @preferred_chapter_id THEN 0 ELSE 1 END ASC,
      `
      : "";

  if (preferredChapterId != null) {
    request.input("preferred_chapter_id", sql.Int, preferredChapterId);
  }

  const linksResult = await request.query(`
    SELECT
      chapter_id,
      ISNULL(is_primary, 0) AS is_primary,
      sort_order,
      created_at
    FROM dbo.identity_memory_chapter
    WHERE author_id = @author_id
      AND memory_id = @memory_id
    ORDER BY
      ${preferredSql}
      CASE WHEN ISNULL(is_primary,0) = 1 THEN 0 ELSE 1 END ASC,
      CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END ASC,
      sort_order ASC,
      created_at ASC,
      chapter_id ASC;
  `);

  const links = linksResult?.recordset || [];
  if (!links.length) return null;

  let chosen = null;

  if (preferredChapterId != null) {
    chosen = links.find((x) => Number(x.chapter_id) === Number(preferredChapterId)) || null;
  }

  if (!chosen) {
    const existingPrimary = links.filter((x) => Number(x.is_primary) === 1);
    if (existingPrimary.length === 1) {
      chosen = existingPrimary[0];
    } else {
      chosen = links[0];
    }
  }

  await createRequest(db)
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .input("primary_chapter_id", sql.Int, Number(chosen.chapter_id))
    .query(`
      UPDATE dbo.identity_memory_chapter
      SET is_primary =
        CASE
          WHEN chapter_id = @primary_chapter_id THEN 1
          ELSE 0
        END
      WHERE author_id = @author_id
        AND memory_id = @memory_id;
    `);

  return Number(chosen.chapter_id);
}

async function getMoveSourceLink(pool, authorId, memoryId, targetChapterId, explicitFromChapterId) {
  const request = pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .input("target_chapter_id", sql.Int, targetChapterId);

  if (explicitFromChapterId != null) {
    request.input("from_chapter_id", sql.Int, explicitFromChapterId);

    const explicit = await request.query(`
      SELECT TOP 1
        imc.chapter_id,
        c.title AS chapter_title,
        ISNULL(imc.is_primary,0) AS is_primary,
        imc.sort_order,
        imc.created_at
      FROM dbo.identity_memory_chapter imc
      INNER JOIN dbo.identity_chapter c
        ON c.chapter_id = imc.chapter_id
       AND c.author_id = imc.author_id
      WHERE imc.author_id = @author_id
        AND imc.memory_id = @memory_id
        AND imc.chapter_id = @from_chapter_id
        AND ISNULL(c.is_deleted,0) = 0;
    `);

    return explicit?.recordset?.[0] || null;
  }

  const fallback = await request.query(`
    SELECT TOP 1
      imc.chapter_id,
      c.title AS chapter_title,
      ISNULL(imc.is_primary,0) AS is_primary,
      imc.sort_order,
      imc.created_at
    FROM dbo.identity_memory_chapter imc
    INNER JOIN dbo.identity_chapter c
      ON c.chapter_id = imc.chapter_id
     AND c.author_id = imc.author_id
    WHERE imc.author_id = @author_id
      AND imc.memory_id = @memory_id
      AND imc.chapter_id <> @target_chapter_id
      AND ISNULL(c.is_deleted,0) = 0
    ORDER BY
      CASE WHEN ISNULL(imc.is_primary,0) = 1 THEN 0 ELSE 1 END ASC,
      CASE WHEN imc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
      imc.sort_order ASC,
      imc.created_at ASC,
      imc.chapter_id ASC;
  `);

  return fallback?.recordset?.[0] || null;
}

async function getChapterEditorialState(pool, authorId, chapterId) {
  const result = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        c.chapter_id,
        c.author_id,
        c.title,
        c.description,
        c.status,
        c.current_version_id,
        c.created_at,
        c.updated_at,
        c.published_at,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
            THEN COALESCE(
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), c.publication_status))), ''),
              CONVERT(varchar(50), c.status)
            )
          ELSE CONVERT(varchar(50), c.status)
        END AS publication_status_effective,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'published_version_number') IS NOT NULL
            THEN c.published_version_number
          ELSE NULL
        END AS published_version_number
      FROM dbo.identity_chapter c
      WHERE c.chapter_id = @chapter_id
        AND c.author_id = @author_id
        AND ISNULL(c.is_deleted, 0) = 0;
    `);

  const row = result?.recordset?.[0] || null;
  if (!row) return null;

  const currentVersionResult = await pool
    .request()
    .input("chapter_id", sql.Int, chapterId)
    .query(`
      SELECT TOP 1
        chapter_version_id,
        chapter_id,
        author_id,
        title_snapshot,
        body,
        created_at
      FROM dbo.identity_chapter_versions
      WHERE chapter_id = @chapter_id
      ORDER BY created_at DESC, chapter_version_id DESC;
    `);

  const currentVersion = currentVersionResult?.recordset?.[0] || null;

  return {
    chapter: row,
    currentVersion,
  };
}

function buildChapterPublicationPendingRequirements(detail) {
  const out = [];
  const chapter = detail?.chapter || null;
  const version = detail?.currentVersion || null;

  const title = String(chapter?.title ?? "").trim();
  const body = String(version?.body ?? "").trim();

  if (!title) out.push("MISSING_TITLE");
  if (!body) out.push("MISSING_CONTENT");

  const chapterVersionId = Number(version?.chapter_version_id ?? chapter?.current_version_id ?? 0);
  if (!Number.isInteger(chapterVersionId) || chapterVersionId <= 0) {
    out.push("INVALID_VERSION");
  }

  return out;
}

function buildChapterPublicationSnapshot(detail) {
  const chapter = detail?.chapter || null;
  const version = detail?.currentVersion || null;
  const publicationStatus = normalizePublicationStatus(
    chapter?.publication_status_effective ?? chapter?.status
  );
  const pending = buildChapterPublicationPendingRequirements(detail);

  return {
    chapter_id: Number(chapter?.chapter_id ?? 0),
    status: publicationStatus,
    persisted_status: publicationStatus,
    is_publishable: pending.length === 0,
    pending_requirements: pending,
    published_at: publicationStatus === "PUBLIC" ? chapter?.published_at ?? null : null,
    published_version_number:
      publicationStatus === "PUBLIC"
        ? Number(chapter?.published_version_number ?? version?.chapter_version_id ?? 0) || null
        : null,
    current_version_id: Number(version?.chapter_version_id ?? chapter?.current_version_id ?? 0) || null,
  };
}

router.get("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const pool = await getPool();
    const rows = await listExistingChapters(pool, authorId);

    return res.json({ items: rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const title = String(req.body?.title ?? "").trim();
    const description =
      req.body?.description != null ? String(req.body.description).trim() : null;
    const body = req.body?.body != null ? String(req.body.body) : "";
    const requestedStatus =
      req.body?.status != null ? String(req.body.status).toUpperCase() : "DRAFT";

    if (!title) {
      return res.status(400).json({ error: "title é obrigatório." });
    }

    const safeStatus = requestedStatus === "PUBLIC" ? "PUBLIC" : "DRAFT";

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("title", sql.NVarChar(200), title)
      .input("description", sql.NVarChar(400), description)
      .input("body", sql.NVarChar(sql.MAX), body)
      .input("status", sql.VarChar(20), safeStatus)
      .output("chapter_id", sql.Int)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Create_WithVersion");

    const out = result?.output || {};
    const firstRow = result?.recordset?.[0] || null;
    const chapterId = out.chapter_id ?? firstRow?.chapter_id ?? null;

    try {
      if (chapterId != null) {
        await createNarrativeEvent({
          authorId,
          eventType: "chapter_created",
          chapterId,
          eventKey: buildEventKey("chapter_created", [
            "author",
            authorId,
            "chapter",
            chapterId,
          ]),
          metadata: {
            title,
            status: safeStatus,
            source: "chapters.create",
          },
        });
      }
    } catch (e) {
      console.warn("NarrativeEvent chapter_created failed:", e?.message);
    }

    return res.status(201).json({
      chapter_id: chapterId,
      chapter_version_id:
        out.chapter_version_id ?? firstRow?.chapter_version_id ?? null,
      status: safeStatus,
      publication_status: safeStatus,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detail = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detail?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const chapter = normalizeChapterRow(detail.chapter);
    const currentVersion = detail.currentVersion
      ? normalizeChapterVersionRow(detail.currentVersion)
      : null;

    const resolvedStatus = chapter?.status === "PUBLIC" ? "PUBLIC" : "DRAFT";

    return res.json({
      chapter_id: chapter.chapter_id,
      author_id: chapter.author_id,
      title: chapter.title,
      description: chapter.description ?? null,
      status: resolvedStatus,
      publication_status: resolvedStatus,
      current_version_id: chapter.current_version_id ?? null,
      created_at: chapter.created_at ?? null,
      updated_at: chapter.updated_at ?? null,
      published_at: chapter.published_at ?? null,
      published_version_number: chapter.published_version_number ?? null,
      body: currentVersion?.body ?? "",
      chapter,
      current_version: currentVersion,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/publication", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detail = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detail?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const publication = buildChapterPublicationSnapshot(detail);

    return res.json(publication);
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const title = String(req.body?.title ?? "").trim();
    const description =
      req.body?.description != null ? String(req.body.description).trim() : null;
    const body = req.body?.body != null ? String(req.body.body) : null;

    if (!title) return res.status(400).json({ error: "title é obrigatório." });
    if (body === null) return res.status(400).json({ error: "body é obrigatório." });

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("title", sql.NVarChar(200), title)
      .input("description", sql.NVarChar(400), description)
      .input("body", sql.NVarChar(sql.MAX), body)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Update_WithVersion");

    const out = result?.output || {};
    const firstRow = result?.recordset?.[0] || null;

    return res.json({
      chapter_id: chapterId,
      chapter_version_id:
        out.chapter_version_id ?? firstRow?.chapter_version_id ?? null,
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

router.post("/:id/publish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detailBefore = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detailBefore?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const publicationBefore = buildChapterPublicationSnapshot(detailBefore);
    if (publicationBefore.status === "PUBLIC") {
      return res.status(409).json({
        error: "Capítulo já publicado.",
        code: "CHAPTER_ALREADY_PUBLISHED",
      });
    }

    if (!publicationBefore.is_publishable) {
      return res.status(422).json({
        error: "Capítulo não publicável.",
        code: "CHAPTER_NOT_PUBLISHABLE",
        pending_requirements: publicationBefore.pending_requirements,
      });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Publish");

    const detailAfter = await getChapterEditorialState(pool, authorId, chapterId);
    const publicationAfter = buildChapterPublicationSnapshot(detailAfter);

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_published",
        chapterId,
        eventKey: buildEventKey("chapter_published", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "version",
          publicationAfter.published_version_number ?? publicationAfter.current_version_id ?? "na",
        ]),
        metadata: {
          publication_status: "PUBLIC",
          published_version_number: publicationAfter.published_version_number ?? null,
          source: "chapters.publish",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_published failed:", e?.message);
    }

    return res.json({
      ok: true,
      chapter_id: chapterId,
      status: "PUBLIC",
      publication_status: "PUBLIC",
      published_at: publicationAfter.published_at,
      published_version_number: publicationAfter.published_version_number,
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

router.post("/:id/unpublish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();
    const detailBefore = await getChapterEditorialState(pool, authorId, chapterId);

    if (!detailBefore?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const publicationBefore = buildChapterPublicationSnapshot(detailBefore);
    if (publicationBefore.status !== "PUBLIC") {
      return res.status(409).json({
        error: "Capítulo já está em rascunho.",
        code: "CHAPTER_ALREADY_DRAFT",
      });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Unpublish");

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_unpublished",
        chapterId,
        eventKey: buildEventKey("chapter_unpublished", [
          "author",
          authorId,
          "chapter",
          chapterId,
        ]),
        metadata: {
          publication_status: "DRAFT",
          source: "chapters.unpublish",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_unpublished failed:", e?.message);
    }

    return res.json({
      ok: true,
      chapter_id: chapterId,
      status: "DRAFT",
      publication_status: "DRAFT",
      published_at: null,
      published_version_number: null,
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("não encontrado") || msg.includes("acesso negado")) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }
    return next(err);
  }
});

router.get("/:id/memories", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .query(`
        SELECT
          m.memory_id,
          m.author_id,
          m.title,
          m.content,
          m.created_at,
          m.version_number,
          m.phase_id,
          p.phase_code AS life_phase,
          p.name       AS phase_name,

          mc.chapter_id,
          mc.is_primary,
          mc.sort_order,
          mc.created_at AS linked_at,
          mc.created_by AS linked_by
        FROM dbo.identity_memory_chapter mc
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = mc.memory_id
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        WHERE mc.chapter_id = @chapter_id
          AND mc.author_id  = @author_id
          AND m.author_id   = @author_id
          AND ISNULL(m.is_deleted,0) = 0
        ORDER BY
          CASE WHEN mc.sort_order IS NULL THEN 1 ELSE 0 END ASC,
          mc.sort_order ASC,
          mc.created_at ASC,
          m.created_at DESC,
          m.memory_id DESC;
      `);

    return res.json({
      chapter_id: chapterId,
      items: result.recordset || [],
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/suggest", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const options = {
      language:
        req.body?.options?.language != null
          ? String(req.body.options.language)
          : "pt-BR",
      tone:
        req.body?.options?.tone != null
          ? String(req.body.options.tone)
          : "autobiografico",
      maxSections:
        req.body?.options?.max_sections != null
          ? Number(req.body.options.max_sections)
          : 6,
      maxThemes:
        req.body?.options?.max_themes != null
          ? Number(req.body.options.max_themes)
          : 5,
    };

    const result = await generateChapterSuggestion({
      authorId,
      chapterId,
      options,
    });

    if (!result?.ok) {
      return res.status(result?.status || 400).json({
        ok: false,
        code: result?.code || "CHAPTER_SUGGEST_FAILED",
        message: result?.message || "Falha ao gerar sugestão de capítulo.",
        meta: result?.meta || null,
      });
    }

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_ai_suggestion_generated",
        chapterId,
        eventKey: buildEventKey("chapter_ai_suggestion_generated", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "suggestion",
          result.suggestion_id,
        ]),
        metadata: {
          suggestion_id: result.suggestion_id,
          source_memory_count: result?.meta?.source_memory_count ?? null,
          provider: result?.meta?.provider ?? "mock",
          model: result?.meta?.model ?? "chapter-engine-v1-local",
          themes: result?.data?.themes ?? [],
          source: "chapters.suggest",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_ai_suggestion_generated failed:", e?.message);
    }

    return res.status(result.status || 201).json(result);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/suggestions/latest", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    const result = await getLatestChapterSuggestion({
      authorId,
      chapterId,
    });

    if (!result?.ok) {
      return res.status(result?.status || 404).json({
        ok: false,
        code: result?.code || "SUGGESTION_NOT_FOUND",
        message: result?.message || "Nenhuma sugestão encontrada.",
      });
    }

    return res.status(result.status || 200).json(result);
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/suggestions/:suggestionId/apply", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const suggestionId = toInt(req.params.suggestionId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    if (!Number.isFinite(suggestionId) || suggestionId <= 0) {
      return res.status(400).json({ error: "suggestion_id inválido." });
    }

    const applyScope = normalizeApplyScope(req.body?.apply_scope ?? req.body?.scope ?? "all");
    if (!applyScope) {
      return res.status(422).json({
        error: "apply_scope inválido.",
        detail: "Use: title, summary ou all.",
      });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const suggestion = await getSuggestionForApply(pool, authorId, chapterId, suggestionId);
    if (!suggestion) {
      return res.status(404).json({
        error: "Sugestão não encontrada.",
        code: "SUGGESTION_NOT_FOUND",
      });
    }

    const suggestionStatus = String(suggestion.suggestion_status ?? "").trim().toLowerCase();
    if (suggestionStatus === "discarded") {
      return res.status(409).json({
        error: "Sugestão descartada não pode ser aplicada.",
        code: "SUGGESTION_ALREADY_DISCARDED",
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status: "discarded",
          discarded_at: suggestion.discarded_at ?? null,
        },
      });
    }

    const detail = await getChapterDetailForApply(pool, authorId, chapterId);
    if (!detail?.chapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const currentTitle = normalizeOptionalText(detail.chapter.title) ?? "";
    const currentDescription = normalizeOptionalText(detail.chapter.description);
    const currentBody =
      detail.currentVersion?.body != null ? String(detail.currentVersion.body) : "";

    const suggestedTitle = normalizeOptionalText(suggestion.chapter_title_suggestion);
    const suggestedSummary = normalizeOptionalText(suggestion.chapter_summary);

    if (applyScope === "title" && !suggestedTitle) {
      return res.status(422).json({
        error: "Sugestão sem título aplicável.",
        code: "SUGGESTION_HAS_NO_TITLE",
      });
    }

    if (applyScope === "summary" && !suggestedSummary) {
      return res.status(422).json({
        error: "Sugestão sem resumo aplicável.",
        code: "SUGGESTION_HAS_NO_SUMMARY",
      });
    }

    if (applyScope === "all" && !suggestedTitle && !suggestedSummary) {
      return res.status(422).json({
        error: "Sugestão sem conteúdo aplicável.",
        code: "SUGGESTION_HAS_NO_CONTENT",
      });
    }

    const nextTitle =
      applyScope === "title" || applyScope === "all"
        ? suggestedTitle || currentTitle
        : currentTitle;

    const nextBody =
      applyScope === "summary" || applyScope === "all"
        ? suggestedSummary || currentBody
        : currentBody;

    if (!nextTitle) {
      return res.status(422).json({
        error: "O capítulo ficaria sem título após aplicar a sugestão.",
        code: "INVALID_RESULTING_TITLE",
      });
    }

    const titleChanged =
      normalizeComparableText(nextTitle) !== normalizeComparableText(currentTitle);
    const bodyChanged =
      normalizeComparableText(nextBody) !== normalizeComparableText(currentBody);

    if (!titleChanged && !bodyChanged) {
      return res.status(200).json({
        ok: true,
        applied: false,
        code: "NO_CHANGES_TO_APPLY",
        message: "A sugestão já está refletida no capítulo. Nenhuma nova versão foi criada.",
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        apply_scope: applyScope,
        chapter_version_id:
          detail.chapter?.current_version_id != null
            ? Number(detail.chapter.current_version_id)
            : null,
        chapter: {
          chapter_id: chapterId,
          title: currentTitle,
          description: currentDescription,
          body: currentBody,
        },
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status:
            suggestion.suggestion_status != null ? String(suggestion.suggestion_status) : null,
          applied_at: suggestion.applied_at ?? null,
        },
        changes: {
          title_changed: false,
          body_changed: false,
        },
      });
    }

    const updateResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("title", sql.NVarChar(200), nextTitle)
      .input("description", sql.NVarChar(400), currentDescription)
      .input("body", sql.NVarChar(sql.MAX), nextBody)
      .output("chapter_version_id", sql.Int)
      .execute("dbo.p_Chapter_Update_WithVersion");

    const chapterVersionId =
      updateResult?.output?.chapter_version_id ??
      updateResult?.recordset?.[0]?.chapter_version_id ??
      null;

    await markSuggestionApplied(pool, authorId, chapterId, suggestionId);

    const appliedAtIso = new Date().toISOString();

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_ai_suggestion_applied",
        chapterId,
        eventKey: buildEventKey("chapter_ai_suggestion_applied", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "suggestion",
          suggestionId,
          "scope",
          applyScope,
        ]),
        metadata: {
          suggestion_id: suggestionId,
          apply_scope: applyScope,
          chapter_version_id: chapterVersionId,
          title_applied: titleChanged,
          summary_applied: bodyChanged,
          provider: suggestion.llm_provider ?? null,
          model: suggestion.llm_model ?? null,
          prompt_version: suggestion.prompt_version ?? null,
          confidence_score:
            suggestion.confidence_score != null ? Number(suggestion.confidence_score) : null,
          source: "chapters.apply_suggestion",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_ai_suggestion_applied failed:", e?.message);
    }

    return res.status(200).json({
      ok: true,
      applied: true,
      chapter_id: chapterId,
      suggestion_id: suggestionId,
      apply_scope: applyScope,
      chapter_version_id: chapterVersionId != null ? Number(chapterVersionId) : null,
      chapter: {
        chapter_id: chapterId,
        title: nextTitle,
        description: currentDescription,
        body: nextBody,
      },
      suggestion: {
        suggestion_id: Number(suggestion.suggestion_id),
        suggestion_status: "applied",
        applied_at: appliedAtIso,
      },
      changes: {
        title_changed: titleChanged,
        body_changed: bodyChanged,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/suggestions/:suggestionId/discard", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const suggestionId = toInt(req.params.suggestionId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }

    if (!Number.isFinite(suggestionId) || suggestionId <= 0) {
      return res.status(400).json({ error: "suggestion_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    const suggestion = await getSuggestionForApply(pool, authorId, chapterId, suggestionId);
    if (!suggestion) {
      return res.status(404).json({
        error: "Sugestão não encontrada.",
        code: "SUGGESTION_NOT_FOUND",
      });
    }

    const suggestionStatus = String(suggestion.suggestion_status ?? "").trim().toLowerCase();

    if (suggestionStatus === "applied") {
      return res.status(409).json({
        error: "Sugestão já aplicada não pode ser descartada.",
        code: "SUGGESTION_ALREADY_APPLIED",
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status: "applied",
          applied_at: suggestion.applied_at ?? null,
        },
      });
    }

    if (suggestionStatus === "discarded") {
      return res.status(200).json({
        ok: true,
        discarded: true,
        chapter_id: chapterId,
        suggestion_id: suggestionId,
        suggestion: {
          suggestion_id: Number(suggestion.suggestion_id),
          suggestion_status: "discarded",
          discarded_at: suggestion.discarded_at ?? null,
        },
      });
    }

    const discardedRow = await markSuggestionDiscarded(pool, authorId, chapterId, suggestionId);
    const discardedAtIso =
      discardedRow?.discarded_at != null
        ? new Date(discardedRow.discarded_at).toISOString()
        : new Date().toISOString();

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "chapter_ai_suggestion_discarded",
        chapterId,
        eventKey: buildEventKey("chapter_ai_suggestion_discarded", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "suggestion",
          suggestionId,
        ]),
        metadata: {
          suggestion_id: suggestionId,
          provider: suggestion.llm_provider ?? null,
          model: suggestion.llm_model ?? null,
          prompt_version: suggestion.prompt_version ?? null,
          confidence_score:
            suggestion.confidence_score != null ? Number(suggestion.confidence_score) : null,
          source: "chapters.discard_suggestion",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent chapter_ai_suggestion_discarded failed:", e?.message);
    }

    return res.status(200).json({
      ok: true,
      discarded: true,
      chapter_id: chapterId,
      suggestion_id: suggestionId,
      suggestion: {
        suggestion_id: Number(discardedRow?.suggestion_id ?? suggestionId),
        suggestion_status:
          discardedRow?.suggestion_status != null
            ? String(discardedRow.suggestion_status)
            : "discarded",
        discarded_at: discardedAtIso,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/memories/:memoryId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }

    const requestedPrimary = normalizeBitFlag(
      req.body?.is_primary ?? req.body?.isPrimary,
      0
    );

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const existingInChapter = await getMemoryLinkInChapter(pool, authorId, chapterId, memoryId);
    if (existingInChapter?.chapter_id != null) {
      const links = await listMemoryLinks(pool, authorId, memoryId);

      return res.status(200).json({
        ok: true,
        already_linked: true,
        chapter_id: chapterId,
        memory_id: memoryId,
        linked_at: existingInChapter.linked_at ?? null,
        linked_by: existingInChapter.linked_by ?? null,
        is_primary: existingInChapter.is_primary != null ? Number(existingInChapter.is_primary) : 0,
        sort_order:
          existingInChapter.sort_order != null ? Number(existingInChapter.sort_order) : null,
        all_links: links,
      });
    }

    const existingLinks = await listMemoryLinks(pool, authorId, memoryId);
    const shouldBePrimary = existingLinks.length === 0 ? 1 : requestedPrimary;

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      const nextOrder = await getNextSortOrder(tx, authorId, chapterId);

      await createRequest(tx)
        .input("author_id", sql.Int, authorId)
        .input("chapter_id", sql.Int, chapterId)
        .input("memory_id", sql.Int, memoryId)
        .input("is_primary", sql.Bit, shouldBePrimary)
        .input("sort_order", sql.Int, nextOrder)
        .query(`
          INSERT INTO dbo.identity_memory_chapter
            (author_id, memory_id, chapter_id, is_primary, sort_order, created_by)
          VALUES
            (@author_id, @memory_id, @chapter_id, @is_primary, @sort_order, NULL);
        `);

      if (shouldBePrimary === 1) {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId, chapterId);
      } else {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId);
      }

      await tx.commit();

      let primaryChapterId = null;
      try {
        const finalLinks = await listMemoryLinks(pool, authorId, memoryId);
        primaryChapterId =
          finalLinks.find((x) => Number(x.is_primary) === 1)?.chapter_id ?? null;
      } catch {}

      try {
        await createNarrativeEvent({
          authorId,
          eventType: "memory_linked_to_chapter",
          memoryId,
          chapterId,
          eventKey: buildEventKey("memory_linked_to_chapter", [
            "author",
            authorId,
            "chapter",
            chapterId,
            "memory",
            memoryId,
          ]),
          metadata: {
            is_primary_requested: requestedPrimary,
            is_primary_effective: primaryChapterId === chapterId ? 1 : 0,
            source: "chapters.link_memory",
          },
        });
      } catch (e) {
        console.warn("NarrativeEvent memory_linked_to_chapter failed:", e?.message);
      }

      return res.status(201).json({
        ok: true,
        chapter_id: chapterId,
        memory_id: memoryId,
        created: true,
        requested_primary: requestedPrimary,
        is_primary: primaryChapterId === chapterId ? 1 : 0,
      });
    } catch (e) {
      try {
        await tx.rollback();
      } catch {}
      throw e;
    }
  } catch (err) {
    const msg = String(err?.message || "");

    if (msg.includes("UX_imc_memory_primary") || msg.includes("duplicate key")) {
      const authorId = Number(req?.user?.author_id || 0);
      const chapterId = toInt(req.params.id);
      const memoryId = toInt(req.params.memoryId);

      try {
        const pool = await getPool();
        const existingLinks =
          authorId > 0 && Number.isFinite(memoryId) && memoryId > 0
            ? await listMemoryLinks(pool, authorId, memoryId)
            : [];

        return res.status(409).json({
          error:
            "A API agora aceita memória em múltiplos capítulos, mas o banco ainda está bloqueando este vínculo.",
          code: "MEMORY_LINK_BLOCKED_BY_DB_CONSTRAINT",
          memory_id: Number.isFinite(memoryId) ? memoryId : null,
          requested_chapter_id: Number.isFinite(chapterId) ? chapterId : null,
          existing_links: existingLinks,
          hint:
            "Revise a constraint/índice único da tabela dbo.identity_memory_chapter para permitir unicidade por (memory_id, chapter_id) e, se houver regra de primário, no máximo um vínculo primário por memória.",
        });
      } catch {
        return res.status(409).json({
          error:
            "A API agora aceita memória em múltiplos capítulos, mas o banco ainda está bloqueando este vínculo.",
          code: "MEMORY_LINK_BLOCKED_BY_DB_CONSTRAINT",
          hint:
            "Revise a constraint/índice único da tabela dbo.identity_memory_chapter para permitir unicidade por (memory_id, chapter_id) e, se houver regra de primário, no máximo um vínculo primário por memória.",
        });
      }
    }

    return next(err);
  }
});

router.post("/:id/memories/:memoryId/move", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);
    const fromChapterIdRaw =
      req.body?.from_chapter_id ??
      req.body?.fromChapterId ??
      req.query?.from_chapter_id ??
      req.query?.fromChapterId ??
      null;
    const fromChapterId =
      fromChapterIdRaw == null || fromChapterIdRaw === "" ? null : toInt(fromChapterIdRaw);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }
    if (fromChapterIdRaw != null && (!Number.isFinite(fromChapterId) || fromChapterId <= 0)) {
      return res.status(400).json({ error: "from_chapter_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const sourceLink = await getMoveSourceLink(
      pool,
      authorId,
      memoryId,
      chapterId,
      fromChapterId
    );

    if (!sourceLink) {
      return res.status(404).json({
        error: "Vínculo de origem não encontrado para esta memória.",
        code: "LINK_NOT_FOUND",
        memory_id: memoryId,
        from_chapter_id: fromChapterId,
      });
    }

    const fromChapterResolvedId = Number(sourceLink.chapter_id);
    const fromChapterTitle =
      sourceLink.chapter_title != null ? String(sourceLink.chapter_title) : null;
    const sourceWasPrimary = Number(sourceLink.is_primary ?? 0) === 1;

    if (fromChapterResolvedId === chapterId) {
      return res.status(200).json({
        ok: true,
        code: "ALREADY_IN_CHAPTER",
        memory_id: memoryId,
        from_chapter_id: fromChapterResolvedId,
        from_chapter_title: fromChapterTitle,
        to_chapter_id: chapterId,
      });
    }

    const targetLink = await getMemoryLinkInChapter(pool, authorId, chapterId, memoryId);

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      let nextOrder = null;

      if (!targetLink) {
        nextOrder = await getNextSortOrder(tx, authorId, chapterId);

        await createRequest(tx)
          .input("author_id", sql.Int, authorId)
          .input("memory_id", sql.Int, memoryId)
          .input("to_chapter_id", sql.Int, chapterId)
          .input("sort_order", sql.Int, nextOrder)
          .input("is_primary", sql.Bit, sourceWasPrimary ? 1 : 0)
          .query(`
            INSERT INTO dbo.identity_memory_chapter
              (author_id, memory_id, chapter_id, is_primary, sort_order, created_by)
            VALUES
              (@author_id, @memory_id, @to_chapter_id, @is_primary, @sort_order, NULL);
          `);
      }

      await createRequest(tx)
        .input("author_id", sql.Int, authorId)
        .input("memory_id", sql.Int, memoryId)
        .input("from_chapter_id", sql.Int, fromChapterResolvedId)
        .query(`
          DELETE FROM dbo.identity_memory_chapter
          WHERE author_id = @author_id
            AND memory_id = @memory_id
            AND chapter_id = @from_chapter_id;
        `);

      if (sourceWasPrimary) {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId, chapterId);
      } else {
        await ensureMemoryPrimaryLink(tx, authorId, memoryId);
      }

      await tx.commit();

      const finalLinks = await listMemoryLinks(pool, authorId, memoryId);
      const finalTargetLink =
        finalLinks.find((x) => Number(x.chapter_id) === Number(chapterId)) || null;
      const primaryChapterId =
        finalLinks.find((x) => Number(x.is_primary) === 1)?.chapter_id ?? null;

      try {
        await createNarrativeEvent({
          authorId,
          eventType: "memory_reordered",
          memoryId,
          chapterId,
          eventKey: buildEventKey("memory_reordered", [
            "author",
            authorId,
            "from",
            fromChapterResolvedId,
            "to",
            chapterId,
            "memory",
            memoryId,
          ]),
          metadata: {
            from_chapter_id: fromChapterResolvedId,
            from_chapter_title: fromChapterTitle,
            to_chapter_id: chapterId,
            target_already_linked: !!targetLink,
            sort_order:
              finalTargetLink?.sort_order != null
                ? Number(finalTargetLink.sort_order)
                : nextOrder,
            promoted_to_primary: primaryChapterId === chapterId ? 1 : 0,
            source: "chapters.move_memory",
          },
        });
      } catch (e) {
        console.warn("NarrativeEvent memory_reordered(move) failed:", e?.message);
      }

      return res.status(200).json({
        ok: true,
        code: targetLink ? "MERGED_AND_MOVED" : "MOVED",
        memory_id: memoryId,
        from_chapter_id: fromChapterResolvedId,
        from_chapter_title: fromChapterTitle,
        to_chapter_id: chapterId,
        sort_order:
          finalTargetLink?.sort_order != null ? Number(finalTargetLink.sort_order) : nextOrder,
        is_primary: primaryChapterId === chapterId ? 1 : 0,
      });
    } catch (e) {
      try {
        await tx.rollback();
      } catch {}
      throw e;
    }
  } catch (err) {
    const msg = String(err?.message || "");

    if (msg.includes("UX_imc_memory_primary") || msg.includes("duplicate key")) {
      return res.status(409).json({
        error:
          "O movimento foi interpretado em domínio N:N, mas o banco ainda possui restrição incompatível com o vínculo final.",
        code: "MEMORY_MOVE_BLOCKED_BY_DB_CONSTRAINT",
        hint:
          "Garanta unicidade por (memory_id, chapter_id) e apenas um vínculo primário por memória, se essa regra existir no banco.",
      });
    }

    return next(err);
  }
});

router.delete("/:id/memories/:memoryId", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const existingLink = await getMemoryLinkInChapter(pool, authorId, chapterId, memoryId);
    if (!existingLink) {
      return res.status(404).json({ error: "Vínculo não encontrado." });
    }

    const wasPrimary = Number(existingLink.is_primary ?? 0) === 1;

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      await createRequest(tx)
        .input("author_id", sql.Int, authorId)
        .input("chapter_id", sql.Int, chapterId)
        .input("memory_id", sql.Int, memoryId)
        .query(`
          DELETE FROM dbo.identity_memory_chapter
          WHERE author_id=@author_id
            AND chapter_id=@chapter_id
            AND memory_id=@memory_id;
        `);

      await ensureMemoryPrimaryLink(tx, authorId, memoryId);

      await tx.commit();

      return res.json({
        ok: true,
        chapter_id: chapterId,
        memory_id: memoryId,
        removed_primary: wasPrimary,
      });
    } catch (e) {
      try {
        await tx.rollback();
      } catch {}
      throw e;
    }
  } catch (err) {
    return next(err);
  }
});

router.put("/:id/memories/:memoryId/order", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const chapterId = toInt(req.params.id);
    const memoryId = toInt(req.params.memoryId);

    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: "chapter_id inválido." });
    }
    if (!Number.isFinite(memoryId) || memoryId <= 0) {
      return res.status(400).json({ error: "memory_id inválido." });
    }

    const sortOrderRaw = req.body?.sort_order ?? req.body?.sortOrder ?? null;
    const sortOrder =
      sortOrderRaw === null || sortOrderRaw === undefined ? null : Number(sortOrderRaw);

    if (
      sortOrder !== null &&
      (!Number.isInteger(sortOrder) || sortOrder < 1 || sortOrder > 1000000)
    ) {
      return res.status(422).json({ error: "sort_order inválido (use int >= 1 ou null)." });
    }

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const exists = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("memory_id", sql.Int, memoryId)
      .query(`
        SELECT TOP 1 1 AS ok
        FROM dbo.identity_memory_chapter
        WHERE author_id=@author_id AND chapter_id=@chapter_id AND memory_id=@memory_id;
      `);

    if (!exists.recordset?.[0]?.ok) {
      return res.status(404).json({ error: "Vínculo não encontrado." });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("memory_id", sql.Int, memoryId)
      .input("sort_order", sql.Int, sortOrder)
      .query(`
        UPDATE dbo.identity_memory_chapter
        SET sort_order = @sort_order
        WHERE author_id=@author_id AND chapter_id=@chapter_id AND memory_id=@memory_id;
      `);

    try {
      await createNarrativeEvent({
        authorId,
        eventType: "memory_reordered",
        memoryId,
        chapterId,
        eventKey: buildEventKey("memory_reordered", [
          "author",
          authorId,
          "chapter",
          chapterId,
          "memory",
          memoryId,
          "sort",
          sortOrder ?? "null",
        ]),
        metadata: {
          sort_order: sortOrder,
          source: "chapters.update_order",
        },
      });
    } catch (e) {
      console.warn("NarrativeEvent memory_reordered(order) failed:", e?.message);
    }

    return res.json({
      ok: true,
      chapter_id: chapterId,
      memory_id: memoryId,
      sort_order: sortOrder,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;