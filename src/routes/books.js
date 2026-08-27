// C:\HDUD_DATA\hdud-api-node\src\routes\books.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { checkPlanFeature, sendPlanDenied } from "../services/plan-enforcement.service.js";

const router = express.Router();

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function ensureAuthorId(req, res) {
  const authorId = Number(req?.user?.author_id);
  if (!Number.isInteger(authorId) || authorId <= 0) {
    res.status(401).json({ error: "Não autenticado." });
    return null;
  }
  return authorId;
}

function ensureUserId(req, res) {
  const userId = Number(req?.user?.user_id ?? req?.user?.userId ?? req?.user?.id ?? req?.user?.uid ?? req?.user?.sub);
  if (!Number.isInteger(userId) || userId <= 0) { res.status(401).json({ error: "user_id não encontrado no token." }); return null; }
  return userId;
}

async function requireBookAssembly(req, res, pool) {
  const userId = ensureUserId(req, res);
  if (!userId) return null;
  const check = await checkPlanFeature({ pool, userId, featureCode: "BOOK_ASSEMBLY", requestedValue: 1 });
  if (!check.allowed) {
    sendPlanDenied(res, check, { status: 403, message: "Book Assembly não está disponível no seu plano atual." });
    return null;
  }
  return { userId, check };
}

function normalizeText(value, maxLen, fallback = null) {
  if (value == null) return fallback;
  const s = String(value).trim();
  if (!s) return fallback;
  return s.slice(0, maxLen);
}

function normalizeStatus(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (s === "PUBLIC" || s === "SHARED") return s;
  return "DRAFT";
}

function normalizeChapters(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((x, index) => ({
      chapter_id: toInt(x?.chapter_id ?? x?.id ?? x),
      sort_order: toInt(x?.sort_order ?? index + 1),
      part_title: normalizeText(x?.part_title, 200, null),
    }))
    .filter(
      (x) =>
        Number.isInteger(x.chapter_id) &&
        x.chapter_id > 0 &&
        Number.isInteger(x.sort_order) &&
        x.sort_order > 0,
    );
}

async function assertBookOwned(pool, authorId, bookId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("book_id", sql.Int, bookId)
    .query(`
      SELECT TOP 1 book_id
      FROM dbo.identity_book
      WHERE book_id = @book_id
        AND author_id = @author_id
        AND ISNULL(is_deleted, 0) = 0;
    `);

  return !!r.recordset?.[0]?.book_id;
}

async function validateChapters(pool, authorId, chapters) {
  const ids = [...new Set(chapters.map((x) => x.chapter_id))];

  // Um Livro pode nascer vazio e receber capítulos depois.
  // Isso também permite remover o último capítulo sem apagar o Livro.
  if (!ids.length) {
    return { ok: true };
  }

  const request = pool.request().input("author_id", sql.Int, authorId);

  ids.forEach((id, index) => {
    request.input(`chapter_id_${index}`, sql.Int, id);
  });

  const placeholders = ids.map((_, index) => `@chapter_id_${index}`).join(",");

  const r = await request.query(`
    SELECT chapter_id
    FROM dbo.identity_chapter
    WHERE author_id = @author_id
      AND ISNULL(is_deleted, 0) = 0
      AND chapter_id IN (${placeholders});
  `);

  const found = new Set((r.recordset || []).map((x) => Number(x.chapter_id)));
  const missing = ids.filter((id) => !found.has(id));

  if (missing.length) {
    return {
      ok: false,
      error: "Um ou mais capítulos não pertencem ao autor ou não existem.",
      missing_chapter_ids: missing,
    };
  }

  return { ok: true };
}

async function createBookVersion(poolOrTx, payload) {
  const r = await poolOrTx
    .request()
    .input("book_id", sql.Int, payload.book_id)
    .input("author_id", sql.Int, payload.author_id)
    .input("version_number", sql.Int, payload.version_number)
    .input("title_snapshot", sql.NVarChar(200), payload.title)
    .input("subtitle_snapshot", sql.NVarChar(300), payload.subtitle)
    .input("synopsis_snapshot", sql.NVarChar(1000), payload.synopsis)
    .input("description_snapshot", sql.NVarChar(sql.MAX), payload.description)
    .input("event_type", sql.VarChar(50), payload.event_type)
    .query(`
      UPDATE dbo.identity_book_versions
      SET is_current_version = 0
      WHERE book_id = @book_id
        AND author_id = @author_id;

      INSERT INTO dbo.identity_book_versions
      (
        book_id,
        author_id,
        version_number,
        title_snapshot,
        subtitle_snapshot,
        synopsis_snapshot,
        description_snapshot,
        event_type,
        created_at,
        is_current_version,
        is_published_version
      )
      OUTPUT INSERTED.book_version_id
      VALUES
      (
        @book_id,
        @author_id,
        @version_number,
        @title_snapshot,
        @subtitle_snapshot,
        @synopsis_snapshot,
        @description_snapshot,
        @event_type,
        SYSUTCDATETIME(),
        1,
        0
      );
    `);

  return Number(r.recordset?.[0]?.book_version_id ?? 0);
}

