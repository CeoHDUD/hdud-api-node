// C:\HDUD_DATA\hdud-api-node\src\routes\chapters.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import {
  createNarrativeEvent,
  buildEventKey,
} from "../services/narrative-events.js";

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

function normalizeChapterRow(r) {
  if (!r) return null;
  return {
    chapter_id: r.chapter_id,
    author_id: r.author_id,
    title: r.title,
    description: r.description,
    status: r.status,
    current_version_id: r.current_version_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published_at: r.published_at,
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

async function getMemoryLink(pool, authorId, memoryId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("memory_id", sql.Int, memoryId)
    .query(`
      SELECT TOP 1
        chapter_id,
        is_primary,
        sort_order,
        created_at AS linked_at,
        created_by AS linked_by
      FROM dbo.identity_memory_chapter
      WHERE author_id = @author_id
        AND memory_id = @memory_id;
    `);

  return r?.recordset?.[0] || null;
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
        title,
        status,
        created_at,
        updated_at,
        published_at
      FROM dbo.identity_chapter
      WHERE author_id = @author_id
        AND ISNULL(is_deleted,0) = 0
      ORDER BY
        CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END ASC,
        updated_at DESC,
        created_at DESC,
        chapter_id DESC;
    `);

  return (r?.recordset || []).map((x) => ({
    chapter_id: Number(x.chapter_id),
    title: x.title != null ? String(x.title) : null,
    status: x.status != null ? String(x.status) : null,
    created_at: x.created_at ?? null,
    updated_at: x.updated_at ?? null,
    published_at: x.published_at ?? null,
  }));
}

router.get("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .execute("dbo.p_Chapter_List_ByAuthor");

    const rows = result?.recordset || [];
    return res.json({ items: rows.map(normalizeChapterRow) });
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
    const status =
      req.body?.status != null ? String(req.body.status).toUpperCase() : "DRAFT";

    if (!title) {
      return res.status(400).json({ error: "title é obrigatório." });
    }

    const safeStatus = ["DRAFT", "PUBLIC", "SHARED"].includes(status)
      ? status
      : "DRAFT";

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
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Get_ById");

    const recordsets = result?.recordsets || [];
    const chapterRows = recordsets[0] || [];
    const versionRows = recordsets[1] || [];

    if (!chapterRows.length) {
      return res.status(404).json({ error: "Capítulo não encontrado." });
    }

    return res.json({
      chapter: normalizeChapterRow(chapterRows[0]),
      current_version: versionRows.length
        ? normalizeChapterVersionRow(versionRows[0])
        : null,
    });
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
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Publish");

    const row = result?.recordset?.[0] || null;
    return res.json({ chapter_id: chapterId, status: row?.status || "PUBLIC" });
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
    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .execute("dbo.p_Chapter_Unpublish");

    const row = result?.recordset?.[0] || null;
    return res.json({ chapter_id: chapterId, status: row?.status || "DRAFT" });
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

    const pool = await getPool();

    const okChapter = await assertChapterOwned(pool, authorId, chapterId);
    if (!okChapter) return res.status(404).json({ error: "Capítulo não encontrado." });

    const okMemory = await assertMemoryOwned(pool, authorId, memoryId);
    if (!okMemory) return res.status(404).json({ error: "Memória não encontrada." });

    const existing = await getMemoryLink(pool, authorId, memoryId);
    if (existing?.chapter_id != null) {
      const existingChapterId = Number(existing.chapter_id);

      if (existingChapterId === chapterId) {
        return res.status(200).json({
          ok: true,
          already_linked: true,
          chapter_id: chapterId,
          memory_id: memoryId,
          linked_at: existing.linked_at ?? null,
          linked_by: existing.linked_by ?? null,
        });
      }

      const currentChapterTitle = await getChapterTitle(pool, authorId, existingChapterId);
      const existingChapters = await listExistingChapters(pool, authorId);

      return res.status(409).json({
        error: "Memória já vinculada a outro capítulo.",
        code: "MEMORY_ALREADY_LINKED",
        memory_id: memoryId,
        current_chapter_id: existingChapterId,
        current_chapter_title: currentChapterTitle,
        requested_chapter_id: chapterId,
        existing_chapters: existingChapters,
        hint: "Remova o vínculo no capítulo atual antes de vincular aqui.",
      });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("memory_id", sql.Int, memoryId)
      .query(`
        DECLARE @next_order INT;
        SELECT @next_order = ISNULL(MAX(sort_order), 0) + 1
        FROM dbo.identity_memory_chapter
        WHERE author_id=@author_id AND chapter_id=@chapter_id;

        INSERT INTO dbo.identity_memory_chapter (author_id, memory_id, chapter_id, is_primary, sort_order, created_by)
        VALUES (@author_id, @memory_id, @chapter_id, 1, @next_order, NULL);
      `);

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
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("UX_imc_memory_primary") || msg.includes("duplicate key")) {
      return res.status(409).json({
        error: "Memória já vinculada a outro capítulo.",
        code: "MEMORY_ALREADY_LINKED",
      });
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

    const curQ = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("memory_id", sql.Int, memoryId)
      .query(`
        SELECT TOP 1
          imc.chapter_id,
          c.title AS chapter_title
        FROM dbo.identity_memory_chapter imc
        INNER JOIN dbo.identity_chapter c
          ON c.chapter_id = imc.chapter_id
         AND c.author_id = imc.author_id
        WHERE imc.author_id = @author_id
          AND imc.memory_id = @memory_id
        ORDER BY imc.chapter_id DESC;
      `);

    const cur = curQ.recordset?.[0] || null;
    if (!cur) {
      return res.status(404).json({
        error: "Vínculo não encontrado para esta memória.",
        code: "LINK_NOT_FOUND",
        memory_id: memoryId,
      });
    }

    const fromChapterId = Number(cur.chapter_id);
    const fromChapterTitle = cur.chapter_title != null ? String(cur.chapter_title) : null;

    if (fromChapterId === chapterId) {
      return res.status(200).json({
        ok: true,
        code: "ALREADY_IN_CHAPTER",
        memory_id: memoryId,
        from_chapter_id: fromChapterId,
        from_chapter_title: fromChapterTitle,
        to_chapter_id: chapterId,
      });
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      await new sql.Request(tx)
        .input("author_id", sql.Int, authorId)
        .input("memory_id", sql.Int, memoryId)
        .input("from_chapter_id", sql.Int, fromChapterId)
        .query(`
          DELETE FROM dbo.identity_memory_chapter
          WHERE author_id = @author_id
            AND memory_id = @memory_id
            AND chapter_id = @from_chapter_id;
        `);

      const maxQ = await new sql.Request(tx)
        .input("author_id", sql.Int, authorId)
        .input("to_chapter_id", sql.Int, chapterId)
        .query(`
          SELECT ISNULL(MAX(sort_order), 0) AS max_sort
          FROM dbo.identity_memory_chapter
          WHERE author_id = @author_id
            AND chapter_id = @to_chapter_id;
        `);

      const nextOrder = Number(maxQ.recordset?.[0]?.max_sort ?? 0) + 1;

      await new sql.Request(tx)
        .input("author_id", sql.Int, authorId)
        .input("memory_id", sql.Int, memoryId)
        .input("to_chapter_id", sql.Int, chapterId)
        .input("sort_order", sql.Int, nextOrder)
        .query(`
          INSERT INTO dbo.identity_memory_chapter
            (author_id, memory_id, chapter_id, is_primary, sort_order, created_by)
          VALUES
            (@author_id, @memory_id, @to_chapter_id, 1, @sort_order, NULL);
        `);

      await tx.commit();

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
            fromChapterId,
            "to",
            chapterId,
            "memory",
            memoryId,
          ]),
          metadata: {
            from_chapter_id: fromChapterId,
            from_chapter_title: fromChapterTitle,
            to_chapter_id: chapterId,
            sort_order: nextOrder,
            source: "chapters.move_memory",
          },
        });
      } catch (e) {
        console.warn("NarrativeEvent memory_reordered(move) failed:", e?.message);
      }

      return res.status(200).json({
        ok: true,
        code: "MOVED",
        memory_id: memoryId,
        from_chapter_id: fromChapterId,
        from_chapter_title: fromChapterTitle,
        to_chapter_id: chapterId,
        sort_order: nextOrder,
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

    const del = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("chapter_id", sql.Int, chapterId)
      .input("memory_id", sql.Int, memoryId)
      .query(`
        DELETE FROM dbo.identity_memory_chapter
        WHERE author_id=@author_id AND chapter_id=@chapter_id AND memory_id=@memory_id;

        SELECT @@ROWCOUNT AS affected;
      `);

    const affected = Number(del?.recordset?.[0]?.affected ?? 0);
    if (!affected) return res.status(404).json({ error: "Vínculo não encontrado." });

    return res.json({ ok: true, chapter_id: chapterId, memory_id: memoryId });
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