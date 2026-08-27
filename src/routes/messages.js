import express from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import { fileURLToPath } from "url";
import { getPool, sql } from "../db.js";
import { authenticate } from "../middleware/auth.js";
import {
  checkPlanFeature,
  sendPlanDenied,
} from "../services/plan-enforcement.service.js";
import {
  getAuthorId,
  resolveMessageUserId,
  assertConnected,
  getOrCreateConversation,
  assertConversationMember,
  createMessageNotification,
} from "../services/message.service.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRIVATE_STORAGE_ROOT = path.resolve(
  process.env.HDUD_PRIVATE_STORAGE_DIR || path.resolve(__dirname, "../../storage")
);
const MESSAGE_ATTACHMENT_ROOT = path.join(PRIVATE_STORAGE_ROOT, "message-attachments");
const TECHNICAL_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const ALLOWED_ATTACHMENTS = Object.freeze({
  ".jpg": {
    mime: "image/jpeg",
    category: "image",
    extension: "jpg",
    preview: true,
    magic: "jpeg",
  },
  ".jpeg": {
    mime: "image/jpeg",
    category: "image",
    extension: "jpg",
    preview: true,
    magic: "jpeg",
  },
  ".png": {
    mime: "image/png",
    category: "image",
    extension: "png",
    preview: true,
    magic: "png",
  },
  ".webp": {
    mime: "image/webp",
    category: "image",
    extension: "webp",
    preview: true,
    magic: "webp",
  },
  ".pdf": {
    mime: "application/pdf",
    category: "pdf",
    extension: "pdf",
    preview: true,
    magic: "pdf",
  },
  ".txt": {
    mime: "text/plain",
    category: "text",
    extension: "txt",
    preview: true,
    magic: "text",
  },
  ".doc": {
    mime: "application/msword",
    category: "document",
    extension: "doc",
    preview: false,
    magic: "cfb",
  },
  ".docx": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    category: "document",
    extension: "docx",
    preview: false,
    magic: "zip",
  },
  ".xls": {
    mime: "application/vnd.ms-excel",
    category: "spreadsheet",
    extension: "xls",
    preview: false,
    magic: "cfb",
  },
  ".xlsx": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    category: "spreadsheet",
    extension: "xlsx",
    preview: false,
    magic: "zip",
  },
});

const messageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: TECHNICAL_UPLOAD_MAX_BYTES,
    files: 1,
  },
});

function messageUploadSingle(req, res, next) {
  return messageUpload.single("file")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          ok: false,
          error: "O arquivo excede o teto técnico de 50 MB.",
          code: "MESSAGE_ATTACHMENT_TECHNICAL_LIMIT",
          technical_limit_bytes: TECHNICAL_UPLOAD_MAX_BYTES,
        });
      }
      return res.status(400).json({
        ok: false,
        error: "Upload de anexo inválido.",
        code: err.code || "MESSAGE_ATTACHMENT_UPLOAD_INVALID",
      });
    }

    return next(err);
  });
}

function fail(res, err) {
  const status = Number(err?.status || 500);
  return res.status(status).json({ error: err?.message || "Falha na mensageria." });
}

function peerName(row) {
  return String(row?.name_public || row?.full_name || row?.author_code || "Autor HDUD");
}

function safeOriginalFileName(value) {
  const raw = String(value || "arquivo")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return (raw || "arquivo").slice(0, 520);
}

function hasPrefix(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((value, index) => buffer[index] === value);
}

