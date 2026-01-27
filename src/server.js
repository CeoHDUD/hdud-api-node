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
// LOG
// =======================
console.log("[ROUTE] OK /auth");
console.log("[ROUTE] OK /chapters");
console.log("[ROUTE] OK /api/chapters");
console.log("[ROUTE] OK /memory");
console.log("[ROUTE] OK /");
console.log("[ROUTE] OK /authors");

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
