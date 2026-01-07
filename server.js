// server.js — HDUD API Core v0.6 (Hardened)

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


//

const PORT = process.env.PORT || 4000;

// ERRADO no Docker: app.listen(PORT, "127.0.0.1")
// CERTO:
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HDUD API listening on http://0.0.0.0:${PORT}`);
});


// PATH FIX — ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// Request ID
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Helmet
app.use(
  helmet({
    contentSecurityPolicy: isProd ? undefined : false,
    crossOriginEmbedderPolicy: false
  })
);

// CORS
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
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS_BLOCKED'));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id']
  })
);

// Rate limit
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: isProd ? 300 : 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false
  })
);

// JSON body
app.use(
  express.json({
    limit: '1mb',
    type: ['application/json', 'application/*+json']
  })
);

// Auth opcional
app.use(optionalAuth);

// Root amigável
app.get('/', (req, res) => {
  res.type('application/json; charset=utf-8').send({
    name: 'HDUD Core API',
    docs: '/docs/swagger',
    health: '/health'
  });
});

// Swagger
const openapiPath = path.join(__dirname, 'docs', 'openapi.yaml');
let openapiDocument = {};
try {
  openapiDocument = YAML.load(openapiPath);
} catch {
  openapiDocument = { openapi: '3.0.3', info: { title: 'HDUD Core API', version: '0.6.0' } };
}

app.use(
  '/docs/swagger',
  swaggerUi.serve,
  swaggerUi.setup(openapiDocument, { swaggerOptions: { persistAuthorization: true } })
);

app.get('/docs/openapi.json', (req, res) => {
  res.type('application/json; charset=utf-8').send(openapiDocument);
});

app.use('/docs', express.static(path.join(__dirname, 'docs')));

// Health
app.get('/health', async (req, res) => {
  try {
    await getPool();
    res.json({ status: 'ok', db: 'connected', version: 'HDUD-API-Node v0.6' });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// Rotas
app.use('/auth', authRouter);
app.use('/authors', authorsRouter);

// ⚠️ memoriesRouter montado NA RAIZ
app.use('/', memoriesRouter);

// 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
    request_id: req.id
  });
});

// Error handler
app.use((err, req, res, next) => {
  if (err && err.message === 'CORS_BLOCKED') {
    return res.status(403).json({ error: 'CORS blocked.', request_id: req.id });
  }
  console.error(`[ERR][${req.id}]`, err);
  res.status(500).json({ error: 'Internal Server Error', request_id: req.id });
});

app.listen(port, () => {
  console.log(`HDUD API v0.6 rodando em: http://localhost:${port}`);
});
