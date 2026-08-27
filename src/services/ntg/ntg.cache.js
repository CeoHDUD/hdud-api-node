import { getRedisConnection } from "../../queue/redis.js";

const memoryCache = new Map();
const DEFAULT_TTL_SECONDS = Math.max(30, Number(process.env.NTG_CACHE_TTL_SECONDS || 900));
const REDIS_PREFIX = String(process.env.NTG_CACHE_PREFIX || "hdud:ntg:v1").trim();
const REDIS_ENABLED = String(process.env.NTG_CACHE_REDIS_ENABLED || "true").toLowerCase() !== "false";
const REDIS_TIMEOUT_MS = Math.max(50, Number(process.env.NTG_CACHE_REDIS_TIMEOUT_MS || 250));

function now() {
  return Date.now();
}

function redisKey(key) {
  return `${REDIS_PREFIX}:${key}`;
}

function withTimeout(promise, timeoutMs = REDIS_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Redis timeout")), timeoutMs)),
  ]);
}

function getMemory(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function setMemory(key, value, ttlSeconds) {
  memoryCache.set(key, {
    value,
    expiresAt: now() + ttlSeconds * 1000,
  });
}

async function getRedis(key) {
  if (!REDIS_ENABLED) return null;
  try {
    const redis = getRedisConnection();
    const raw = await withTimeout(redis.get(redisKey(key)));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setRedis(key, value, ttlSeconds) {
  if (!REDIS_ENABLED) return;
  try {
    const redis = getRedisConnection();
    await withTimeout(redis.set(redisKey(key), JSON.stringify(value), "EX", ttlSeconds));
  } catch {}
}

export async function getCached(key) {
  const memoryValue = getMemory(key);
  if (memoryValue !== null) return { hit: true, source: "memory", value: memoryValue };

  const redisValue = await getRedis(key);
  if (redisValue !== null) {
    setMemory(key, redisValue, DEFAULT_TTL_SECONDS);
    return { hit: true, source: "redis", value: redisValue };
  }

  return { hit: false, source: null, value: null };
}

export async function setCached(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const ttl = Math.max(30, Number(ttlSeconds || DEFAULT_TTL_SECONDS));
  setMemory(key, value, ttl);
  await setRedis(key, value, ttl);
  return value;
}

export async function cached(key, loader, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const existing = await getCached(key);
  if (existing.hit) return { value: existing.value, cache: existing.source };

  const value = await loader();
  await setCached(key, value, ttlSeconds);
  return { value, cache: "miss" };
}

export async function invalidateNtgCache() {
  memoryCache.clear();
  if (!REDIS_ENABLED) return;

  try {
    const redis = getRedisConnection();
    let cursor = "0";
    do {
      const [nextCursor, keys] = await withTimeout(
        redis.scan(cursor, "MATCH", `${REDIS_PREFIX}:*`, "COUNT", 100)
      );
      cursor = nextCursor;
      if (keys.length) await withTimeout(redis.del(...keys));
    } while (cursor !== "0");
  } catch {}
}

export function getNtgCacheSettings() {
  return {
    ttl_seconds: DEFAULT_TTL_SECONDS,
    redis_enabled: REDIS_ENABLED,
    prefix: REDIS_PREFIX,
  };
}
