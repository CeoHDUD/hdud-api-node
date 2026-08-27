import express from "express";
import { getPool, sql } from "../db.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

function authorId(req) {
  const id = Number(req.user?.author_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function syncNetworkNotifications(pool, me) {
  // Convite recebido — idempotente por source_key.
  await pool.request().input("me", sql.Int, me).query(`
    INSERT INTO dbo.identity_notification
      (author_id, type, actor_author_id, entity_type, entity_id, source_key, payload_json, is_read, created_at)
    SELECT
      i.to_author_id,
      'invite_received',
      i.from_author_id,
      'network_invite',
      i.invite_id,
      CONCAT('invite_received:', i.invite_id),
      CONCAT('{"invite_id":', i.invite_id, '}'),
      0,
      i.created_at
    FROM dbo.identity_network_invite i
    WHERE i.to_author_id = @me
      AND NOT EXISTS (
        SELECT 1 FROM dbo.identity_notification n
        WHERE n.author_id = @me AND n.source_key = CONCAT('invite_received:', i.invite_id)
      );
  `);

  // Convite aceito — notifica quem enviou.
  await pool.request().input("me", sql.Int, me).query(`
    INSERT INTO dbo.identity_notification
      (author_id, type, actor_author_id, entity_type, entity_id, source_key, payload_json, is_read, created_at)
    SELECT
      i.from_author_id,
      'invite_accepted',
      i.to_author_id,
      'network_invite',
      i.invite_id,
      CONCAT('invite_accepted:', i.invite_id),
      CONCAT('{"invite_id":', i.invite_id, '}'),
      0,
      COALESCE(i.responded_at, i.created_at)
    FROM dbo.identity_network_invite i
    WHERE i.from_author_id = @me
      AND i.status = 'accepted'
      AND NOT EXISTS (
        SELECT 1 FROM dbo.identity_notification n
        WHERE n.author_id = @me AND n.source_key = CONCAT('invite_accepted:', i.invite_id)
      );
  `);
}

async function syncSocialNotifications(pool, me) {
  // Curtidas de conexões em publicações do próprio autor.
  await pool.request().input("me", sql.Int, me).query(`
    ;WITH own_targets AS (
      SELECT CAST('MEMORY' AS varchar(20)) AS target_type, m.memory_id AS target_id
      FROM dbo.identity_memory m
      WHERE m.author_id = @me AND ISNULL(m.is_deleted, 0) = 0
      UNION ALL
      SELECT CAST('CHAPTER' AS varchar(20)), c.chapter_id
      FROM dbo.identity_chapter c
      WHERE c.author_id = @me AND ISNULL(c.is_deleted, 0) = 0
    ), mutual AS (
      SELECT f.followed_id AS author_id
      FROM dbo.identity_follow f
      WHERE f.follower_id = @me
        AND EXISTS (
          SELECT 1 FROM dbo.identity_follow rf
          WHERE rf.follower_id = f.followed_id AND rf.followed_id = @me
        )
    )
    INSERT INTO dbo.identity_notification
      (author_id, type, actor_author_id, entity_type, entity_id, source_key, payload_json, is_read, created_at)
    SELECT
      @me,
      'publication_liked',
      r.author_id,
      r.target_type,
      r.target_id,
      CONCAT('publication_liked:', r.reaction_id),
      CONCAT('{"target_type":"', r.target_type, '","target_id":', r.target_id, '}'),
      0,
      r.created_at
    FROM dbo.identity_feed_reaction r
    INNER JOIN own_targets t ON t.target_type = r.target_type AND t.target_id = r.target_id
    INNER JOIN mutual mc ON mc.author_id = r.author_id
    WHERE r.author_id <> @me
      AND NOT EXISTS (
        SELECT 1 FROM dbo.identity_notification n
        WHERE n.author_id = @me AND n.source_key = CONCAT('publication_liked:', r.reaction_id)
      );

    -- Se a curtida for removida antes/depois da sincronização, a notificação correspondente não deve sobreviver.
    DELETE n
    FROM dbo.identity_notification n
    WHERE n.author_id = @me
      AND n.type = 'publication_liked'
      AND n.source_key LIKE 'publication_liked:%'
      AND NOT EXISTS (
        SELECT 1
        FROM dbo.identity_feed_reaction r
        WHERE r.reaction_id = TRY_CONVERT(bigint, SUBSTRING(n.source_key, LEN('publication_liked:') + 1, 40))
      );
  `);

  // Comentários de conexões em publicações do próprio autor.
  await pool.request().input("me", sql.Int, me).query(`
    ;WITH own_targets AS (
      SELECT CAST('MEMORY' AS varchar(20)) AS target_type, m.memory_id AS target_id
      FROM dbo.identity_memory m
      WHERE m.author_id = @me AND ISNULL(m.is_deleted, 0) = 0
      UNION ALL
      SELECT CAST('CHAPTER' AS varchar(20)), c.chapter_id
      FROM dbo.identity_chapter c
      WHERE c.author_id = @me AND ISNULL(c.is_deleted, 0) = 0
    ), mutual AS (
      SELECT f.followed_id AS author_id
      FROM dbo.identity_follow f
      WHERE f.follower_id = @me
        AND EXISTS (
          SELECT 1 FROM dbo.identity_follow rf
          WHERE rf.follower_id = f.followed_id AND rf.followed_id = @me
        )
    )
    INSERT INTO dbo.identity_notification
      (author_id, type, actor_author_id, entity_type, entity_id, source_key, payload_json, is_read, created_at)
    SELECT
      @me,
      'publication_commented',
      c.author_id,
      c.target_type,
      c.target_id,
      CONCAT('publication_commented:', c.comment_id),
      CONCAT('{"target_type":"', c.target_type, '","target_id":', c.target_id, ',"comment_id":', c.comment_id, '}'),
      0,
      c.created_at
    FROM dbo.identity_feed_comment c
    INNER JOIN own_targets t ON t.target_type = c.target_type AND t.target_id = c.target_id
    INNER JOIN mutual mc ON mc.author_id = c.author_id
    WHERE c.author_id <> @me
      AND ISNULL(c.is_deleted, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM dbo.identity_notification n
        WHERE n.author_id = @me AND n.source_key = CONCAT('publication_commented:', c.comment_id)
      );
  `);

  // Ecos/compartilhamentos de conexões em publicações do próprio autor.
  await pool.request().input("me", sql.Int, me).query(`
    ;WITH own_targets AS (
      SELECT CAST('MEMORY' AS varchar(20)) AS target_type, m.memory_id AS target_id
      FROM dbo.identity_memory m
      WHERE m.author_id = @me AND ISNULL(m.is_deleted, 0) = 0
      UNION ALL
      SELECT CAST('CHAPTER' AS varchar(20)), c.chapter_id
      FROM dbo.identity_chapter c
      WHERE c.author_id = @me AND ISNULL(c.is_deleted, 0) = 0
    ), mutual AS (
      SELECT f.followed_id AS author_id
      FROM dbo.identity_follow f
      WHERE f.follower_id = @me
        AND EXISTS (
          SELECT 1 FROM dbo.identity_follow rf
          WHERE rf.follower_id = f.followed_id AND rf.followed_id = @me
        )
    )
    INSERT INTO dbo.identity_notification
      (author_id, type, actor_author_id, entity_type, entity_id, source_key, payload_json, is_read, created_at)
    SELECT
      @me,
      'publication_shared',
      s.author_id,
      s.target_type,
      s.target_id,
      CONCAT('publication_shared:', s.share_id),
      CONCAT('{"target_type":"', s.target_type, '","target_id":', s.target_id, ',"share_id":', s.share_id, '}'),
      0,
      s.created_at
    FROM dbo.identity_feed_share s
    INNER JOIN own_targets t ON t.target_type = s.target_type AND t.target_id = s.target_id
    INNER JOIN mutual mc ON mc.author_id = s.author_id
    WHERE s.author_id <> @me
      AND NOT EXISTS (
        SELECT 1 FROM dbo.identity_notification n
        WHERE n.author_id = @me AND n.source_key = CONCAT('publication_shared:', s.share_id)
      );
  `);
}

async function syncAll(pool, me) {
  await syncNetworkNotifications(pool, me);
  await syncSocialNotifications(pool, me);
}

router.get("/unread-count", authenticate, async (req, res) => {
  try {
    const me = authorId(req);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    const pool = await getPool();
    await syncAll(pool, me);
    const r = await pool.request().input("me", sql.Int, me).query(`
      SELECT COUNT_BIG(*) AS unread_count
      FROM dbo.identity_notification
      WHERE author_id = @me AND is_read = 0;
    `);
    return res.json({ unread_count: Number(r.recordset?.[0]?.unread_count || 0) });
  } catch (err) {
    console.error("[notifications.unread-count]", err);
    return res.status(500).json({ error: err?.message || "Falha nas notificações." });
  }
});

router.get("/", authenticate, async (req, res) => {
  try {
    const me = authorId(req);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    const pool = await getPool();
    await syncAll(pool, me);
    const r = await pool.request().input("me", sql.Int, me).query(`
      SELECT TOP 100
        n.notification_id, n.type, n.actor_author_id, n.entity_type, n.entity_id,
        n.payload_json, n.is_read, n.created_at, n.read_at,
        a.name_public, a.full_name, a.author_code, a.avatar_url
      FROM dbo.identity_notification n
      LEFT JOIN dbo.identity_author a ON a.author_id = n.actor_author_id
      WHERE n.author_id = @me
      ORDER BY n.created_at DESC, n.notification_id DESC;
    `);

    return res.json({
      items: (r.recordset || []).map((row) => ({
        notification_id: Number(row.notification_id),
        type: row.type,
        actor_author_id: row.actor_author_id ? Number(row.actor_author_id) : null,
        actor_name: row.name_public || row.full_name || row.author_code || "HDUD",
        avatar_url: row.avatar_url || null,
        entity_type: row.entity_type || null,
        entity_id: row.entity_id ? Number(row.entity_id) : null,
        payload: (() => {
          try { return row.payload_json ? JSON.parse(row.payload_json) : {}; }
          catch { return {}; }
        })(),
        is_read: !!row.is_read,
        created_at: row.created_at,
        read_at: row.read_at,
      })),
    });
  } catch (err) {
    console.error("[notifications.list]", err);
    return res.status(500).json({ error: err?.message || "Falha nas notificações." });
  }
});

router.post("/read-all", authenticate, async (req, res) => {
  try {
    const me = authorId(req);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    const pool = await getPool();
    await pool.request().input("me", sql.Int, me).query(`
      UPDATE dbo.identity_notification
      SET is_read = 1, read_at = COALESCE(read_at, SYSUTCDATETIME())
      WHERE author_id = @me AND is_read = 0;
    `);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Falha ao marcar notificações." });
  }
});

router.post("/:notificationId/read", authenticate, async (req, res) => {
  try {
    const me = authorId(req);
    const id = Number(req.params.notificationId);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "notificationId inválido." });
    const pool = await getPool();
    await pool.request().input("me", sql.Int, me).input("id", sql.BigInt, id).query(`
      UPDATE dbo.identity_notification
      SET is_read = 1, read_at = COALESCE(read_at, SYSUTCDATETIME())
      WHERE notification_id = @id AND author_id = @me;
    `);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Falha ao marcar notificação." });
  }
});

export default router;
