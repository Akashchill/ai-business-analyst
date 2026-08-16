/**
 * Redis client — fail open.
 * If Redis is disabled or unreachable, query caching is skipped and the API still works.
 */
import { createClient } from 'redis';

let client = null;
let connectAttempt = null;
let lastError = null;
let lastFailedAt = 0;
const RETRY_COOLDOWN_MS = 15_000;

export function isRedisEnabled() {
  const flag = (process.env.REDIS_ENABLED || '').toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return false;
  if (flag === 'true' || flag === '1' || flag === 'on') return true;
  return Boolean(process.env.REDIS_URL);
}

export function getRedisUrl() {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

export function getRedisStatus() {
  return {
    enabled: isRedisEnabled(),
    connected: Boolean(client?.isOpen),
    error: lastError,
  };
}

function attachErrorHandler(redisClient) {
  redisClient.on('error', (err) => {
    lastError = err.message;
    console.warn('Redis error:', err.message);
  });
}

/**
 * Returns a connected client, or null if Redis is off / unreachable.
 */
export async function getRedis() {
  if (!isRedisEnabled()) return null;
  if (client?.isOpen) return client;
  if (lastFailedAt && Date.now() - lastFailedAt < RETRY_COOLDOWN_MS) return null;
  return connectRedis();
}

export async function connectRedis() {
  if (!isRedisEnabled()) {
    console.log('Redis: disabled (set REDIS_ENABLED=true to cache query results)');
    return null;
  }
  if (client?.isOpen) return client;
  if (connectAttempt) return connectAttempt;

  connectAttempt = (async () => {
    if (client && !client.isOpen) {
      try {
        await client.close();
      } catch {
        // ignore
      }
      client = null;
    }

    const url = getRedisUrl();
    const redisClient = createClient({
      url,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 8) return false;
          return Math.min(retries * 250, 2000);
        },
        connectTimeout: 3000,
      },
    });
    attachErrorHandler(redisClient);

    try {
      await redisClient.connect();
      client = redisClient;
      lastError = null;
      lastFailedAt = 0;
      console.log(`Redis: connected (${url})`);
      return client;
    } catch (err) {
      lastError = err.message;
      lastFailedAt = Date.now();
      console.warn(`Redis: unavailable (${err.message}) — query cache disabled, API will continue`);
      try {
        await redisClient.close();
      } catch {
        // ignore close errors on a failed connect
      }
      client = null;
      return null;
    } finally {
      connectAttempt = null;
    }
  })();

  return connectAttempt;
}

export async function closeRedis() {
  connectAttempt = null;
  if (!client) return;
  const toClose = client;
  client = null;
  try {
    if (toClose.isOpen) await toClose.quit();
  } catch {
    try {
      await toClose.close();
    } catch {
      // ignore
    }
  }
}
