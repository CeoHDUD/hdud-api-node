// C:\HDUD_DATA\hdud-api-node\src\routes\feed.js

import express from "express";
import { getPool, sql } from "../db.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

function normalizePublishedStatus(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (s === "PUBLISHED" || s === "PUBLIC" || s === "SHARED") return "PUBLISHED";
  return "DRAFT";
}

function safeText(value, max = 220) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function normalizeRelationshipType(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "mutual" || s === "following") return s;
  if (s === "self") return "self";
  return "following";
}

function normalizeOriginScope(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (
    s === "connection" ||
    s === "following" ||
    s === "network_activity" ||
    s === "author_profile" ||
    s === "self"
  ) {
    return s;
  }
  return "following";
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTargetType(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (s === "MEMORY" || s === "CHAPTER") return s;
  return null;
}

function normalizeEventType(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (s === "LIKE" || s === "COMMENT" || s === "SHARE") return s;
  return null;
}

function getAuthorId(req) {
  const authorId = Number(req?.user?.author_id || 0);
  return Number.isInteger(authorId) && authorId > 0 ? authorId : null;
}

function getApiBaseMeta(profileRow, authorId) {
  return profileRow
    ? {
        author_id: Number(profileRow.author_id),
        author_code: profileRow.author_code ?? null,
        display_name: profileRow.display_name ?? null,
        preferred_language: "pt-BR",
      }
    : {
        author_id: authorId,
        author_code: null,
        display_name: null,
        preferred_language: "pt-BR",
      };
}

function wantsAuthorFeed(req) {
  const scope = String(req.query?.scope ?? req.query?.mode ?? "").trim().toLowerCase();

  return (
    scope === "author" ||
    scope === "profile" ||
    scope === "self" ||
    scope === "author_profile"
  );
}

async function resolveTarget(pool, targetType, targetId) {
  if (targetType === "MEMORY") {
    const r = await pool
      .request()
      .input("target_id", sql.Int, targetId)
      .query(`
        SELECT TOP 1
          CAST('MEMORY' AS varchar(20)) AS target_type,
          m.memory_id AS target_id,
          m.author_id,
          m.title,
          m.content,
          m.published_at,
          m.publication_status
        FROM dbo.identity_memory m
        WHERE m.memory_id = @target_id
          AND ISNULL(m.is_deleted, 0) = 0;
      `);

    return r.recordset?.[0] || null;
  }

  const r = await pool
    .request()
    .input("target_id", sql.Int, targetId)
    .query(`
      SELECT TOP 1
        CAST('CHAPTER' AS varchar(20)) AS target_type,
        c.chapter_id AS target_id,
        c.author_id,
        c.title,
        c.description AS content,
        c.published_at,
        CASE
          WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
            THEN COALESCE(NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), c.publication_status))), ''), CONVERT(varchar(50), c.status))
          ELSE CONVERT(varchar(50), c.status)
        END AS publication_status
      FROM dbo.identity_chapter c
      WHERE c.chapter_id = @target_id
        AND ISNULL(c.is_deleted, 0) = 0;
    `);

  return r.recordset?.[0] || null;
}

async function ensureTargetPublished(pool, targetType, targetId) {
  const target = await resolveTarget(pool, targetType, targetId);
  if (!target) return { ok: false, status: 404, error: "Conteúdo não encontrado." };

  const publicationStatus = normalizePublishedStatus(target.publication_status);
  if (publicationStatus !== "PUBLISHED") {
    return { ok: false, status: 400, error: "Somente conteúdo publicado pode receber interação social." };
  }

  return { ok: true, target: { ...target, publication_status: publicationStatus } };
}

async function listCommentsForTarget(pool, targetType, targetId, limit = 6) {
  const result = await pool
    .request()
    .input("target_type", sql.VarChar(20), targetType)
    .input("target_id", sql.Int, targetId)
    .input("limit", sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        c.comment_id,
        c.author_id,
        c.content,
        c.created_at,
        COALESCE(
          NULLIF(LTRIM(RTRIM(a.name_public)), ''),
          NULLIF(LTRIM(RTRIM(a.author_code)), ''),
          'Autor'
        ) AS author_name,
        a.author_code
      FROM dbo.identity_feed_comment c
      INNER JOIN dbo.identity_author a
        ON a.author_id = c.author_id
      WHERE c.target_type = @target_type
        AND c.target_id = @target_id
        AND ISNULL(c.is_deleted, 0) = 0
      ORDER BY c.created_at DESC, c.comment_id DESC;
    `);

  return (result.recordset || []).map((row) => ({
    comment_id: Number(row.comment_id),
    author_id: Number(row.author_id),
    author_name: row.author_name ?? null,
    author_code: row.author_code ?? null,
    content: row.content ?? "",
    created_at: row.created_at ?? null,
  }));
}

function buildItemsFromRows(rows, commentMap) {
  return rows.map((row) => {
    const publicationStatus = normalizePublishedStatus(row.publication_status_raw);
    const relationshipType = normalizeRelationshipType(row.relationship_type);
    const originScope = normalizeOriginScope(row.origin_scope);
    const relevanceScore = toNumberOrNull(row.relevance_score) ?? 0;
    const author_id = toNumberOrNull(row.author_id);
    const chapter_id = toNumberOrNull(row.chapter_id);
    const memory_id = toNumberOrNull(row.memory_id);
    const targetType = String(row.item_type || "").toLowerCase() === "memory" ? "MEMORY" : "CHAPTER";
    const targetId = targetType === "MEMORY" ? memory_id : chapter_id;

    const counts = {
      likes: Number(row.total_reactions || 0),
      comments: Number(row.total_comments || 0),
      shares: Number(row.total_shares || 0),
    };

    const commentsPreview = targetId ? commentMap.get(`${targetType}:${targetId}`) || [] : [];

    const social = row.social_event_type
      ? {
          event_type: normalizeEventType(row.social_event_type),
          actor_author_id: toNumberOrNull(row.social_actor_author_id),
          actor_name: row.social_actor_name ?? null,
          comment: row.share_comment ?? null,
          share_type: row.share_type ?? null,
        }
      : null;

    if (String(row.item_type || "").toLowerCase() === "chapter") {
      return {
        type: "chapter",
        title: row.title ?? "",
        date: row.activity_at,
        source_id: String(row.source_id),
        authorId: author_id,
        authorName: row.author_name ?? null,
        authorCode: row.author_code ?? null,
        relationshipType,
        originScope,
        relevanceScore,
        meta: {
          nav: row.nav || "/chapters",
          date_source: "published_at",
          activity_at: row.activity_at ?? null,
          preview: safeText(row.preview_text, 320),
          publication_status: publicationStatus,
          published_at: row.published_at ?? null,
          chapter_id,
          memory_id: null,
          status: publicationStatus,
          description: safeText(row.preview_text, 320),
          author_id,
          author_name: row.author_name ?? null,
          author_code: row.author_code ?? null,
          relationship_type: relationshipType,
          origin_scope: originScope,
          relevance_score: relevanceScore,
          social,
          counts,
          liked_by_me: !!row.liked_by_me,
          comments_preview: commentsPreview,
        },
      };
    }

    return {
      type: "memory",
      title: row.title ?? "",
      date: row.activity_at,
      source_id: String(row.source_id),
      photoUrl: row.photo_url ?? null,
      authorId: author_id,
      authorName: row.author_name ?? null,
      authorCode: row.author_code ?? null,
      relationshipType,
      originScope,
      relevanceScore,
      meta: {
        nav: row.nav || `/memories/${String(row.source_id)}`,
        date_source: "published_at",
        activity_at: row.activity_at ?? null,
        preview: safeText(row.preview_text, 320),
        phase_code: row.phase_code ?? null,
        photo_url: row.photo_url ?? null,
        publication_status: publicationStatus,
        published_at: row.published_at ?? null,
        memory_id,
        chapter_id: null,
        status: publicationStatus,
        author_id,
        author_name: row.author_name ?? null,
        author_code: row.author_code ?? null,
        relationship_type: relationshipType,
        origin_scope: originScope,
        relevance_score: relevanceScore,
        social,
        counts,
        liked_by_me: !!row.liked_by_me,
        comments_preview: commentsPreview,
      },
    };
  });
}

async function buildCommentMapFromRows(pool, rows) {
  const commentKeys = rows.map((row) => ({
    item_type: String(row.item_type || "").toLowerCase(),
    target_type: String(row.item_type || "").toLowerCase() === "memory" ? "MEMORY" : "CHAPTER",
    target_id:
      String(row.item_type || "").toLowerCase() === "memory"
        ? toNumberOrNull(row.memory_id)
        : toNumberOrNull(row.chapter_id),
  }));

  const commentMap = new Map();

  for (const key of commentKeys) {
    if (!key.target_id) continue;
    const mapKey = `${key.target_type}:${key.target_id}`;
    if (commentMap.has(mapKey)) continue;
    const comments = await listCommentsForTarget(pool, key.target_type, key.target_id, 3);
    commentMap.set(mapKey, comments);
  }

  return commentMap;
}

async function queryDashboardFeed(pool, authorId, limit) {
  const result = await pool
    .request()
    .input("viewer_author_id", sql.Int, authorId)
    .input("limit", sql.Int, limit)
    .query(`
      WITH viewer_connections AS (
        SELECT
          f.followed_id AS author_id,
          CAST(
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM dbo.identity_follow rf
                WHERE rf.follower_id = f.followed_id
                  AND rf.followed_id = @viewer_author_id
              )
              THEN 'mutual'
              ELSE 'following'
            END
            AS varchar(20)
          ) AS relationship_type,
          CAST(
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM dbo.identity_follow rf
                WHERE rf.follower_id = f.followed_id
                  AND rf.followed_id = @viewer_author_id
              )
              THEN 'connection'
              ELSE 'following'
            END
            AS varchar(20)
          ) AS origin_scope,
          CAST(
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM dbo.identity_follow rf
                WHERE rf.follower_id = f.followed_id
                  AND rf.followed_id = @viewer_author_id
              )
              THEN 700
              ELSE 400
            END
            AS int
          ) AS relationship_score
        FROM dbo.identity_follow f
        WHERE f.follower_id = @viewer_author_id
          AND f.followed_id <> @viewer_author_id
      ),
      dedup_connections AS (
        SELECT
          x.author_id,
          x.relationship_type,
          x.origin_scope,
          x.relationship_score
        FROM (
          SELECT
            vc.*,
            ROW_NUMBER() OVER (
              PARTITION BY vc.author_id
              ORDER BY vc.relationship_score DESC, vc.author_id ASC
            ) AS rn
          FROM viewer_connections vc
        ) x
        WHERE x.rn = 1
      ),
      network_authors AS (
        SELECT
          dc.author_id,
          dc.relationship_type,
          dc.origin_scope,
          dc.relationship_score,
          ia.author_code,
          COALESCE(
            NULLIF(LTRIM(RTRIM(ia.name_public)), ''),
            NULLIF(LTRIM(RTRIM(ia.author_code)), ''),
            'Autor'
          ) AS author_name
        FROM dedup_connections dc
        INNER JOIN dbo.identity_author ia
          ON ia.author_id = dc.author_id
        WHERE dc.author_id <> @viewer_author_id
      ),
      direct_memory_feed AS (
        SELECT
          CAST('memory' AS varchar(20)) AS item_type,
          CAST(m.memory_id AS varchar(50)) AS source_id,
          m.author_id,
          na.author_name,
          na.author_code,
          na.relationship_type,
          na.origin_scope,
          na.relationship_score,
          m.title AS title,
          m.published_at AS activity_at,
          CONCAT('/memories/', CAST(m.memory_id AS varchar(50))) AS nav,
          m.content AS preview_text,
          p.phase_code AS phase_code,
          CONCAT('/cdn/memories/', CAST(m.author_id AS varchar(50)), '/', CAST(m.memory_id AS varchar(50))) AS photo_url,
          CONVERT(varchar(50), m.publication_status) AS publication_status_raw,
          m.published_at AS published_at,
          CAST(NULL AS int) AS chapter_id,
          CAST(m.memory_id AS int) AS memory_id,
          CAST(NULL AS varchar(30)) AS social_event_type,
          CAST(NULL AS int) AS social_actor_author_id,
          CAST(NULL AS nvarchar(120)) AS social_actor_name,
          CAST(NULL AS nvarchar(max)) AS share_comment,
          CAST(NULL AS varchar(20)) AS share_type,
          CAST(
            na.relationship_score + 120 + CASE WHEN m.published_at IS NOT NULL THEN 50 ELSE 0 END
            AS int
          ) AS relevance_score
        FROM dbo.identity_memory m
        INNER JOIN network_authors na
          ON na.author_id = m.author_id
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        WHERE ISNULL(m.is_deleted, 0) = 0
          AND UPPER(LTRIM(RTRIM(ISNULL(CONVERT(varchar(50), m.publication_status), '')))) = 'PUBLISHED'
          AND m.published_at IS NOT NULL
          AND m.author_id <> @viewer_author_id
      ),
      direct_chapter_feed AS (
        SELECT
          CAST('chapter' AS varchar(20)) AS item_type,
          CAST(c.chapter_id AS varchar(50)) AS source_id,
          c.author_id,
          na.author_name,
          na.author_code,
          na.relationship_type,
          na.origin_scope,
          na.relationship_score,
          c.title AS title,
          c.published_at AS activity_at,
          CONCAT('/chapters/', CAST(c.chapter_id AS varchar(50))) AS nav,
          COALESCE(c.description, c.title, '') AS preview_text,
          CAST(NULL AS varchar(50)) AS phase_code,
          CAST(NULL AS varchar(500)) AS photo_url,
          CASE
            WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
              THEN COALESCE(
                NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), c.publication_status))), ''),
                CONVERT(varchar(50), c.status)
              )
            ELSE CONVERT(varchar(50), c.status)
          END AS publication_status_raw,
          c.published_at AS published_at,
          CAST(c.chapter_id AS int) AS chapter_id,
          CAST(NULL AS int) AS memory_id,
          CAST(NULL AS varchar(30)) AS social_event_type,
          CAST(NULL AS int) AS social_actor_author_id,
          CAST(NULL AS nvarchar(120)) AS social_actor_name,
          CAST(NULL AS nvarchar(max)) AS share_comment,
          CAST(NULL AS varchar(20)) AS share_type,
          CAST(
            na.relationship_score + 220 + CASE WHEN c.published_at IS NOT NULL THEN 50 ELSE 0 END
            AS int
          ) AS relevance_score
        FROM dbo.identity_chapter c
        INNER JOIN network_authors na
          ON na.author_id = c.author_id
        WHERE ISNULL(c.is_deleted, 0) = 0
          AND UPPER(
            LTRIM(RTRIM(
              CASE
                WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
                  THEN COALESCE(
                    NULLIF(CONVERT(varchar(50), c.publication_status), ''),
                    CONVERT(varchar(50), c.status)
                  )
                ELSE CONVERT(varchar(50), c.status)
              END
            ))
          ) IN ('PUBLIC', 'PUBLISHED', 'SHARED')
          AND c.published_at IS NOT NULL
          AND c.author_id <> @viewer_author_id
      ),
      direct_feed AS (
        SELECT * FROM direct_memory_feed
        UNION ALL
        SELECT * FROM direct_chapter_feed
      ),

      social_event_candidates AS (
        SELECT
          r.reaction_id AS event_id,
          r.author_id AS actor_author_id,
          na.author_name AS actor_name,
          na.author_code AS actor_code,
          na.relationship_type,
          CAST('network_activity' AS varchar(20)) AS origin_scope,
          na.relationship_score,
          r.target_type,
          r.target_id,
          CAST('LIKE' AS varchar(30)) AS event_type,
          r.created_at,
          CAST(NULL AS nvarchar(max)) AS share_comment,
          CAST(NULL AS varchar(20)) AS share_type
        FROM dbo.identity_feed_reaction r
        INNER JOIN network_authors na
          ON na.author_id = r.author_id
        WHERE r.author_id <> @viewer_author_id

        UNION ALL

        SELECT
          c.comment_id AS event_id,
          c.author_id AS actor_author_id,
          na.author_name AS actor_name,
          na.author_code AS actor_code,
          na.relationship_type,
          CAST('network_activity' AS varchar(20)) AS origin_scope,
          na.relationship_score,
          c.target_type,
          c.target_id,
          CAST('COMMENT' AS varchar(30)) AS event_type,
          c.created_at,
          CAST(NULL AS nvarchar(max)) AS share_comment,
          CAST(NULL AS varchar(20)) AS share_type
        FROM dbo.identity_feed_comment c
        INNER JOIN network_authors na
          ON na.author_id = c.author_id
        WHERE c.author_id <> @viewer_author_id
          AND ISNULL(c.is_deleted, 0) = 0

        UNION ALL

        SELECT
          s.share_id AS event_id,
          s.author_id AS actor_author_id,
          na.author_name AS actor_name,
          na.author_code AS actor_code,
          na.relationship_type,
          CAST('network_activity' AS varchar(20)) AS origin_scope,
          na.relationship_score,
          s.target_type,
          s.target_id,
          CAST('SHARE' AS varchar(30)) AS event_type,
          s.created_at,
          s.comment AS share_comment,
          s.share_type
        FROM dbo.identity_feed_share s
        INNER JOIN network_authors na
          ON na.author_id = s.author_id
        WHERE s.author_id <> @viewer_author_id
      ),

      social_memory_feed AS (
        SELECT
          CAST('memory' AS varchar(20)) AS item_type,
          CAST(m.memory_id AS varchar(50)) AS source_id,
          m.author_id,
          COALESCE(
            NULLIF(LTRIM(RTRIM(a.name_public)), ''),
            NULLIF(LTRIM(RTRIM(a.author_code)), ''),
            'Autor'
          ) AS author_name,
          a.author_code,
          sec.relationship_type,
          sec.origin_scope,
          sec.relationship_score,
          m.title AS title,
          sec.created_at AS activity_at,
          CONCAT('/memories/', CAST(m.memory_id AS varchar(50))) AS nav,
          m.content AS preview_text,
          p.phase_code AS phase_code,
          CONCAT('/cdn/memories/', CAST(m.author_id AS varchar(50)), '/', CAST(m.memory_id AS varchar(50))) AS photo_url,
          CONVERT(varchar(50), m.publication_status) AS publication_status_raw,
          m.published_at AS published_at,
          CAST(NULL AS int) AS chapter_id,
          CAST(m.memory_id AS int) AS memory_id,
          sec.event_type AS social_event_type,
          sec.actor_author_id AS social_actor_author_id,
          sec.actor_name AS social_actor_name,
          sec.share_comment,
          sec.share_type,
          CAST(
            sec.relationship_score + 300 +
            CASE
              WHEN sec.event_type = 'COMMENT' THEN 60
              WHEN sec.event_type = 'SHARE' THEN 80
              ELSE 40
            END
            AS int
          ) AS relevance_score
        FROM social_event_candidates sec
        INNER JOIN dbo.identity_memory m
          ON sec.target_type = 'MEMORY'
         AND sec.target_id = m.memory_id
        INNER JOIN dbo.identity_author a
          ON a.author_id = m.author_id
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        LEFT JOIN dedup_connections dc
          ON dc.author_id = m.author_id
        WHERE ISNULL(m.is_deleted, 0) = 0
          AND UPPER(LTRIM(RTRIM(ISNULL(CONVERT(varchar(50), m.publication_status), '')))) = 'PUBLISHED'
          AND m.published_at IS NOT NULL
          AND m.author_id <> @viewer_author_id
          AND m.author_id <> sec.actor_author_id
          AND dc.author_id IS NULL
      ),

      social_chapter_feed AS (
        SELECT
          CAST('chapter' AS varchar(20)) AS item_type,
          CAST(c.chapter_id AS varchar(50)) AS source_id,
          c.author_id,
          COALESCE(
            NULLIF(LTRIM(RTRIM(a.name_public)), ''),
            NULLIF(LTRIM(RTRIM(a.author_code)), ''),
            'Autor'
          ) AS author_name,
          a.author_code,
          sec.relationship_type,
          sec.origin_scope,
          sec.relationship_score,
          c.title AS title,
          sec.created_at AS activity_at,
          CONCAT('/chapters/', CAST(c.chapter_id AS varchar(50))) AS nav,
          COALESCE(c.description, c.title, '') AS preview_text,
          CAST(NULL AS varchar(50)) AS phase_code,
          CAST(NULL AS varchar(500)) AS photo_url,
          CASE
            WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
              THEN COALESCE(
                NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), c.publication_status))), ''),
                CONVERT(varchar(50), c.status)
              )
            ELSE CONVERT(varchar(50), c.status)
          END AS publication_status_raw,
          c.published_at AS published_at,
          CAST(c.chapter_id AS int) AS chapter_id,
          CAST(NULL AS int) AS memory_id,
          sec.event_type AS social_event_type,
          sec.actor_author_id AS social_actor_author_id,
          sec.actor_name AS social_actor_name,
          sec.share_comment,
          sec.share_type,
          CAST(
            sec.relationship_score + 340 +
            CASE
              WHEN sec.event_type = 'COMMENT' THEN 60
              WHEN sec.event_type = 'SHARE' THEN 80
              ELSE 40
            END
            AS int
          ) AS relevance_score
        FROM social_event_candidates sec
        INNER JOIN dbo.identity_chapter c
          ON sec.target_type = 'CHAPTER'
         AND sec.target_id = c.chapter_id
        INNER JOIN dbo.identity_author a
          ON a.author_id = c.author_id
        LEFT JOIN dedup_connections dc
          ON dc.author_id = c.author_id
        WHERE ISNULL(c.is_deleted, 0) = 0
          AND UPPER(
            LTRIM(RTRIM(
              CASE
                WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
                  THEN COALESCE(
                    NULLIF(CONVERT(varchar(50), c.publication_status), ''),
                    CONVERT(varchar(50), c.status)
                  )
                ELSE CONVERT(varchar(50), c.status)
              END
            ))
          ) IN ('PUBLIC', 'PUBLISHED', 'SHARED')
          AND c.published_at IS NOT NULL
          AND c.author_id <> @viewer_author_id
          AND c.author_id <> sec.actor_author_id
          AND dc.author_id IS NULL
      ),
      social_feed_ranked AS (
        SELECT *
        FROM (
          SELECT
            sf.*,
            ROW_NUMBER() OVER (
              PARTITION BY sf.item_type, sf.source_id, sf.social_actor_author_id, sf.social_event_type
              ORDER BY sf.activity_at DESC, sf.source_id DESC
            ) AS rn
          FROM (
            SELECT * FROM social_memory_feed
            UNION ALL
            SELECT * FROM social_chapter_feed
          ) sf
        ) x
        WHERE x.rn = 1
      ),

      unified AS (
        SELECT * FROM direct_feed
        UNION ALL
        SELECT
          item_type,
          source_id,
          author_id,
          author_name,
          author_code,
          relationship_type,
          origin_scope,
          relationship_score,
          title,
          activity_at,
          nav,
          preview_text,
          phase_code,
          photo_url,
          publication_status_raw,
          published_at,
          chapter_id,
          memory_id,
          social_event_type,
          social_actor_author_id,
          social_actor_name,
          share_comment,
          share_type,
          relevance_score
        FROM social_feed_ranked
      ),

      ranked AS (
        SELECT
          u.*,
          ROW_NUMBER() OVER (
            PARTITION BY u.item_type, u.source_id
            ORDER BY
              u.activity_at DESC,
              u.published_at DESC,
              u.source_id DESC
          ) AS rn
        FROM unified u
      )

      SELECT TOP (@limit)
        u.item_type,
        u.source_id,
        u.author_id,
        u.author_name,
        u.author_code,
        u.relationship_type,
        u.origin_scope,
        u.relationship_score,
        u.relevance_score,
        u.title,
        u.activity_at,
        u.nav,
        u.preview_text,
        u.phase_code,
        u.photo_url,
        u.publication_status_raw,
        u.published_at,
        u.chapter_id,
        u.memory_id,
        u.social_event_type,
        u.social_actor_author_id,
        u.social_actor_name,
        u.share_comment,
        u.share_type,
        reactions.total_reactions,
        comments.total_comments,
        shares.total_shares,
        CASE WHEN my_like.reaction_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS liked_by_me
      FROM ranked u
      OUTER APPLY (
        SELECT COUNT_BIG(1) AS total_reactions
        FROM dbo.identity_feed_reaction r
        WHERE r.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND r.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
      ) reactions
      OUTER APPLY (
        SELECT COUNT_BIG(1) AS total_comments
        FROM dbo.identity_feed_comment c
        WHERE c.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND c.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
          AND ISNULL(c.is_deleted, 0) = 0
      ) comments
      OUTER APPLY (
        SELECT COUNT_BIG(1) AS total_shares
        FROM dbo.identity_feed_share s
        WHERE s.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND s.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
      ) shares
      OUTER APPLY (
        SELECT TOP 1 r.reaction_id
        FROM dbo.identity_feed_reaction r
        WHERE r.author_id = @viewer_author_id
          AND r.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND r.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
      ) my_like
      WHERE u.rn = 1
      ORDER BY
		  COALESCE(u.activity_at, u.published_at) DESC,
		  u.relevance_score DESC,
		  u.source_id DESC;
			`);

  return result.recordset || [];
}

async function queryAuthorProfileFeed(pool, authorId, limit) {
  const result = await pool
    .request()
    .input("viewer_author_id", sql.Int, authorId)
    .input("limit", sql.Int, limit)
    .query(`
      WITH self_memory_feed AS (
        SELECT
          CAST('memory' AS varchar(20)) AS item_type,
          CAST(m.memory_id AS varchar(50)) AS source_id,
          m.author_id,
          COALESCE(
            NULLIF(LTRIM(RTRIM(a.name_public)), ''),
            NULLIF(LTRIM(RTRIM(a.author_code)), ''),
            'Autor'
          ) AS author_name,
          a.author_code,
          CAST('self' AS varchar(20)) AS relationship_type,
          CAST('author_profile' AS varchar(30)) AS origin_scope,
          CAST(1000 AS int) AS relationship_score,
          m.title AS title,
          COALESCE(last_social.created_at, m.published_at) AS activity_at,
          CONCAT('/memories/', CAST(m.memory_id AS varchar(50))) AS nav,
          m.content AS preview_text,
          p.phase_code AS phase_code,
          CONCAT('/cdn/memories/', CAST(m.author_id AS varchar(50)), '/', CAST(m.memory_id AS varchar(50))) AS photo_url,
          CONVERT(varchar(50), m.publication_status) AS publication_status_raw,
          m.published_at AS published_at,
          CAST(NULL AS int) AS chapter_id,
          CAST(m.memory_id AS int) AS memory_id,
          last_social.event_type AS social_event_type,
          last_social.actor_author_id AS social_actor_author_id,
          last_social.actor_name AS social_actor_name,
          CAST(NULL AS nvarchar(max)) AS share_comment,
          CAST(NULL AS varchar(20)) AS share_type,
          CAST(
            1000
            + CASE WHEN m.published_at IS NOT NULL THEN 120 ELSE 0 END
            + CASE
                WHEN last_social.event_type = 'COMMENT' THEN 90
                WHEN last_social.event_type = 'SHARE' THEN 70
                WHEN last_social.event_type = 'LIKE' THEN 50
                ELSE 0
              END
            AS int
          ) AS relevance_score
        FROM dbo.identity_memory m
        INNER JOIN dbo.identity_author a
          ON a.author_id = m.author_id
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        OUTER APPLY (
          SELECT TOP 1
            x.event_type,
            x.actor_author_id,
            x.actor_name,
            x.created_at
          FROM (
            SELECT
              CAST('LIKE' AS varchar(30)) AS event_type,
              r.author_id AS actor_author_id,
              COALESCE(
                NULLIF(LTRIM(RTRIM(ia.name_public)), ''),
                NULLIF(LTRIM(RTRIM(ia.author_code)), ''),
                'Autor'
              ) AS actor_name,
              r.created_at
            FROM dbo.identity_feed_reaction r
            INNER JOIN dbo.identity_author ia
              ON ia.author_id = r.author_id
            WHERE r.target_type = 'MEMORY'
              AND r.target_id = m.memory_id
              AND r.author_id <> @viewer_author_id

            UNION ALL

            SELECT
              CAST('COMMENT' AS varchar(30)) AS event_type,
              c.author_id AS actor_author_id,
              COALESCE(
                NULLIF(LTRIM(RTRIM(ia.name_public)), ''),
                NULLIF(LTRIM(RTRIM(ia.author_code)), ''),
                'Autor'
              ) AS actor_name,
              c.created_at
            FROM dbo.identity_feed_comment c
            INNER JOIN dbo.identity_author ia
              ON ia.author_id = c.author_id
            WHERE c.target_type = 'MEMORY'
              AND c.target_id = m.memory_id
              AND ISNULL(c.is_deleted, 0) = 0
              AND c.author_id <> @viewer_author_id

            UNION ALL

            SELECT
              CAST('SHARE' AS varchar(30)) AS event_type,
              s.author_id AS actor_author_id,
              COALESCE(
                NULLIF(LTRIM(RTRIM(ia.name_public)), ''),
                NULLIF(LTRIM(RTRIM(ia.author_code)), ''),
                'Autor'
              ) AS actor_name,
              s.created_at
            FROM dbo.identity_feed_share s
            INNER JOIN dbo.identity_author ia
              ON ia.author_id = s.author_id
            WHERE s.target_type = 'MEMORY'
              AND s.target_id = m.memory_id
              AND s.author_id <> @viewer_author_id
          ) x
          ORDER BY x.created_at DESC
        ) last_social
        WHERE m.author_id = @viewer_author_id
          AND ISNULL(m.is_deleted, 0) = 0
          AND UPPER(LTRIM(RTRIM(ISNULL(CONVERT(varchar(50), m.publication_status), '')))) = 'PUBLISHED'
          AND m.published_at IS NOT NULL
      ),

      self_chapter_feed AS (
        SELECT
          CAST('chapter' AS varchar(20)) AS item_type,
          CAST(c.chapter_id AS varchar(50)) AS source_id,
          c.author_id,
          COALESCE(
            NULLIF(LTRIM(RTRIM(a.name_public)), ''),
            NULLIF(LTRIM(RTRIM(a.author_code)), ''),
            'Autor'
          ) AS author_name,
          a.author_code,
          CAST('self' AS varchar(20)) AS relationship_type,
          CAST('author_profile' AS varchar(30)) AS origin_scope,
          CAST(1000 AS int) AS relationship_score,
          c.title AS title,
          COALESCE(last_social.created_at, c.published_at) AS activity_at,
          CONCAT('/chapters/', CAST(c.chapter_id AS varchar(50))) AS nav,
          COALESCE(c.description, c.title, '') AS preview_text,
          CAST(NULL AS varchar(50)) AS phase_code,
          CAST(NULL AS varchar(500)) AS photo_url,
          CASE
            WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
              THEN COALESCE(
                NULLIF(LTRIM(RTRIM(CONVERT(varchar(50), c.publication_status))), ''),
                CONVERT(varchar(50), c.status)
              )
            ELSE CONVERT(varchar(50), c.status)
          END AS publication_status_raw,
          c.published_at AS published_at,
          CAST(c.chapter_id AS int) AS chapter_id,
          CAST(NULL AS int) AS memory_id,
          last_social.event_type AS social_event_type,
          last_social.actor_author_id AS social_actor_author_id,
          last_social.actor_name AS social_actor_name,
          CAST(NULL AS nvarchar(max)) AS share_comment,
          CAST(NULL AS varchar(20)) AS share_type,
          CAST(
            1000
            + CASE WHEN c.published_at IS NOT NULL THEN 160 ELSE 0 END
            + CASE
                WHEN last_social.event_type = 'COMMENT' THEN 90
                WHEN last_social.event_type = 'SHARE' THEN 70
                WHEN last_social.event_type = 'LIKE' THEN 50
                ELSE 0
              END
            AS int
          ) AS relevance_score
        FROM dbo.identity_chapter c
        INNER JOIN dbo.identity_author a
          ON a.author_id = c.author_id
        OUTER APPLY (
          SELECT TOP 1
            x.event_type,
            x.actor_author_id,
            x.actor_name,
            x.created_at
          FROM (
            SELECT
              CAST('LIKE' AS varchar(30)) AS event_type,
              r.author_id AS actor_author_id,
              COALESCE(
                NULLIF(LTRIM(RTRIM(ia.name_public)), ''),
                NULLIF(LTRIM(RTRIM(ia.author_code)), ''),
                'Autor'
              ) AS actor_name,
              r.created_at
            FROM dbo.identity_feed_reaction r
            INNER JOIN dbo.identity_author ia
              ON ia.author_id = r.author_id
            WHERE r.target_type = 'CHAPTER'
              AND r.target_id = c.chapter_id
              AND r.author_id <> @viewer_author_id

            UNION ALL

            SELECT
              CAST('COMMENT' AS varchar(30)) AS event_type,
              cm.author_id AS actor_author_id,
              COALESCE(
                NULLIF(LTRIM(RTRIM(ia.name_public)), ''),
                NULLIF(LTRIM(RTRIM(ia.author_code)), ''),
                'Autor'
              ) AS actor_name,
              cm.created_at
            FROM dbo.identity_feed_comment cm
            INNER JOIN dbo.identity_author ia
              ON ia.author_id = cm.author_id
            WHERE cm.target_type = 'CHAPTER'
              AND cm.target_id = c.chapter_id
              AND ISNULL(cm.is_deleted, 0) = 0
              AND cm.author_id <> @viewer_author_id

            UNION ALL

            SELECT
              CAST('SHARE' AS varchar(30)) AS event_type,
              s.author_id AS actor_author_id,
              COALESCE(
                NULLIF(LTRIM(RTRIM(ia.name_public)), ''),
                NULLIF(LTRIM(RTRIM(ia.author_code)), ''),
                'Autor'
              ) AS actor_name,
              s.created_at
            FROM dbo.identity_feed_share s
            INNER JOIN dbo.identity_author ia
              ON ia.author_id = s.author_id
            WHERE s.target_type = 'CHAPTER'
              AND s.target_id = c.chapter_id
              AND s.author_id <> @viewer_author_id
          ) x
          ORDER BY x.created_at DESC
        ) last_social
        WHERE c.author_id = @viewer_author_id
          AND ISNULL(c.is_deleted, 0) = 0
          AND UPPER(
            LTRIM(RTRIM(
              CASE
                WHEN COL_LENGTH('dbo.identity_chapter', 'publication_status') IS NOT NULL
                  THEN COALESCE(
                    NULLIF(CONVERT(varchar(50), c.publication_status), ''),
                    CONVERT(varchar(50), c.status)
                  )
                ELSE CONVERT(varchar(50), c.status)
              END
            ))
          ) IN ('PUBLIC', 'PUBLISHED', 'SHARED')
          AND c.published_at IS NOT NULL
      ),
      unified AS (
        SELECT * FROM self_memory_feed
        UNION ALL
        SELECT * FROM self_chapter_feed
      )

      SELECT TOP (@limit)
        u.item_type,
        u.source_id,
        u.author_id,
        u.author_name,
        u.author_code,
        u.relationship_type,
        u.origin_scope,
        u.relationship_score,
        u.relevance_score,
        u.title,
        u.activity_at,
        u.nav,
        u.preview_text,
        u.phase_code,
        u.photo_url,
        u.publication_status_raw,
        u.published_at,
        u.chapter_id,
        u.memory_id,
        u.social_event_type,
        u.social_actor_author_id,
        u.social_actor_name,
        u.share_comment,
        u.share_type,
        reactions.total_reactions,
        comments.total_comments,
        shares.total_shares,
        CASE WHEN my_like.reaction_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS liked_by_me
      FROM unified u
      OUTER APPLY (
        SELECT COUNT_BIG(1) AS total_reactions
        FROM dbo.identity_feed_reaction r
        WHERE r.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND r.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
      ) reactions
      OUTER APPLY (
        SELECT COUNT_BIG(1) AS total_comments
        FROM dbo.identity_feed_comment c
        WHERE c.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND c.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
          AND ISNULL(c.is_deleted, 0) = 0
      ) comments
      OUTER APPLY (
        SELECT COUNT_BIG(1) AS total_shares
        FROM dbo.identity_feed_share s
        WHERE s.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND s.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
      ) shares
      OUTER APPLY (
        SELECT TOP 1 r.reaction_id
        FROM dbo.identity_feed_reaction r
        WHERE r.author_id = @viewer_author_id
          AND r.target_type = CASE WHEN u.item_type = 'memory' THEN 'MEMORY' ELSE 'CHAPTER' END
          AND r.target_id = CASE WHEN u.item_type = 'memory' THEN u.memory_id ELSE u.chapter_id END
      ) my_like
      ORDER BY
        u.activity_at DESC,
        u.relevance_score DESC,
        u.source_id DESC;
    `);

  return result.recordset || [];
}

router.get("/", authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Não autenticado.",
      });
    }

    const pool = await getPool();

    const profileResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT TOP 1
          a.author_id,
          a.author_code,
          COALESCE(
            NULLIF(LTRIM(RTRIM(a.name_public)), ''),
            NULLIF(LTRIM(RTRIM(a.author_code)), ''),
            'Autor'
          ) AS display_name
        FROM dbo.identity_author a
        WHERE a.author_id = @author_id;
      `);

    const profileRow = profileResult?.recordset?.[0] || null;

    const authorFeedMode = wantsAuthorFeed(req);
    const rows = authorFeedMode
      ? await queryAuthorProfileFeed(pool, authorId, limit)
      : await queryDashboardFeed(pool, authorId, limit);

    const commentMap = await buildCommentMapFromRows(pool, rows);
    const items = buildItemsFromRows(rows, commentMap);

    const chapterCount = items.filter((x) => x.type === "chapter").length;
    const memoryCount = items.filter((x) => x.type === "memory").length;
    const socialCount = items.filter((x) => x?.meta?.social).length;

    return res.json({
      version: "FEED_v0.1",
      actor: {
        author_id: authorId,
        name_public: profileRow?.display_name ?? null,
        avatar_url: null,
      },
      profile: getApiBaseMeta(profileRow, authorId),
      items,
      meta: {
        generated_at: new Date().toISOString(),
        limit,
        truth_mode: "published_only",
        scope_mode: authorFeedMode
          ? "author_profile_with_social_context"
          : "dashboard_network_with_social_activity",
        ordering_mode: "activity_first",
        item_count: items.length,
        chapter_count: chapterCount,
        memory_count: memoryCount,
        social_activity_count: socialCount,
        has_more: false,
      },
    });
  } catch (err) {
    console.error("[feed.get]", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar o feed.",
      detail: err?.message || "Falha inesperada.",
    });
  }
});

