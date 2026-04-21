// C:\HDUD_DATA\hdud-api-node\src\queue\memory-audio.queue.js

import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";

export const MEMORY_AUDIO_QUEUE_NAME =
  process.env.MEMORY_AUDIO_QUEUE_NAME || "memory-audio-transcription";

let queueInstance = null;

export function getMemoryAudioQueue() {
  if (queueInstance) return queueInstance;

  queueInstance = new Queue(MEMORY_AUDIO_QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: Number(process.env.MEMORY_AUDIO_QUEUE_ATTEMPTS || 3),
      backoff: {
        type: "exponential",
        delay: Number(process.env.MEMORY_AUDIO_QUEUE_BACKOFF_MS || 5000),
      },
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  });

  return queueInstance;
}

export function buildMemoryAudioJobId(mediaId) {
  return `memory-audio_${Number(mediaId)}`;
}

export async function enqueueMemoryAudioTranscriptionJob({
  memoryId,
  mediaId,
  authorId,
  userId = null,
  audioSeconds = null,
  planCode = null,
}) {
  const queue = getMemoryAudioQueue();

  return queue.add(
    "transcribe",
    {
      memoryId: Number(memoryId),
      mediaId: Number(mediaId),
      authorId: Number(authorId),
      userId:
        userId == null || Number.isNaN(Number(userId)) ? null : Number(userId),
      audioSeconds:
        audioSeconds == null || Number.isNaN(Number(audioSeconds))
          ? null
          : Number(audioSeconds),
      planCode:
        planCode == null || !String(planCode).trim()
          ? null
          : String(planCode).trim().toUpperCase(),
      requestedAt: new Date().toISOString(),
    },
    {
      jobId: buildMemoryAudioJobId(mediaId),
    }
  );
}