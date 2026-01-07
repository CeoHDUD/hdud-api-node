// C:\HDUD_DATA\hdud-api-node\src\server.js
// HDUD API Node v0.6 — SERVER FREEZER (SECURE, NO-SILENT-FALLBACK)
//
// ✔ Nunca quebra por router faltando
// ✔ /health sempre responde
// ✔ POST /authors/:authorId/memories funcional
// ✔ NUNCA usa 'sa' por fallback
// ✔ Falha explícita se config estiver errada
// ✔ FIX: evita SQL 8144 (params vazando do sp_set_session_context)

import express from "express";
import cors from "cors";
import helmet from "helmet";
import sql from "mssql";

import { authRequired } from "./middleware/auth.js";

const APP_VERSION = process.env.APP_VERSION || "HDUD-API-Node v0.6";
const PORT = Number(process.env.PORT || 4000);

// -----------------------------------------------------------------------------
// SQL CONFIG (STRICT — SEM FALLBACK PERIGOSO)
// -----------------------------------------------------------------------------
function getSqlConfig() {
  const server = process.env.DB_SERVER || process.env.SQL_SERVER;
  const user = process.env.DB_USER || process.env.SQL_USER;
  const password = process.env.DB_PASSWORD || process.env.SQL_PASSWORD;
  const database = process.env.DB_DATABASE || process.env.SQL_DATABASE;
  const port = Number(process.env.DB_PORT || process.env.SQL_PORT || 1433);

  if (!server || !user || !password || !database) {
    throw new Error(
      "[SQL CONFIG] Variáveis obrigatórias ausentes. Esperado: DB_SERVER, DB_USER, DB_PASSWORD, DB_DATABASE"
    );
  }

  return {
    user,
    password,
    server,
    port,
    database,
    options: {
      encrypt: String(process.env.DB_ENCRYPT || "false") === "true",
      trustServerCertificate: true,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    requestTimeout: 30000,
    connectionTimeout: 15000,
  };
}

let poolPromise = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(getSqlConfig());
  }
  return poolPromise;
}

// -----------------------------------------------------------------------------
// APP
// -----------------------------------------------------------------------------
const app = express();

// 🚫 NÃO usar trust proxy em dev/Docker
app.set("trust proxy", false);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "2mb" }));

// -----------------------------------------------------------------------------
// HEALTH — NUNCA QUEBRA
// -----------------------------------------------------------------------------
app.get("/health", async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query("SELECT 1");
    res.status(200).json({
      status: "ok",
      db: "connected",
      version: APP_VERSION,
    });
  } catch (err) {
    // health sempre 200
    res.status(200).json({
      status: "ok",
      db: "disconnected",
      version: APP_VERSION,
      detail: err?.message,
    });
  }
});

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function getUserIdentity(req) {
  const userId =
    Number(req.user?.user_id) || Number(req.user?.id) || Number(req.user?.sub);

  const userCode = (req.user?.email ||
    req.user?.username ||
    req.user?.sub ||
    "hdud_api")
    .toString()
    .slice(0, 100);

  return { userId, userCode };
}

/**
 * IMPORTANTÍSSIMO:
 * - NÃO reutilize o mesmo "request" que vai executar a procedure.
 * - senão o param do session_context vira “argumento extra” na proc (SQL 8144).
 */
async function trySetSessionContext(pool, userCode) {
  try {
    const ctx = pool.request(); // request separado (limpo)
    await ctx.query`
      EXEC sys.sp_set_session_context
        @key=N'hdud_user',
        @value=${userCode};
    `;
  } catch {
    // silencioso (não pode quebrar a request)
  }
}

// -----------------------------------------------------------------------------
// ROUTER AUTO-MOUNT (NUNCA QUEBRA SERVER)
// -----------------------------------------------------------------------------
async function tryMount(path, modulePath) {
  try {
    const mod = await import(modulePath);
    const router = mod.default || mod.router;
    if (!router) throw new Error("router não exportado");
    app.use(path, router);
    console.log(`[ROUTE] OK ${path} <= ${modulePath}`);
    return true;
  } catch (err) {
    console.log(`[ROUTE] SKIP ${path} <= ${modulePath} :: ${err.message}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// MAIN (mount -> fallback -> handlers -> listen)
// -----------------------------------------------------------------------------
async function main() {
  // Mount routers ANTES de abrir a porta (evita cair em fallback por timing)
  await tryMount("/auth", "./routes/auth.js");
  await tryMount("/", "./routes/memory.js");
  await tryMount("/", "./routes/memories.js");
  await tryMount("/", "./routes/authors.js");

  // ---------------------------------------------------------------------------
  // FALLBACK CRÍTICO — CREATE MEMORY
  // - fica por último, para não “ganhar” do router correto por ordem
  // - FIX: session_context em request separado
  // ---------------------------------------------------------------------------
  app.post("/authors/:authorId/memories", authRequired, async (req, res) => {
    try {
      const authorId = Number(req.params.authorId);
      if (!authorId || authorId <= 0) {
        return res.status(400).json({ error: "authorId inválido" });
      }

      const content =
        typeof req.body?.content === "string" ? req.body.content.trim() : "";
      if (!content) {
        return res.status(400).json({ error: "content é obrigatório" });
      }

      const title =
        typeof req.body?.title === "string"
          ? req.body.title.trim().slice(0, 500)
          : null;

      const { userId, userCode } = getUserIdentity(req);
      if (!userId || userId <= 0) {
        return res.status(401).json({ error: "userId não encontrado no token" });
      }

      const pool = await getPool();

      // session_context em request separado (não vaza params)
      await trySetSessionContext(pool, userCode);

      // request limpo só para a proc
      const request = pool.request();
      request.input("AuthorId", sql.Int, authorId);
      request.input("Title", sql.NVarChar(500), title);
      request.input("Content", sql.NVarChar(sql.MAX), content);
      request.input("UserId", sql.Int, userId);
      request.input("UserCode", sql.NVarChar(100), userCode);

      const result = await request.execute("dbo.p_CreateMemory_WithVersion");
      res.status(201).json(result.recordset?.[0] || { ok: true });
    } catch (err) {
      console.error("[CREATE MEMORY]", err);
      res.status(500).json({
        error: "Falha ao criar memória",
        detail: err?.originalError?.info?.message || err?.message || "Erro interno",
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 404 + ERROR HANDLER
  // ---------------------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({
      error: "Not Found",
      path: req.path,
    });
  });

  app.use((err, _req, res, _next) => {
    console.error("[FATAL]", err);
    res.status(500).json({
      error: "Internal Server Error",
      detail: err?.message || "Erro interno",
    });
  });

  // ---------------------------------------------------------------------------
  // START
  // ---------------------------------------------------------------------------
  app.listen(PORT, () => {
    console.log(`HDUD API listening on :${PORT} (${APP_VERSION})`);
    console.log(
      `[DB] server=${process.env.DB_SERVER} db=${process.env.DB_DATABASE} user=${process.env.DB_USER}`
    );
  });
}

main().catch((err) => {
  console.error("[BOOT ERROR]", err);
  process.exit(1);
});
