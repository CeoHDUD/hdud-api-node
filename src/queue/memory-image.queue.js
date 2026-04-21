// C:\HDUD_DATA\hdud-api-node\src\queue\memory-image.queue.js

import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";

export const MEMORY_IMAGE_QUEUE_NAME =
  process.env.MEMORY_IMAGE_QUEUE_NAME || "memory-image-processing";

let queueInstance = null;

export function getMemoryImageQueue() {
  if (queueInstance) return queueInstance;

  queueInstance = new Queue(MEMORY_IMAGE_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: Number(process.env.MEMORY_IMAGE_QUEUE_ATTEMPTS || 3),
      backoff: {
        type: "exponential",
        delay: Number(process.env.MEMORY_IMAGE_QUEUE_BACKOFF_MS || 5000),
      },
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  });

  return queueInstance;
}

export function buildMemoryImageJobId(mediaId) {
  return `memory-image_${Number(mediaId)}`;
}

export async function enqueueMemoryImageProcessingJob({
  memoryId,
  mediaId,
  authorId,
  userId = null,
  mimeType = null,
  originalFileName = null,
  requestedVariant = "feed",
  tempFilePath = null,
}) {
  const queue = getMemoryImageQueue();

  return queue.add(
    "process",
    {
      memoryId: Number(memoryId),
      mediaId: Number(mediaId),
      authorId: Number(authorId),
      userId:
        userId == null || Number.isNaN(Number(userId)) ? null : Number(userId),
      mimeType:
        mimeType == null || !String(mimeType).trim()
          ? null
          : String(mimeType).trim().toLowerCase(),
      originalFileName:
        originalFileName == null || !String(originalFileName).trim()
          ? null
          : String(originalFileName).trim(),
      requestedVariant:
        requestedVariant == null || !String(requestedVariant).trim()
          ? "feed"
          : String(requestedVariant).trim().toLowerCase(),
      tempFilePath:
        tempFilePath == null || !String(tempFilePath).trim()
          ? null
          : String(tempFilePath).trim(),
      requestedAt: new Date().toISOString(),
    },
    {
      jobId: buildMemoryImageJobId(mediaId),
    }
  );
}