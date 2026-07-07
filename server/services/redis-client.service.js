const { createClient } = require('redis');

let client;
let connectPromise;
let disabled = false;

function redisUrl() {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

function redisConnectTimeoutMs() {
  return Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 1500);
}

function canUseMemoryFallback() {
  return (
    process.env.NODE_ENV !== 'production' ||
    process.env.SMS_RATE_LIMIT_ALLOW_MEMORY_FALLBACK === 'true'
  );
}

async function getRedisClient() {
  if (process.env.NODE_ENV === 'test') return null;
  if (disabled) return null;
  if (client?.isOpen) return client;
  if (!client) {
    client = createClient({
      url: redisUrl(),
      socket: {
        connectTimeout: redisConnectTimeoutMs(),
      },
    });
    client.on('error', (err) => {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[Redis] error:', err.message);
      }
    });
  }
  if (!connectPromise) {
    connectPromise = Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Redis connection timed out')),
          redisConnectTimeoutMs()
        );
      }),
    ]).catch((err) => {
      connectPromise = null;
      client?.disconnect?.().catch(() => {});
      client = null;
      if (canUseMemoryFallback()) {
        disabled = true;
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[Redis] unavailable, using memory fallback:', err.message);
        }
        return null;
      }
      throw err;
    });
  }
  return connectPromise;
}

module.exports = {
  getRedisClient,
  canUseMemoryFallback,
};