function validateMagic(buffer, kind) {
  switch (kind) {
    case "jpeg":
      return hasPrefix(buffer, [0xff, 0xd8, 0xff]);
    case "png":
      return hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "webp":
      return (
        Buffer.isBuffer(buffer) &&
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case "pdf":
      return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    case "text":
      return Buffer.isBuffer(buffer) && !buffer.includes(0x00);
    case "cfb":
      return hasPrefix(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "zip":
      return (
        hasPrefix(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
        hasPrefix(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
        hasPrefix(buffer, [0x50, 0x4b, 0x07, 0x08])
      );
    default:
      return false;
  }
}

function validateAttachmentFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return null;

  const originalFileName = safeOriginalFileName(file.originalname);
  const ext = path.extname(originalFileName).toLowerCase();
  const rule = ALLOWED_ATTACHMENTS[ext];

  if (!rule) {
    const err = new Error("Tipo de arquivo não permitido em mensagens.");
    err.status = 415;
    throw err;
  }

  const receivedMime = String(file.mimetype || "").trim().toLowerCase();
  if (receivedMime !== rule.mime) {
    const err = new Error("O tipo MIME do arquivo não corresponde à extensão permitida.");
    err.status = 415;
    throw err;
  }

  if (!validateMagic(file.buffer, rule.magic)) {
    const err = new Error("O conteúdo do arquivo não corresponde ao tipo informado.");
    err.status = 415;
    throw err;
  }

  if (!(Number(file.size) > 0)) {
    const err = new Error("Arquivo vazio não é permitido.");
    err.status = 400;
    throw err;
  }

  return {
    originalFileName,
    fileExtension: rule.extension,
    mimeType: rule.mime,
    category: rule.category,
    previewInline: rule.preview,
    sizeBytes: Number(file.size),
    sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    buffer: file.buffer,
  };
}

function attachmentRelativePath({ ownerAuthorId, conversationId, messageId, attachmentId, extension }) {
  return path.posix.join(
    "message-attachments",
    `author_${Number(ownerAuthorId)}`,
    `conversation_${Number(conversationId)}`,
    `message_${Number(messageId)}`,
    `attachment_${Number(attachmentId)}`,
    `original.${String(extension)}`
  );
}

function resolvePrivateStoredPath(storagePath) {
  const relative = String(storagePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = path.resolve(PRIVATE_STORAGE_ROOT, relative);
  const rootPrefix = PRIVATE_STORAGE_ROOT.endsWith(path.sep)
    ? PRIVATE_STORAGE_ROOT
    : `${PRIVATE_STORAGE_ROOT}${path.sep}`;

  if (resolved !== PRIVATE_STORAGE_ROOT && !resolved.startsWith(rootPrefix)) {
    const err = new Error("Caminho de storage inválido.");
    err.status = 500;
    throw err;
  }

  return resolved;
}

async function removeCreatedAttachmentFile(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch {}

  let dir = path.dirname(filePath);
  const stopAt = path.resolve(MESSAGE_ATTACHMENT_ROOT);
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      await fsp.rmdir(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

function attachmentFromRow(row, conversationId) {
  if (!row?.message_attachment_id) return null;
  const attachmentId = Number(row.message_attachment_id);
  const base = `/messages/${Number(conversationId)}/attachments/${attachmentId}`;
  return {
    message_attachment_id: attachmentId,
    original_file_name: row.original_file_name,
    file_extension: row.file_extension || null,
    mime_type: row.mime_type,
    file_size_bytes: Number(row.file_size_bytes || 0),
    attachment_category: row.attachment_category,
    preview_url: base,
    download_url: `${base}?download=1`,
  };
}

function contentDispositionFileName(name) {
  const safe = safeOriginalFileName(name).replace(/["\\]/g, "_");
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_") || "arquivo";
  return {
    ascii,
    encoded: encodeURIComponent(safe),
  };
}

router.get("/unread-count", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });
    const pool = await getPool();
    const r = await pool.request().input("author_id", sql.Int, authorId).query(`
      SELECT COUNT_BIG(*) AS unread_count
      FROM dbo.identity_message
      WHERE receiver_author_id = @author_id AND read_at IS NULL;
    `);
    return res.json({ unread_count: Number(r.recordset?.[0]?.unread_count || 0) });
  } catch (err) { return fail(res, err); }
});

router.post("/read-all", authenticate, async (req, res) => {
  try {
    const me = getAuthorId(req);
    if (!me) return res.status(401).json({ error: "Não autenticado." });

    const pool = await getPool();
    const tx = pool.transaction();
    await tx.begin();

    try {
      const messagesResult = await tx
        .request()
        .input("author_id", sql.Int, me)
        .query(`
          UPDATE dbo.identity_message
          SET
            read_at = COALESCE(read_at, SYSUTCDATETIME()),
            status = 'read'
          WHERE receiver_author_id = @author_id
            AND read_at IS NULL;

          SELECT @@ROWCOUNT AS affected;
        `);

      await tx
        .request()
        .input("author_id", sql.Int, me)
        .query(`
          UPDATE dbo.identity_notification
          SET
            is_read = 1,
            read_at = COALESCE(read_at, SYSUTCDATETIME())
          WHERE author_id = @author_id
            AND type = 'message_received'
            AND is_read = 0;
        `);

      await tx.commit();

      return res.json({
        ok: true,
        affected: Number(messagesResult.recordset?.[0]?.affected || 0),
      });
    } catch (err) {
      try { await tx.rollback(); } catch {}
      throw err;
    }
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/connections", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });
    const pool = await getPool();
    const r = await pool.request().input("author_id", sql.Int, authorId).query(`
      SELECT a.author_id, a.author_code, a.full_name, a.name_public, a.avatar_url,
             c.conversation_id
      FROM dbo.identity_follow f1
      INNER JOIN dbo.identity_follow f2
        ON f2.follower_id = f1.followed_id
       AND f2.followed_id = f1.follower_id
      INNER JOIN dbo.identity_author a ON a.author_id = f1.followed_id
      LEFT JOIN dbo.identity_conversation c
        ON c.author_a_id = CASE WHEN @author_id < a.author_id THEN @author_id ELSE a.author_id END
       AND c.author_b_id = CASE WHEN @author_id < a.author_id THEN a.author_id ELSE @author_id END
      WHERE f1.follower_id = @author_id
      ORDER BY COALESCE(a.name_public, a.full_name, a.author_code);
    `);
    return res.json({ items: (r.recordset || []).map(row => ({
      author_id: Number(row.author_id),
      name: peerName(row),
      avatar_url: row.avatar_url || null,
      conversation_id: row.conversation_id ? Number(row.conversation_id) : null,
    })) });
  } catch (err) { return fail(res, err); }
});

router.get("/conversations", authenticate, async (req, res) => {
  try {
    const authorId = getAuthorId(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });
    const pool = await getPool();
    const r = await pool.request().input("author_id", sql.Int, authorId).query(`
      SELECT
        c.conversation_id,
        c.created_at,
        c.updated_at,
        c.last_message_at,
        peer.author_id AS peer_author_id,
        peer.author_code,
        peer.full_name,
        peer.name_public,
        peer.avatar_url,
        lm.message_id AS last_message_id,
        lm.content AS last_message,
        lm.created_at AS last_message_created_at,
        lm.sender_author_id AS last_sender_author_id,
        lm.attachment_file_name,
        unread.unread_count
      FROM dbo.identity_conversation c
      INNER JOIN dbo.identity_author peer
        ON peer.author_id = CASE WHEN c.author_a_id = @author_id THEN c.author_b_id ELSE c.author_a_id END
      OUTER APPLY (
        SELECT TOP 1
          m.message_id,
          m.content,
          m.created_at,
          m.sender_author_id,
          a.original_file_name AS attachment_file_name
        FROM dbo.identity_message m
        LEFT JOIN dbo.identity_message_attachment a
          ON a.message_id = m.message_id
         AND a.is_deleted = 0
        WHERE m.conversation_id = c.conversation_id
        ORDER BY m.created_at DESC, m.message_id DESC
      ) lm
      OUTER APPLY (
        SELECT COUNT_BIG(*) AS unread_count
        FROM dbo.identity_message um
        WHERE um.conversation_id = c.conversation_id
          AND um.receiver_author_id = @author_id
          AND um.read_at IS NULL
      ) unread
      WHERE c.author_a_id = @author_id OR c.author_b_id = @author_id
      ORDER BY COALESCE(c.last_message_at, c.updated_at, c.created_at) DESC, c.conversation_id DESC;
    `);

    return res.json({ items: (r.recordset || []).map(row => ({
      conversation_id: Number(row.conversation_id),
      peer: {
        author_id: Number(row.peer_author_id),
        name: peerName(row),
        avatar_url: row.avatar_url || null,
      },
      last_message:
        String(row.last_message || "").trim() ||
        (row.attachment_file_name ? `📎 ${row.attachment_file_name}` : null),
      last_message_at: row.last_message_created_at || row.last_message_at || row.updated_at || row.created_at,
      last_sender_author_id: row.last_sender_author_id ? Number(row.last_sender_author_id) : null,
      unread_count: Number(row.unread_count || 0),
    })) });
  } catch (err) { return fail(res, err); }
});

router.post("/with/:authorId", authenticate, async (req, res) => {
  try {
    const me = getAuthorId(req);
    const peer = Number(req.params.authorId);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    if (!Number.isInteger(peer) || peer <= 0) return res.status(400).json({ error: "Autor inválido." });
    const pool = await getPool();
    const c = await getOrCreateConversation(pool, me, peer);
    return res.status(201).json({ conversation_id: Number(c.conversation_id) });
  } catch (err) { return fail(res, err); }
});

router.get("/:conversationId/attachments/:attachmentId", authenticate, async (req, res) => {
  try {
    const me = getAuthorId(req);
    const conversationId = Number(req.params.conversationId);
    const attachmentId = Number(req.params.attachmentId);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: "Conversa inválida." });
    }
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      return res.status(400).json({ error: "Anexo inválido." });
    }

    const pool = await getPool();
    const c = await assertConversationMember(pool, conversationId, me);
    const peerId = Number(c.author_a_id) === me ? Number(c.author_b_id) : Number(c.author_a_id);
    await assertConnected(pool, me, peerId);

    const r = await pool
      .request()
      .input("conversation_id", sql.BigInt, conversationId)
      .input("attachment_id", sql.BigInt, attachmentId)
      .query(`
        SELECT TOP 1
          a.message_attachment_id,
          a.message_id,
          a.conversation_id,
          a.owner_author_id,
          a.original_file_name,
          a.file_extension,
          a.mime_type,
          a.file_size_bytes,
          a.attachment_category,
          a.storage_provider,
          a.storage_path
        FROM dbo.identity_message_attachment a
        INNER JOIN dbo.identity_message m
          ON m.message_id = a.message_id
         AND m.conversation_id = a.conversation_id
        WHERE a.message_attachment_id = @attachment_id
          AND a.conversation_id = @conversation_id
          AND a.is_deleted = 0;
      `);

    const attachment = r.recordset?.[0];
    if (!attachment) return res.status(404).json({ error: "Anexo não encontrado." });
    if (String(attachment.storage_provider) !== "local_private") {
      return res.status(501).json({ error: "Provider de storage do anexo ainda não suportado." });
    }

    const fullPath = resolvePrivateStoredPath(attachment.storage_path);
    let stat;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      return res.status(404).json({ error: "Arquivo físico do anexo não encontrado." });
    }
    if (!stat.isFile()) return res.status(404).json({ error: "Arquivo físico do anexo não encontrado." });

    const forceDownload = String(req.query?.download || "") === "1";
    const inlineAllowed = ["image", "pdf", "text"].includes(String(attachment.attachment_category));
    const disposition = forceDownload || !inlineAllowed ? "attachment" : "inline";
    const fileName = contentDispositionFileName(attachment.original_file_name);

    res.setHeader("Content-Type", String(attachment.mime_type));
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${fileName.ascii}"; filename*=UTF-8''${fileName.encoded}`
    );

    return fs.createReadStream(fullPath).pipe(res);
  } catch (err) { return fail(res, err); }
});