router.post("/like", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Não autenticado.",
      });
    }

    const targetType = normalizeTargetType(req.body?.target_type);
    const targetId = toNumberOrNull(req.body?.target_id);

    if (!targetType || !targetId) {
      return res.status(400).json({
        ok: false,
        error: "target_type e target_id são obrigatórios.",
      });
    }

    const pool = await getPool();
    const published = await ensureTargetPublished(pool, targetType, targetId);

    if (!published.ok) {
      return res.status(published.status).json({
        ok: false,
        error: published.error,
      });
    }

    const existing = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("target_type", sql.VarChar(20), targetType)
      .input("target_id", sql.Int, targetId)
      .query(`
        SELECT TOP 1 reaction_id
        FROM dbo.identity_feed_reaction
        WHERE author_id = @author_id
          AND target_type = @target_type
          AND target_id = @target_id;
      `);

    let liked = false;

    if (existing.recordset?.length) {
      await pool
        .request()
        .input("reaction_id", sql.Int, existing.recordset[0].reaction_id)
        .query(`
          DELETE FROM dbo.identity_feed_reaction
          WHERE reaction_id = @reaction_id;
        `);

      liked = false;
    } else {
      await pool
        .request()
        .input("author_id", sql.Int, authorId)
        .input("target_type", sql.VarChar(20), targetType)
        .input("target_id", sql.Int, targetId)
        .query(`
          INSERT INTO dbo.identity_feed_reaction
            (author_id, target_type, target_id, reaction_type, created_at)
          VALUES
            (@author_id, @target_type, @target_id, 'LIKE', SYSUTCDATETIME());
        `);

      liked = true;
    }

    const counts = await getInteractionCounts(pool, targetType, targetId);

    return res.json({
      ok: true,
      liked,
      counts,
    });
  } catch (err) {
    console.error("[feed.like]", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao curtir publicação.",
      detail: err?.message || "Falha inesperada.",
    });
  }
});

