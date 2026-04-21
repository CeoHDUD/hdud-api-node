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

function normalizeAvatarValue(v) {
  if (v == null) return null;

  const s = String(v).trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "false") {
    return null;
  }

  // Aceita SOMENTE:
  // 1) URL absoluta http/https
  // 2) caminho absoluto iniciando com "/"
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return s;

  return null;
}

function makePreview(text, maxLen = 140) {
  const s = normalizeText(text, "");
  if (!s) return "História em construção dentro da HDUD.";
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (!oneLine) return "História em construção dentro da HDUD.";
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

function safeIso(value) {
  if (!value) return null;
  try {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch {}
  return null;
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const i = Math.trunc(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function pickDisplayName(row) {
  return (
    normalizeText(row?.name_public, "") ||
    normalizeText(row?.full_name, "") ||
    normalizeText(row?.author_code, "") ||
    `Autor ${row?.author_id ?? ""}`.trim()
  );
}

function isSuspiciousHumanName(row) {
  const raw =
    normalizeText(row?.name_public, "") ||
    normalizeText(row?.full_name, "") ||
    normalizeText(row?.author_code, "");

  const value = raw.toLowerCase();
  if (!value || value.length < 3) return true;

  const blockedTokens = [
    "system",
    "kernel",
    "teste",
    "test",
    "admin",
    "suporte",
    "service",
    "servico",
    "bot",
  ];

  return blockedTokens.some((token) => value.includes(token));
}

function parseDelimitedNames(value) {
  const raw = normalizeText(value, "");
  if (!raw) return [];
  return raw
    .split("|")
    .map((x) => normalizeText(x, ""))
    .filter(Boolean)
    .slice(0, 3);
}

function buildSuggestionReasons(row) {
  const mutualCount =
    Number(
      row?.mutual_count ??
        row?.mutual_connections ??
        0
    ) || 0;

  const mutualNames = Array.isArray(row?.mutual_names)
    ? row.mutual_names.filter(Boolean)
    : parseDelimitedNames(row?.mutual_preview_names);

  const memoryCount =
    Number(
      row?.memory_count ??
        row?.total_memories ??
        0
    ) || 0;

  const hasRecentActivity =
    Number(row?.is_recently_active || 0) === 1 ||
    normalizeText(row?.recent_activity_label, "").toLowerCase().includes("ativo");

  const hasBio = Number(row?.has_bio || 0) === 1;
  const hasAvatar = Number(row?.has_avatar || 0) === 1;
  const hasLocation = Number(row?.has_location || 0) === 1;

  const reasons = [];

  if (mutualCount > 0) {
    if (mutualNames.length === 1) {
      reasons.push(`Você e ${pickDisplayName(row)} conhecem ${mutualNames[0]}`);
    } else if (mutualNames.length === 2) {
      reasons.push(`Você e ${pickDisplayName(row)} conhecem ${mutualNames[0]} e ${mutualNames[1]}`);
    } else if (mutualNames.length >= 3) {
      reasons.push(
        `Você e ${pickDisplayName(row)} conhecem ${mutualNames[0]}, ${mutualNames[1]} e mais ${Math.max(mutualCount - 2, 1)}`
      );
    } else {
      reasons.push(`${mutualCount} conex${mutualCount === 1 ? "ão" : "ões"} em comum`);
    }
  }

  if (hasRecentActivity) {
    reasons.push("Ativo recentemente");
  }

  if (memoryCount > 0) {
    reasons.push(`Possui ${memoryCount} ${memoryCount === 1 ? "memória pública" : "memórias públicas"}`);
  }

  if (hasBio && hasAvatar && hasLocation) {
    reasons.push("Perfil bem preenchido");
  } else if (hasBio || hasAvatar || hasLocation) {
    reasons.push("Perfil parcialmente preenchido");
  }

  return reasons.slice(0, 4);
}

function mapAuthorCard(row) {
  if (!row) return null;

  const avatarUrl = normalizeAvatarValue(row.avatar_url);
  const mutualNames = parseDelimitedNames(row.mutual_preview_names);
  const totalMemories = Number(row.total_memories || row.memory_count || 0);
  const mutualCount = Number(row.mutual_connections || row.mutual_count || 0);
  const score = Number(row.SCORE || row.score || 0);
  const lastActivityAt = safeIso(
    row.last_activity_at ||
      row.last_memory_created_at ||
      row.updated_at ||
      row.created_at
  );
  const reasons =
    Array.isArray(row.reasons) && row.reasons.length
      ? row.reasons
      : buildSuggestionReasons({
          ...row,
          mutual_names: mutualNames,
          memory_count: totalMemories,
          mutual_count: mutualCount,
        });

  const primaryReason =
    normalizeText(row.primary_reason, "") || reasons[0] || "Sugestão de conexão";

  return {
    author_id: Number(row.author_id),
    author_code: row.author_code != null ? String(row.author_code) : null,
    name_public: pickDisplayName(row),
    bio_short: row.bio_short != null ? String(row.bio_short) : null,
    location: row.location != null ? String(row.location) : null,
    avatar_url: avatarUrl,
    memory_preview:
      row.memory_preview != null ? makePreview(String(row.memory_preview), 140) : null,
    email: row.email != null ? String(row.email) : null,
    is_following: Number(row.is_following || 0),
    follows_me: Number(row.follows_me || 0),
    has_pending_invite_from_me: Number(row.has_pending_invite_from_me || 0),
    has_pending_invite_to_me: Number(row.has_pending_invite_to_me || 0),

    // legado / já usado no front
    mutual_connections: mutualCount,
    mutual_preview_names: mutualNames,
    total_memories: totalMemories,
    last_memory_created_at: row.last_memory_created_at ? safeIso(row.last_memory_created_at) : null,
    recent_activity_label: row.recent_activity_label != null ? String(row.recent_activity_label) : null,

    // novos campos incrementais
    mutual_names: mutualNames,
    mutual_count: mutualCount,
    memory_count: totalMemories,
    last_activity_at: lastActivityAt,
    score,
    reasons,
    primary_reason: primaryReason,
    has_bio: Number(row.has_bio || 0),
    has_avatar: Number(row.has_avatar || 0),
    has_location: Number(row.has_location || 0),
    profile_score: Number(row.profile_score || 0),
    activity_score: Number(row.activity_score || 0),
    memory_score: Number(row.memory_score || 0),
    mutual_score: Number(row.mutual_score || 0),
    is_recently_active: Number(row.is_recently_active || 0),
  };
}

async function authorExists(pool, authorId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .query(`
      SELECT TOP 1 a.author_id
      FROM dbo.identity_author a
      WHERE a.author_id = @author_id;
    `);

  return r.recordset.length > 0;
}

async function areConnectedEitherWay(pool, a, b) {
  const r = await pool
    .request()
    .input("a", sql.Int, a)
    .input("b", sql.Int, b)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM dbo.identity_follow f
      WHERE
        (f.follower_id = @a AND f.followed_id = @b)
        OR
        (f.follower_id = @b AND f.followed_id = @a);
    `);

  return r.recordset.length > 0;
}

async function pendingInviteExistsEitherWay(pool, a, b) {
  const r = await pool
    .request()
    .input("a", sql.Int, a)
    .input("b", sql.Int, b)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM dbo.identity_network_invite i
      WHERE
        (
          (i.from_author_id = @a AND i.to_author_id = @b)
          OR
          (i.from_author_id = @b AND i.to_author_id = @a)
        )
        AND i.status = 'pending';
    `);

  return r.recordset.length > 0;
}

async function getSummaryCounts(pool, authorId) {
  const r = await pool
    .request()
    .input("author_id", sql.Int, authorId)
    .query(`
      SELECT
        following_count = (
          SELECT COUNT(*)
          FROM dbo.identity_follow f
          WHERE f.follower_id = @author_id
        ),
        followers_count = (
          SELECT COUNT(*)
          FROM dbo.identity_follow f
          WHERE f.followed_id = @author_id
        ),
        connections_count = (
          SELECT COUNT(*)
          FROM dbo.identity_follow f1
          INNER JOIN dbo.identity_follow f2
            ON f2.follower_id = f1.followed_id
           AND f2.followed_id = f1.follower_id
          WHERE f1.follower_id = @author_id
        ),
        invites_received = (
          SELECT COUNT(*)
          FROM dbo.identity_network_invite i
          WHERE i.to_author_id = @author_id
            AND i.status = 'pending'
        ),
        invites_sent = (
          SELECT COUNT(*)
          FROM dbo.identity_network_invite i
          WHERE i.from_author_id = @author_id
            AND i.status = 'pending'
        );
    `);

  const row = r.recordset?.[0] || {};

  const following = Number(row.following_count || 0);
  const followers = Number(row.followers_count || 0);
  const connections = Number(row.connections_count || 0);
  const invitesReceived = Number(row.invites_received || 0);
  const invitesSent = Number(row.invites_sent || 0);

  return {
    following,
    followers,
    connections,
    invites_received: invitesReceived,
    invites_sent: invitesSent,
    counts: {
      following,
      followers,
      connections,
      invites_received: invitesReceived,
      invites_sent: invitesSent,
    },
  };
}

// ============================
// SUMMARY
// ============================

router.get("/summary", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const pool = await getPool();
    const summary = await getSummaryCounts(pool, authorId);

    return res.json({
      ok: true,
      author_id: authorId,
      followers: summary.followers,
      following: summary.following,
      newFollowers: 0,
      profileViews7d: 0,
      growth7d: "+0%",
      presenceStatus: "Inicial",
      connections: summary.connections,
      invites_received: summary.invites_received,
      invites_sent: summary.invites_sent,
      counts: summary.counts,
      meta: {
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[network.summary]", err);
    return res.status(500).json({ error: "Erro ao carregar resumo da rede." });
  }
});

// ============================
// MUTUAL CONNECTIONS
// ============================

router.get("/mutual", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const targetAuthorId = Number(req.query?.author_id);
    const limit = clampInt(req.query?.limit, 1, 20, 5);

    if (!Number.isInteger(targetAuthorId) || targetAuthorId <= 0 || targetAuthorId === authorId) {
      return res.status(400).json({ error: "author_id inválido." });
    }

    const pool = await getPool();

    const exists = await authorExists(pool, targetAuthorId);
    if (!exists) {
      return res.status(404).json({ error: "Autor alvo não encontrado." });
    }

    const result = await pool
      .request()
      .input("me", sql.Int, authorId)
      .input("target", sql.Int, targetAuthorId)
      .input("limit", sql.Int, limit)
      .query(`
        WITH my_connections AS (
          SELECT f1.followed_id AS author_id
          FROM dbo.identity_follow f1
          INNER JOIN dbo.identity_follow f2
            ON f2.follower_id = f1.followed_id
           AND f2.followed_id = f1.follower_id
          WHERE f1.follower_id = @me
        ),
        target_connections AS (
          SELECT f1.followed_id AS author_id
          FROM dbo.identity_follow f1
          INNER JOIN dbo.identity_follow f2
            ON f2.follower_id = f1.followed_id
           AND f2.followed_id = f1.follower_id
          WHERE f1.follower_id = @target
        ),
        mutual_ids AS (
          SELECT mc.author_id
          FROM my_connections mc
          INNER JOIN target_connections tc
            ON tc.author_id = mc.author_id
          WHERE mc.author_id <> @me
            AND mc.author_id <> @target
        )
        SELECT TOP (@limit)
          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url,
          last_memory.memory_preview,
          COUNT(*) OVER() AS total_mutual
        FROM mutual_ids mi
        INNER JOIN dbo.identity_author a
          ON a.author_id = mi.author_id
        OUTER APPLY (
          SELECT TOP 1
            m.content AS memory_preview
          FROM dbo.identity_memory m
          WHERE m.author_id = a.author_id
            AND ISNULL(m.is_deleted, 0) = 0
          ORDER BY m.created_at DESC, m.memory_id DESC
        ) last_memory
        ORDER BY a.author_id DESC;
      `);

    const rows = result.recordset || [];

    const items = rows.map((row) => mapAuthorCard(row));
    const mutualConnections = rows.length > 0 ? Number(rows[0].total_mutual || 0) : 0;

    return res.json({
      ok: true,
      author_id: authorId,
      target_author_id: targetAuthorId,
      mutual_connections: mutualConnections,
      items,
      meta: {
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[network.mutual]", err);
    return res.status(500).json({ error: "Erro ao carregar conexões em comum." });
  }
});

// ============================
// SUGGESTIONS
// ============================

router.get("/suggestions", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const limit = clampInt(req.query?.limit, 1, 30, 12);
    const pool = await getPool();

    const r = await pool
      .request()
      .input("me", sql.Int, authorId)
      .input("limit", sql.Int, limit)
      .query(`
        WITH memory_stats AS (
          SELECT
            m.author_id,
            COUNT(*) AS total_memories,
            SUM(CASE WHEN m.created_at >= DATEADD(DAY, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS recent_memories_30d,
            MAX(m.created_at) AS last_memory_created_at
          FROM dbo.identity_memory m
          WHERE ISNULL(m.is_deleted, 0) = 0
          GROUP BY m.author_id
        ),
        my_connections AS (
          SELECT f1.followed_id AS author_id
          FROM dbo.identity_follow f1
          INNER JOIN dbo.identity_follow f2
            ON f2.follower_id = f1.followed_id
           AND f2.followed_id = f1.follower_id
          WHERE f1.follower_id = @me
        ),
        candidate_base AS (
          SELECT
            a.author_id,
            a.user_id,
            a.author_code,
            a.full_name,
            a.name_public,
            a.bio_short,
            a.location,
            a.avatar_url,
            a.created_at,
            a.updated_at,
            ISNULL(ms.total_memories, 0) AS total_memories,
            ISNULL(ms.recent_memories_30d, 0) AS recent_memories_30d,
            ms.last_memory_created_at,
            last_memory.memory_preview
          FROM dbo.identity_author a
          LEFT JOIN memory_stats ms
            ON ms.author_id = a.author_id
          OUTER APPLY (
            SELECT TOP 1
              m.content AS memory_preview
            FROM dbo.identity_memory m
            WHERE m.author_id = a.author_id
              AND ISNULL(m.is_deleted, 0) = 0
            ORDER BY m.created_at DESC, m.memory_id DESC
          ) last_memory
          WHERE a.author_id <> @me
            AND NOT EXISTS (
              SELECT 1
              FROM dbo.identity_follow f
              WHERE
                (f.follower_id = @me AND f.followed_id = a.author_id)
                OR
                (f.follower_id = a.author_id AND f.followed_id = @me)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM dbo.identity_network_invite i
              WHERE
                (
                  (i.from_author_id = @me AND i.to_author_id = a.author_id)
                  OR
                  (i.from_author_id = a.author_id AND i.to_author_id = @me)
                )
                AND i.status = 'pending'
            )
            AND NULLIF(LTRIM(RTRIM(ISNULL(a.name_public, ISNULL(a.full_name, ISNULL(a.author_code, ''))))), '') IS NOT NULL
        ),
        mutual_rollup AS (
          SELECT
            cb.author_id,
            COUNT(*) AS mutual_count,
            STUFF((
              SELECT TOP 3
                '|' + names.display_name
              FROM (
                SELECT
                  COALESCE(
                    NULLIF(LTRIM(RTRIM(a2.name_public)), ''),
                    NULLIF(LTRIM(RTRIM(a2.full_name)), ''),
                    NULLIF(LTRIM(RTRIM(a2.author_code)), ''),
                    'Autor ' + CAST(a2.author_id AS VARCHAR(20))
                  ) AS display_name,
                  a2.author_id
                FROM my_connections mc2
                INNER JOIN dbo.identity_follow c1b
                  ON c1b.follower_id = cb.author_id
                 AND c1b.followed_id = mc2.author_id
                INNER JOIN dbo.identity_follow c2b
                  ON c2b.follower_id = mc2.author_id
                 AND c2b.followed_id = cb.author_id
                INNER JOIN dbo.identity_author a2
                  ON a2.author_id = mc2.author_id
                WHERE mc2.author_id <> cb.author_id
                  AND mc2.author_id <> @me
              ) names
              ORDER BY names.display_name ASC, names.author_id DESC
              FOR XML PATH(''), TYPE
            ).value('.', 'NVARCHAR(MAX)'), 1, 1, '') AS mutual_preview_names
          FROM candidate_base cb
          INNER JOIN my_connections mc
            ON mc.author_id <> cb.author_id
           AND mc.author_id <> @me
          INNER JOIN dbo.identity_follow c1
            ON c1.follower_id = cb.author_id
           AND c1.followed_id = mc.author_id
          INNER JOIN dbo.identity_follow c2
            ON c2.follower_id = mc.author_id
           AND c2.followed_id = cb.author_id
          GROUP BY cb.author_id
        )
        SELECT TOP (@limit)
          cb.author_id,
          cb.author_code,
          cb.full_name,
          cb.name_public,
          cb.bio_short,
          cb.location,
          cb.avatar_url,
          cb.memory_preview,
          cb.total_memories,
          cb.recent_memories_30d,
          cb.last_memory_created_at,
          COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) AS last_activity_at,
          CASE
            WHEN COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) >= DATEADD(DAY, -7, SYSUTCDATETIME()) THEN 'Ativo recentemente'
            WHEN COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) >= DATEADD(DAY, -30, SYSUTCDATETIME()) THEN 'Ativo neste mês'
            ELSE 'Narrativa ativa'
          END AS recent_activity_label,

          ISNULL(mr.mutual_count, 0) AS mutual_connections,
          ISNULL(mr.mutual_count, 0) AS mutual_count,
          mr.mutual_preview_names,

          CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.bio_short, ''))), '') IS NOT NULL THEN 1 ELSE 0 END AS has_bio,
          CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.location, ''))), '') IS NOT NULL THEN 1 ELSE 0 END AS has_location,
          CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.avatar_url, ''))), '') IS NOT NULL THEN 1 ELSE 0 END AS has_avatar,

          CASE
            WHEN ISNULL(mr.mutual_count, 0) > 0 THEN ISNULL(mr.mutual_count, 0) * 5
            ELSE 0
          END AS mutual_score,

          CASE
            WHEN COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) >= DATEADD(DAY, -7, SYSUTCDATETIME()) THEN 9
            WHEN COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) >= DATEADD(DAY, -30, SYSUTCDATETIME()) THEN 3
            ELSE 0
          END AS activity_score,

          CASE
            WHEN ISNULL(cb.total_memories, 0) >= 10 THEN 6
            WHEN ISNULL(cb.total_memories, 0) >= 5 THEN 4
            WHEN ISNULL(cb.total_memories, 0) >= 1 THEN 2
            ELSE 0
          END AS memory_score,

          (
            CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.bio_short, ''))), '') IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.avatar_url, ''))), '') IS NOT NULL THEN 1 ELSE 0 END +
            CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.location, ''))), '') IS NOT NULL THEN 1 ELSE 0 END
          ) AS profile_score,

          CASE
            WHEN COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) >= DATEADD(DAY, -7, SYSUTCDATETIME()) THEN 1
            ELSE 0
          END AS is_recently_active,

          (
            CASE
              WHEN ISNULL(mr.mutual_count, 0) > 0 THEN ISNULL(mr.mutual_count, 0) * 5
              ELSE 0
            END
            +
            CASE
              WHEN COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) >= DATEADD(DAY, -7, SYSUTCDATETIME()) THEN 9
              WHEN COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) >= DATEADD(DAY, -30, SYSUTCDATETIME()) THEN 3
              ELSE 0
            END
            +
            CASE
              WHEN ISNULL(cb.total_memories, 0) >= 10 THEN 6
              WHEN ISNULL(cb.total_memories, 0) >= 5 THEN 4
              WHEN ISNULL(cb.total_memories, 0) >= 1 THEN 2
              ELSE 0
            END
            +
            (
              CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.bio_short, ''))), '') IS NOT NULL THEN 1 ELSE 0 END +
              CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.avatar_url, ''))), '') IS NOT NULL THEN 1 ELSE 0 END +
              CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(cb.location, ''))), '') IS NOT NULL THEN 1 ELSE 0 END
            )
          ) AS SCORE
        FROM candidate_base cb
        LEFT JOIN mutual_rollup mr
          ON mr.author_id = cb.author_id
        ORDER BY
          SCORE DESC,
          ISNULL(mr.mutual_count, 0) DESC,
          cb.total_memories DESC,
          COALESCE(cb.last_memory_created_at, cb.updated_at, cb.created_at) DESC,
          cb.author_id DESC;
      `);

    const items = (r.recordset || [])
      .filter((row) => !isSuspiciousHumanName(row))
      .map((row) => {
        const mapped = mapAuthorCard(row);
        const reasons = buildSuggestionReasons({
          ...row,
          mutual_names: mapped.mutual_names,
          memory_count: mapped.memory_count,
          mutual_count: mapped.mutual_count,
        });

        const primaryReason = reasons[0] || "Sugestão de conexão";

        return {
          ...mapped,
          reasons,
          primary_reason: primaryReason,
          reason: primaryReason,
          score: Number(row.SCORE || 0),
          mutual_connections: Number(row.mutual_connections || 0),
          mutual_count: Number(row.mutual_count || 0),
          mutual_names: mapped.mutual_names,
          memory_count: Number(row.total_memories || 0),
          total_memories: Number(row.total_memories || 0),
          last_activity_at: safeIso(row.last_activity_at),
          last_memory_created_at: safeIso(row.last_memory_created_at),
        };
      });

    return res.json({
      ok: true,
      author_id: authorId,
      items,
      suggestions: items,
      meta: {
        strategy: "hdud_social_engine_v1_affinity_score",
        weights: {
          mutual_connections: 5,
          activity: 3,
          memories: 2,
          profile: 1,
        },
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[network.suggestions]", err);
    return res.status(500).json({ error: "Erro ao carregar sugestões." });
  }
});

// ============================
// SEARCH
// ============================

router.get("/search", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const q = normalizeText(req.query?.q, "");
    const limit = clampInt(req.query?.limit, 1, 50, 20);

    if (!q || q.length < 2) {
      return res.json({
        ok: true,
        author_id: authorId,
        items: [],
        meta: {
          strategy: "network_search_v2",
          query: q,
          reason: "query_too_short",
          generated_at: new Date().toISOString(),
        },
      });
    }

    const pool = await getPool();

    const r = await pool
      .request()
      .input("me", sql.Int, authorId)
      .input("q", sql.NVarChar(200), q)
      .input("limit", sql.Int, limit)
      .query(`
        WITH my_connections AS (
          SELECT f1.followed_id AS author_id
          FROM dbo.identity_follow f1
          INNER JOIN dbo.identity_follow f2
            ON f2.follower_id = f1.followed_id
           AND f2.followed_id = f1.follower_id
          WHERE f1.follower_id = @me
        )
        SELECT TOP (@limit)
          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url,
          u.email,
          last_memory.memory_preview,

          is_following = CASE
            WHEN EXISTS (
              SELECT 1
              FROM dbo.identity_follow f
              WHERE f.follower_id = @me
                AND f.followed_id = a.author_id
            ) THEN 1 ELSE 0
          END,

          follows_me = CASE
            WHEN EXISTS (
              SELECT 1
              FROM dbo.identity_follow f
              WHERE f.follower_id = a.author_id
                AND f.followed_id = @me
            ) THEN 1 ELSE 0
          END,

          has_pending_invite_from_me = CASE
            WHEN EXISTS (
              SELECT 1
              FROM dbo.identity_network_invite i
              WHERE i.from_author_id = @me
                AND i.to_author_id = a.author_id
                AND i.status = 'pending'
            ) THEN 1 ELSE 0
          END,

          has_pending_invite_to_me = CASE
            WHEN EXISTS (
              SELECT 1
              FROM dbo.identity_network_invite i
              WHERE i.from_author_id = a.author_id
                AND i.to_author_id = @me
                AND i.status = 'pending'
            ) THEN 1 ELSE 0
          END,

          mutual_connections = (
            SELECT COUNT(*)
            FROM my_connections mc
            INNER JOIN dbo.identity_follow c1
              ON c1.follower_id = a.author_id
             AND c1.followed_id = mc.author_id
            INNER JOIN dbo.identity_follow c2
              ON c2.follower_id = mc.author_id
             AND c2.followed_id = a.author_id
            WHERE mc.author_id <> a.author_id
              AND mc.author_id <> @me
          )

        FROM dbo.identity_author a
        LEFT JOIN dbo.identity_user u
          ON u.author_id = a.author_id
        OUTER APPLY (
          SELECT TOP 1
            m.content AS memory_preview
          FROM dbo.identity_memory m
          WHERE m.author_id = a.author_id
            AND ISNULL(m.is_deleted, 0) = 0
          ORDER BY m.created_at DESC, m.memory_id DESC
        ) last_memory
        WHERE a.author_id <> @me
          AND (
            a.name_public LIKE '%' + @q + '%'
            OR a.full_name LIKE '%' + @q + '%'
            OR a.author_code LIKE '%' + @q + '%'
            OR EXISTS (
              SELECT 1
              FROM dbo.identity_user u2
              WHERE
                (
                  u2.user_id = a.user_id
                  OR u2.author_id = a.author_id
                )
                AND (
                  u2.email LIKE '%' + @q + '%'
                  OR LEFT(u2.email, CHARINDEX('@', u2.email + '@') - 1) LIKE '%' + @q + '%'
                )
            )
          )
        ORDER BY
          CASE
            WHEN a.name_public = @q THEN 0
            WHEN a.full_name = @q THEN 1
            WHEN EXISTS (
              SELECT 1
              FROM dbo.identity_user u3
              WHERE
                (
                  u3.user_id = a.user_id
                  OR u3.author_id = a.author_id
                )
                AND u3.email = @q
            ) THEN 2
            WHEN a.author_code = @q THEN 3
            WHEN a.name_public LIKE @q + '%' THEN 4
            WHEN a.full_name LIKE @q + '%' THEN 5
            WHEN EXISTS (
              SELECT 1
              FROM dbo.identity_user u4
              WHERE
                (
                  u4.user_id = a.user_id
                  OR u4.author_id = a.author_id
                )
                AND LEFT(u4.email, CHARINDEX('@', u4.email + '@') - 1) LIKE @q + '%'
            ) THEN 6
            ELSE 7
          END,
          mutual_connections DESC,
          ISNULL(a.updated_at, a.created_at) DESC,
          a.author_id DESC;
      `);

    const items = (r.recordset || []).map((row) => {
      const mapped = mapAuthorCard(row);
      const mutual = Number(row.mutual_connections || 0);

      let reason = "Resultado da busca";
      if (Number(row.has_pending_invite_from_me || 0) === 1) {
        reason = "Convite pendente enviado";
      } else if (Number(row.has_pending_invite_to_me || 0) === 1) {
        reason = "Essa pessoa já enviou um convite para você";
      } else if (Number(row.is_following || 0) === 1 && Number(row.follows_me || 0) === 1) {
        reason = "Essa pessoa já faz parte da sua rede";
      } else if (Number(row.is_following || 0) === 1) {
        reason = "Você já acompanha essa pessoa";
      } else if (mutual > 0) {
        reason = `${mutual} conex${mutual === 1 ? "ão" : "ões"} em comum`;
      }

      return {
        ...mapped,
        reason,
        mutual_connections: mutual,
      };
    });

    return res.json({
      ok: true,
      author_id: authorId,
      items,
      meta: {
        strategy: "network_search_v3_mutuals",
        query: q,
        limit,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[network.search]", err);
    return res.status(500).json({ error: "Erro ao buscar usuários." });
  }
});

// ============================
// INVITES
// ============================

router.get("/invites", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const pool = await getPool();

    const received = await pool
      .request()
      .input("id", sql.Int, authorId)
      .query(`
        SELECT
          i.invite_id,
          i.from_author_id,
          i.to_author_id,
          i.status,
          i.message,
          i.created_at,
          i.responded_at,

          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url,

          last_memory.memory_preview
        FROM dbo.identity_network_invite i
        INNER JOIN dbo.identity_author a
          ON a.author_id = i.from_author_id
        OUTER APPLY (
          SELECT TOP 1
            m.content AS memory_preview
          FROM dbo.identity_memory m
          WHERE m.author_id = a.author_id
            AND ISNULL(m.is_deleted, 0) = 0
          ORDER BY
            m.created_at DESC,
            m.memory_id DESC
        ) last_memory
        WHERE i.to_author_id = @id
          AND i.status = 'pending'
        ORDER BY i.created_at DESC, i.invite_id DESC;
      `);

    const sent = await pool
      .request()
      .input("id", sql.Int, authorId)
      .query(`
        SELECT
          i.invite_id,
          i.from_author_id,
          i.to_author_id,
          i.status,
          i.message,
          i.created_at,
          i.responded_at,

          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url,

          last_memory.memory_preview
        FROM dbo.identity_network_invite i
        INNER JOIN dbo.identity_author a
          ON a.author_id = i.to_author_id
        OUTER APPLY (
          SELECT TOP 1
            m.content AS memory_preview
          FROM dbo.identity_memory m
          WHERE m.author_id = a.author_id
            AND ISNULL(m.is_deleted, 0) = 0
          ORDER BY
            m.created_at DESC,
            m.memory_id DESC
        ) last_memory
        WHERE i.from_author_id = @id
          AND i.status = 'pending'
        ORDER BY i.created_at DESC, i.invite_id DESC;
      `);

    const receivedItems = (received.recordset || []).map((row) => ({
      invite_id: Number(row.invite_id),
      from_author_id: Number(row.from_author_id),
      to_author_id: Number(row.to_author_id),
      status: String(row.status),
      message: row.message != null ? String(row.message) : null,
      created_at: safeIso(row.created_at),
      responded_at: row.responded_at ? safeIso(row.responded_at) : null,
      author: mapAuthorCard(row),
    }));

    const sentItems = (sent.recordset || []).map((row) => ({
      invite_id: Number(row.invite_id),
      from_author_id: Number(row.from_author_id),
      to_author_id: Number(row.to_author_id),
      status: String(row.status),
      message: row.message != null ? String(row.message) : null,
      created_at: safeIso(row.created_at),
      responded_at: row.responded_at ? safeIso(row.responded_at) : null,
      author: mapAuthorCard(row),
    }));

    return res.json({
      ok: true,
      author_id: authorId,
      received: receivedItems,
      sent: sentItems,
      counts: {
        received: receivedItems.length,
        sent: sentItems.length,
      },
      meta: {
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[network.invites]", err);
    return res.status(500).json({ error: "Erro ao listar convites." });
  }
});

// ============================
// ENVIAR CONVITE
// ============================

router.post("/invite", authenticate, async (req, res) => {
  try {
    const fromId = getAuthorId(req);
    const toId = Number(req.body?.to_author_id);

    if (!fromId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    if (!Number.isInteger(toId) || toId <= 0 || toId === fromId) {
      return res.status(400).json({ error: "Convite inválido." });
    }

    const pool = await getPool();

    const targetExists = await authorExists(pool, toId);
    if (!targetExists) {
      return res.status(404).json({ error: "Usuário de destino não encontrado." });
    }

    const connected = await areConnectedEitherWay(pool, fromId, toId);
    if (connected) {
      return res.status(400).json({ error: "Já conectado." });
    }

    const pending = await pendingInviteExistsEitherWay(pool, fromId, toId);
    if (pending) {
      return res.status(400).json({ error: "Já existe convite pendente entre esses usuários." });
    }

    const insert = await pool
      .request()
      .input("a", sql.Int, fromId)
      .input("b", sql.Int, toId)
      .query(`
        INSERT INTO dbo.identity_network_invite
          (from_author_id, to_author_id)
        OUTPUT
          INSERTED.invite_id,
          INSERTED.from_author_id,
          INSERTED.to_author_id,
          INSERTED.status,
          INSERTED.created_at,
          INSERTED.responded_at
        VALUES
          (@a, @b);
      `);

    const invite = insert.recordset?.[0] || null;

    return res.json({
      ok: true,
      invite: invite
        ? {
            invite_id: Number(invite.invite_id),
            from_author_id: Number(invite.from_author_id),
            to_author_id: Number(invite.to_author_id),
            status: String(invite.status),
            created_at: safeIso(invite.created_at),
            responded_at: invite.responded_at ? safeIso(invite.responded_at) : null,
          }
        : null,
    });
  } catch (err) {
    console.error("[network.invite.create]", err);
    return res.status(500).json({ error: "Erro ao enviar convite." });
  }
});

// ============================
// ACEITAR CONVITE
// ============================

router.post("/invite/:id/accept", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    const inviteId = Number(req.params.id);

    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    if (!Number.isInteger(inviteId) || inviteId <= 0) {
      return res.status(400).json({ error: "Convite inválido." });
    }

    const pool = await getPool();

    const invite = await pool
      .request()
      .input("id", sql.Int, inviteId)
      .query(`
        SELECT TOP 1
          invite_id,
          from_author_id,
          to_author_id,
          status,
          created_at,
          responded_at
        FROM dbo.identity_network_invite
        WHERE invite_id = @id;
      `);

    const row = invite.recordset?.[0] || null;

    if (!row) {
      return res.status(404).json({ error: "Convite não encontrado." });
    }

    if (Number(row.to_author_id) !== authorId) {
      return res.status(403).json({ error: "Você não pode aceitar este convite." });
    }

    if (String(row.status) !== "pending") {
      return res.status(400).json({ error: "Convite já respondido." });
    }

    const tx = pool.transaction();
    await tx.begin();

    try {
      await tx
        .request()
        .input("id", sql.Int, inviteId)
        .query(`
          UPDATE dbo.identity_network_invite
          SET
            status = 'accepted',
            responded_at = SYSUTCDATETIME()
          WHERE invite_id = @id
            AND status = 'pending';
        `);

      await tx
        .request()
        .input("a", sql.Int, Number(row.from_author_id))
        .input("b", sql.Int, Number(row.to_author_id))
        .query(`
          IF NOT EXISTS (
            SELECT 1
            FROM dbo.identity_follow
            WHERE follower_id = @a
              AND followed_id = @b
          )
          BEGIN
            INSERT INTO dbo.identity_follow
              (follower_id, followed_id, created_at)
            VALUES
              (@a, @b, SYSUTCDATETIME());
          END
        `);

      await tx
        .request()
        .input("a", sql.Int, Number(row.to_author_id))
        .input("b", sql.Int, Number(row.from_author_id))
        .query(`
          IF NOT EXISTS (
            SELECT 1
            FROM dbo.identity_follow
            WHERE follower_id = @a
              AND followed_id = @b
          )
          BEGIN
            INSERT INTO dbo.identity_follow
              (follower_id, followed_id, created_at)
            VALUES
              (@a, @b, SYSUTCDATETIME());
          END
        `);

      await tx
        .request()
        .input("a", sql.Int, Number(row.from_author_id))
        .input("b", sql.Int, Number(row.to_author_id))
        .input("current_invite_id", sql.Int, inviteId)
        .query(`
          UPDATE dbo.identity_network_invite
          SET
            status = 'accepted',
            responded_at = COALESCE(responded_at, SYSUTCDATETIME())
          WHERE invite_id <> @current_invite_id
            AND status = 'pending'
            AND (
              (from_author_id = @a AND to_author_id = @b)
              OR
              (from_author_id = @b AND to_author_id = @a)
            );
        `);

      await tx.commit();

      return res.json({
        ok: true,
        invite_id: inviteId,
        status: "accepted",
        connection_created: true,
        reciprocal_follow: true,
      });
    } catch (txErr) {
      try {
        await tx.rollback();
      } catch {}
      throw txErr;
    }
  } catch (err) {
    console.error("[network.invite.accept]", err);
    return res.status(500).json({ error: "Erro ao aceitar convite." });
  }
});

// ============================
// REJEITAR CONVITE
// ============================

router.post("/invite/:id/reject", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    const inviteId = Number(req.params.id);

    if (!authorId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    if (!Number.isInteger(inviteId) || inviteId <= 0) {
      return res.status(400).json({ error: "Convite inválido." });
    }

    const pool = await getPool();

    const result = await pool
      .request()
      .input("id", sql.Int, inviteId)
      .input("me", sql.Int, authorId)
      .query(`
        UPDATE dbo.identity_network_invite
        SET
          status = 'rejected',
          responded_at = SYSUTCDATETIME()
        WHERE invite_id = @id
          AND to_author_id = @me
          AND status = 'pending';

        SELECT @@ROWCOUNT AS affected;
      `);

    const affected = Number(result.recordset?.[0]?.affected || 0);

    if (affected <= 0) {
      return res.status(404).json({ error: "Convite pendente não encontrado para rejeição." });
    }

    return res.json({
      ok: true,
      invite_id: inviteId,
      status: "rejected",
    });
  } catch (err) {
    console.error("[network.invite.reject]", err);
    return res.status(500).json({ error: "Erro ao rejeitar convite." });
  }
});

export default router;