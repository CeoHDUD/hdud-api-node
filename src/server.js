// C:\HDUD_DATA\hdud-api-node\src\server.js

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import fsp from "fs/promises";

let helmet = null;
try {
  const mod = await import("helmet");
  helmet = mod?.default || null;
} catch {}

let multer = null;
try {
  const mod = await import("multer");
  multer = mod?.default || null;
} catch {}

import authRouter from "./routes/auth.js";
import memoryRouter from "./routes/memory.js";
import memoriesRouter from "./routes/memories.js";
import authorsRouter from "./routes/authors.js";
import chaptersRouter from "./routes/chapters.js";

import { authenticate } from "./middleware/auth.js";
import { getPool, sql } from "./db.js";

const PORT = process.env.PORT || 4000;

// versão do serviço (override via env se quiser)
const SERVICE_VERSION =
  process.env.HDUD_API_VERSION ||
  process.env.npm_package_version ||
  "HDUD-API-Node v0.6";

const app = express();

/**
 * FIX DEFINITIVO (sem dependência externa):
 * - Helmet pode setar CORP= same-origin no fim
 * - express.static setHeaders pode NÃO vencer dependendo da ordem interna
 *
 * Então nós "hookamos" res.writeHead e garantimos o header final para /cdn.
 */
function forceHeadersOnWriteHead(res, fn) {
  const origWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    try {
      fn();
    } catch {}
    return origWriteHead.apply(this, args);
  };
}

// =======================
// PUBLIC DIR (FIX DEFINITIVO DO /cdn)
// =======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/server.js -> ../public
const PUBLIC_DIR = path.resolve(__dirname, "../public");

// CDN local avatar dir (estrutura tipo S3 local)
const AVATARS_DIR = path.join(PUBLIC_DIR, "avatars");

// =======================
// CORS (para chamadas fetch/XHR)
// =======================
app.use(cors({ origin: "*" }));

// =======================
// GARANTIA FINAL DE HEADERS PARA /cdn/*
// =======================
app.use((req, res, next) => {
  if (req.path.startsWith("/cdn")) {
    forceHeadersOnWriteHead(res, () => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    });
  }
  next();
});

// =======================
// Helmet (produção)
// =======================
if (helmet) {
  const helmetMw = helmet({
    contentSecurityPolicy: false,
  });

  app.use((req, res, next) => {
    if (req.path.startsWith("/cdn")) return next();
    return helmetMw(req, res, next);
  });
}

// força UTF-8 (API 100% JSON) — não aplicar em /cdn
app.use((req, res, next) => {
  if (req.path.startsWith("/cdn")) return next();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

app.use(express.json({ limit: "1mb" }));

// =======================
// ROUTES BASE (DX)
// =======================
app.get("/", (_req, res) => {
  return res.json({
    ok: true,
    service: "hdud-api",
    version: SERVICE_VERSION,
    time: new Date().toISOString(),
    routes: [
      "/auth",
      "/memory",
      "/memories (via /)",
      "/authors",
      "/chapters",
      "/api/chapters",
      "/feed",
      "/timeline",
      "/profile (PUT) [legacy]",
      "/me/profile (GET,PUT) [PROFILE_v1]",
      "/me/avatar (POST multipart) [PROFILE_v1]",
      "/authors/:id/profile (GET) [PROFILE_v1]",
      "/cdn/avatars/:authorId/avatar (canônico, sem extensão)",
      "/cdn/* (static) [MVP CDN local]",
      "/health",
    ],
  });
});

// Health: check real do banco
app.get("/health", async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query("SELECT 1 AS ok;");

    return res.json({
      status: "ok",
      db: "connected",
      version: SERVICE_VERSION,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      status: "degraded",
      db: "disconnected",
      version: SERVICE_VERSION,
      time: new Date().toISOString(),
      detail: err?.message || "DB check failed",
    });
  }
});

// =======================
// ROTAS
// =======================
app.use("/auth", authRouter);

// ✅ Capítulos — contrato oficial
app.use("/chapters", chaptersRouter);
app.use("/api/chapters", chaptersRouter); // alias para frontend

app.use("/memory", memoryRouter);
app.use("/", memoriesRouter);
app.use("/authors", authorsRouter);