async function replaceBookChapters(poolOrTx, authorId, bookId, chapters) {
  await poolOrTx
    .request()
    .input("book_id", sql.Int, bookId)
    .query(`
      DELETE FROM dbo.identity_chapter_book
      WHERE book_id = @book_id;
    `);

  for (const item of chapters) {
    await poolOrTx
      .request()
      .input("book_id", sql.Int, bookId)
      .input("chapter_id", sql.Int, item.chapter_id)
      .input("part_title", sql.NVarChar(200), item.part_title)
      .input("sort_order", sql.Int, item.sort_order)
      .query(`
        INSERT INTO dbo.identity_chapter_book
        (
          book_id,
          chapter_id,
          part_title,
          sort_order,
          created_at
        )
        VALUES
        (
          @book_id,
          @chapter_id,
          @part_title,
          @sort_order,
          SYSUTCDATETIME()
        );
      `);
  }
}

async function getNextBookVersionNumber(pool, bookId) {
  const r = await pool
    .request()
    .input("book_id", sql.Int, bookId)
    .query(`
      SELECT ISNULL(MAX(version_number), 0) + 1 AS next_version
      FROM dbo.identity_book_versions
      WHERE book_id = @book_id;
    `);

  return Number(r.recordset?.[0]?.next_version ?? 1);
}

async function getBookPreview(pool, authorId, bookId) {
  const bookR = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("book_id", sql.Int, bookId)
    .query(`
      SELECT TOP 1
        book_id,
        author_id,
        title,
        subtitle,
        synopsis,
        description,
        status,
        current_version_id,
        created_at,
        updated_at,
        published_at
      FROM dbo.identity_book
      WHERE book_id = @book_id
        AND author_id = @author_id
        AND ISNULL(is_deleted, 0) = 0;
    `);

  const book = bookR.recordset?.[0] || null;
  if (!book) return null;

  const chaptersR = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .input("book_id", sql.Int, bookId)
    .query(`
      SELECT
        cb.chapter_book_id,
        cb.book_id,
        cb.chapter_id,
        cb.part_title,
        cb.sort_order,
        c.title,
        c.description,
        c.status,
        c.publication_status,
        c.current_version_id,
        c.created_at,
        c.updated_at,
        c.published_at,
        v.body
      FROM dbo.identity_chapter_book cb
      INNER JOIN dbo.identity_chapter c
        ON c.chapter_id = cb.chapter_id
      LEFT JOIN dbo.identity_chapter_versions v
        ON v.chapter_version_id = c.current_version_id
      WHERE cb.book_id = @book_id
        AND c.author_id = @author_id
        AND ISNULL(c.is_deleted, 0) = 0
      ORDER BY
        cb.sort_order ASC,
        cb.chapter_book_id ASC;
    `);

  const chapters = (chaptersR.recordset || []).map((x) => ({
    chapter_book_id: Number(x.chapter_book_id),
    book_id: Number(x.book_id),
    chapter_id: Number(x.chapter_id),
    part_title: x.part_title ?? null,
    sort_order: Number(x.sort_order),
    title: x.title ?? null,
    description: x.description ?? null,
    status: x.publication_status ?? x.status ?? null,
    current_version_id: x.current_version_id ?? null,
    created_at: x.created_at ?? null,
    updated_at: x.updated_at ?? null,
    published_at: x.published_at ?? null,
    body: x.body ?? "",
  }));

  const partsMap = new Map();

  for (const chapter of chapters) {
    const key = chapter.part_title || "Livro";
    if (!partsMap.has(key)) {
      partsMap.set(key, {
        part_title: chapter.part_title,
        chapters: [],
      });
    }
    partsMap.get(key).chapters.push(chapter);
  }

  return {
    book: {
      book_id: Number(book.book_id),
      author_id: Number(book.author_id),
      title: book.title,
      subtitle: book.subtitle ?? null,
      synopsis: book.synopsis ?? null,
      description: book.description ?? null,
      status: book.status,
      current_version_id: book.current_version_id ?? null,
      created_at: book.created_at ?? null,
      updated_at: book.updated_at ?? null,
      published_at: book.published_at ?? null,
    },
    total_chapters: chapters.length,
    total_parts: partsMap.size,
    parts: Array.from(partsMap.values()),
    chapters,
    traceability: {
      rule: "Livro → Capítulo → Memória",
      book_has_own_body: false,
      source_policy: "Livro composto apenas por capítulos reais do autor.",
    },
  };
}

