// C:\HDUD_DATA\hdud-api-node\src\server.js

import express from "express";
import cors from "cors";

let helmet = null;
try {
  const mod = await import("helmet");
  helmet = mod?.default || null;
} catch {}

import authRouter from "./routes/auth.js";
import memoryRouter from "./routes/memory.js";
import memoriesRouter from "./routes/memories.js";
import authorsRouter from "./routes/authors.js";
import chaptersRouter from "./routes/chapters.js";

const PORT = process.env.PORT || 4000;

/**
 * Base interna (server-to-server) para o agregador /timeline.
 * NUNCA dependa do Host externo (ex.: localhost:5173 via Nginx),
 * pois dentro do container isso aponta para o container atual e pode dar "fetch failed".
 *
 * Você pode sobrescrever via env:
 *   SELF_BASE_URL=http://127.0.0.1:4000
 * ou (em docker) até:
 *   SELF_BASE_URL=http://hdud-api:4000
 */
const SELF_BASE_URL = process.env.SELF_BASE_URL || `http://127.0.0.1:${PORT}`;

const app = express();

if (helmet) {
  app.use(helmet({ contentSecurityPolicy: false }));
}

app.use(cors({ origin: "*" }));

// força UTF-8
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

app.use(express.json({ limit: "1mb" }));

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
// TIMELINE (CORE) — agregador unificado
// =======================
function pickFirstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function pickFirstId(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "number") return String(v);
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function parseJsonSafe(text) {
  try {
    // remove BOM se existir
    const cleaned = typeof text === "string" ? text.replace(/^\uFEFF/, "") : text;
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function asArray(payload) {
  // ✅ se veio como string (parse falhou antes), tenta parse aqui (defensivo)
  if (typeof payload === "string") {
    const parsed = parseJsonSafe(payload);
    if (parsed) return asArray(parsed);
    return [];
  }

  // ✅ array direto
  if (Array.isArray(payload)) return payload;

  // ✅ wrappers comuns
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;

  // ✅ HDUD shapes (memories/chapters)
  if (Array.isArray(payload?.memories)) return payload.memories;
  if (Array.isArray(payload?.chapters)) return payload.chapters;

  // ✅ wrappers aninhados (defensivo)
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload?.data?.memories)) return payload.data.memories;
  if (Array.isArray(payload?.data?.chapters)) return payload.data.chapters;

  return [];
}

function safeDateMs(value) {
  if (!value) return null;
  const d1 = new Date(value);
  if (!isNaN(d1.getTime())) return d1.getTime();
  const d2 = new Date(String(value).replace(" ", "T"));
  if (!isNaN(d2.getTime())) return d2.getTime();
  return null;
}