// =======================
// HELPERS (CORE)
// =======================
function safeDateMs(value) {
  if (!value) return null;
  const d1 = new Date(value);
  if (!isNaN(d1.getTime())) return d1.getTime();
  const d2 = new Date(String(value).replace(" ", "T"));
  if (!isNaN(d2.getTime())) return d2.getTime();
  return null;
}

function normalizeText(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function normalizeIsoOrNow(value) {
  const ms = safeDateMs(value);
  if (typeof ms === "number") return new Date(ms).toISOString();
  return new Date().toISOString();
}

function mkNav(kind, id, extra) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return "/";

  const k = String(kind || "").toLowerCase();

  if (k === "memory") return `/memories/${n}`;
  if (k === "chapter") return `/chapters/${n}`;

  if (k === "version") {
    const v = extra?.version_number ?? extra?.version ?? null;
    return v != null ? `/memories/${n}?version=${Number(v)}` : `/memories/${n}`;
  }

  return "/";
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const i = Math.trunc(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeNullableString(v, maxLen = 200) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function makePreview(text, maxLen = 120) {
  const s = normalizeText(text, "");
  if (!s) return null;
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

// =======================
// PROFILE_v1 (MVP) — Trilho Perfil (sem tocar core)
// =======================
function normalizeNullableStringStrict(v, maxLen, fieldName) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return { ok: true, value: null };
    return { ok: true, value: s.slice(0, maxLen) };
  }
  return {
    ok: false,
    error: `Campo '${fieldName}' inválido (esperado string ou null).`,
  };
}

function getAuthorIdFromToken(req) {
  const authorId = Number(req.user?.author_id);
  if (!Number.isInteger(authorId) || authorId <= 0) return null;
  return authorId;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function guessExtFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  return null;
}

function authorAvatarFolder(authorId) {
  return path.join(AVATARS_DIR, `author_${authorId}`);
}

async function removeExistingAvatarFiles(authorId) {
  try {
    const dir = authorAvatarFolder(authorId);
    await ensureDir(dir);
    const files = await fsp.readdir(dir);

    // remove canônico e legado
    const toDelete = files.filter((f) => {
      const s = String(f || "");
      if (/^avatar\.(jpg|jpeg|png|webp)$/i.test(s)) return true;          // avatar.jpg
      if (new RegExp(`^avatar_${authorId}\\.(jpg|jpeg|png|webp)$`, "i").test(s)) return true; // avatar_1.jpg
      return false;
    });

    for (const f of toDelete) {
      try {
        await fsp.unlink(path.join(dir, f));
      } catch {}
    }
  } catch {}
}

async function findExistingAvatarFile(authorId) {
  try {
    const dir = authorAvatarFolder(authorId);
    const files = await fsp.readdir(dir);

    // prefer canônico
    const canon = files.find((x) => /^avatar\.(jpg|jpeg|png|webp)$/i.test(x));
    if (canon) return path.join(dir, canon);

    // fallback legado: avatar_<id>.ext
    const legacy = files.find((x) =>
      new RegExp(`^avatar_${authorId}\\.(jpg|jpeg|png|webp)$`, "i").test(x)
    );
    return legacy ? path.join(dir, legacy) : null;
  } catch {
    return null;
  }
}

// =======================
// CDN AVATAR CANÔNICO (SEM EXTENSÃO)
// GET /cdn/avatars/:authorId/avatar
// ⚠️ IMPORTANTE: ESTA ROTA PRECISA VIR ANTES DO express.static("/cdn", ...)
// =======================
app.get("/cdn/avatars/:authorId/avatar", async (req, res) => {
  const authorId = Number(req.params.authorId);
  if (!Number.isInteger(authorId) || authorId <= 0) {
    return res.status(400).json({ error: "author_id inválido" });
  }

  const p = await findExistingAvatarFile(authorId);
  if (!p) return res.status(404).end();

  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  return res.sendFile(p);
});

// =======================
// CDN LOCAL (MVP) — /cdn/*  (STATIC)
// Serve arquivos estáticos em /public
// =======================
app.use(
  "/cdn",
  express.static(PUBLIC_DIR, {
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

/**
 * GET /authors/:id/profile (público)
 */
app.get("/authors/:id/profile", async (req, res, next) => {
  try {
    const authorId = Number(req.params.id);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(400).json({ error: "author_id inválido" });
    }

    const pool = await getPool();
    const r = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT TOP 1
          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url
        FROM dbo.identity_author a
        WHERE a.author_id = @author_id;
      `);

    const row = r.recordset?.[0];
    if (!row) return res.status(404).json({ error: "Author não encontrado" });

    const fallbackName =
      (row.name_public && String(row.name_public).trim()) ||
      (row.full_name && String(row.full_name).trim()) ||
      (row.author_code && String(row.author_code).trim()) ||
      null;

    return res.json({
      author_id: Number(row.author_id),
      name_public: fallbackName,
      bio_short: row.bio_short != null ? String(row.bio_short) : null,
      location: row.location != null ? String(row.location) : null,
      avatar_url: row.avatar_url != null ? String(row.avatar_url) : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /me/profile (self)
 */
app.get("/me/profile", authenticate, async (req, res, next) => {
  try {
    const authorId = getAuthorIdFromToken(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });

    const pool = await getPool();

    const userId = req.user?.sub;
    const userR = await pool
      .request()
      .input("user_id", sql.BigInt, userId)
      .query(`
        SELECT TOP 1 user_id, email, author_id
        FROM dbo.identity_user
        WHERE user_id = @user_id;
      `);

    const userRow = userR.recordset?.[0];
    const email = userRow?.email ? String(userRow.email) : null;

    const r = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT TOP 1
          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url
        FROM dbo.identity_author a
        WHERE a.author_id = @author_id;
      `);

    const row = r.recordset?.[0];
    if (!row) return res.status(404).json({ error: "Author não encontrado" });

    const fallbackName =
      (row.name_public && String(row.name_public).trim()) ||
      (row.full_name && String(row.full_name).trim()) ||
      (row.author_code && String(row.author_code).trim()) ||
      null;

    return res.json({
      author_id: Number(row.author_id),
      email,
      name_public: fallbackName,
      bio_short: row.bio_short != null ? String(row.bio_short) : null,
      location: row.location != null ? String(row.location) : null,
      avatar_url: row.avatar_url != null ? String(row.avatar_url) : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /me/profile (self)
 * ✅ NÃO aceita avatar_url (avatar é gerenciado via upload/backend)
 */
app.put("/me/profile", authenticate, async (req, res, next) => {
  try {
    const authorId = getAuthorIdFromToken(req);
    if (!authorId) return res.status(401).json({ error: "Não autenticado." });

    const a = normalizeNullableStringStrict(req.body?.name_public, 120, "name_public");
    const b = normalizeNullableStringStrict(req.body?.bio_short, 280, "bio_short");
    const l = normalizeNullableStringStrict(req.body?.location, 120, "location");

    if (!a.ok) return res.status(400).json({ error: "Payload inválido", detail: a.error });
    if (!b.ok) return res.status(400).json({ error: "Payload inválido", detail: b.error });
    if (!l.ok) return res.status(400).json({ error: "Payload inválido", detail: l.error });

    const nothing = a.value === undefined && b.value === undefined && l.value === undefined;

    if (nothing) {
      return res.status(400).json({
        error: "Nenhum campo enviado.",
        detail: "Envie ao menos um: name_public, bio_short, location (podem ser null).",
      });
    }

    const pool = await getPool();

    const r = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("has_name_public", sql.Bit, a.value !== undefined ? 1 : 0)
      .input("name_public", sql.NVarChar(120), a.value === undefined ? null : a.value)
      .input("has_bio_short", sql.Bit, b.value !== undefined ? 1 : 0)
      .input("bio_short", sql.NVarChar(280), b.value === undefined ? null : b.value)
      .input("has_location", sql.Bit, l.value !== undefined ? 1 : 0)
      .input("location", sql.NVarChar(120), l.value === undefined ? null : l.value)
      .query(`
        UPDATE a
        SET
          name_public = CASE WHEN @has_name_public = 1 THEN @name_public ELSE a.name_public END,
          bio_short   = CASE WHEN @has_bio_short   = 1 THEN @bio_short   ELSE a.bio_short   END,
          location    = CASE WHEN @has_location    = 1 THEN @location    ELSE a.location    END,
          updated_at  = SYSUTCDATETIME()
        FROM dbo.identity_author a
        WHERE a.author_id = @author_id;

        IF (@@ROWCOUNT = 0)
        BEGIN
          SELECT 0 AS ok;
          RETURN;
        END

        SELECT TOP 1
          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url
        FROM dbo.identity_author a
        WHERE a.author_id = @author_id;
      `);

    const row = r.recordset?.[0];
    if (!row) return res.status(404).json({ error: "Author não encontrado" });

    const fallbackName =
      (row.name_public && String(row.name_public).trim()) ||
      (row.full_name && String(row.full_name).trim()) ||
      (row.author_code && String(row.author_code).trim()) ||
      null;

    return res.json({
      ok: true,
      author_id: authorId,
      profile: {
        name_public: fallbackName,
        bio_short: row.bio_short != null ? String(row.bio_short) : null,
        location: row.location != null ? String(row.location) : null,
        avatar_url: row.avatar_url != null ? String(row.avatar_url) : null,
      },
      meta: { updated_at: new Date().toISOString() },
    });
  } catch (err) {
    return next(err);
  }
});

// =======================
// AVATAR UPLOAD (PROFILE_v1)
// POST /me/avatar  (multipart/form-data, field: "file")
// - salva em /public/avatars/author_<id>/avatar.<ext>
// - atualiza dbo.identity_author.avatar_url = /cdn/avatars/<id>/avatar?v=<ts>
// =======================
if (multer) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
    fileFilter: (_req, file, cb) => {
      const ext = guessExtFromMime(file?.mimetype);
      if (!ext) return cb(new Error("Formato inválido. Use JPG, PNG ou WEBP."));
      return cb(null, true);
    },
  });

  app.post("/me/avatar", authenticate, upload.single("file"), async (req, res, next) => {
    try {
      const authorId = getAuthorIdFromToken(req);
      if (!authorId) return res.status(401).json({ error: "Não autenticado." });

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          error: "Arquivo ausente.",
          detail: 'Envie multipart/form-data com campo "file".',
        });
      }

      const ext = guessExtFromMime(req.file.mimetype);
      if (!ext) {
        return res.status(415).json({
          error: "Formato inválido.",
          detail: "Use JPG, PNG ou WEBP.",
        });
      }

      const dir = authorAvatarFolder(authorId);
      await ensureDir(dir);

      await removeExistingAvatarFiles(authorId);

      // ✅ canônico
      const filename = `avatar.${ext}`;
      const outPath = path.join(dir, filename);

      await fsp.writeFile(outPath, req.file.buffer);

      if (!fs.existsSync(outPath)) {
        return res.status(500).json({ error: "Falha ao salvar avatar." });
      }

      const v = Date.now();
      const avatarUrl = `/cdn/avatars/${authorId}/avatar?v=${v}`;

      const pool = await getPool();
      await pool
        .request()
        .input("author_id", sql.Int, authorId)
        .input("avatar_url", sql.NVarChar(400), avatarUrl)
        .query(`
          UPDATE dbo.identity_author
          SET avatar_url = @avatar_url,
              updated_at = SYSUTCDATETIME()
          WHERE author_id = @author_id;
        `);

      return res.json({
        ok: true,
        author_id: authorId,
        avatar_url: avatarUrl,
        meta: { saved_at: new Date().toISOString() },
      });
    } catch (err) {
      return next(err);
    }
  });
} else {
  app.post("/me/avatar", authenticate, (_req, res) => {
    return res.status(501).json({
      error: "Upload não habilitado.",
      detail:
        "Dependência 'multer' não encontrada. Instale 'multer' no hdud-api-node para habilitar /me/avatar.",
    });
  });
}

// =======================
// PROFILE (LEGACY CORE) — mantém como está
// =======================
app.put("/profile", authenticate, async (req, res, next) => {
  try {
    const authorId = Number(req.user?.author_id);
    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const displayName = normalizeNullableString(req.body?.display_name, 200);
    const preferredLanguage = normalizeNullableString(req.body?.preferred_language, 20);

    if (
      preferredLanguage !== undefined &&
      preferredLanguage !== null &&
      !/^[a-z]{2}(-[A-Z]{2})?$/.test(preferredLanguage)
    ) {
      return res.status(422).json({ error: "preferred_language inválido (ex.: pt-BR, en-US)." });
    }

    if (displayName === undefined && preferredLanguage === undefined) {
      return res.status(400).json({
        error: "Nenhum campo enviado. Use display_name e/ou preferred_language (podem ser null).",
      });
    }

    const pool = await getPool();

    const r = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .input("display_name", sql.NVarChar(200), displayName ?? null)
      .input("preferred_language", sql.NVarChar(20), preferredLanguage ?? null)
      .query(`
        UPDATE p
        SET
          display_name = COALESCE(@display_name, p.display_name),
          preferred_language = COALESCE(@preferred_language, p.preferred_language)
        FROM dbo.identity_profile p
        WHERE p.author_id = @author_id;

        IF (@@ROWCOUNT = 0)
        BEGIN
          INSERT INTO dbo.identity_profile (author_id, display_name, preferred_language)
          VALUES (@author_id, @display_name, @preferred_language);
        END

        SELECT TOP 1
          a.author_id,
          a.author_code,
          p.display_name,
          p.preferred_language
        FROM dbo.identity_author a
        LEFT JOIN dbo.identity_profile p
          ON p.author_id = a.author_id
        WHERE a.author_id = @author_id;
      `);

    const row = r.recordset?.[0] || null;

    const authorCode = row?.author_code ? String(row.author_code) : null;
    const displayNameOut = row?.display_name ? String(row.display_name) : null;

    return res.json({
      profile: {
        author_id: authorId,
        author_code: authorCode,
        display_name: displayNameOut || authorCode || null,
        preferred_language: row?.preferred_language ? String(row.preferred_language) : null,
      },
      meta: { updated_at: new Date().toISOString() },
    });
  } catch (err) {
    return next(err);
  }
});

// =======================
// FEED (CORE)
// =======================
function compareFeedDescDeterministic(a, b) {
  const da = safeDateMs(a?.date) ?? -Infinity;
  const db = safeDateMs(b?.date) ?? -Infinity;

  if (da !== db) return db - da;

  const order = { chapter: 0, memory: 1 };
  const ta = order[a?.type] ?? 99;
  const tb = order[b?.type] ?? 99;
  if (ta !== tb) return ta - tb;

  const sa = String(a?.source_id ?? "");
  const sb = String(b?.source_id ?? "");
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

app.get("/feed", authenticate, async (req, res, next) => {
  try {
    const authorIdRaw = req.user?.author_id;
    const authorId = Number(authorIdRaw);

    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const limit = clampInt(req.query?.limit, 1, 50, 20);

    const pool = await getPool();

    const profR = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT TOP 1
          a.author_id,
          a.author_code,
          p.display_name,
          p.preferred_language
        FROM dbo.identity_author a
        LEFT JOIN dbo.identity_profile p
          ON p.author_id = a.author_id
        WHERE a.author_id = @author_id;
      `);

    const pr = profR.recordset?.[0] || null;

    const authorCode = pr?.author_code ? String(pr.author_code) : null;
    const displayNameRaw = pr?.display_name ? String(pr.display_name) : null;

    const profile = {
      author_id: authorId,
      author_code: authorCode,
      display_name: displayNameRaw || authorCode || null,
      preferred_language: pr?.preferred_language ? String(pr.preferred_language) : null,
    };

    const memR = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          m.memory_id,
          m.title,
          m.content,
          m.created_at AS memory_created_at,
          v.last_version_at,
          p.phase_code AS life_phase,
          mc.chapter_id
        FROM dbo.identity_memory m
        LEFT JOIN dbo.identity_memory_chapter mc
          ON mc.memory_id = m.memory_id
        LEFT JOIN dbo.identity_phase p
          ON p.phase_id = m.phase_id
        OUTER APPLY (
          SELECT TOP 1 created_at AS last_version_at
          FROM dbo.identity_memory_versions vv
          WHERE vv.memory_id = m.memory_id
          ORDER BY vv.version_number DESC, vv.created_at DESC
        ) v
        WHERE m.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0;
      `);

    const memories = (memR.recordset || []).map((m) => {
      const memoryId = Number(m.memory_id);
      const title = normalizeText(m.title, "(Memória sem título)");

      const a1 = safeDateMs(m.memory_created_at);
      const a2 = safeDateMs(m.last_version_at);
      const bestMs =
        typeof a1 === "number" && typeof a2 === "number"
          ? Math.max(a1, a2)
          : typeof a2 === "number"
          ? a2
          : typeof a1 === "number"
          ? a1
          : Date.now();

      const activityAtIso = new Date(bestMs).toISOString();

      const preview = makePreview(m.content, 120);
      const phaseCode = m.life_phase ? String(m.life_phase) : null;
      const chapterId = m.chapter_id != null ? Number(m.chapter_id) : null;

      return {
        type: "memory",
        title,
        date: activityAtIso,
        source_id: String(memoryId),
        meta: {
          nav: mkNav("memory", memoryId),
          date_source: "activity_at",
          activity_at: activityAtIso,
          preview: preview || undefined,
          phase_code: phaseCode || undefined,
          chapter_id: Number.isInteger(chapterId) ? chapterId : undefined,
        },
      };
    });

    const chapR = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          c.chapter_id,
          c.title,
          c.description,
          c.created_at,
          c.updated_at,
          c.published_at,
          c.status
        FROM dbo.identity_chapter c
        WHERE c.author_id = @author_id
          AND ISNULL(c.is_deleted, 0) = 0;
      `);

    const chapters = (chapR.recordset || []).map((c) => {
      const chapterId = Number(c.chapter_id);
      const title = normalizeText(c.title, "(Capítulo sem título)");

      const activityIso = normalizeIsoOrNow(c.published_at ?? c.updated_at ?? c.created_at);

      const description = normalizeText(c.description, "");
      const descriptionPreview = makePreview(description, 140);

      return {
        type: "chapter",
        title,
        date: activityIso,
        source_id: String(chapterId),
        meta: {
          nav: mkNav("chapter", chapterId),
          date_source: "activity_at",
          activity_at: activityIso,
          status: c.status ?? null,
          description: descriptionPreview || undefined,
        },
      };
    });

    const allItems = [...chapters, ...memories].sort(compareFeedDescDeterministic);
    const items = allItems.slice(0, limit);

    return res.json({
      profile,
      items,
      meta: {
        generated_at: new Date().toISOString(),
        limit,
        summary: { counts: { memories: memories.length, chapters: chapters.length } },
      },
    });
  } catch (err) {
    return next(err);
  }
});

// =======================
// TIMELINE (CORE)
// =======================
function compareAscDeterministic(a, b) {
  const da = safeDateMs(a?.date) ?? -Infinity;
  const db = safeDateMs(b?.date) ?? -Infinity;

  if (da !== db) return da - db;

  const sa = String(a?.source_id ?? "");
  const sb = String(b?.source_id ?? "");
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

app.get("/timeline", authenticate, async (req, res, next) => {
  try {
    const authorIdRaw = req.user?.author_id;
    const authorId = Number(authorIdRaw);

    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const pool = await getPool();

    const memResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          m.memory_id,
          m.author_id,
          m.title,
          m.created_at,
          m.version_number,
          m.is_deleted
        FROM dbo.identity_memory m
        WHERE m.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0;
      `);

    const memories = (memResult.recordset || []).map((m) => {
      const memoryId = Number(m.memory_id);
      const title = normalizeText(m.title, "(Memória sem título)");
      const date = normalizeIsoOrNow(m.created_at);

      return {
        type: "memory",
        title,
        date,
        source_id: String(memoryId),
        meta: {
          nav: mkNav("memory", memoryId),
          date_source: "created_at",
          memory_id: memoryId,
          current_version: m.version_number ?? null,
        },
      };
    });

    const chapResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          c.chapter_id,
          c.author_id,
          c.title,
          c.created_at,
          c.updated_at,
          c.published_at,
          c.status,
          ISNULL(c.is_deleted, 0) AS is_deleted
        FROM dbo.identity_chapter c
        WHERE c.author_id = @author_id
          AND ISNULL(c.is_deleted, 0) = 0;
      `);

    const chapters = (chapResult.recordset || []).map((c) => {
      const chapterId = Number(c.chapter_id);
      const title = normalizeText(c.title, "(Capítulo sem título)");
      const date = normalizeIsoOrNow(c.created_at);

      return {
        type: "chapter",
        title,
        date,
        source_id: String(chapterId),
        meta: {
          nav: mkNav("chapter", chapterId),
          date_source: "created_at",
          chapter_id: chapterId,
          status: c.status ?? null,
          published_at: c.published_at ?? null,
        },
      };
    });

    const verResult = await pool
      .request()
      .input("author_id", sql.Int, authorId)
      .query(`
        SELECT
          v.memory_id,
          v.version_number,
          v.title,
          v.created_at,
          m.title AS memory_title
        FROM dbo.identity_memory_versions v
        INNER JOIN dbo.identity_memory m
          ON m.memory_id = v.memory_id
        WHERE m.author_id = @author_id
          AND ISNULL(m.is_deleted, 0) = 0;
      `);

    const versions = (verResult.recordset || []).map((v) => {
      const memoryId = Number(v.memory_id);
      const versionNumber = Number(v.version_number);

      const baseTitle = normalizeText(v.memory_title, "(Memória sem título)");
      const titleSnap = normalizeText(v.title, "");
      const title =
        titleSnap && titleSnap !== baseTitle
          ? `Versão ${versionNumber} — ${titleSnap}`
          : `Versão ${versionNumber} — ${baseTitle}`;

      const date = normalizeIsoOrNow(v.created_at);
      const sourceId = `${memoryId}:${versionNumber}`;

      return {
        type: "version",
        title,
        date,
        source_id: sourceId,
        meta: {
          nav: mkNav("version", memoryId, { version_number: versionNumber }),
          date_source: "version.created_at",
          memory_id: memoryId,
          version_number: versionNumber,
        },
      };
    });

    const events = [...memories, ...chapters, ...versions].sort(compareAscDeterministic);

    return res.json({
      items: events,
      meta: {
        author_id: authorId,
        generated_at: new Date().toISOString(),
        sources: { memories: true, chapters: true, versions: true, ledger: false },
      },
    });
  } catch (err) {
    return next(err);
  }
});

// =======================
// LOG
// =======================
console.log("[ROUTE] OK /auth");
console.log("[ROUTE] OK /chapters");
console.log("[ROUTE] OK /api/chapters");
console.log("[ROUTE] OK /memory");
console.log("[ROUTE] OK /");
console.log("[ROUTE] OK /authors");
console.log("[ROUTE] OK /timeline");
console.log("[ROUTE] OK /feed");
console.log("[ROUTE] OK /profile (PUT) [legacy]");
console.log("[ROUTE] OK /me/profile (GET,PUT) [PROFILE_v1]");
console.log("[ROUTE] OK /me/avatar (POST multipart) [PROFILE_v1]");
console.log("[ROUTE] OK /authors/:id/profile (GET) [PROFILE_v1]");
console.log("[ROUTE] OK /cdn/avatars/:authorId/avatar (canônico, sem extensão)");
console.log("[ROUTE] OK /cdn/* (static) [MVP CDN local]");
console.log("[ROUTE] OK /health");
console.log("[ROUTE] OK / (root)");

// Error handler
app.use((err, _req, res, _next) => {
  const status =
    err?.statusCode ||
    err?.status ||
    (err?.type === "entity.parse.failed" ? 400 : 500);

  console.error(status >= 500 ? "[FATAL]" : "[WARN]", err);

  res.status(status).json({
    error: status >= 500 ? "Internal Server Error" : "Bad Request",
    detail: err?.message,
  });
});

console.log("[BOOT] server file:", __filename);
console.log("[BOOT] PUBLIC_DIR:", PUBLIC_DIR);
console.log("[BOOT] AVATARS_DIR:", AVATARS_DIR);
console.log("[BOOT] has CDN avatar route:", typeof app._router?.stack?.find?.(r => r?.route?.path === "/cdn/avatars/:authorId/avatar") !== "undefined");



// LISTEN (Docker-safe)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HDUD API listening on :${PORT}`);
});
