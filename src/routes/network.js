// C:\HDUD_DATA\hdud-api-node\src\routes\network.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

// ============================
// Helpers
// ============================

function getAuthorId(req) {
  const authorId = Number(req.user?.author_id);
  return Number.isInteger(authorId) && authorId > 0 ? authorId : null;
}

function normalizeText(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function makePreview(text, maxLen = 140) {
  const s = normalizeText(text, "");
  if (!s) return "História em construção dentro da HDUD.";
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (!oneLine) return "História em construção dentro da HDUD.";
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

function toBooleanDb(v) {
  return v === true || v === 1 || v === "1";
}

function safeIso(value) {
  try {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {}
  return new Date().toISOString();
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const i = Math.trunc(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

// ============================
// Summary
// ============================

router.get("/summary", authenticate, async (req, res, next) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });

    const pool = await getPool();

    const result = await pool.request().input("author_id", sql.Int, authorId).query(`
      SELECT
        followers = (
          SELECT COUNT(1)
          FROM dbo.identity_follow f
          WHERE f.followed_id = @author_id
        ),
        following = (
          SELECT COUNT(1)
          FROM dbo.identity_follow f
          WHERE f.follower_id = @author_id
        ),
        new_followers_7d = (
          SELECT COUNT(1)
          FROM dbo.identity_follow f
          WHERE f.followed_id = @author_id
            AND f.created_at >= DATEADD(DAY, -7, SYSUTCDATETIME())
        );
    `);

    const row = result.recordset?.[0] || {};

    const followers = Number(row.followers || 0);
    const following = Number(row.following || 0);
    const newFollowers = Number(row.new_followers_7d || 0);

    let presenceStatus = "Inicial";
    if (followers >= 25 || following >= 15 || newFollowers >= 3) presenceStatus = "Moderada";
    if (followers >= 50 || following >= 30 || newFollowers >= 6) presenceStatus = "Alta";

    const growthBase = followers <= 0 ? 1 : followers;
    const growthPct = Math.max(0, Math.round((newFollowers / growthBase) * 100));

    return res.json({
      followers,
      following,
      newFollowers,
      profileViews7d: 0,
      growth7d: `+${growthPct}%`,
      presenceStatus,
    });
  } catch (err) {
    return next(err);
  }
});

// ============================
// Suggestions
// ============================

router.get("/suggestions", authenticate, async (req, res, next) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });

    const limit = clampInt(req.query?.limit, 1, 50, 12);
    const pool = await getPool();

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("limit", sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url,
          last_memory_title = lm.title,
          last_memory_content = lm.content,
          memory_count = ISNULL(mem_stats.memory_count, 0),
          chapter_count = ISNULL(ch_stats.chapter_count, 0),
          is_following = CASE
            WHEN f.followed_id IS NOT NULL THEN 1
            ELSE 0
          END
        FROM dbo.identity_author a
        LEFT JOIN dbo.identity_follow f
          ON f.followed_id = a.author_id
         AND f.follower_id = @author_id
        OUTER APPLY (
          SELECT COUNT(1) AS memory_count
          FROM dbo.identity_memory m
          WHERE m.author_id = a.author_id
            AND ISNULL(m.is_deleted, 0) = 0
        ) mem_stats
        OUTER APPLY (
          SELECT COUNT(1) AS chapter_count
          FROM dbo.identity_chapter c
          WHERE c.author_id = a.author_id
            AND ISNULL(c.is_deleted, 0) = 0
        ) ch_stats
        OUTER APPLY (
          SELECT TOP 1
            m.title,
            m.content
          FROM dbo.identity_memory m
          WHERE m.author_id = a.author_id
            AND ISNULL(m.is_deleted, 0) = 0
          ORDER BY m.created_at DESC, m.memory_id DESC
        ) lm
        WHERE a.author_id <> @author_id
        ORDER BY
          CASE WHEN f.followed_id IS NULL THEN 0 ELSE 1 END ASC,
          ISNULL(mem_stats.memory_count, 0) DESC,
          ISNULL(ch_stats.chapter_count, 0) DESC,
          a.author_id DESC;
      `);

    const items = (result.recordset || [])
      .map((row) => {
        const name =
          normalizeText(row.name_public) ||
          normalizeText(row.full_name) ||
          normalizeText(row.author_code) ||
          "Usuário";

        const memoryCount = Number(row.memory_count || 0);
        const chapterCount = Number(row.chapter_count || 0);

        const signals = [];
        if (memoryCount > 0) signals.push("Narrativa ativa");
        if (chapterCount > 0) signals.push("Capítulos publicados");
        if (signals.length === 0) signals.push("História em construção");

        const reason =
          memoryCount > 0 || chapterCount > 0
            ? "Sugestão baseada em atividade narrativa dentro da HDUD."
            : "Sugestão baseada na expansão inicial da sua rede.";

        const preview = makePreview(
          row.last_memory_content || row.last_memory_title || "História em construção dentro da HDUD.",
          160
        );

        return {
          id: Number(row.author_id),
          author_id: Number(row.author_id),
          name,
          name_public: name,
          headline: normalizeText(row.bio_short, "História em construção na HDUD."),
          location: normalizeText(row.location, ""),
          avatar_url: row.avatar_url != null ? String(row.avatar_url) : null,
          is_following: toBooleanDb(row.is_following),
          signals,
          reason,
          preview,
        };
      })
      .filter((x) => Number.isInteger(x.id) && x.id > 0);

    return res.json({ items, total: items.length });
  } catch (err) {
    return next(err);
  }
});

// ============================
// Follow
// ============================

router.post("/follow", authenticate, async (req, res, next) => {
  try {
    const followerId = getAuthorId(req);
    if (!followerId) return res.status(401).json({ error: "Não autenticado." });

    const followedId = Number(req.body?.author_id);
    if (!Number.isInteger(followedId) || followedId <= 0) {
      return res.status(400).json({ error: "author_id inválido." });
    }

    if (followedId === followerId) {
      return res.status(400).json({ error: "Você não pode seguir a si mesmo." });
    }

    const pool = await getPool();

    const existsAuthor = await pool
      .request()
      .input("author_id", sql.Int, followedId)
      .query(`
        SELECT TOP 1 a.author_id
        FROM dbo.identity_author a
        WHERE a.author_id = @author_id;
      `);

    if (!existsAuthor.recordset?.[0]) {
      return res.status(404).json({ error: "Autor alvo não encontrado." });
    }

    await pool
      .request()
      .input("follower_id", sql.Int, followerId)
      .input("followed_id", sql.Int, followedId)
      .query(`
        IF NOT EXISTS (
          SELECT 1
          FROM dbo.identity_follow
          WHERE follower_id = @follower_id
            AND followed_id = @followed_id
        )
        BEGIN
          INSERT INTO dbo.identity_follow (
            follower_id,
            followed_id,
            created_at
          )
          VALUES (
            @follower_id,
            @followed_id,
            SYSUTCDATETIME()
          );
        END
      `);

    return res.json({
      ok: true,
      action: "followed",
      author_id: followedId,
      meta: { updated_at: new Date().toISOString() },
    });
  } catch (err) {
    return next(err);
  }
});

// ============================
// Unfollow
// ============================

router.delete("/follow/:id", authenticate, async (req, res, next) => {
  try {
    const followerId = getAuthorId(req);
    if (!followerId) return res.status(401).json({ error: "Não autenticado." });

    const followedId = Number(req.params.id);
    if (!Number.isInteger(followedId) || followedId <= 0) {
      return res.status(400).json({ error: "author_id inválido." });
    }

    const pool = await getPool();

    await pool
      .request()
      .input("follower_id", sql.Int, followerId)
      .input("followed_id", sql.Int, followedId)
      .query(`
        DELETE FROM dbo.identity_follow
        WHERE follower_id = @follower_id
          AND followed_id = @followed_id;
      `);

    return res.json({
      ok: true,
      action: "unfollowed",
      author_id: followedId,
      meta: { updated_at: new Date().toISOString() },
    });
  } catch (err) {
    return next(err);
  }
});

// ============================
// Feed social vivo (rede)
// ============================

router.get("/feed", authenticate, async (req, res, next) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });

    const limit = clampInt(req.query?.limit, 1, 50, 20);
    const pool = await getPool();

    const result = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("limit", sql.Int, limit)
      .query(`
        ;WITH followed_authors AS (
          SELECT f.followed_id
          FROM dbo.identity_follow f
          WHERE f.follower_id = @author_id
        ),
        memory_feed AS (
          SELECT TOP (@limit)
            item_type = 'memory',
            item_id = m.memory_id,
            activity_at = m.created_at,
            author_id = a.author_id,
            author_name =
              COALESCE(NULLIF(LTRIM(RTRIM(a.name_public)), ''), NULLIF(LTRIM(RTRIM(a.full_name)), ''), NULLIF(LTRIM(RTRIM(a.author_code)), ''), 'Usuário'),
            avatar_url = a.avatar_url,
            title = m.title,
            body_text = m.content
          FROM dbo.identity_memory m
          INNER JOIN followed_authors fa
            ON fa.followed_id = m.author_id
          INNER JOIN dbo.identity_author a
            ON a.author_id = m.author_id
          WHERE ISNULL(m.is_deleted, 0) = 0
          ORDER BY m.created_at DESC, m.memory_id DESC
        ),
        chapter_feed AS (
          SELECT TOP (@limit)
            item_type = 'chapter',
            item_id = c.chapter_id,
            activity_at = COALESCE(c.published_at, c.updated_at, c.created_at),
            author_id = a.author_id,
            author_name =
              COALESCE(NULLIF(LTRIM(RTRIM(a.name_public)), ''), NULLIF(LTRIM(RTRIM(a.full_name)), ''), NULLIF(LTRIM(RTRIM(a.author_code)), ''), 'Usuário'),
            avatar_url = a.avatar_url,
            title = c.title,
            body_text = c.description
          FROM dbo.identity_chapter c
          INNER JOIN followed_authors fa
            ON fa.followed_id = c.author_id
          INNER JOIN dbo.identity_author a
            ON a.author_id = c.author_id
          WHERE ISNULL(c.is_deleted, 0) = 0
          ORDER BY COALESCE(c.published_at, c.updated_at, c.created_at) DESC, c.chapter_id DESC
        )
        SELECT TOP (@limit)
          item_type,
          item_id,
          activity_at,
          author_id,
          author_name,
          avatar_url,
          title,
          body_text
        FROM (
          SELECT * FROM memory_feed
          UNION ALL
          SELECT * FROM chapter_feed
        ) src
        ORDER BY activity_at DESC, item_type ASC, item_id DESC;
      `);

    const items = (result.recordset || []).map((row) => ({
      id: `${String(row.item_type)}_${Number(row.item_id)}`,
      type: String(row.item_type),
      createdAt: safeIso(row.activity_at),
      author: {
        id: Number(row.author_id),
        name: normalizeText(row.author_name, "Usuário"),
        avatar: row.avatar_url != null ? String(row.avatar_url) : null,
      },
      content: {
        title: normalizeText(
          row.title,
          String(row.item_type) === "chapter" ? "(Capítulo sem título)" : "(Memória sem título)"
        ),
        preview: makePreview(row.body_text, 160),
      },
    }));

    return res.json({
      items,
      total: items.length,
      meta: { generated_at: new Date().toISOString(), limit },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;