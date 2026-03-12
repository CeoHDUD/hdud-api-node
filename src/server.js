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
import timelineRouter from "./routes/timeline.js";

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

app.use(express.json({ limit: "1mb" }));

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
      "/memories (via /)",
      "/authors",
      "/chapters",
      "/api/chapters",
      "/feed",
      "/api/feed (alias)",
      "/timeline",
      "/api/timeline (alias)",
      "/profile (PUT) [legacy]",
      "/me/profile (GET,PUT) [PROFILE_v1]",
      "/api/me/profile (GET,PUT) [alias]",
      "/me/avatar (POST multipart) [PROFILE_v1]",
      "/api/me/avatar (POST multipart) [alias]",
      "/authors/:id/profile (GET) [PROFILE_v1]",
      "/api/authors/:id/profile (GET) [alias]",
      "/cdn/avatars/:authorId/avatar (canônico, sem extensão)",
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
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = guessExtFromMime(file?.mimetype);
      if (!ext) return cb(new Error("Formato inválido. Use JPG, PNG ou WEBP."));
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
  }

  app.post("/me/avatar", authenticate, upload.single("file"), handleMeAvatarUpload);
  app.post("/api/me/avatar", authenticate, upload.single("file"), handleMeAvatarUpload);
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
}

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

function compareFeedV01(a, b) {
  const sa = Number(a?.score ?? 0);
  const sb = Number(b?.score ?? 0);
  if (sa !== sb) return sb - sa;

  const da = safeDateMs(a?.activity_at) ?? -Infinity;
  const db = safeDateMs(b?.activity_at) ?? -Infinity;
  if (da !== db) return db - da;

  const ka = String(a?.kind ?? "");
  const kb = String(b?.kind ?? "");
  if (ka !== kb) return ka < kb ? -1 : 1;

  const ida = String(a?.object?.id ?? "");
  const idb = String(b?.object?.id ?? "");
  if (ida < idb) return -1;
  if (ida > idb) return 1;

  const aa = String(a?.activity_at ?? "");
  const ab = String(b?.activity_at ?? "");
  if (aa < ab) return -1;
  if (aa > ab) return 1;

  return 0;
}

function hashStringToInt(input) {
  const s = String(input ?? "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function prng01(seed) {
  let x = (seed >>> 0) || 123456789;
  x = (Math.imul(1664525, x) + 1013904223) >>> 0;
  return x / 4294967296;
}

function actionWeight(action) {
  const a = String(action || "").toLowerCase();
  if (a === "published") return 40;
  if (a === "created") return 20;
  if (a === "updated") return 10;
  return 0;
}

function kindBoost(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "chapter") return 15;
  if (k === "memory") return 10;
  if (k === "version") return 5;
  return 0;
}

function computeRecencyScore(activityAtIso) {
  const now = Date.now();
  const ms = safeDateMs(activityAtIso);
  const ageMin = typeof ms === "number" ? Math.max(0, (now - ms) / 60000) : 999999;

  const x = ageMin;
  const s = 900 / (1 + x / 240);
  return Math.max(0, Math.floor(s));
}

function socialSignalScore(counts) {
  const c = counts || {};
  const likes = Number(c.likes || 0);
  const comments = Number(c.comments || 0);
  const reposts = Number(c.reposts || 0);
  const saves = Number(c.saves || 0);
  const raw = likes * 3 + comments * 12 + reposts * 16 + saves * 10;
  return Math.max(0, Math.min(250, raw));
}

function computeScoreVNext({ kind, action, activity_at, social }) {
  const rec = computeRecencyScore(activity_at);
  const aw = actionWeight(action);
  const kb = kindBoost(kind);
  const ss = socialSignalScore(social?.counts);
  return rec + aw + kb + ss;
}

function normalizeV01Action(kind, meta) {
  const k = String(kind || "").toLowerCase();
  if (k === "chapter") {
    const st = String(meta?.status ?? "").toLowerCase();
    if (st === "published") return "published";
    if (meta?.published_at) return "published";
    return "created";
  }
  if (k === "memory") {
    const src = String(meta?.date_source ?? "").toLowerCase();
    if (src === "activity_at") return "updated";
    return "created";
  }
  if (k === "version") return "updated";
  return "created";
}

function buildSocialBlockStubVNext({ seedKey, action, kind }) {
  const verbMap = {
    published: "publicou",
    created: "criou",
    updated: "atualizou",
  };
  const verb = verbMap[String(action || "").toLowerCase()] || "movimentou";

  const seed = hashStringToInt(`${seedKey}|${action}|${kind}`);
  const r1 = prng01(seed);
  const r2 = prng01(seed ^ 0x9e3779b9);
  const r3 = prng01(seed ^ 0x85ebca6b);

  const likes = Math.floor(r1 * 18);
  const comments = Math.floor(r2 * 6);
  const reposts = Math.floor(r3 * 4);
  const saves = Math.floor(prng01(seed ^ 0xc2b2ae35) * 8);

  const poolNames = [
    "Ana Silva",
    "João Lima",
    "Maria Souza",
    "Pedro Santos",
    "Bruno Almeida",
    "Lucas Vieira",
    "Carla Nunes",
    "Rafael Costa",
    "Juliana Rocha",
    "Fernanda Dias",
  ];

  const pickCount = Math.max(0, Math.min(3, Math.floor(prng01(seed ^ 0x27d4eb2d) * 4)));
  const people = [];
  for (let i = 0; i < pickCount; i++) {
    const idx = Math.floor(prng01(seed ^ (i * 1315423911)) * poolNames.length);
    people.push({ name: poolNames[idx] });
  }

  const friendOf = prng01(seed ^ 0x165667b1) > 0.72 ? { label: "conhecido de você" } : null;

  return {
    friendOf,
    people,
    verb,
    counts: { likes, comments, reposts, saves },
  };
}

