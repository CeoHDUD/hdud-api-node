// server.js — HDUD API Core v0.6 (Hardened)
// Segurança + Observabilidade (sem quebrar contratos)
// Mantém: /auth, /authors, /memories..., /docs/swagger, /docs/openapi.json, /health

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import YAML from 'yamljs';
import swaggerUi from 'swagger-ui-express';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { optionalAuth } from './middleware/auth.js';

import authRouter from './routes/auth.js';
import authorsRouter from './routes/authors.js';
import memoriesRouter from './routes/memories.js';

import { getPool } from './db.js';

// ============================================================
// 🔧 PATH FIX — necessário para ESM
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 🔧 CONFIG BÁSICA
// ============================================================
dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// ============================================================
// 🧾 Request ID (observabilidade mínima)
// ============================================================
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// ============================================================
// 🛡️ Security headers (Helmet)
// ============================================================
app.use(
  helmet({
    // Swagger usa recursos inline; em dev é comum relaxar CSP
    contentSecurityPolicy: isProd ? undefined : false,
    crossOriginEmbedderPolicy: false
  })
);

// ============================================================
// 🌍 CORS (controle explícito)
// - Em produção, defina HDUD_CORS_ORIGINS="https://seu-dominio.com,https://app.seu-dominio.com"
// - Em dev, libera localhost
// ============================================================
const defaultDevOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4000',
  'http://127.0.0.1:4000'
];

const envOrigins = (process.env.HDUD_CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowedOrigins = envOrigins.length ? envOrigins : defaultDevOrigins;

app.use(
  cors({
    origin: (origin, cb) => {
      // Permite chamadas sem Origin (ex: curl, Postman, server-to-server)
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes(origin)) return cb(null, true);

      return cb(new Error('CORS_BLOCKED'));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id']
  })
);

// ============================================================
// 🧯 Rate limit (leve)
// ============================================================
app.use(
  rateLimit({
    windowMs: 60_000, // 1 min
    limit: isProd ? 300 : 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false
  })
);

// ============================================================
// 📦 Body parser (UTF-8 + limite)
// ============================================================
app.use(
  express.json({
    limit: '1mb',
    type: ['application/json', 'application/*+json']
  })
);

// ============================================================
// 🔐 Auth opcional
// ============================================================
app.use(optionalAuth);

// ============================================================
// 📘 CARREGAR OPENAPI (YAML)
// ============================================================
const openapiPath = path.join(__dirname, 'docs', 'openapi.yaml');
console.log('Carregando OpenAPI em:', openapiPath);

let openapiDocument = {};
try {
  openapiDocument = YAML.load(openapiPath);
} catch (err) {
  console.error('❌ ERRO ao carregar openapi.yaml:', err.message);

  openapiDocument = {
    openapi: '3.0.3',
    info: {
      title: 'HDUD Core API',
      version: '0.6.0',
      description: 'Falha ao carregar openapi.yaml. Verifique src/docs/openapi.yaml.'
    }
  };
}

// ============================================================
// 📚 SWAGGER / OPENAPI
// ============================================================

// Swagger UI — /docs/swagger
app.use('/docs/swagger', swaggerUi.serve, swaggerUi.setup(openapiDocument));

// OpenAPI JSON — /docs/openapi.json
app.get('/docs/openapi.json', (req, res) => {
  res.type('application/json; charset=utf-8').send(openapiDocument);
});

// Docs estáticos — /docs
app.use('/docs', express.static(path.join(__dirname, 'docs')));

// ============================================================
// ❤️ HEALTH CHECK
// ============================================================
app.get('/health', async (req, res) => {
  try {
    await getPool();
    res.json({ status: 'ok', db: 'connected', version: 'HDUD-API-Node v0.6' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ============================================================
// 🌐 ROTAS DA APLICAÇÃO
// ============================================================

app.use('/auth', authRouter);
app.use('/authors', authorsRouter);

// memoriesRouter define paths: /authors/:id/memories, /memories/:id, etc.
app.use('/', memoriesRouter);

// ============================================================
// 🧯 404 handler
// ============================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
    request_id: req.id
  });
});

// ============================================================
// 🧯 Error handler padronizado
// ============================================================
app.use((err, req, res, next) => {
  // CORS
  if (err && err.message === 'CORS_BLOCKED') {
    return res.status(403).json({
      error: 'CORS blocked for this origin.',
      request_id: req.id
    });
  }

  // JSON parse error
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      error: 'Invalid JSON body.',
      request_id: req.id
    });
  }

  console.error(`[ERR][${req.id}]`, err);

  res.status(500).json({
    error: 'Internal Server Error',
    request_id: req.id
  });
});

// ============================================================
// 🚀 START SERVER
// ============================================================
app.listen(port, () => {
  console.log(`HDUD API v0.6 (hardened) rodando em: http://localhost:${port}`);
  console.log(`Swagger UI:   http://localhost:${port}/docs/swagger`);
  console.log(`OpenAPI JSON: http://localhost:${port}/docs/openapi.json`);
  console.log(`Docs (HTML):  http://localhost:${port}/docs/`);
});
