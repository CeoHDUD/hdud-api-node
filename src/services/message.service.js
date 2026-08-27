import { sql } from "../db.js";

export function getAuthorId(req) {
  const id = Number(req.user?.author_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function resolveMessageUserId(pool, req, authorId) {
  const direct =
    positiveInt(req.user?.user_id) ||
    positiveInt(req.user?.userId) ||
    positiveInt(req.user?.id) ||
    positiveInt(req.user?.uid) ||
    positiveInt(req.user?.sub);

  if (direct) return direct;

  const normalizedAuthorId = positiveInt(authorId);
  if (!normalizedAuthorId) return null;

  const result = await pool
    .request()
    .input("author_id", sql.Int, normalizedAuthorId)
    .query(`
      SELECT TOP 1 user_id
      FROM dbo.identity_user
      WHERE author_id = @author_id
      ORDER BY user_id DESC;
    `);

  return positiveInt(result.recordset?.[0]?.user_id);
}

export async function assertConnected(pool, authorA, authorB) {
  if (!authorA || !authorB || authorA === authorB) {
    const err = new Error("Conversa inválida.");
    err.status = 400;
    throw err;
  }

  const r = await pool.request()
    .input("a", sql.Int, authorA)
    .input("b", sql.Int, authorB)
    .query(`
      SELECT TOP 1 1 AS ok
      FROM dbo.identity_follow f1
      INNER JOIN dbo.identity_follow f2
        ON f2.follower_id = f1.followed_id
       AND f2.followed_id = f1.follower_id
      WHERE f1.follower_id = @a
        AND f1.followed_id = @b;
    `);

  if (!r.recordset?.length) {
    const err = new Error("Mensagens são permitidas somente entre conexões.");
    err.status = 403;
    throw err;
  }
}

export async function getOrCreateConversation(pool, authorA, authorB) {
  await assertConnected(pool, authorA, authorB);
  const low = Math.min(authorA, authorB);
  const high = Math.max(authorA, authorB);

  const tx = pool.transaction();
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    let r = await tx.request()
      .input("low", sql.Int, low)
      .input("high", sql.Int, high)
      .query(`
        SELECT TOP 1 conversation_id, author_a_id, author_b_id, created_at, updated_at, last_message_at
        FROM dbo.identity_conversation WITH (UPDLOCK, HOLDLOCK)
        WHERE author_a_id = @low AND author_b_id = @high;
      `);

    if (!r.recordset?.length) {
      r = await tx.request()
        .input("low", sql.Int, low)
        .input("high", sql.Int, high)
        .query(`
          INSERT INTO dbo.identity_conversation
            (author_a_id, author_b_id, created_at, updated_at)
          OUTPUT inserted.conversation_id, inserted.author_a_id, inserted.author_b_id,
                 inserted.created_at, inserted.updated_at, inserted.last_message_at
          VALUES (@low, @high, SYSUTCDATETIME(), SYSUTCDATETIME());
        `);
    }

    await tx.commit();
    return r.recordset[0];
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  }
}

export async function assertConversationMember(pool, conversationId, authorId) {
  const r = await pool.request()
    .input("conversation_id", sql.BigInt, conversationId)
    .input("author_id", sql.Int, authorId)
    .query(`
      SELECT TOP 1 conversation_id, author_a_id, author_b_id
      FROM dbo.identity_conversation
      WHERE conversation_id = @conversation_id
        AND (author_a_id = @author_id OR author_b_id = @author_id);
    `);

  const row = r.recordset?.[0];
  if (!row) {
    const err = new Error("Conversa não encontrada.");
    err.status = 404;
    throw err;
  }
  return row;
}

export async function createMessageNotification(txOrPool, receiverId, senderId, conversationId, messageId, preview) {
  const req = txOrPool.request()
    .input("author_id", sql.Int, receiverId)
    .input("actor_author_id", sql.Int, senderId)
    .input("entity_id", sql.BigInt, messageId)
    .input("conversation_id", sql.BigInt, conversationId)
    .input("preview", sql.NVarChar(300), preview)
    .input("payload_json", sql.NVarChar(sql.MAX), JSON.stringify({ conversation_id: Number(conversationId), message_id: Number(messageId), preview }));

  await req.query(`
    INSERT INTO dbo.identity_notification
      (author_id, type, actor_author_id, entity_type, entity_id, source_key, payload_json, is_read, created_at)
    VALUES
      (@author_id, 'message_received', @actor_author_id, 'message', @entity_id, CONCAT('message_received:', @entity_id), @payload_json, 0, SYSUTCDATETIME());
  `);
}