async function handleFeed(req, res, next) {
  try {
    const authorIdRaw = req.user?.author_id;
    const authorId = Number(authorIdRaw);

    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(401).json({ error: "Não autenticado." });
    }

    const limit = clampInt(req.query?.limit, 1, 50, 20);
    const v = String(req.query?.v ?? "").trim().toLowerCase();

    const pool = await getPool();

    const profR = await pool
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
      author_id: authorId,
      author_code: authorCode,
      display_name: displayNameRaw || authorCode || null,
      preferred_language: pr?.preferred_language ? String(pr.preferred_language) : null,
    };

    const actorV01 = {
      author_id: authorId,
      name_public: namePublic,
      avatar_url: pr?.avatar_url != null ? String(pr.avatar_url) : null,
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

    const memoriesLegacy = (memR.recordset || []).map((m) => {
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

    const chaptersLegacy = (chapR.recordset || []).map((c) => {
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
          published_at: c.published_at ?? null,
          description: descriptionPreview || undefined,
        },
      };
    });

    const allLegacy = [...chaptersLegacy, ...memoriesLegacy].sort(compareFeedDescDeterministic);
    const legacyItems = allLegacy.slice(0, limit);

    const wantsV01 = v === "0.1" || v === "v0.1" || v === "1";

    if (wantsV01) {
      const v01Candidates = (allLegacy || []).map((it) => {
        const kind = String(it.type || "").toLowerCase();
        const activityAt = it?.meta?.activity_at || it?.date || new Date().toISOString();
        const action = normalizeV01Action(kind, it?.meta);

        const idNum = Number(it?.source_id);
        const id = Number.isFinite(idNum) && idNum > 0 ? idNum : String(it?.source_id ?? "");

        const obj = {
          kind,
          id,
          title: normalizeText(it?.title, "(sem título)"),
          nav: it?.meta?.nav || "/",
          preview: it?.meta?.preview || it?.meta?.description || null,
          meta: {
            phase_code: it?.meta?.phase_code ?? null,
            chapter_id: it?.meta?.chapter_id ?? null,
            status: it?.meta?.status ?? null,
            published_at: it?.meta?.published_at ?? null,
          },
        };

        const activityIso = new Date(safeDateMs(activityAt) ?? Date.now()).toISOString();

        const seedKey = `${kind}:${String(obj.id)}`;
        const social = buildSocialBlockStubVNext({ seedKey, action, kind });

        const score = computeScoreVNext({
          kind,
          action,
          activity_at: activityIso,
          social,
        });

        return {
          actor: actorV01,
          kind,
          action,
          activity_at: activityIso,
          object: obj,
          social,
          score,
        };
      });

      const v01Items = v01Candidates.sort(compareFeedV01).slice(0, limit);

      return res.json({
        version: "FEED_v0.1",
        actor: actorV01,
        items: v01Items,
        meta: {
          generated_at: new Date().toISOString(),
          limit,
          ranking: "MOVE_D(recency + action_weight + social_signal)",
          weights: {
            action: { published: 40, created: 20, updated: 10 },
            social: { like: 3, comment: 12, repost: 16, save: 10 },
          },
          summary: {
            counts: { memories: memoriesLegacy.length, chapters: chaptersLegacy.length },
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
        summary: { counts: { memories: memoriesLegacy.length, chapters: chaptersLegacy.length } },
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
console.log("[ROUTE] OK /profile (PUT) [legacy]");
console.log("[ROUTE] OK /me/profile (GET,PUT) [PROFILE_v1]");
console.log("[ROUTE] OK /api/me/profile (GET,PUT) [alias]");
console.log("[ROUTE] OK /me/avatar (POST multipart) [PROFILE_v1]");
console.log("[ROUTE] OK /api/me/avatar (POST multipart) [alias]");
console.log("[ROUTE] OK /authors/:id/profile (GET) [PROFILE_v1]");
console.log("[ROUTE] OK /api/authors/:id/profile (GET) [alias]");
console.log("[ROUTE] OK /cdn/avatars/:authorId/avatar (canônico, sem extensão)");
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
console.log(
  "[BOOT] has CDN avatar route:",
  typeof app._router?.stack?.find?.((r) => r?.route?.path === "/cdn/avatars/:authorId/avatar") !==
    "undefined"
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HDUD API listening on :${PORT}`);
});