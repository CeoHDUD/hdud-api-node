// C:\HDUD_DATA\hdud-api-node\src\server.js

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import fsp from "fs/promises";
import meRouter from "./routes/me.js";
import plansRouter from "./routes/plans.js";
import feedRouter from "./routes/feed.js";

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

let sharp = null;
try {
  const mod = await import("sharp");
  sharp = mod?.default || mod || null;
} catch {}

import authRouter from "./routes/auth.js";
import memoryRouter from "./routes/memory.js";
import memoriesRouter from "./routes/memories.js";
import authorsRouter from "./routes/authors.js";
import chaptersRouter from "./routes/chapters.js";
import timelineRouter from "./routes/timeline.js";
import networkRouter from "./routes/network.js";

import { authenticate } from "./middleware/auth.js";
import { getPool, sql } from "./db.js";

const PORT = process.env.PORT || 4000;

const SERVICE_VERSION =
  process.env.HDUD_API_VERSION ||
  process.env.npm_package_version ||
  "HDUD-API-Node v0.6";

const app = express();

function forceHeadersOnWriteHead(res, fn) {
  const origWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    try {
      fn();
    } catch {}
    return origWriteHead.apply(this, args);
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const AVATARS_DIR = path.join(PUBLIC_DIR, "avatars");
const MEMORIES_DIR = path.join(PUBLIC_DIR, "memories");
const MEMORY_MEDIA_DIR = path.join(PUBLIC_DIR, "memory-media");

app.use(cors({ origin: "*" }));

app.use((req, res, next) => {
  if (req.path.startsWith("/cdn")) {
    forceHeadersOnWriteHead(res, () => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    });
  }
  next();
});

if (helmet) {
  const helmetMw = helmet({
    contentSecurityPolicy: false,
  });

  app.use((req, res, next) => {
    if (req.path.startsWith("/cdn")) return next();
    return helmetMw(req, res, next);
  });
}

app.use((req, res, next) => {
  if (req.path.startsWith("/cdn")) return next();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

app.use(express.json({ limit: "4mb" }));

app.get("/", (_req, res) => {
  return res.json({
    ok: true,
    service: "hdud-api",
    version: SERVICE_VERSION,
    time: new Date().toISOString(),
    routes: [
      "/auth",
      "/api/auth",
      "/memory",
      "/memory/:id/audio (GET, POST multipart) [MEMORY_AUDIO_v1]",
      "/memory/:id/audio/:mediaId (GET) [MEMORY_AUDIO_v1]",
      "/memory/:id/audio/:mediaId/transcribe (POST) [MEMORY_AUDIO_v1]",
      "/memory/:id/audio/:mediaId/validate (PUT) [MEMORY_AUDIO_v1]",
      "/memory/:id/audio/:mediaId/refine (POST) [MEMORY_AUDIO_v1]",
      "/memory/:id/audio/:mediaId/apply (POST) [MEMORY_AUDIO_v1]",
      "/memories (via /)",
      "/authors",
      "/chapters",
      "/api/chapters",
      "/feed",
      "/api/feed (alias)",
      "/timeline",
      "/api/timeline (alias)",
      "/network",
      "/api/network",
      "/profile (PUT) [legacy]",
      "/me/profile (GET,PUT) [PROFILE_v1]",
      "/api/me/profile (GET,PUT) [alias]",
      "/me/avatar (POST multipart) [PROFILE_v1]",
      "/api/me/avatar (POST multipart) [alias]",
      "/memory/:id/photo (POST multipart) [MEMORY_v1]",
      "/api/memory/:id/photo (POST multipart) [alias]",
      "/authors/:id/profile (GET) [PROFILE_v1]",
      "/api/authors/:id/profile (GET) [alias]",
      "/cdn/avatars/:authorId/avatar (canônico, sem extensão)",
      "/cdn/memories/:authorId/:memoryId (canônico, sem extensão)",
      "/cdn/memory-media/:authorId/:memoryId/:mediaId/:variant (canônico imagem/áudio)",
      "/cdn/* (static) [MVP CDN local]",
      "/health",
    ],
  });
});

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

app.use("/auth", authRouter);
app.use("/api/auth", authRouter);
console.log("[ROUTE] OK /api/auth");

app.use("/chapters", chaptersRouter);
app.use("/api/chapters", chaptersRouter);
app.use("/memory", memoryRouter);
app.use("/", memoriesRouter);
app.use("/api", memoriesRouter);
app.use("/authors", authorsRouter);
app.use("/timeline", timelineRouter);
app.use("/api/timeline", timelineRouter);
app.use("/network", networkRouter);
app.use("/api/network", networkRouter);
app.use("/me", meRouter);
app.use("/api/me", meRouter);
app.use("/plans", plansRouter);
app.use("/api/plans", plansRouter);
app.use("/feed", feedRouter);
app.use("/api/feed", feedRouter);

console.log("[ROUTE] OK /feed");
console.log("[ROUTE] OK /api/feed");
console.log("[ROUTE] OK /network");
console.log("[ROUTE] OK /api/network");

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

function guessAudioExtFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
  if (m === "audio/mp4" || m === "audio/x-m4a" || m === "audio/aac") return "m4a";
  if (m === "audio/wav" || m === "audio/wave" || m === "audio/x-wav") return "wav";
  if (m === "audio/ogg" || m === "audio/opus") return "ogg";
  if (m === "audio/webm") return "webm";
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

    const toDelete = files.filter((f) => {
      const s = String(f || "");
      if (/^avatar\.(jpg|jpeg|png|webp)$/i.test(s)) return true;
      if (new RegExp(`^avatar_${authorId}\\.(jpg|jpeg|png|webp)$`, "i").test(s)) return true;
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

    const canon = files.find((x) => /^avatar\.(jpg|jpeg|png|webp)$/i.test(x));
    if (canon) return path.join(dir, canon);

    const legacy = files.find((x) =>
      new RegExp(`^avatar_${authorId}\\.(jpg|jpeg|png|webp)$`, "i").test(x)
    );
    return legacy ? path.join(dir, legacy) : null;
  } catch {
    return null;
  }
}

function authorMemoryFolder(authorId) {
  return path.join(MEMORIES_DIR, `author_${authorId}`);
}

function buildMemoryVariantBaseName(memoryId) {
  return `memory_${memoryId}`;
}

function buildLegacyMemoryFileRegex(memoryId) {
  return new RegExp(`^memory_${memoryId}\\.(jpg|jpeg|png|webp)$`, "i");
}

function buildDerivedMemoryFileRegex(memoryId) {
  return new RegExp(
    `^memory_${memoryId}_(original|feed|thumb)\\.(jpg|jpeg|png|webp)$`,
    "i"
  );
}

function normalizeImageVariant(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "original") return "original";
  if (v === "thumb") return "thumb";
  return "feed";
}

function classifyImageOrientation(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (!(w > 0) || !(h > 0)) return "unknown";

  const ratio = w / h;
  if (ratio > 2) return "panoramic";
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.85) return "portrait";
  return "square";
}

