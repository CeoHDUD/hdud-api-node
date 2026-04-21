// C:\HDUD_DATA\hdud-api-node\src\workers\memory-image.worker.js

import path from "path";
import process from "process";
import fs from "fs/promises";
import sharp from "sharp";
import { Worker } from "bullmq";
import { getPool, sql } from "../db.js";
import { getRedisConnection } from "../queue/redis.js";
import { MEMORY_IMAGE_QUEUE_NAME } from "../queue/memory-image.queue.js";

const WORKER_CONCURRENCY = Number(
  process.env.MEMORY_IMAGE_WORKER_CONCURRENCY || 2
);

const PUBLIC_DIR = path.join(process.cwd(), "public");

const FEED_WIDTH = 1200;
const FEED_HEIGHT = 1500; // 4:5
const THUMB_SIZE = 400;

console.log("[WORKER][MEMORY_IMAGE] starting...", {
  queue: MEMORY_IMAGE_QUEUE_NAME,
  concurrency: WORKER_CONCURRENCY,
  publicDir: PUBLIC_DIR,
  feedVariant: `${FEED_WIDTH}x${FEED_HEIGHT}`,
});

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function classifyOrientation(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);

  if (!(w > 0) || !(h > 0)) return "unknown";

  const ratio = w / h;
  if (ratio > 2) return "panoramic";
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.85) return "portrait";
  return "square";
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
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

function buildImagePaths(baseDir) {
  return {
    original: path.join(baseDir, "original.jpg"),
    feed: path.join(baseDir, "feed.jpg"),
    thumb: path.join(baseDir, "thumb.jpg"),
  };
}

function buildOriginalStoragePath(authorId, memoryId, mediaId) {
  return `memory-media/${String(authorId)}/memory_${String(
    memoryId
  )}/media_${String(mediaId)}/original.jpg`;
}

