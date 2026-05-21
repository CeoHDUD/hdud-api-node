// C:\HDUD_DATA\hdud-api-node\src\workers\memory-image.worker.js

import path from "path";
import process from "process";
import fs from "fs/promises";
import sharp from "sharp";
import { Worker } from "bullmq";
import { getPool, sql } from "../db.js";
import { getRedisConnection } from "../queue/redis.js";
import { MEMORY_IMAGE_QUEUE_NAME } from "../queue/memory-image.queue.js";

const WORKER_CONCURRENCY = Number(process.env.MEMORY_IMAGE_WORKER_CONCURRENCY || 2);

const PUBLIC_DIR = path.join(process.cwd(), "public");

const FEED_WIDTH = Number(process.env.MEMORY_IMAGE_FEED_WIDTH || 1080);
const FEED_HEIGHT = Number(process.env.MEMORY_IMAGE_FEED_HEIGHT || 1350);
const THUMB_SIZE = Number(process.env.MEMORY_IMAGE_THUMB_SIZE || 500);

const CLEAN_CANVAS_BG = Object.freeze({ r: 242, g: 242, b: 244 });

const FEED_CANVAS = Object.freeze({
  portrait: {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    mode: "portrait_editorial",
    inset: Number(process.env.MEMORY_IMAGE_FEED_PORTRAIT_INSET || 0),
    foregroundFit: "cover",
    backgroundBlur: 14,
    backgroundBrightness: 1.0,
    backgroundSaturation: 0.96,
    cleanCanvas: false,
  },
  landscape: {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    mode: "landscape_contain",
    inset: Number(process.env.MEMORY_IMAGE_FEED_LANDSCAPE_INSET || 72),
    foregroundFit: "contain",
    backgroundBlur: 18,
    backgroundBrightness: 1.03,
    backgroundSaturation: 0.9,
    cleanCanvas: false,
  },
  square: {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    mode: "square_clean_canvas",
    inset: Number(process.env.MEMORY_IMAGE_FEED_SQUARE_INSET || 96),
    foregroundFit: "contain",
    backgroundBlur: 0,
    backgroundBrightness: 1,
    backgroundSaturation: 1,
    cleanCanvas: true,
  },
  panoramic: {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    mode: "panoramic_contain",
    inset: Number(process.env.MEMORY_IMAGE_FEED_PANORAMIC_INSET || 108),
    foregroundFit: "contain",
    backgroundBlur: 20,
    backgroundBrightness: 1.04,
    backgroundSaturation: 0.88,
    cleanCanvas: false,
  },
  collage: {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    mode: "collage_clean_canvas",
    inset: Number(process.env.MEMORY_IMAGE_FEED_COLLAGE_INSET || 36),
    foregroundFit: "contain",
    backgroundBlur: 0,
    backgroundBrightness: 1,
    backgroundSaturation: 1,
    cleanCanvas: true,
  },
  logo: {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    mode: "logo_clean_canvas",
    inset: Number(process.env.MEMORY_IMAGE_FEED_LOGO_INSET || 140),
    foregroundFit: "contain",
    backgroundBlur: 0,
    backgroundBrightness: 1,
    backgroundSaturation: 1,
    cleanCanvas: true,
  },
  unknown: {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    mode: "unknown_clean_canvas",
    inset: Number(process.env.MEMORY_IMAGE_FEED_UNKNOWN_INSET || 96),
    foregroundFit: "contain",
    backgroundBlur: 0,
    backgroundBrightness: 1,
    backgroundSaturation: 1,
    cleanCanvas: true,
  },
});

console.log("[WORKER][MEMORY_IMAGE] starting...", {
  queue: MEMORY_IMAGE_QUEUE_NAME,
  concurrency: WORKER_CONCURRENCY,
  publicDir: PUBLIC_DIR,
  feedVariant: `${FEED_WIDTH}x${FEED_HEIGHT}`,
  contract: "smart-media-pipeline-v1.1-clean-canvas",
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

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.trunc(n), max));
}

function classifyGeometry(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  if (!(w > 0) || !(h > 0)) return "unknown";

  const ratio = w / h;

  if (ratio >= 2.05) return "panoramic";
  if (ratio > 1.15) return "landscape";
  if (ratio <= 0.9) return "portrait";
  return "square";
}