async function removeExistingMemoryPhotoFiles(authorId, memoryId) {
  try {
    const dir = authorMemoryFolder(authorId);
    await ensureDir(dir);
    const files = await fsp.readdir(dir);

    const toDelete = files.filter((f) => {
      const name = String(f || "");
      return (
        buildLegacyMemoryFileRegex(memoryId).test(name) ||
        buildDerivedMemoryFileRegex(memoryId).test(name)
      );
    });

    for (const f of toDelete) {
      try {
        await fsp.unlink(path.join(dir, f));
      } catch {}
    }
  } catch {}
}

function memoryMediaFolder(authorId, memoryId, mediaId) {
  return path.join(
    PUBLIC_DIR,
    "memory-media",
    String(authorId),
    `memory_${memoryId}`,
    `media_${mediaId}`
  );
}

async function findExistingMemoryImageFile(authorId, memoryId, mediaId, variant = "feed") {
  try {
    const dir = memoryMediaFolder(authorId, memoryId, mediaId);
    const files = await fsp.readdir(dir);
    const normalizedVariant = normalizeImageVariant(variant);

    const preferredOrder =
      normalizedVariant === "original"
        ? ["original", "feed", "thumb"]
        : normalizedVariant === "thumb"
          ? ["thumb", "feed", "original"]
          : ["feed", "original", "thumb"];

    for (const item of preferredOrder) {
      const found = files.find((x) =>
        new RegExp(`^${item}\\.(jpg|jpeg|png|webp)$`, "i").test(String(x || ""))
      );
      if (found) return path.join(dir, found);
    }

    return null;
  } catch {
    return null;
  }
}

async function findPrimaryMemoryImageMediaId(authorId, memoryId) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("author_id", sql.Int, Number(authorId))
      .input("memory_id", sql.Int, Number(memoryId))
      .query(`
        SELECT TOP 1 media_id
        FROM dbo.identity_memory_media
        WHERE author_id = @author_id
          AND memory_id = @memory_id
          AND media_type = 'image'
          AND ISNULL(is_deleted, 0) = 0
        ORDER BY is_primary_for_memory DESC, created_at DESC, media_id DESC;
      `);

    const mediaId = result.recordset?.[0]?.media_id;
    return Number.isInteger(Number(mediaId)) && Number(mediaId) > 0
      ? Number(mediaId)
      : null;
  } catch {
    return null;
  }
}

async function findExistingMemoryPhotoFile(authorId, memoryId, variant = "feed") {
  try {
    const primaryMediaId = await findPrimaryMemoryImageMediaId(authorId, memoryId);
    if (primaryMediaId) {
      const primaryPath = await findExistingMemoryImageFile(
        authorId,
        memoryId,
        primaryMediaId,
        variant
      );
      if (primaryPath) return primaryPath;
    }

    const dir = authorMemoryFolder(authorId);
    const files = await fsp.readdir(dir);
    const normalizedVariant = normalizeImageVariant(variant);

    const preferredOrder =
      normalizedVariant === "original"
        ? ["original", "feed", "thumb"]
        : normalizedVariant === "thumb"
          ? ["thumb", "feed", "original"]
          : ["feed", "original", "thumb"];

    for (const item of preferredOrder) {
      const found = files.find((x) =>
        new RegExp(`^memory_${memoryId}_${item}\\.(jpg|jpeg|png|webp)$`, "i").test(
          String(x || "")
        )
      );
      if (found) return path.join(dir, found);
    }

    const legacy = files.find((x) =>
      buildLegacyMemoryFileRegex(memoryId).test(String(x || ""))
    );
    return legacy ? path.join(dir, legacy) : null;
  } catch {
    return null;
  }
}