async function getColumns(pool, schemaName, tableName) {
  const result = await pool
    .request()
    .input("schema_name", sql.NVarChar(128), schemaName)
    .input("table_name", sql.NVarChar(128), tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema_name
        AND TABLE_NAME = @table_name
    `);

  return new Set((result.recordset || []).map((r) => String(r.COLUMN_NAME)));
}

async function updateMemoryMedia(pool, mediaId, payload) {
  const columns = await getColumns(pool, "dbo", "identity_memory_media");
  const request = pool.request().input("media_id", sql.BigInt, Number(mediaId));
  const assignments = [];

  function setIfColumn(column, inputName, sqlType, value) {
    if (!columns.has(column) || value === undefined) return;
    assignments.push(`[${column}] = @${inputName}`);
    request.input(inputName, sqlType, value);
  }

  setIfColumn("storage_path", "storage_path", sql.NVarChar(500), payload.storage_path);
  setIfColumn("updated_at", "updated_at", sql.DateTime2, payload.updated_at);

  if (columns.has("image_width") && payload.image_width !== undefined) {
    assignments.push("[image_width] = @image_width");
    request.input("image_width", sql.Int, payload.image_width);
  }

  if (columns.has("image_height") && payload.image_height !== undefined) {
    assignments.push("[image_height] = @image_height");
    request.input("image_height", sql.Int, payload.image_height);
  }

  if (columns.has("image_aspect_ratio") && payload.image_aspect_ratio !== undefined) {
    assignments.push("[image_aspect_ratio] = @image_aspect_ratio");
    request.input("image_aspect_ratio", sql.Decimal(10, 4), payload.image_aspect_ratio);
  }

  if (columns.has("image_orientation") && payload.image_orientation !== undefined) {
    assignments.push("[image_orientation] = @image_orientation");
    request.input("image_orientation", sql.VarChar(20), payload.image_orientation);
  }

  if (columns.has("processed") && payload.processed !== undefined) {
    assignments.push("[processed] = @processed");
    request.input("processed", sql.Bit, payload.processed ? 1 : 0);
  }

  if (columns.has("processing_status") && payload.processing_status !== undefined) {
    assignments.push("[processing_status] = @processing_status");
    request.input("processing_status", sql.VarChar(30), payload.processing_status);
  }

  if (columns.has("status") && payload.status !== undefined) {
    assignments.push("[status] = @status");
    request.input("status", sql.VarChar(30), payload.status);
  }

  if (columns.has("transcription_status") && payload.transcription_status !== undefined) {
    assignments.push("[transcription_status] = @transcription_status");
    request.input("transcription_status", sql.VarChar(30), payload.transcription_status);
  }

  if (!assignments.length) return;

  await request.query(`
    UPDATE dbo.identity_memory_media
    SET ${assignments.join(", ")}
    WHERE media_id = @media_id;
  `);
}

async function updateMemoryPhotoUrl(pool, memoryId, authorId) {
  const photoUrl = `/cdn/memories/${authorId}/${memoryId}`;

  await pool
    .request()
    .input("memory_id", sql.Int, Number(memoryId))
    .input("photo_url", sql.NVarChar(1000), photoUrl)
    .query(`
      UPDATE dbo.identity_memory
      SET photo_url = @photo_url
      WHERE memory_id = @memory_id;
    `);
}

async function updateMemoryImageMeta(pool, memoryId, meta) {
  const columns = await getColumns(pool, "dbo", "identity_memory");
  const request = pool.request().input("memory_id", sql.Int, Number(memoryId));
  const assignments = [];

  if (columns.has("image_width")) {
    assignments.push("image_width = @image_width");
    request.input("image_width", sql.Int, meta.width);
  }

  if (columns.has("image_height")) {
    assignments.push("image_height = @image_height");
    request.input("image_height", sql.Int, meta.height);
  }

  if (columns.has("image_aspect_ratio")) {
    assignments.push("image_aspect_ratio = @image_aspect_ratio");
    request.input("image_aspect_ratio", sql.Decimal(10, 4), meta.aspect_ratio);
  }

  if (columns.has("image_orientation")) {
    assignments.push("image_orientation = @image_orientation");
    request.input("image_orientation", sql.VarChar(20), meta.orientation);
  }

  if (!assignments.length) return;

  await request.query(`
    UPDATE dbo.identity_memory
    SET ${assignments.join(", ")}
    WHERE memory_id = @memory_id;
  `);
}

async function renderFeedVariant(buffer) {
  const base = sharp(buffer, { failOn: "none" }).rotate();

  const background = await base
    .clone()
    .resize(FEED_WIDTH, FEED_HEIGHT, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    })
    .blur(18)
    .modulate({
      brightness: 0.96,
      saturation: 1.04,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const foreground = await base
    .clone()
    .resize(FEED_WIDTH - 72, FEED_HEIGHT - 72, {
      fit: "contain",
      position: "centre",
      withoutEnlargement: true,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp(background)
    .composite([{ input: foreground, gravity: "centre" }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

async function processJob(job) {
  const mediaId = toInt(job?.data?.mediaId);
  const memoryId = toInt(job?.data?.memoryId);
  const authorId = toInt(job?.data?.authorId);
  const tempFilePath = normalizeString(job?.data?.tempFilePath);

  if (!mediaId || !memoryId || !authorId) {
    throw new Error("Job de imagem inválido: mediaId/memoryId/authorId obrigatórios.");
  }

  if (!tempFilePath) {
    throw new Error("Job de imagem inválido: tempFilePath ausente.");
  }

  console.log("[WORKER][MEMORY_IMAGE] processing", {
    jobId: job?.id,
    mediaId,
    memoryId,
    authorId,
    tempFilePath,
  });

  const pool = await getPool();

  const baseDir = memoryMediaFolder(authorId, memoryId, mediaId);
  await ensureDir(baseDir);

  const paths = buildImagePaths(baseDir);
  const buffer = await fs.readFile(tempFilePath);

  const source = sharp(buffer, { failOn: "none" }).rotate();
  const metadata = await source.metadata();

  const width = Number(metadata?.width || 0) || null;
  const height = Number(metadata?.height || 0) || null;
  const aspectRatio =
    width && height ? Number((width / height).toFixed(4)) : null;
  const orientation = classifyOrientation(width, height);

  await source
    .clone()
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(paths.original);

  const feedBuffer = await renderFeedVariant(buffer);
  await fs.writeFile(paths.feed, feedBuffer);

  await source
    .clone()
    .resize(THUMB_SIZE, THUMB_SIZE, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(paths.thumb);

  await updateMemoryMedia(pool, mediaId, {
    storage_path: buildOriginalStoragePath(authorId, memoryId, mediaId),
    updated_at: new Date(),
    processed: true,
    processing_status: "processed",
    status: "processed",
    image_width: width,
    image_height: height,
    image_aspect_ratio: aspectRatio,
    image_orientation: orientation,
  });

  await updateMemoryPhotoUrl(pool, memoryId, authorId);

  await updateMemoryImageMeta(pool, memoryId, {
    width,
    height,
    aspect_ratio: aspectRatio,
    orientation,
  });

  try {
    await fs.unlink(tempFilePath);
  } catch {}

  console.log("[WORKER][MEMORY_IMAGE] done", {
    jobId: job?.id,
    mediaId,
    memoryId,
    authorId,
  });

  return {
    ok: true,
    mediaId,
    memoryId,
    authorId,
  };
}

const worker = new Worker(MEMORY_IMAGE_QUEUE_NAME, processJob, {
  connection: getRedisConnection(),
  concurrency: WORKER_CONCURRENCY,
});

worker.on("completed", (job) => {
  console.log("[WORKER][MEMORY_IMAGE] completed", {
    jobId: job?.id,
    mediaId: job?.data?.mediaId,
    memoryId: job?.data?.memoryId,
  });
});

worker.on("failed", async (job, err) => {
  console.error("[WORKER][MEMORY_IMAGE] failed", {
    jobId: job?.id,
    mediaId: job?.data?.mediaId,
    memoryId: job?.data?.memoryId,
    error: err?.message || err,
  });

  try {
    const mediaId = toInt(job?.data?.mediaId);
    if (!mediaId) return;

    const pool = await getPool();
    await updateMemoryMedia(pool, mediaId, {
      updated_at: new Date(),
      processing_status: "failed",
      status: "failed",
      transcription_status: "failed",
    });
  } catch (updateErr) {
    console.error("[WORKER][MEMORY_IMAGE] failed status update error", {
      jobId: job?.id,
      error: updateErr?.message || updateErr,
    });
  }
});

export default worker;