router.get("/:conversationId", authenticate, async (req, res) => {
  try {
    const me = getAuthorId(req);
    const id = Number(req.params.conversationId);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Conversa inválida." });
    const pool = await getPool();
    const c = await assertConversationMember(pool, id, me);
    const peerId = Number(c.author_a_id) === me ? Number(c.author_b_id) : Number(c.author_a_id);
    await assertConnected(pool, me, peerId);

    const peerR = await pool.request().input("peer", sql.Int, peerId).query(`
      SELECT TOP 1 author_id, author_code, full_name, name_public, avatar_url
      FROM dbo.identity_author WHERE author_id = @peer;
    `);
    const msgR = await pool.request().input("conversation_id", sql.BigInt, id).query(`
      SELECT
        m.message_id,
        m.conversation_id,
        m.sender_author_id,
        m.receiver_author_id,
        m.content,
        m.status,
        m.attachment_type,
        m.attachment_id,
        m.created_at,
        m.delivered_at,
        m.read_at,
        a.message_attachment_id,
        a.original_file_name,
        a.file_extension,
        a.mime_type,
        a.file_size_bytes,
        a.attachment_category
      FROM dbo.identity_message m
      LEFT JOIN dbo.identity_message_attachment a
        ON a.message_id = m.message_id
       AND a.is_deleted = 0
      WHERE m.conversation_id = @conversation_id
      ORDER BY m.created_at ASC, m.message_id ASC;
    `);
    const peer = peerR.recordset?.[0] || {};
    return res.json({
      me_author_id: me,
      conversation: { conversation_id: id, peer: { author_id: peerId, name: peerName(peer), avatar_url: peer.avatar_url || null } },
      messages: (msgR.recordset || []).map((m) => ({
        message_id: Number(m.message_id),
        conversation_id: Number(m.conversation_id),
        sender_author_id: Number(m.sender_author_id),
        receiver_author_id: Number(m.receiver_author_id),
        content: m.content,
        status: m.status,
        attachment_type: m.attachment_type,
        attachment_id: m.attachment_id == null ? null : Number(m.attachment_id),
        created_at: m.created_at,
        delivered_at: m.delivered_at,
        read_at: m.read_at,
        attachment: attachmentFromRow(m, id),
      })),
    });
  } catch (err) { return fail(res, err); }
});

