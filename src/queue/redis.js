// C:\HDUD_DATA\hdud-api-node\src\queue\redis.js

import IORedis from "ioredis";

let redisConnection = null;

export function getRedisConnection() {
  if (redisConnection) return redisConnection;

  const host = process.env.REDIS_HOST || "redis";
  const port = Number(process.env.REDIS_PORT || 6379);

  redisConnection = new IORedis({
    host,
    port,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redisConnection.on("connect", () => {
    console.log(`[QUEUE][REDIS] connected ${host}:${port}`);
  });

  redisConnection.on("error", (err) => {
    console.error("[QUEUE][REDIS] error:", err?.message || err);
  });

  return redisConnection;
}

export async function closeRedisConnection() {
  if (!redisConnection) return;
  try {
    await redisConnection.quit();
  } catch {
    try {
      redisConnection.disconnect();
    } catch {}
  } finally {
    redisConnection = null;
  }
}