async function persistMemoryImageMeta(pool, memoryId, meta) {
  if (!meta || !Number.isInteger(Number(memoryId)) || Number(memoryId) <= 0) return;

  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  const aspectRatio =
    Number.isFinite(Number(meta.aspect_ratio)) && Number(meta.aspect_ratio) > 0
      ? Number(meta.aspect_ratio)
      : null;
  const orientation = normalizeNullableString(meta.orientation, 20);

  await pool
    .request()
    .input("memory_id", sql.Int, Number(memoryId))
    .input("image_width", sql.Int, Number.isInteger(width) && width > 0 ? width : null)
    .input("image_height", sql.Int, Number.isInteger(height) && height > 0 ? height : null)
    .input("image_aspect_ratio", sql.Decimal(10, 4), aspectRatio)
    .input("image_orientation", sql.VarChar(20), orientation)
    .query(`
      IF COL_LENGTH('dbo.identity_memory', 'image_width') IS NOT NULL
      BEGIN
        UPDATE dbo.identity_memory
        SET image_width = @image_width
        WHERE memory_id = @memory_id;
      END

      IF COL_LENGTH('dbo.identity_memory', 'image_height') IS NOT NULL
      BEGIN
        UPDATE dbo.identity_memory
        SET image_height = @image_height
        WHERE memory_id = @memory_id;
      END

      IF COL_LENGTH('dbo.identity_memory', 'image_aspect_ratio') IS NOT NULL
      BEGIN
        UPDATE dbo.identity_memory
        SET image_aspect_ratio = @image_aspect_ratio
        WHERE memory_id = @memory_id;
      END

      IF COL_LENGTH('dbo.identity_memory', 'image_orientation') IS NOT NULL
      BEGIN
        UPDATE dbo.identity_memory
        SET image_orientation = @image_orientation
        WHERE memory_id = @memory_id;
      END
    `);
}