router.post("/:conversationId/messages", authenticate, messageUploadSingle, async (req, res) => {
  let createdPhysicalPath = null;
  let tx = null;
  try {
    const me = getAuthorId(req);
    const id = Number(req.params.conversationId);
    const content = String(req.body?.content || "").trim();
    const attachment = req.file ? validateAttachmentFile(req.file) : null;

    if (!me) return res.status(401).json({ error: "Não autenticado." });
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Conversa inválida." });
    if (!content && !attachment) return res.status(400).json({ error: "Mensagem vazia." });
    if (content.length > 4000) return res.status(400).json({ error: "Mensagem excede 4000 caracteres." });

    const pool = await getPool();
    const c = await assertConversationMember(pool, id, me);
    const receiver = Number(c.author_a_id) === me ? Number(c.author_b_id) : Number(c.author_a_id);
    await assertConnected(pool, me, receiver);

    const userId = await resolveMessageUserId(pool, req, me);
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: "userId não encontrado para o autor autenticado.",
      });
    }

    const messagingCheck = await checkPlanFeature({
      pool,
      userId,
      featureCode: "MESSAGING",
      requestedValue: 1,
    });
    if (!messagingCheck.allowed) {
      return sendPlanDenied(res, messagingCheck, {
        status: 403,
        message: "Seu plano atual não permite o uso de Mensagens.",
      });
    }

    if (attachment) {
      const uploadCheck = await checkPlanFeature({
        pool,
        userId,
        featureCode: "UPLOAD_MAX_BYTES",
        requestedValue: attachment.sizeBytes,
      });
      if (!uploadCheck.allowed) {
        return sendPlanDenied(res, uploadCheck, {
          status: 413,
          message: "O arquivo excede o limite de upload do seu plano.",
        });
      }
    }

    tx = pool.transaction();
    await tx.begin();

    const r = await tx.request()
      .input("conversation_id", sql.BigInt, id)
      .input("sender", sql.Int, me)
      .input("receiver", sql.Int, receiver)
      .input("content", sql.NVarChar(4000), content)
      .query(`
        INSERT INTO dbo.identity_message
          (conversation_id, sender_author_id, receiver_author_id, content, status, attachment_type, created_at, delivered_at)
        OUTPUT inserted.*
        VALUES (@conversation_id, @sender, @receiver, @content, 'delivered', 'text', SYSUTCDATETIME(), SYSUTCDATETIME());
      `);

    const message = r.recordset[0];
    let persistedAttachment = null;

    if (attachment) {
      const attachmentInsert = await tx
        .request()
        .input("message_id", sql.BigInt, Number(message.message_id))
        .input("conversation_id", sql.BigInt, id)
        .input("owner_author_id", sql.Int, me)
        .input("original_file_name", sql.NVarChar(520), attachment.originalFileName)
        .input("file_extension", sql.VarChar(20), attachment.fileExtension)
        .input("mime_type", sql.VarChar(150), attachment.mimeType)
        .input("file_size_bytes", sql.BigInt, attachment.sizeBytes)
        .input("file_sha256", sql.Char(64), attachment.sha256)
        .input("attachment_category", sql.VarChar(30), attachment.category)
        .input("storage_provider", sql.VarChar(30), "local_private")
        .input("storage_path", sql.NVarChar(1000), "PENDING")
        .query(`
          INSERT INTO dbo.identity_message_attachment
          (
            message_id,
            conversation_id,
            owner_author_id,
            original_file_name,
            file_extension,
            mime_type,
            file_size_bytes,
            file_sha256,
            attachment_category,
            storage_provider,
            storage_path
          )
          OUTPUT inserted.message_attachment_id
          VALUES
          (
            @message_id,
            @conversation_id,
            @owner_author_id,
            @original_file_name,
            @file_extension,
            @mime_type,
            @file_size_bytes,
            @file_sha256,
            @attachment_category,
            @storage_provider,
            @storage_path
          );
        `);

      const attachmentId = Number(attachmentInsert.recordset?.[0]?.message_attachment_id);
      const relativePath = attachmentRelativePath({
        ownerAuthorId: me,
        conversationId: id,
        messageId: Number(message.message_id),
        attachmentId,
        extension: attachment.fileExtension,
      });
      createdPhysicalPath = resolvePrivateStoredPath(relativePath);
      await fsp.mkdir(path.dirname(createdPhysicalPath), { recursive: true });
      await fsp.writeFile(createdPhysicalPath, attachment.buffer, { flag: "wx" });

      await tx
        .request()
        .input("message_attachment_id", sql.BigInt, attachmentId)
        .input("storage_path", sql.NVarChar(1000), relativePath)
        .query(`
          UPDATE dbo.identity_message_attachment
          SET storage_path = @storage_path,
              updated_at = SYSUTCDATETIME()
          WHERE message_attachment_id = @message_attachment_id;
        `);

      persistedAttachment = {
        message_attachment_id: attachmentId,
        original_file_name: attachment.originalFileName,
        file_extension: attachment.fileExtension,
        mime_type: attachment.mimeType,
        file_size_bytes: attachment.sizeBytes,
        attachment_category: attachment.category,
      };
    }

    await tx.request().input("conversation_id", sql.BigInt, id).query(`
      UPDATE dbo.identity_conversation
      SET updated_at = SYSUTCDATETIME(), last_message_at = SYSUTCDATETIME()
      WHERE conversation_id = @conversation_id;
    `);

    const notificationPreview =
      content.slice(0, 300) ||
      (attachment ? `📎 ${attachment.originalFileName}`.slice(0, 300) : "Nova mensagem");
    await createMessageNotification(
      tx,
      receiver,
      me,
      id,
      Number(message.message_id),
      notificationPreview
    );

    await tx.commit();
    tx = null;

    return res.status(201).json({
      message: {
        ...message,
        message_id: Number(message.message_id),
        conversation_id: Number(message.conversation_id),
        sender_author_id: Number(message.sender_author_id),
        receiver_author_id: Number(message.receiver_author_id),
        attachment: persistedAttachment
          ? attachmentFromRow(persistedAttachment, id)
          : null,
      },
    });
  } catch (err) {
    if (tx) {
      try { await tx.rollback(); } catch {}
    }
    await removeCreatedAttachmentFile(createdPhysicalPath);
    return fail(res, err);
  }
});

