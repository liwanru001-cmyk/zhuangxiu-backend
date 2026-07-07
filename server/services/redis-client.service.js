const { createClient } = require('redis');

let client;
let connectPromise;
let disabled = false;

function redisUrl() {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
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
    client = createClient({ url: redisUrl() });
    client.on('error', (err) => {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[Redis] error:', err.message);
      }
    });
  }
  if (!connectPromise) {
    connectPromise = client.connect().catch((err) => {
      connectPromise = null;
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