async function processMemoryPhotoVariants({ fileBuffer, outputDir, memoryId }) {
  if (!sharp) {
    const err = new Error(
      "Dependência 'sharp' não encontrada. Instale 'sharp' no hdud-api-node para habilitar tratamento de imagem."
    );
    err.status = 501;
    throw err;
  }

  await ensureDir(outputDir);

  const baseName = buildMemoryVariantBaseName(memoryId);
  const originalPath = path.join(outputDir, `${baseName}_original.jpg`);
  const feedPath = path.join(outputDir, `${baseName}_feed.jpg`);
  const thumbPath = path.join(outputDir, `${baseName}_thumb.jpg`);

  const source = sharp(fileBuffer, { failOn: "none" }).rotate();
  const metadata = await source.metadata();

  const width = Number(metadata?.width || 0);
  const height = Number(metadata?.height || 0);
  const aspectRatio =
    width > 0 && height > 0 ? Number((width / height).toFixed(4)) : null;
  const orientation = classifyImageOrientation(width, height);

  await source.clone().jpeg({ quality: 92, mozjpeg: true }).toFile(originalPath);

  await source
    .clone()
    .resize(1200, 900, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(feedPath);

  await source
    .clone()
    .resize(400, 400, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(thumbPath);

  return {
    paths: {
      original: originalPath,
      feed: feedPath,
      thumb: thumbPath,
    },
    meta: {
      width: width || null,
      height: height || null,
      aspect_ratio: aspectRatio,
      orientation,
    },
  };
}

async function findExistingMemoryAudioFile(authorId, memoryId, mediaId) {
  try {
    const dir = memoryMediaFolder(authorId, memoryId, mediaId);
    const files = await fsp.readdir(dir);

    const canon = files.find((x) =>
      /^original\.(mp3|m4a|wav|ogg|webm)$/i.test(String(x || ""))
    );
    return canon ? path.join(dir, canon) : null;
  } catch {
    return null;
  }
}

async function removeExistingMemoryAudioFiles(authorId, memoryId, mediaId) {
  try {
    const dir = memoryMediaFolder(authorId, memoryId, mediaId);
    await ensureDir(dir);
    const files = await fsp.readdir(dir);

    const toDelete = files.filter((f) =>
      /^original\.(mp3|m4a|wav|ogg|webm)$/i.test(String(f || ""))
    );

    for (const f of toDelete) {
      try {
        await fsp.unlink(path.join(dir, f));
      } catch {}
    }
  } catch {}
}

app.get("/cdn/avatars/:authorId/avatar", async (req, res) => {
  const authorId = Number(req.params.authorId);
  if (!Number.isInteger(authorId) || authorId <= 0) {
    return res.status(400).json({ error: "author_id inválido" });
  }

  const p = await findExistingAvatarFile(authorId);
  if (!p) {
    return res.status(204).end();
  }

  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  return res.sendFile(p);
});

app.get("/cdn/memories/:authorId/:memoryId", async (req, res) => {
  const authorId = Number(req.params.authorId);
  const memoryId = Number(req.params.memoryId);
  const variant = normalizeImageVariant(req.query?.variant);

  if (!Number.isInteger(authorId) || authorId <= 0) {
    return res.status(400).json({ error: "author_id inválido" });
  }

  if (!Number.isInteger(memoryId) || memoryId <= 0) {
    return res.status(400).json({ error: "memory_id inválido" });
  }

  const p = await findExistingMemoryPhotoFile(authorId, memoryId, variant);
  if (!p) {
    return res.status(204).end();
  }

  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  return res.sendFile(p);
});

app.get("/cdn/memory-media/:authorId/:memoryId/:mediaId/:variant", async (req, res) => {
  const authorId = Number(req.params.authorId);
  const memoryId = Number(req.params.memoryId);
  const mediaId = Number(req.params.mediaId);
  const variant = String(req.params.variant || "").trim().toLowerCase();

  if (!Number.isInteger(authorId) || authorId <= 0) {
    return res.status(400).json({ error: "author_id inválido" });
  }

  if (!Number.isInteger(memoryId) || memoryId <= 0) {
    return res.status(400).json({ error: "memory_id inválido" });
  }

  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return res.status(400).json({ error: "media_id inválido" });
  }

  if (variant === "original" || variant === "feed" || variant === "thumb") {
    const imagePath = await findExistingMemoryImageFile(
      authorId,
      memoryId,
      mediaId,
      variant
    );

    if (imagePath) {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      return res.sendFile(imagePath);
    }

    if (variant === "original") {
      const audioPath = await findExistingMemoryAudioFile(authorId, memoryId, mediaId);
      if (audioPath) {
        res.setHeader("Cache-Control", "public, max-age=60");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        return res.sendFile(audioPath);
      }
    }

    return res.status(204).end();
  }

  return res.status(400).json({ error: "variant inválida" });
});

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

async function handleAuthorPublicProfile(req, res, next) {
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
}

app.get("/authors/:id/profile", handleAuthorPublicProfile);
app.get("/api/authors/:id/profile", handleAuthorPublicProfile);

async function handleMeProfile(req, res, next) {
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
}

app.get("/me/profile", authenticate, handleMeProfile);
app.get("/api/me/profile", authenticate, handleMeProfile);

async function handleMeProfilePut(req, res, next) {
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
}

app.put("/me/profile", authenticate, handleMeProfilePut);
app.put("/api/me/profile", authenticate, handleMeProfilePut);

if (multer) {
  const uploadImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = guessExtFromMime(file?.mimetype);
      if (!ext) return cb(new Error("Formato inválido. Use JPG, PNG ou WEBP."));
      return cb(null, true);
    },
  });

  const uploadAudio = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = guessAudioExtFromMime(file?.mimetype);
      if (!ext) {
        return cb(new Error("Formato inválido. Use MP3, M4A, WAV, OGG ou WEBM."));
      }
      return cb(null, true);
    },
  });

  async function handleMeAvatarUpload(req, res, next) {
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

      const filename = `avatar.${ext}`;
      const outPath = path.join(dir, filename);

      await fsp.writeFile(outPath, req.file.buffer);

      if (!fs.existsSync(outPath)) {
        return res.status(500).json({ error: "Falha ao salvar avatar." });
      }

      const avatarUrl = `/cdn/avatars/${authorId}/avatar`;

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
  }

  async function handleMemoryPhotoUpload(req, res, next) {
    try {
      const tokenAuthorId = getAuthorIdFromToken(req);
      if (!tokenAuthorId) return res.status(401).json({ error: "Não autenticado." });

      const memoryId = Number(req.params.id);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

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

      const pool = await getPool();
      const mem = await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .query(`
          SELECT TOP 1 memory_id, author_id, is_deleted
          FROM dbo.identity_memory
          WHERE memory_id = @memory_id;
        `);

      const row = mem.recordset?.[0] || null;
      if (!row || row.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const ownerAuthorId = Number(row.author_id);
      if (ownerAuthorId !== tokenAuthorId) {
        return res.status(403).json({ error: "Permissão negada." });
      }

      const dir = authorMemoryFolder(ownerAuthorId);
      await ensureDir(dir);
      await removeExistingMemoryPhotoFiles(ownerAuthorId, memoryId);

      const processed = await processMemoryPhotoVariants({
        fileBuffer: req.file.buffer,
        outputDir: dir,
        memoryId,
      });

      if (!fs.existsSync(processed.paths.feed)) {
        return res.status(500).json({ error: "Falha ao salvar foto da memória." });
      }

      const photoUrl = `/cdn/memories/${ownerAuthorId}/${memoryId}`;

      await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .input("photo_url", sql.NVarChar(1000), photoUrl)
        .query(`
          UPDATE dbo.identity_memory
          SET photo_url = @photo_url
          WHERE memory_id = @memory_id;
        `);

      await persistMemoryImageMeta(pool, memoryId, processed.meta);

      return res.json({
        ok: true,
        author_id: ownerAuthorId,
        memory_id: memoryId,
        photo_url: photoUrl,
        photo_variants: {
          original: `${photoUrl}?variant=original`,
          feed: `${photoUrl}?variant=feed`,
          thumb: `${photoUrl}?variant=thumb`,
        },
        image_meta: processed.meta,
        meta: { saved_at: new Date().toISOString() },
      });
    } catch (err) {
      return next(err);
    }
  }

  async function handleMemoryAudioUpload(req, res, next) {
    try {
      const tokenAuthorId = getAuthorIdFromToken(req);
      if (!tokenAuthorId) return res.status(401).json({ error: "Não autenticado." });

      const memoryId = Number(req.params.id);
      if (!Number.isInteger(memoryId) || memoryId <= 0) {
        return res.status(400).json({ error: "memory_id inválido." });
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          error: "Arquivo ausente.",
          detail: 'Envie multipart/form-data com campo "file".',
        });
      }

      const ext = guessAudioExtFromMime(req.file.mimetype);
      if (!ext) {
        return res.status(415).json({
          error: "Formato inválido.",
          detail: "Use MP3, M4A, WAV, OGG ou WEBM.",
        });
      }

      const durationSecondsRaw = req.body?.duration_seconds;
      const durationSeconds =
        durationSecondsRaw != null && String(durationSecondsRaw).trim() !== ""
          ? Number(durationSecondsRaw)
          : null;

      const isPrimaryRaw = String(req.body?.is_primary ?? "true").trim().toLowerCase();
      const isPrimary = isPrimaryRaw === "true" || isPrimaryRaw === "1";

      const pool = await getPool();
      const mem = await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .query(`
          SELECT TOP 1 memory_id, author_id, is_deleted
          FROM dbo.identity_memory
          WHERE memory_id = @memory_id;
        `);

      const row = mem.recordset?.[0] || null;
      if (!row || row.is_deleted) {
        return res.status(404).json({ error: "Memória não encontrada." });
      }

      const ownerAuthorId = Number(row.author_id);
      if (ownerAuthorId !== tokenAuthorId) {
        return res.status(403).json({ error: "Permissão negada." });
      }

      if (isPrimary) {
        await pool
          .request()
          .input("memory_id", sql.Int, memoryId)
          .query(`
            UPDATE dbo.identity_memory_media
            SET is_primary_for_memory = 0,
                updated_at = SYSUTCDATETIME()
            WHERE memory_id = @memory_id
              AND media_type = 'audio'
              AND ISNULL(is_deleted, 0) = 0;
          `);
      }

      const insertR = await pool
        .request()
        .input("memory_id", sql.Int, memoryId)
        .input("author_id", sql.Int, ownerAuthorId)
        .input("media_type", sql.VarChar(20), "audio")
        .input("storage_provider", sql.VarChar(30), "local")
        .input("storage_path", sql.NVarChar(500), "")
        .input("original_file_name", sql.NVarChar(260), req.file.originalname || null)
        .input("mime_type", sql.VarChar(100), req.file.mimetype || null)
        .input("file_size_bytes", sql.BigInt, Number(req.file.size || req.file.buffer.length || 0))
        .input(
          "duration_seconds",
          sql.Int,
          Number.isFinite(durationSeconds) && durationSeconds > 0
            ? Math.trunc(durationSeconds)
            : null
        )
        .input("transcription_status", sql.VarChar(30), "pending")
        .input("language_code", sql.VarChar(20), "pt-BR")
        .input("is_primary_for_memory", sql.Bit, isPrimary ? 1 : 0)
        .query(`
          INSERT INTO dbo.identity_memory_media
          (
            memory_id,
            author_id,
            media_type,
            storage_provider,
            storage_path,
            original_file_name,
            mime_type,
            file_size_bytes,
            duration_seconds,
            transcription_status,
            language_code,
            is_primary_for_memory
          )
          OUTPUT INSERTED.media_id
          VALUES
          (
            @memory_id,
            @author_id,
            @media_type,
            @storage_provider,
            @storage_path,
            @original_file_name,
            @mime_type,
            @file_size_bytes,
            @duration_seconds,
            @transcription_status,
            @language_code,
            @is_primary_for_memory
          );
        `);

      const mediaId = Number(insertR.recordset?.[0]?.media_id);
      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return res.status(500).json({ error: "Falha ao registrar áudio da memória." });
      }

      const dir = memoryMediaFolder(ownerAuthorId, memoryId, mediaId);
      await ensureDir(dir);
      await removeExistingMemoryAudioFiles(ownerAuthorId, memoryId, mediaId);

      const filename = `original.${ext}`;
      const outPath = path.join(dir, filename);

      await fsp.writeFile(outPath, req.file.buffer);

      if (!fs.existsSync(outPath)) {
        return res.status(500).json({ error: "Falha ao salvar áudio da memória." });
      }

      const storagePath = `/cdn/memory-media/${ownerAuthorId}/${memoryId}/${mediaId}/original`;

      await pool
        .request()
        .input("media_id", sql.BigInt, mediaId)
        .input("storage_path", sql.NVarChar(500), storagePath)
        .query(`
          UPDATE dbo.identity_memory_media
          SET storage_path = @storage_path,
              updated_at = SYSUTCDATETIME()
          WHERE media_id = @media_id;
        `);

      if (
        typeof row.memory_id === "number" ||
        Number.isInteger(Number(row.memory_id))
      ) {
        try {
          await pool
            .request()
            .input("memory_id", sql.Int, memoryId)
            .input("origin_type", sql.VarChar(30), "narrated_audio")
            .query(`
              IF COL_LENGTH('dbo.identity_memory', 'origin_type') IS NOT NULL
              BEGIN
                UPDATE dbo.identity_memory
                SET origin_type = CASE
                    WHEN origin_type IS NULL OR LTRIM(RTRIM(origin_type)) = '' THEN @origin_type
                    ELSE origin_type
                END
                WHERE memory_id = @memory_id;
              END
            `);
        } catch {}
      }

      return res.status(201).json({
        ok: true,
        memory_id: memoryId,
        media: {
          media_id: mediaId,
          media_type: "audio",
          audio_url: storagePath,
          mime_type: req.file.mimetype || null,
          file_size_bytes: Number(req.file.size || req.file.buffer.length || 0),
          duration_seconds:
            Number.isFinite(durationSeconds) && durationSeconds > 0
              ? Math.trunc(durationSeconds)
              : null,
          transcription_status: "pending",
          is_primary_for_memory: isPrimary,
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  app.post("/me/avatar", authenticate, uploadImage.single("file"), handleMeAvatarUpload);
  app.post("/api/me/avatar", authenticate, uploadImage.single("file"), handleMeAvatarUpload);

  app.post("/memory/:id/photo", authenticate, uploadImage.single("file"), handleMemoryPhotoUpload);
  app.post("/api/memory/:id/photo", authenticate, uploadImage.single("file"), handleMemoryPhotoUpload);

  app.post("/memory/:id/audio", authenticate, uploadAudio.single("file"), handleMemoryAudioUpload);
  app.post("/api/memory/:id/audio", authenticate, uploadAudio.single("file"), handleMemoryAudioUpload);
} else {
  app.post("/me/avatar", authenticate, (_req, res) => {
    return res.status(501).json({
      error: "Upload não habilitado.",
      detail:
        "Dependência 'multer' não encontrada. Instale 'multer' no hdud-api-node para habilitar /me/avatar.",
    });
  });

  app.post("/api/me/avatar", authenticate, (_req, res) => {
    return res.status(501).json({
      error: "Upload não habilitado.",
      detail:
        "Dependência 'multer' não encontrada. Instale 'multer' no hdud-api-node para habilitar /api/me/avatar.",
    });
  });

  app.post("/memory/:id/photo", authenticate, (_req, res) => {
    return res.status(501).json({
      error: "Upload não habilitado.",
      detail:
        "Dependência 'multer' não encontrada. Instale 'multer' no hdud-api-node para habilitar /memory/:id/photo.",
    });
  });

  app.post("/api/memory/:id/photo", authenticate, (_req, res) => {
    return res.status(501).json({
      error: "Upload não habilitado.",
      detail:
        "Dependência 'multer' não encontrada. Instale 'multer' no hdud-api-node para habilitar /api/memory/:id/photo.",
    });
  });

  app.post("/memory/:id/audio", authenticate, (_req, res) => {
    return res.status(501).json({
      error: "Upload não habilitado.",
      detail:
        "Dependência 'multer' não encontrada. Instale 'multer' no hdud-api-node para habilitar /memory/:id/audio.",
    });
  });

  app.post("/api/memory/:id/audio", authenticate, (_req, res) => {
    return res.status(501).json({
      error: "Upload não habilitado.",
      detail:
        "Dependência 'multer' não encontrada. Instale 'multer' no hdud-api-node para habilitar /api/memory/:id/audio.",
    });
  });
}

async function handleFeed(req, res, next) {
  try {
    const viewerId = getAuthorIdFromToken(req);
    if (!viewerId) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const limit = clampInt(req.query?.limit, 1, 100, 20);
    const v = String(req.query?.v ?? "").trim().toLowerCase();

    const pool = await getPool();

    const profR = await pool
      .request()
      .input("author_id", sql.Int, viewerId)
      .query(`
        SELECT TOP 1
          a.author_id,
          a.author_code,
          a.full_name,
          a.name_public,
          a.bio_short,
          a.location,
          a.avatar_url,
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

    const namePublic =
      (pr?.name_public && String(pr.name_public).trim()) ||
      (pr?.full_name && String(pr.full_name).trim()) ||
      displayNameRaw ||
      authorCode ||
      null;

    const profileLegacy = {
      author_id: viewerId,
      author_code: authorCode,
      display_name: displayNameRaw || authorCode || null,
      preferred_language: pr?.preferred_language ? String(pr.preferred_language) : null,
    };

    const actorV01 = {
      author_id: viewerId,
      name_public: namePublic,
      avatar_url: pr?.avatar_url != null ? String(pr.avatar_url) : null,
    };

    const feedR = await pool
      .request()
      .input("viewer_author_id", sql.Int, viewerId)
      .input("limit", sql.Int, limit)
      .query(`
        WITH viewer_network AS (
          SELECT
            a.author_id,
            CAST('self' AS varchar(20)) AS relationship_type,
            CAST('self' AS varchar(20)) AS origin_scope,
            CAST(1000 AS int) AS relationship_score
          FROM dbo.identity_author a
          WHERE a.author_id = @viewer_author_id

          UNION ALL

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
        ),
        dedup_viewer_network AS (
          SELECT
            vn.author_id,
            vn.relationship_type,
            vn.origin_scope,
            vn.relationship_score
          FROM (
            SELECT
              vn.*,
              ROW_NUMBER() OVER (
                PARTITION BY vn.author_id
                ORDER BY vn.relationship_score DESC, vn.author_id ASC
              ) AS rn
            FROM viewer_network vn
          ) vn
          WHERE vn.rn = 1
        ),
        network_authors AS (
          SELECT
            vn.author_id,
            vn.relationship_type,
            vn.origin_scope,
            vn.relationship_score,
            ia.author_code,
            COALESCE(
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(200), ia.name_public))), ''),
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(200), ia.full_name))), ''),
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(200), ia.author_code))), '')
            ) AS author_name
          FROM dedup_viewer_network vn
          INNER JOIN dbo.identity_author ia
            ON ia.author_id = vn.author_id
        ),
        memory_feed AS (
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
            COALESCE(
              NULLIF(LTRIM(RTRIM(CONVERT(varchar(1000), m.photo_url))), ''),
              CONCAT('/cdn/memories/', CAST(m.author_id AS varchar(50)), '/', CAST(m.memory_id AS varchar(50)))
            ) AS photo_url,
            CONVERT(varchar(50), m.publication_status) AS publication_status_raw,
            m.published_at AS published_at,
            CAST(NULL AS int) AS chapter_id,
            CAST(m.memory_id AS int) AS memory_id,
            CAST(
              na.relationship_score
              + 120
              + CASE WHEN m.published_at IS NOT NULL THEN 50 ELSE 0 END
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
        ),
        chapter_feed AS (
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
            '/chapters' AS nav,
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
            CAST(
              na.relationship_score
              + 220
              + CASE WHEN c.published_at IS NOT NULL THEN 50 ELSE 0 END
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
        ),
        unified AS (
          SELECT * FROM memory_feed
          UNION ALL
          SELECT * FROM chapter_feed
        )
        SELECT TOP (@limit)
          item_type,
          source_id,
          author_id,
          author_name,
          author_code,
          relationship_type,
          origin_scope,
          relationship_score,
          relevance_score,
          title,
          activity_at,
          nav,
          preview_text,
          phase_code,
          photo_url,
          publication_status_raw,
          published_at,
          chapter_id,
          memory_id
        FROM unified
        ORDER BY
          relevance_score DESC,
          activity_at DESC,
          source_id DESC;
      `);

    const rows = feedR.recordset || [];

    const legacyItems = rows.map((row) => {
      const itemType = String(row.item_type || "").toLowerCase();
      const sourceId = String(row.source_id ?? "");
      const title = normalizeText(
        row.title,
        itemType === "chapter" ? "(Capítulo sem título)" : "(Memória sem título)"
      );
      const activityIso = normalizeIsoOrNow(row.activity_at || row.published_at);
      const publicationStatus =
        row.publication_status_raw != null ? String(row.publication_status_raw) : null;
      const authorName = row.author_name != null ? String(row.author_name) : null;
      const authorCodeRow = row.author_code != null ? String(row.author_code) : null;

      if (itemType === "chapter") {
        return {
          type: "chapter",
          title,
          date: activityIso,
          source_id: sourceId,
          authorId: row.author_id != null ? Number(row.author_id) : null,
          authorName,
          authorCode: authorCodeRow,
          relationshipType: row.relationship_type != null ? String(row.relationship_type) : null,
          originScope: row.origin_scope != null ? String(row.origin_scope) : null,
          relevanceScore: row.relevance_score != null ? Number(row.relevance_score) : null,
          meta: {
            nav: row.nav || "/chapters",
            date_source: "published_at",
            activity_at: activityIso,
            preview: makePreview(row.preview_text, 260) || undefined,
            publication_status: publicationStatus || undefined,
            published_at: row.published_at ? normalizeIsoOrNow(row.published_at) : null,
            chapter_id: row.chapter_id != null ? Number(row.chapter_id) : undefined,
            memory_id: undefined,
            status: publicationStatus || undefined,
            description: makePreview(row.preview_text, 260) || undefined,
            author_id: row.author_id != null ? Number(row.author_id) : undefined,
            author_name: authorName || undefined,
            author_code: authorCodeRow || undefined,
            relationship_type:
              row.relationship_type != null ? String(row.relationship_type) : undefined,
            origin_scope: row.origin_scope != null ? String(row.origin_scope) : undefined,
            relevance_score:
              row.relevance_score != null ? Number(row.relevance_score) : undefined,
          },
        };
      }

      return {
        type: "memory",
        title,
        date: activityIso,
        source_id: sourceId,
        photoUrl: row.photo_url != null ? String(row.photo_url) : null,
        authorId: row.author_id != null ? Number(row.author_id) : null,
        authorName,
        authorCode: authorCodeRow,
        relationshipType: row.relationship_type != null ? String(row.relationship_type) : null,
        originScope: row.origin_scope != null ? String(row.origin_scope) : null,
        relevanceScore: row.relevance_score != null ? Number(row.relevance_score) : null,
        meta: {
          nav: row.nav || mkNav("memory", row.memory_id ?? row.source_id),
          date_source: "published_at",
          activity_at: activityIso,
          preview: makePreview(row.preview_text, 220) || undefined,
          phase_code: row.phase_code != null ? String(row.phase_code) : undefined,
          photo_url: row.photo_url != null ? String(row.photo_url) : undefined,
          publication_status: publicationStatus || undefined,
          published_at: row.published_at ? normalizeIsoOrNow(row.published_at) : null,
          memory_id: row.memory_id != null ? Number(row.memory_id) : undefined,
          chapter_id: undefined,
          status: publicationStatus || undefined,
          author_id: row.author_id != null ? Number(row.author_id) : undefined,
          author_name: authorName || undefined,
          author_code: authorCodeRow || undefined,
          relationship_type:
            row.relationship_type != null ? String(row.relationship_type) : undefined,
          origin_scope: row.origin_scope != null ? String(row.origin_scope) : undefined,
          relevance_score:
            row.relevance_score != null ? Number(row.relevance_score) : undefined,
        },
      };
    });

    const memoryCount = legacyItems.filter((x) => x.type === "memory").length;
    const chapterCount = legacyItems.filter((x) => x.type === "chapter").length;

    const wantsV01 = v === "0.1" || v === "v0.1" || v === "1";

    if (wantsV01) {
      const v01Items = legacyItems.map((it) => {
        const kind = String(it.type || "").toLowerCase();
        const activityAt = it?.meta?.activity_at || it?.date || new Date().toISOString();

        const idNum = Number(it?.source_id);
        const id = Number.isFinite(idNum) && idNum > 0 ? idNum : String(it?.source_id ?? "");

        const obj = {
          kind,
          id,
          title: normalizeText(it?.title, "(sem título)"),
          nav: it?.meta?.nav || "/",
          preview: it?.meta?.preview || it?.meta?.description || null,
          photoUrl: it?.photoUrl ?? it?.meta?.photo_url ?? null,
          meta: {
            phase_code: it?.meta?.phase_code ?? null,
            chapter_id: it?.meta?.chapter_id ?? null,
            status: it?.meta?.status ?? null,
            publication_status: it?.meta?.publication_status ?? null,
            published_at: it?.meta?.published_at ?? null,
            photo_url: it?.meta?.photo_url ?? null,
            author_id: it?.meta?.author_id ?? it?.authorId ?? null,
            author_name: it?.meta?.author_name ?? it?.authorName ?? null,
            author_code: it?.meta?.author_code ?? it?.authorCode ?? null,
            relationship_type: it?.meta?.relationship_type ?? it?.relationshipType ?? null,
            origin_scope: it?.meta?.origin_scope ?? it?.originScope ?? null,
            relevance_score: it?.meta?.relevance_score ?? it?.relevanceScore ?? null,
          },
        };

        const activityIso = new Date(safeDateMs(activityAt) ?? Date.now()).toISOString();

        return {
          actor: {
            author_id: it?.meta?.author_id ?? it?.authorId ?? actorV01.author_id,
            name_public: it?.meta?.author_name ?? it?.authorName ?? actorV01.name_public,
            avatar_url: null,
          },
          kind,
          action: "published",
          activity_at: activityIso,
          object: obj,
        };
      });

      return res.json({
        version: "FEED_v0.1",
        actor: actorV01,
        items: v01Items,
        meta: {
          generated_at: new Date().toISOString(),
          limit,
          truth_mode: "published_only",
          scope_mode: "self_and_network",
          ordering_mode: "relevance_then_recency",
          summary: {
            counts: {
              memories: memoryCount,
              chapters: chapterCount,
            },
          },
        },
        legacy: {
          profile: profileLegacy,
          items: legacyItems,
        },
      });
    }

    return res.json({
      profile: profileLegacy,
      items: legacyItems,
      meta: {
        generated_at: new Date().toISOString(),
        limit,
        truth_mode: "published_only",
        scope_mode: "self_and_network",
        ordering_mode: "relevance_then_recency",
        summary: {
          counts: {
            memories: memoryCount,
            chapters: chapterCount,
          },
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

app.get("/feed", authenticate, handleFeed);
app.get("/api/feed", authenticate, handleFeed);

console.log("[ROUTE] OK /auth");
console.log("[ROUTE] OK /api/auth");
console.log("[ROUTE] OK /chapters");
console.log("[ROUTE] OK /api/chapters");
console.log("[ROUTE] OK /memory");
console.log("[ROUTE] OK /");
console.log("[ROUTE] OK /authors");
console.log("[ROUTE] OK /timeline");
console.log("[ROUTE] OK /api/timeline (alias)");
console.log("[ROUTE] OK /feed");
console.log("[ROUTE] OK /api/feed (alias)");
console.log("[ROUTE] OK /network");
console.log("[ROUTE] OK /api/network");
console.log("[ROUTE] OK /profile (PUT) [legacy]");
console.log("[ROUTE] OK /me/profile (GET,PUT) [PROFILE_v1]");
console.log("[ROUTE] OK /api/me/profile (GET,PUT) [alias]");
console.log("[ROUTE] OK /me/avatar (POST multipart) [PROFILE_v1]");
console.log("[ROUTE] OK /api/me/avatar (POST multipart) [alias]");
console.log("[ROUTE] OK /memory/:id/photo (POST multipart) [MEMORY_v1]");
console.log("[ROUTE] OK /api/memory/:id/photo (POST multipart) [alias]");
console.log("[ROUTE] OK /memory/:id/audio (POST multipart) [MEMORY_AUDIO_v1]");
console.log("[ROUTE] OK /api/memory/:id/audio (POST multipart) [alias]");
console.log("[ROUTE] OK /authors/:id/profile (GET) [PROFILE_v1]");
console.log("[ROUTE] OK /api/authors/:id/profile (GET) [alias]");
console.log("[ROUTE] OK /cdn/avatars/:authorId/avatar (canônico, sem extensão)");
console.log("[ROUTE] OK /cdn/memories/:authorId/:memoryId (canônico, sem extensão)");
console.log("[ROUTE] OK /cdn/memory-media/:authorId/:memoryId/:mediaId/:variant (canônico)");
console.log("[ROUTE] OK /cdn/* (static) [MVP CDN local]");
console.log("[ROUTE] OK /health");
console.log("[ROUTE] OK / (root)");

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
console.log("[BOOT] MEMORIES_DIR:", MEMORIES_DIR);
console.log("[BOOT] MEMORY_MEDIA_DIR:", MEMORY_MEDIA_DIR);
console.log(
  "[BOOT] has CDN avatar route:",
  typeof app._router?.stack?.find?.((r) => r?.route?.path === "/cdn/avatars/:authorId/avatar") !==
    "undefined"
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HDUD API listening on :${PORT}`);
});