router.post("/comment", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Não autenticado.",
      });
    }

    const targetType = normalizeTargetType(req.body?.target_type);
    const targetId = toNumberOrNull(req.body?.target_id);
    const content = String(req.body?.content || "").trim();

    if (!targetType || !targetId) {
      return res.status(400).json({
        ok: false,
        error: "target_type e target_id são obrigatórios.",
      });
    }

    if (!content) {
      return res.status(400).json({
        ok: false,
        error: "Comentário vazio.",
      });
    }

    if (content.length > 1200) {
      return res.status(400).json({
        ok: false,
        error: "Comentário excede 1200 caracteres.",
      });
    }

    const pool = await getPool();
    const published = await ensureTargetPublished(pool, targetType, targetId);

    if (!published.ok) {
      return res.status(published.status).json({
        ok: false,
        error: published.error,
      });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("target_type", sql.VarChar(20), targetType)
      .input("target_id", sql.Int, targetId)
      .input("content", sql.NVarChar(sql.MAX), content)
      .query(`
        INSERT INTO dbo.identity_feed_comment
          (author_id, target_type, target_id, content, created_at, is_deleted)
        VALUES
          (@author_id, @target_type, @target_id, @content, SYSUTCDATETIME(), 0);
      `);

    const counts = await getInteractionCounts(pool, targetType, targetId);
    const commentsPreview = await listCommentsForTarget(pool, targetType, targetId, 3);

    return res.json({
      ok: true,
      counts,
      comments_preview: commentsPreview,
    });
  } catch (err) {
    console.error("[feed.comment]", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao comentar publicação.",
      detail: err?.message || "Falha inesperada.",
    });
  }
});