function resolveFeedCanvas(kind = "unknown") {
  const key = String(kind || "unknown").toLowerCase();
  const canvas = FEED_CANVAS[key] || FEED_CANVAS.unknown;

  return {
    ...canvas,
    width: clampInt(canvas.width, 320, 3000, FEED_WIDTH),
    height: clampInt(canvas.height, 320, 3000, FEED_HEIGHT),
    inset: clampInt(canvas.inset, 0, 260, 96),
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function memoryMediaFolder(authorId, memoryId, mediaId) {
  return path.join(PUBLIC_DIR, "memory-media", String(authorId), `memory_${memoryId}`, `media_${mediaId}`);
}

function buildImagePaths(baseDir) {
  return {
    original: path.join(baseDir, "original.jpg"),
    feed: path.join(baseDir, "feed.jpg"),
    thumb: path.join(baseDir, "thumb.jpg"),
  };
}

function buildOriginalStoragePath(authorId, memoryId, mediaId) {
  return `memory-media/${String(authorId)}/memory_${String(memoryId)}/media_${String(mediaId)}/original.jpg`;
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
    request.input("image_orientation", sql.VarChar(30), payload.image_orientation);
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
    request.input("image_orientation", sql.VarChar(30), meta.orientation);
  }

  if (!assignments.length) return;

  await request.query(`
    UPDATE dbo.identity_memory
    SET ${assignments.join(", ")}
    WHERE memory_id = @memory_id;
  `);
}

async function computeVisualScore(buffer, geometry) {
  const stats = await sharp(buffer, { failOn: "none" })
    .rotate()
    .resize(96, 96, { fit: "fill", kernel: sharp.kernel.nearest })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const raw = stats.data;
  const channels = stats.info.channels || 3;
  const width = 96;
  const height = 96;
  const rowEdges = [];
  const colEdges = [];

  function px(index) {
    const base = index * channels;
    return (raw[base] + raw[base + 1] + raw[base + 2]) / 3;
  }

  for (let y = 1; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += Math.abs(px(y * width + x) - px((y - 1) * width + x));
    }
    rowEdges.push(sum / width);
  }

  for (let x = 1; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      sum += Math.abs(px(y * width + x) - px(y * width + x - 1));
    }
    colEdges.push(sum / height);
  }

  const avgRow = rowEdges.reduce((a, b) => a + b, 0) / Math.max(1, rowEdges.length);
  const avgCol = colEdges.reduce((a, b) => a + b, 0) / Math.max(1, colEdges.length);

  const hardRows = rowEdges.filter((v) => v >= Math.max(28, avgRow * 2.1)).length;
  const hardCols = colEdges.filter((v) => v >= Math.max(28, avgCol * 2.1)).length;

  const centralVerticalEdges = colEdges.filter((v, idx) => idx > 22 && idx < 73 && v >= Math.max(24, avgCol * 1.85)).length;
  const centralHorizontalEdges = rowEdges.filter((v, idx) => idx > 22 && idx < 73 && v >= Math.max(24, avgRow * 1.85)).length;

  const gridScore =
    hardRows * 1.25 +
    hardCols * 1.25 +
    centralVerticalEdges * 1.6 +
    centralHorizontalEdges * 1.6;

  const imageStats = await sharp(buffer, { failOn: "none" }).rotate().stats();
  const channelsStats = imageStats.channels || [];
  const avgR = channelsStats[0]?.mean ?? 0;
  const avgG = channelsStats[1]?.mean ?? 0;
  const avgB = channelsStats[2]?.mean ?? 0;
  const stdR = channelsStats[0]?.stdev ?? 0;
  const stdG = channelsStats[1]?.stdev ?? 0;
  const stdB = channelsStats[2]?.stdev ?? 0;

  const avgBrightness = (avgR + avgG + avgB) / 3;
  const avgStd = (stdR + stdG + stdB) / 3;

  const collageMode =
    gridScore >= 18 ||
    (geometry === "square" && hardRows + hardCols >= 8) ||
    (geometry === "landscape" && centralVerticalEdges + centralHorizontalEdges >= 8);

  const logoLike =
    !collageMode &&
    (geometry === "square" || geometry === "portrait") &&
    avgBrightness >= 170 &&
    avgStd <= 92 &&
    hardRows + hardCols <= 12;

  return {
    collageMode,
    logoLike,
    gridScore: Number(gridScore.toFixed(2)),
    hardRows,
    hardCols,
    centralVerticalEdges,
    centralHorizontalEdges,
    avgBrightness: Number(avgBrightness.toFixed(2)),
    avgStd: Number(avgStd.toFixed(2)),
  };
}

