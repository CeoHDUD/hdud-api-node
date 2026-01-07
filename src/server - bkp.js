// C:\HDUD_DATA\hdud-api-node\src\server.js
// HDUD API Node v0.6 — server (robusto para imports quebrados)
// - Mantém /health
// - Tenta carregar routers existentes (auth, memory/memories, authors) via dynamic import (não derruba o server se falhar)
// - Inclui fallback: POST /authors/:authorId/memories chamando dbo.p_CreateMemory_WithVersion
//
// Requisitos SQL (procedure):
// dbo.p_CreateMemory_WithVersion(
//   @AuthorId INT,
//   @Title NVARCHAR(500),
//   @Content NVARCHAR(MAX),
//   @UserId INT,
//   @UserCode NVARCHAR(100) = NULL
// )

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import sql from "mssql";

import { authRequired } from "./middleware/auth.js";

const APP_VERSION = process.env.APP_VERSION || "HDUD-API-Node v0.6";
const PORT = Number(process.env.PORT || 4000);

// ---------------------------
// SQL CONFIG (ENV-DRIVEN)
// ---------------------------
function getSqlConfig() {
  // Compatível com setups comuns (Windows+Docker):
  // - SQL_HOST / SQL_SERVER
  // - SQL_PORT
  // - SQL_USER
  // - SQL_PASSWORD
  // - SQL_DB / SQL_DATABASE
  const server =
    process.env.SQL_HOST ||
    process.env.SQL_SERVER ||
    process.env.DB_HOST ||
    "host.docker.internal";

  const port = Number(process.env.SQL_PORT || process.env.DB_PORT || 1433);

  const user =
    process.env.SQL_USER ||
    process.env.DB_USER ||
    "sa";

  const password =
    process.env.SQL_PASSWORD ||
    process.env.DB_PASSWORD ||
    "SenhaForte#2025";

  const database =
    process.env.SQL_DB ||
    process.env.SQL_DATABASE ||
    process.env.DB_NAME ||
    "HDUD_CORE";

  const encrypt =
    String(process.env.SQL_ENCRYPT || "false").toLowerCase() === "true";

  const trustServerCertificate =
    String(process.env.SQL_TRUST_CERT || "true").toLowerCase() === "true";

  return {
    user,
    password,
    server,
    port,
    database,
    options: {
      encrypt,
      trustServerCertificate,
    },
    pool: {
      max: Number(process.env.SQL_POOL_MAX || 10),
      min: Number(process.env.SQL_POOL_MIN || 0),
      idleTimeoutMillis: Number(process.env.SQL_POOL_IDLE || 30000),
    },
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT || 30000),
    connectionTimeout: Number(process.env.SQL_CONN_TIMEOUT || 15000),
  };
}

let _poolPromise = null;

async function getPool() {
  if (!_poolPromise) {
    const cfg = getSqlConfig();
    _poolPromise = sql.connect(cfg);
  }
  return _poolPromise;
}

// ---------------------------
// APP
// ---------------------------
const app = express();

app.set("trust proxy", true);

app.use(
  helmet({
    contentSecurityPolicy: false, // MVP/dev: evita dor de cabeça
  })
);

app.use(cors({ origin: "*", credentials: false }));

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---------------------------
// HEALTH
// ---------------------------
app.get("/health", async (_req, res) => {
  try {
    const pool = await getPool();
    // ping simples
    await pool.request().query("SELECT 1 AS ok");
    return res.status(200).json({ status: "ok", db: "connected", version: APP_VERSION });
  } catch (e) {
    return res.status(200).json({ status: "ok", db: "disconnected", version: APP_VERSION });
  }
});

// ---------------------------
// Helpers
// ---------------------------
function getUserIdentity(req) {
  const rawId = req.user?.user_id ?? req.user?.id ?? req.user?.sub;
  const userId = Number(rawId);

  const userCode =
    (req.user?.email ??
      req.user?.user_code ??
      req.user?.username ??
      (typeof req.user?.sub === "string" ? req.user.sub : null) ??
      "hdud_api_v0.6")
      .toString()
      .slice(0, 100);

  return { userId, userCode };
}

async function setSessionContext(request, userCode) {
  // não quebra se não existir permissão/etc
  try {
    await request.query`
      EXEC sys.sp_set_session_context @key=N'hdud_user', @value=${userCode};
    `;
  } catch {
    // ignore
  }
}

// ---------------------------
// ROUTES (dynamic import — não derruba o server)
// ---------------------------
async function tryMountRouter(mountPath, modulePath) {
  try {
    const mod = await import(modulePath);
    const router = mod?.default || mod?.router;
    if (!router) throw new Error(`Router não encontrado em ${modulePath}`);
    app.use(mountPath, router);
    console.log(`[ROUTE] OK mount ${mountPath} <= ${modulePath}`);
    return true;
  } catch (err) {
    console.log(`[ROUTE] SKIP ${mountPath} <= ${modulePath} :: ${err?.message || err}`);
    return false;
  }
}

// tenta montar o que existir no projeto (sem travar)
await tryMountRouter("/auth", "./routes/auth.js");
await tryMountRouter("/", "./routes/memory.js");     // se este router já define /memory e /memory/:id internamente
await tryMountRouter("/", "./routes/memories.js");   // se existir
await tryMountRouter("/", "./routes/authors.js");    // se existir (e se não estiver quebrado)

// ---------------------------
// FALLBACK CRÍTICO (CREATE MEMORY)
// POST /authors/:authorId/memories
// ---------------------------
app.post("/authors/:authorId/memories", authRequired, async (req, res) => {
  try {
    const authorId = Number(req.params.authorId);
    const { title: titleRaw = null, content: contentRaw = null } = req.body ?? {};

    if (!Number.isInteger(authorId) || authorId <= 0) {
      return res.status(400).json({ error: "authorId inválido" });
    }

    const content = typeof contentRaw === "string" ? contentRaw.trim() : "";
    if (!content) {
      return res.status(400).json({ error: "content é obrigatório" });
    }

    let title = null;
    if (typeof titleRaw === "string") {
      const t = titleRaw.trim();
      title = t.length ? t.slice(0, 500) : null;
    }

    const { userId, userCode } = getUserIdentity(req);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({
        error: "Token autenticado, mas userId não encontrado no req.user (esperado: user_id ou id).",
      });
    }

    const pool = await getPool();
    const request = pool.request();

    await setSessionContext(request, userCode);

    request.input("AuthorId", sql.Int, authorId);
    request.input("Title", sql.NVarChar(500), title);
    request.input("Content", sql.NVarChar(sql.MAX), content);
    request.input("UserId", sql.Int, userId);
    request.input("UserCode", sql.NVarChar(100), userCode);

    const result = await request.execute("dbo.p_CreateMemory_WithVersion");
    const row = result.recordset?.[0];

    return res.status(201).json(row || { ok: true });
  } catch (err) {
    console.error("[POST /authors/:authorId/memories] erro:", err);

    const detail =
      err?.originalError?.info?.message ||
      err?.message ||
      "Erro interno";

    return res.status(500).json({ error: "Falha ao criar memória", detail });
  }
});

// ---------------------------
// 404 + ERROR HANDLER
// ---------------------------
app.use((req, res) => {
  return res.status(404).json({ error: "Not Found", path: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  return res.status(500).json({
    error: "Internal Server Error",
    detail: err?.message || "Erro interno",
  });
});

// ---------------------------
// START
// ---------------------------
app.listen(PORT, () => {
  console.log(`HDUD API listening on :${PORT} (${APP_VERSION})`);
});