router.get("/", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const pool = await getPool();

    const r = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          b.book_id,
          b.author_id,
          b.title,
          b.subtitle,
          b.synopsis,
          b.description,
          b.status,
          b.current_version_id,
          b.created_at,
          b.updated_at,
          b.published_at,
          COUNT(cb.chapter_id) AS chapter_count
        FROM dbo.identity_book b
        LEFT JOIN dbo.identity_chapter_book cb
          ON cb.book_id = b.book_id
        WHERE b.author_id = @author_id
          AND ISNULL(b.is_deleted, 0) = 0
        GROUP BY
          b.book_id,
          b.author_id,
          b.title,
          b.subtitle,
          b.synopsis,
          b.description,
          b.status,
          b.current_version_id,
          b.created_at,
          b.updated_at,
          b.published_at
        ORDER BY
          b.updated_at DESC,
          b.created_at DESC,
          b.book_id DESC;
      `);

    return res.json({
      items: (r.recordset || []).map((x) => ({
        book_id: Number(x.book_id),
        author_id: Number(x.author_id),
        title: x.title,
        subtitle: x.subtitle ?? null,
        synopsis: x.synopsis ?? null,
        description: x.description ?? null,
        status: x.status,
        current_version_id: x.current_version_id ?? null,
        created_at: x.created_at ?? null,
        updated_at: x.updated_at ?? null,
        published_at: x.published_at ?? null,
        chapter_count: Number(x.chapter_count ?? 0),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/", authRequired, async (req, res, next) => {
  const authorId = ensureAuthorId(req, res);
  if (!authorId) return;

  const title = normalizeText(req.body?.title, 200, null);
  const subtitle = normalizeText(req.body?.subtitle, 300, null);
  const synopsis = normalizeText(req.body?.synopsis, 1000, null);
  const description = normalizeText(req.body?.description, 4000, null);
  const status = normalizeStatus(req.body?.status);
  const chapters = normalizeChapters(req.body?.chapters);

  if (!title) {
    return res.status(400).json({ error: "title é obrigatório." });
  }

  try {
    const pool = await getPool();
    const entitlement = await requireBookAssembly(req, res, pool);
    if (!entitlement) return;

    const chapterValidation = await validateChapters(pool, authorId, chapters);
    if (!chapterValidation.ok) {
      return res.status(400).json(chapterValidation);
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      const bookR = await tx
        .request()
        .input("author_id", sql.Int, authorId)
        .input("title", sql.NVarChar(200), title)
        .input("subtitle", sql.NVarChar(300), subtitle)
        .input("synopsis", sql.NVarChar(1000), synopsis)
        .input("description", sql.NVarChar(sql.MAX), description)
        .input("status", sql.VarChar(20), status)
        .query(`
          INSERT INTO dbo.identity_book
          (
            author_id,
            title,
            subtitle,
            synopsis,
            description,
            status,
            created_at,
            updated_at,
            published_at,
            is_deleted
          )
          OUTPUT INSERTED.book_id
          VALUES
          (
            @author_id,
            @title,
            @subtitle,
            @synopsis,
            @description,
            @status,
            SYSUTCDATETIME(),
            SYSUTCDATETIME(),
            CASE WHEN @status = 'PUBLIC' THEN SYSUTCDATETIME() ELSE NULL END,
            0
          );
        `);

      const bookId = Number(bookR.recordset?.[0]?.book_id);
      if (!Number.isInteger(bookId) || bookId <= 0) {
        throw new Error("Falha ao criar livro.");
      }

      await replaceBookChapters(tx, authorId, bookId, chapters);

      const versionId = await createBookVersion(tx, {
        book_id: bookId,
        author_id: authorId,
        version_number: 1,
        title,
        subtitle,
        synopsis,
        description,
        event_type: "BOOK_CREATED",
      });

      await tx
        .request()
        .input("book_id", sql.Int, bookId)
        .input("current_version_id", sql.Int, versionId)
        .query(`
          UPDATE dbo.identity_book
          SET current_version_id = @current_version_id,
              updated_at = SYSUTCDATETIME()
          WHERE book_id = @book_id;
        `);

      await tx.commit();

      return res.status(201).json({
        ok: true,
        book_id: bookId,
        book_version_id: versionId,
        status,
        total_chapters: chapters.length,
      });
    } catch (err) {
      try {
        await tx.rollback();
      } catch {}
      throw err;
    }
  } catch (err) {
    return next(err);
  }
});

router.get("/capabilities", authRequired, async (req, res, next) => {
  try {
    const userId = ensureUserId(req, res);
    if (!userId) return;
    const pool = await getPool();
    const [bookAssembly, pdfGeneration] = await Promise.all([
      checkPlanFeature({ pool, userId, featureCode: "BOOK_ASSEMBLY", requestedValue: 1 }),
      checkPlanFeature({ pool, userId, featureCode: "PDF_GENERATION", requestedValue: 1 }),
    ]);
    const contract = await pool.request()
      .input("user_id", sql.BigInt, userId)
      .execute("dbo.p_GetMyPlanContract");
    const theme = (contract?.recordset || []).find((x) => String(x.feature_code || "") === "BOOK_THEME_TIER");
    return res.json({
      ok: true,
      book_assembly: !!bookAssembly.allowed,
      pdf_generation: !!pdfGeneration.allowed,
      book_theme_tier: theme?.string_value ? String(theme.string_value) : "NONE",
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const bookId = toInt(req.params.id);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      return res.status(400).json({ error: "book_id inválido." });
    }

    const pool = await getPool();
    const entitlement = await requireBookAssembly(req, res, pool);
    if (!entitlement) return;
    const preview = await getBookPreview(pool, authorId, bookId);

    if (!preview) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    return res.json(preview);
  } catch (err) {
    return next(err);
  }
});

router.put("/:id", authRequired, async (req, res, next) => {
  const authorId = ensureAuthorId(req, res);
  if (!authorId) return;

  const bookId = toInt(req.params.id);
  if (!Number.isInteger(bookId) || bookId <= 0) {
    return res.status(400).json({ error: "book_id inválido." });
  }

  const title = normalizeText(req.body?.title, 200, null);
  const subtitle = normalizeText(req.body?.subtitle, 300, null);
  const synopsis = normalizeText(req.body?.synopsis, 1000, null);
  const description = normalizeText(req.body?.description, 4000, null);
  const status = normalizeStatus(req.body?.status);
  const chapters = normalizeChapters(req.body?.chapters);

  if (!title) {
    return res.status(400).json({ error: "title é obrigatório." });
  }

  try {
    const pool = await getPool();
    const entitlement = await requireBookAssembly(req, res, pool);
    if (!entitlement) return;

    const owned = await assertBookOwned(pool, authorId, bookId);
    if (!owned) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    const chapterValidation = await validateChapters(pool, authorId, chapters);
    if (!chapterValidation.ok) {
      return res.status(400).json(chapterValidation);
    }

    const nextVersion = await getNextBookVersionNumber(pool, bookId);

    const tx = new sql.Transaction(pool);
    await tx.begin();

    try {
      await tx
        .request()
        .input("book_id", sql.Int, bookId)
        .input("author_id", sql.Int, authorId)
        .input("title", sql.NVarChar(200), title)
        .input("subtitle", sql.NVarChar(300), subtitle)
        .input("synopsis", sql.NVarChar(1000), synopsis)
        .input("description", sql.NVarChar(sql.MAX), description)
        .input("status", sql.VarChar(20), status)
        .query(`
          UPDATE dbo.identity_book
          SET
            title = @title,
            subtitle = @subtitle,
            synopsis = @synopsis,
            description = @description,
            status = @status,
            published_at =
              CASE
                WHEN @status = 'PUBLIC' AND published_at IS NULL THEN SYSUTCDATETIME()
                WHEN @status <> 'PUBLIC' THEN NULL
                ELSE published_at
              END,
            updated_at = SYSUTCDATETIME()
          WHERE book_id = @book_id
            AND author_id = @author_id
            AND ISNULL(is_deleted, 0) = 0;
        `);

      await replaceBookChapters(tx, authorId, bookId, chapters);

      const versionId = await createBookVersion(tx, {
        book_id: bookId,
        author_id: authorId,
        version_number: nextVersion,
        title,
        subtitle,
        synopsis,
        description,
        event_type: "BOOK_UPDATED",
      });

      await tx
        .request()
        .input("book_id", sql.Int, bookId)
        .input("current_version_id", sql.Int, versionId)
        .query(`
          UPDATE dbo.identity_book
          SET current_version_id = @current_version_id,
              updated_at = SYSUTCDATETIME()
          WHERE book_id = @book_id;
        `);

      await tx.commit();

      return res.json({
        ok: true,
        book_id: bookId,
        book_version_id: versionId,
        version_number: nextVersion,
        status,
        total_chapters: chapters.length,
      });
    } catch (err) {
      try {
        await tx.rollback();
      } catch {}
      throw err;
    }
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/preview", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const bookId = toInt(req.params.id);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      return res.status(400).json({ error: "book_id inválido." });
    }

    const pool = await getPool();
    const entitlement = await requireBookAssembly(req, res, pool);
    if (!entitlement) return;
    const preview = await getBookPreview(pool, authorId, bookId);

    if (!preview) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    return res.json(preview);
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/versions", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const bookId = toInt(req.params.id);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      return res.status(400).json({ error: "book_id inválido." });
    }

    const pool = await getPool();
    const entitlement = await requireBookAssembly(req, res, pool);
    if (!entitlement) return;

    const owned = await assertBookOwned(pool, authorId, bookId);
    if (!owned) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    const r = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("book_id", sql.Int, bookId)
      .query(`
        SELECT
          book_version_id,
          book_id,
          author_id,
          version_number,
          title_snapshot,
          subtitle_snapshot,
          synopsis_snapshot,
          description_snapshot,
          event_type,
          created_at,
          is_current_version,
          is_published_version
        FROM dbo.identity_book_versions
        WHERE book_id = @book_id
          AND author_id = @author_id
        ORDER BY version_number DESC, book_version_id DESC;
      `);

    return res.json({
      book_id: bookId,
      items: (r.recordset || []).map((x) => ({
        book_version_id: Number(x.book_version_id),
        book_id: Number(x.book_id),
        author_id: Number(x.author_id),
        version_number: Number(x.version_number),
        title_snapshot: x.title_snapshot,
        subtitle_snapshot: x.subtitle_snapshot ?? null,
        synopsis_snapshot: x.synopsis_snapshot ?? null,
        description_snapshot: x.description_snapshot ?? null,
        event_type: x.event_type,
        created_at: x.created_at ?? null,
        is_current_version: Number(x.is_current_version ?? 0) === 1,
        is_published_version: Number(x.is_published_version ?? 0) === 1,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/publish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const bookId = toInt(req.params.id);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      return res.status(400).json({ error: "book_id inválido." });
    }

    const pool = await getPool();
    const entitlement = await requireBookAssembly(req, res, pool);
    if (!entitlement) return;

    const owned = await assertBookOwned(pool, authorId, bookId);
    if (!owned) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    await pool
      .request()
      .input("book_id", sql.Int, bookId)
      .input("author_id", sql.Int, authorId)
      .query(`
        UPDATE dbo.identity_book
        SET status = 'PUBLIC',
            published_at = ISNULL(published_at, SYSUTCDATETIME()),
            updated_at = SYSUTCDATETIME()
        WHERE book_id = @book_id
          AND author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;

        UPDATE dbo.identity_book_versions
        SET is_published_version =
          CASE
            WHEN book_version_id = (
              SELECT current_version_id
              FROM dbo.identity_book
              WHERE book_id = @book_id
                AND author_id = @author_id
            )
            THEN 1 ELSE 0
          END
        WHERE book_id = @book_id
          AND author_id = @author_id;
      `);

    return res.json({
      ok: true,
      book_id: bookId,
      status: "PUBLIC",
    });
  } catch (err) {
    return next(err);
  }
});


router.post("/:id/unpublish", authRequired, async (req, res, next) => {
  try {
    const authorId = ensureAuthorId(req, res);
    if (!authorId) return;

    const bookId = toInt(req.params.id);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      return res.status(400).json({ error: "book_id inválido." });
    }

    const pool = await getPool();
    const entitlement = await requireBookAssembly(req, res, pool);
    if (!entitlement) return;

    const owned = await assertBookOwned(pool, authorId, bookId);
    if (!owned) {
      return res.status(404).json({ error: "Livro não encontrado." });
    }

    await pool
      .request()
      .input("book_id", sql.Int, bookId)
      .input("author_id", sql.Int, authorId)
      .query(`
        UPDATE dbo.identity_book
        SET status = 'DRAFT',
            published_at = NULL,
            updated_at = SYSUTCDATETIME()
        WHERE book_id = @book_id
          AND author_id = @author_id
          AND ISNULL(is_deleted, 0) = 0;

        UPDATE dbo.identity_book_versions
        SET is_published_version = 0
        WHERE book_id = @book_id
          AND author_id = @author_id;
      `);

    return res.json({
      ok: true,
      book_id: bookId,
      status: "DRAFT",
      published_at: null,
      feed_eligible: false,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;