router.post("/:conversationId/read", authenticate, async (req, res) => {
  try {
    const me = getAuthorId(req);
    const id = Number(req.params.conversationId);
    if (!me) return res.status(401).json({ error: "Não autenticado." });
    const pool = await getPool();
    await assertConversationMember(pool, id, me);
    const r = await pool.request().input("conversation_id", sql.BigInt, id).input("author_id", sql.Int, me).query(`
      UPDATE dbo.identity_message
      SET read_at = COALESCE(read_at, SYSUTCDATETIME()), status = 'read'
      WHERE conversation_id = @conversation_id
        AND receiver_author_id = @author_id
        AND read_at IS NULL;
      SELECT @@ROWCOUNT AS affected;
    `);
    await pool.request().input("author_id", sql.Int, me).input("conversation_id", sql.BigInt, id).query(`
      UPDATE dbo.identity_notification
      SET is_read = 1, read_at = COALESCE(read_at, SYSUTCDATETIME())
      WHERE author_id = @author_id
        AND type = 'message_received'
        AND is_read = 0
        AND TRY_CONVERT(BIGINT, JSON_VALUE(payload_json, '$.conversation_id')) = @conversation_id;
    `);
    return res.json({ ok: true, affected: Number(r.recordset?.[0]?.affected || 0) });
  } catch (err) { return fail(res, err); }
});

export default router;