function classifySmartMedia({ geometry, visualScore }) {
  if (visualScore?.collageMode) return "collage";
  if (visualScore?.logoLike) return "logo";
  return geometry || "unknown";
}

async function renderBlurredBackground(base, canvas) {
  return base
    .clone()
    .resize(canvas.width, canvas.height, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .blur(canvas.backgroundBlur)
    .modulate({
      brightness: canvas.backgroundBrightness,
      saturation: canvas.backgroundSaturation,
    })
    .jpeg({
      quality: 86,
      mozjpeg: true,
      chromaSubsampling: "4:2:0",
    })
    .toBuffer();
}

async function renderCleanCanvas(canvas) {
  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 3,
      background: CLEAN_CANVAS_BG,
    },
  })
    .jpeg({
      quality: 92,
      mozjpeg: true,
      chromaSubsampling: "4:2:0",
    })
    .toBuffer();
}

async function renderForeground(base, canvas) {
  const maxWidth = Math.max(240, canvas.width - canvas.inset * 2);
  const maxHeight = Math.max(240, canvas.height - canvas.inset * 2);

  const fit = canvas.foregroundFit === "cover" ? "cover" : "contain";

  return base
    .clone()
    .resize(maxWidth, maxHeight, {
      fit,
      position: "centre",
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .sharpen({
      sigma: 0.38,
      m1: 0.54,
      m2: 1.06,
    })
    .png()
    .toBuffer();
}

async function renderFeedVariant(buffer, smartKind = "unknown") {
  const base = sharp(buffer, { failOn: "none" }).rotate();
  const canvas = resolveFeedCanvas(smartKind);

  const foreground = await renderForeground(base, canvas);

  const background = canvas.cleanCanvas
    ? await renderCleanCanvas(canvas)
    : await renderBlurredBackground(base, canvas);

  const output = await sharp(background)
    .composite([{ input: foreground, gravity: "centre" }])
    .jpeg({
      quality: 91,
      mozjpeg: true,
      chromaSubsampling: "4:2:0",
    })
    .toBuffer();

  return {
    buffer: output,
    canvas,
  };
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
  const aspectRatio = width && height ? Number((width / height).toFixed(4)) : null;

  const geometry = classifyGeometry(width, height);
  const visualScore = await computeVisualScore(buffer, geometry);
  const smartKind = classifySmartMedia({ geometry, visualScore });

  await source
    .clone()
    .jpeg({
      quality: 96,
      mozjpeg: true,
      chromaSubsampling: "4:4:4",
    })
    .toFile(paths.original);

  const feedVariant = await renderFeedVariant(buffer, smartKind);
  await fs.writeFile(paths.feed, feedVariant.buffer);

  await source
    .clone()
    .resize(THUMB_SIZE, THUMB_SIZE, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    })
    .jpeg({
      quality: 88,
      mozjpeg: true,
      chromaSubsampling: "4:4:4",
    })
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
    image_orientation: smartKind,
  });

  await updateMemoryPhotoUrl(pool, memoryId, authorId);

  await updateMemoryImageMeta(pool, memoryId, {
    width,
    height,
    aspect_ratio: aspectRatio,
    orientation: smartKind,
  });

  try {
    await fs.unlink(tempFilePath);
  } catch {}

  console.log("[WORKER][MEMORY_IMAGE] done", {
    jobId: job?.id,
    mediaId,
    memoryId,
    authorId,
    geometry,
    smartKind,
    collageMode: visualScore.collageMode,
    logoLike: visualScore.logoLike,
    gridScore: visualScore.gridScore,
    feedCanvas: `${feedVariant.canvas.width}x${feedVariant.canvas.height}`,
    mode: feedVariant.canvas.mode,
    cleanCanvas: feedVariant.canvas.cleanCanvas,
  });

  return {
    ok: true,
    mediaId,
    memoryId,
    authorId,
    source: {
      width,
      height,
      aspectRatio,
      geometry,
    },
    visualScore,
    feedVariant: {
      width: feedVariant.canvas.width,
      height: feedVariant.canvas.height,
      inset: feedVariant.canvas.inset,
      kind: smartKind,
      mode: feedVariant.canvas.mode,
      cleanCanvas: feedVariant.canvas.cleanCanvas,
      contract: "smart-media-pipeline-v1.1-clean-canvas",
    },
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