async function fetchJsonSafe(url, authHeader) {
  const headers = {};
  if (authHeader) headers.Authorization = authHeader;

  // timeout curto pra não travar o /timeline
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);

  try {
    const r = await fetch(url, { headers, signal: controller.signal });
    const text = await r.text();

    let data = null;
    try {
      // tenta parse normal
      data = text ? JSON.parse(text) : null;
    } catch {
      // ✅ fallback: tenta parse removendo BOM
      const parsed = parseJsonSafe(text);
      data = parsed !== null ? parsed : text;
    }

    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

function normalizeMemories(payload) {
  const list = asArray(payload);

  return list.map((m, idx) => {
    const id =
      pickFirstId(m, ["id", "memory_id", "id_memory", "identity_memory_id"]) ||
      `mem-${idx}`;
    const title =
      pickFirstString(m, ["title", "titulo", "name"]) || "(Memória sem título)";
    const note =
      pickFirstString(m, ["content", "conteudo", "text", "texto", "body"]) ||
      pickFirstString(m, ["description", "descricao", "summary", "resumo"]) ||
      "";

    const at =
      pickFirstString(m, [
        "created_at",
        "createdAt",
        "dt_created",
        "inserted_at",
        "datahora",
        "data_hora",
        "when",
        "at",
        "updated_at",
        "updatedAt",
      ]) || new Date().toISOString();

    return {
      id: `memory:${id}`,
      kind: "Memória",
      title,
      note: note || undefined,
      at,
      at_ms: safeDateMs(at),
      source: "memories",
      raw: m,
    };
  });
}

function normalizeChapters(payload) {
  const list = asArray(payload);

  return list.map((c, idx) => {
    const id =
      pickFirstId(c, ["id", "chapter_id", "id_chapter"]) || `chap-${idx}`;
    const title =
      pickFirstString(c, ["title", "titulo", "name"]) || "(Capítulo sem título)";
    const note =
      pickFirstString(c, ["description", "descricao", "summary", "resumo"]) ||
      pickFirstString(c, ["content", "conteudo", "text", "texto", "body"]) ||
      "";

    const at =
      pickFirstString(c, [
        "created_at",
        "createdAt",
        "dt_created",
        "inserted_at",
        "datahora",
        "data_hora",
        "when",
        "at",
        "updated_at",
        "updatedAt",
      ]) || new Date().toISOString();

    return {
      id: `chapter:${id}`,
      kind: "Capítulo",
      title,
      note: note || undefined,
      at,
      at_ms: safeDateMs(at),
      source: "chapters",
      raw: c,
    };
  });
}

// Endpoint unificado (CORE): agrega o que existir hoje (memories/chapters).
app.get("/timeline", async (req, res, next) => {
  try {
    const authHeader = req.headers?.authorization || null;

    // ✅ Base INTERNA fixa (não depende do Host externo / proxy)
    const base = SELF_BASE_URL;

    const warnings = [];
    const events = [];

    // MEMORIES — endpoint real conhecido
    const memCandidates = [`${base}/authors/1/memories`];
    let memOk = false;

    for (const url of memCandidates) {
      const r = await fetchJsonSafe(url, authHeader);
      if (r.ok) {
        const memEvents = normalizeMemories(r.data);
        events.push(...memEvents);

        // ✅ só marca ok se realmente gerou eventos
        memOk = memEvents.length > 0;

        if (!memOk) {
          warnings.push(`Memórias: endpoint OK, mas payload não virou lista (verifique shape/parse) em ${url}`);
        }
        break;
      } else {
        if ([401, 403, 404].includes(r.status)) {
          warnings.push(`Memórias: indisponível/sem acesso (${r.status}) em ${url}`);
        } else {
          warnings.push(`Memórias: erro HTTP ${r.status} em ${url}`);
        }
      }
    }
    if (!memOk) warnings.push("Memórias: não carregadas (nenhum evento normalizado).");

    // CHAPTERS — prioriza alias do frontend
    const chapCandidates = [`${base}/api/chapters`, `${base}/chapters`, `${base}/authors/1/chapters`];
    let chapOk = false;

    for (const url of chapCandidates) {
      const r = await fetchJsonSafe(url, authHeader);
      if (r.ok) {
        const chapEvents = normalizeChapters(r.data);
        events.push(...chapEvents);
        chapOk = chapEvents.length > 0;

        if (!chapOk) {
          warnings.push(`Capítulos: endpoint OK, mas payload não virou lista em ${url}`);
        }
        break;
      } else {
        if ([401, 403, 404].includes(r.status)) {
          warnings.push(`Capítulos: indisponível/sem acesso (${r.status}) em ${url}`);
        } else {
          warnings.push(`Capítulos: erro HTTP ${r.status} em ${url}`);
        }
      }
    }
    if (!chapOk) warnings.push("Capítulos: não carregados (nenhum evento normalizado).");

    // Ordenação cronológica desc (sem data válida vai pro fim)
    events.sort((a, b) => {
      const da = typeof a.at_ms === "number" ? a.at_ms : -Infinity;
      const db = typeof b.at_ms === "number" ? b.at_ms : -Infinity;
      return db - da;
    });

    return res.json({
      ok: true,
      items: events,
      warnings,
      meta: {
        sources: {
          memories: memOk,
          chapters: chapOk,
          versions: false,
          ledger: false,
        },
        generated_at: new Date().toISOString(),
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

// Health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", db: "connected", version: "HDUD-API-Node v0.6" });
});

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

// LISTEN (Docker-safe)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HDUD API listening on :${PORT}`);
});