router.post("/share", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);

    if (!authorId) {
      return res.status(401).json({
        ok: false,
        error: "Não autenticado.",
      });
    }

    const targetType = normalizeTargetType(req.body?.target_type);
    const targetId = toNumberOrNull(req.body?.target_id);
    const shareType = String(req.body?.share_type || "INTERNAL").trim().toUpperCase();
    const comment = String(req.body?.comment || "").trim();
    const externalUrl = String(req.body?.external_url || "").trim();

    if (!targetType || !targetId) {
      return res.status(400).json({
        ok: false,
        error: "target_type e target_id são obrigatórios.",
      });
    }

    if (comment.length > 800) {
      return res.status(400).json({
        ok: false,
        error: "Comentário do compartilhamento excede 800 caracteres.",
      });
    }

    if (externalUrl && !/^https?:\/\//i.test(externalUrl)) {
      return res.status(400).json({
        ok: false,
        error: "URL externa inválida.",
      });
    }

    const pool = await getPool();
    const published = await ensureTargetPublished(pool, targetType, targetId);

    if (!published.ok) {
      return res.status(published.status).json({
        ok: false,
        error: published.error,
      });
    }

    await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("target_type", sql.VarChar(20), targetType)
      .input("target_id", sql.Int, targetId)
      .input("share_type", sql.VarChar(20), shareType === "EXTERNAL" ? "EXTERNAL" : "INTERNAL")
      .input("comment", sql.NVarChar(sql.MAX), comment || null)
      .input("external_url", sql.NVarChar(500), externalUrl || null)
      .query(`
        INSERT INTO dbo.identity_feed_share
          (author_id, target_type, target_id, share_type, comment, external_url, created_at)
        VALUES
          (@author_id, @target_type, @target_id, @share_type, @comment, @external_url, SYSUTCDATETIME());
      `);

    const counts = await getInteractionCounts(pool, targetType, targetId);

    return res.json({
      ok: true,
      counts,
    });
  } catch (err) {
    console.error("[feed.share]", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao compartilhar publicação.",
      detail: err?.message || "Falha inesperada.",
    });
  }
});

async function getInteractionCounts(pool, targetType, targetId) {
  const result = await pool
    .request()
    .input("target_type", sql.VarChar(20), targetType)
    .input("target_id", sql.Int, targetId)
    .query(`
      SELECT
        (
          SELECT COUNT_BIG(1)
          FROM dbo.identity_feed_reaction r
          WHERE r.target_type = @target_type
            AND r.target_id = @target_id
        ) AS likes,
        (
          SELECT COUNT_BIG(1)
          FROM dbo.identity_feed_comment c
          WHERE c.target_type = @target_type
            AND c.target_id = @target_id
            AND ISNULL(c.is_deleted, 0) = 0
        ) AS comments,
        (
          SELECT COUNT_BIG(1)
          FROM dbo.identity_feed_share s
          WHERE s.target_type = @target_type
            AND s.target_id = @target_id
        ) AS shares;
    `);

  const row = result.recordset?.[0] || {};

  return {
    likes: Number(row.likes || 0),
    comments: Number(row.comments || 0),
    shares: Number(row.shares || 0),
  };
}

export default router;