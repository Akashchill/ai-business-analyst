/**
 * Cache-aside store for analytics/RAG agent results.
 * Exact-match on a normalized question; fail-open when Redis is unavailable.
 */
import { createHash } from 'crypto';
import { getRedis } from '../config/redis.js';

export const QUERY_KEY_PREFIX = 'query:';
export const QUERY_INDEX_KEY = 'query:index';
export const MAX_CACHEABLE_ROWS = 200;
export const MAX_CACHEABLE_BYTES = 512 * 1024;

const jsonReplacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

export function getTtlSeconds() {
  const n = Number(process.env.QUERY_CACHE_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

export function getMaxKeys() {
  const n = Number(process.env.QUERY_CACHE_MAX_KEYS);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

export function normalizeQuestion(question) {
  return String(question || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\?+$/g, '');
}

export function cacheKey(question, dbType = 'postgresql') {
  const hash = createHash('sha256').update(normalizeQuestion(question)).digest('hex');
  return `${QUERY_KEY_PREFIX}${dbType}:${hash}`;
}

export function isCacheableResult(result) {
  if (!result || result.success === false) return false;
  if (result.responseMode !== 'analytics') return false;
  const skippedIntents = new Set(['greeting', 'general_business', 'out_of_scope']);
  if (result.intent && skippedIntents.has(result.intent)) return false;
  if ((result.rowCount || 0) > MAX_CACHEABLE_ROWS) return false;
  return true;
}

export function shouldStorePayload(serialized) {
  return Buffer.byteLength(serialized, 'utf8') <= MAX_CACHEABLE_BYTES;
}

function serializeResult(result) {
  const rest = { ...result };
  delete rest.historyId;
  delete rest.timestamp;
  delete rest.cached;
  return JSON.stringify(rest, jsonReplacer);
}

async function bumpLru(redis, key) {
  await redis.zAdd(QUERY_INDEX_KEY, { score: Date.now(), value: key });
}

async function trimLru(redis, maxKeys) {
  const count = await redis.zCard(QUERY_INDEX_KEY);
  if (count <= maxKeys) return;
  const excess = count - maxKeys;
  const oldKeys = await redis.zRange(QUERY_INDEX_KEY, 0, excess - 1);
  if (!oldKeys.length) return;
  await redis.unlink(...oldKeys);
  await redis.zRem(QUERY_INDEX_KEY, ...oldKeys);
}

export async function getCachedQuery(question, dbType = 'postgresql') {
  const redis = await getRedis();
  if (!redis) return null;
  const key = cacheKey(question, dbType);
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    await bumpLru(redis, key);
    await redis.expire(key, getTtlSeconds());
    return parsed;
  } catch (err) {
    console.warn('Query cache get failed:', err.message);
    return null;
  }
}

export async function setCachedQuery(question, dbType, result) {
  if (!isCacheableResult(result)) return false;
  let serialized;
  try {
    serialized = serializeResult(result);
  } catch (err) {
    console.warn('Query cache serialize failed:', err.message);
    return false;
  }
  if (!shouldStorePayload(serialized)) return false;

  const redis = await getRedis();
  if (!redis) return false;
  const key = cacheKey(question, dbType);
  try {
    await redis.set(key, serialized, { EX: getTtlSeconds() });
    await bumpLru(redis, key);
    await trimLru(redis, getMaxKeys());
    return true;
  } catch (err) {
    console.warn('Query cache set failed:', err.message);
    return false;
  }
}

export async function invalidateQueryCache() {
  const redis = await getRedis();
  if (!redis) return 0;
  try {
    const keys = [];
    for await (const key of redis.scanIterator({ MATCH: `${QUERY_KEY_PREFIX}*`, COUNT: 100 })) {
      keys.push(key);
    }
    if (keys.length) await redis.unlink(...keys);
    await redis.del(QUERY_INDEX_KEY);
    return keys.length;
  } catch (err) {
    console.warn('Query cache invalidate failed:', err.message);
    return 0;
  }
}
