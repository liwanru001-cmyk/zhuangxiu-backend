const crypto = require('crypto');
const { getRedisClient, canUseMemoryFallback } = require('./redis-client.service');

const memoryStore = new Map();

const LIMIT_MESSAGE = '验证频繁，稍后再试';
const IP_BLOCK_MESSAGE = '验证频繁，稍后再试';

function nowMs() {
  return Date.now();
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function cleanMemoryKey(key) {
  const item = memoryStore.get(key);
  if (item && item.expiresAt <= nowMs()) {
    memoryStore.delete(key);
    return null;
  }
  return item || null;
}

async function redisGet(redis, key) {
  if (redis) return redis.get(key);
  const item = cleanMemoryKey(key);
  return item ? String(item.value) : null;
}

async function redisDel(redis, key) {
  if (redis) return redis.del(key);
  memoryStore.delete(key);
  return 1;
}

async function redisSet(redis, key, value, ttlSeconds, mode) {
  if (redis) {
    if (mode === 'NX') {
      return redis.set(key, String(value), { EX: ttlSeconds, NX: true });
    }
    return redis.set(key, String(value), { EX: ttlSeconds });
  }
  const existing = cleanMemoryKey(key);
  if (mode === 'NX' && existing) return null;
  memoryStore.set(key, {
    value,
    expiresAt: nowMs() + ttlSeconds * 1000,
  });
  return 'OK';
}

async function redisIncr(redis, key, ttlSeconds) {
  if (redis) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttlSeconds);
    return count;
  }
  const existing = cleanMemoryKey(key);
  const value = existing ? Number(existing.value) + 1 : 1;
  memoryStore.set(key, {
    value,
    expiresAt: existing?.expiresAt || nowMs() + ttlSeconds * 1000,
  });
  return value;
}

async function redisTtl(redis, key) {
  if (redis) return redis.ttl(key);
  const item = cleanMemoryKey(key);
  if (!item) return -2;
  return Math.max(1, Math.ceil((item.expiresAt - nowMs()) / 1000));
}

async function redisMget(redis, keys) {
  if (redis) return redis.mGet(keys);
  return Promise.all(keys.map((key) => redisGet(null, key)));
}

async function clientOrFallback() {
  try {
    return await getRedisClient();
  } catch (err) {
    err.publicMessage = '短信风控服务暂不可用';
    err.statusCode = 503;
    throw err;
  }
}

function deviceIdFromRequest(req) {
  const headerValue =
    req.get?.('x-device-id') ||
    req.get?.('x-device-fingerprint') ||
    req.headers?.['x-device-id'] ||
    req.headers?.['x-device-fingerprint'];
  const bodyValue = req.body?.device_id || req.body?.deviceId;
  const raw = String(headerValue || bodyValue || '').trim();
  if (raw) return stableHash(raw.slice(0, 128));
  return stableHash(`fallback:${req.ip || ''}:${req.get?.('user-agent') || ''}`);
}

function ipFromRequest(req) {
  return String(req.ip || req.connection?.remoteAddress || 'unknown').trim();
}

function shanghaiParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function dateKey({ year, month, day }) {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function addShanghaiDays(parts, days) {
  const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day + days, 0, 0, 0);
  const shiftedBack = new Date(utcMs - 8 * 60 * 60 * 1000);
  return shanghaiParts(shiftedBack);
}

function nightWindowKey(date = new Date()) {
  const parts = shanghaiParts(date);
  if (parts.hour >= 22) return dateKey(parts);
  if (parts.hour < 8) return dateKey(addShanghaiDays(parts, -1));
  return null;
}

function randomBlockTtlSeconds() {
  return 3600 + crypto.randomInt(0, 3 * 3600 + 1);
}

async function rejectWithTtl(redis, key, message, statusCode = 429) {
  const ttl = await redisTtl(redis, key);
  return { allowed: false, message, statusCode, retryAfter: ttl > 0 ? ttl : undefined };
}

async function enforceSendLimit({ req, phone, scene }) {
  const redis = await clientOrFallback();
  if (!redis && !canUseMemoryFallback()) {
    return { allowed: false, message: '短信风控服务暂不可用', statusCode: 503 };
  }

  const ip = stableHash(ipFromRequest(req));
  const device = deviceIdFromRequest(req);
  const phoneKey = stableHash(phone);
  const sceneKey = String(scene || 'register');
  const nightKey = nightWindowKey();

  const keys = {
    ipBlock: `sms:block:ip:${ip}`,
    phoneMinute: `sms:phone:minute:${sceneKey}:${phoneKey}`,
    phoneHour: `sms:phone:hour:${sceneKey}:${phoneKey}`,
    phoneDay: `sms:phone:day:${sceneKey}:${phoneKey}`,
    phoneNight: nightKey ? `sms:phone:night:${nightKey}:${phoneKey}` : null,
    ipMinute: `sms:ip:minute:${ip}`,
    ipHour: `sms:ip:hour:${ip}`,
    ipDay: `sms:ip:day:${ip}`,
    deviceTenMinute: `sms:device:10m:${device}`,
    deviceDay: `sms:device:day:${device}`,
  };

  if (await redisGet(redis, keys.ipBlock)) {
    return rejectWithTtl(redis, keys.ipBlock, IP_BLOCK_MESSAGE);
  }

  const countKeys = [
    keys.phoneHour,
    keys.phoneDay,
    keys.ipMinute,
    keys.ipHour,
    keys.ipDay,
    keys.deviceTenMinute,
    keys.deviceDay,
    ...(keys.phoneNight ? [keys.phoneNight] : []),
  ];
  const counts = (await redisMget(redis, countKeys)).map((value) => Number(value || 0));
  const [
    phoneHour,
    phoneDay,
    ipMinute,
    ipHour,
    ipDay,
    deviceTenMinute,
    deviceDay,
    phoneNight,
  ] = counts;

  if (await redisGet(redis, keys.phoneMinute)) {
    return rejectWithTtl(redis, keys.phoneMinute, LIMIT_MESSAGE);
  }
  if (phoneHour >= 3 || phoneDay >= 10 || (keys.phoneNight && phoneNight >= 2)) {
    return { allowed: false, message: LIMIT_MESSAGE, statusCode: 429 };
  }
  if (deviceTenMinute >= 3 || deviceDay >= 8) {
    return { allowed: false, message: LIMIT_MESSAGE, statusCode: 429 };
  }
  if (ipMinute >= 15 || ipHour >= 80 || ipDay >= 200) {
    const ttl = randomBlockTtlSeconds();
    await redisSet(redis, keys.ipBlock, '1', ttl);
    return { allowed: false, message: IP_BLOCK_MESSAGE, statusCode: 429, retryAfter: ttl };
  }

  const intervalSet = await redisSet(redis, keys.phoneMinute, '1', 60, 'NX');
  if (!intervalSet) {
    return rejectWithTtl(redis, keys.phoneMinute, LIMIT_MESSAGE);
  }

  await Promise.all([
    redisIncr(redis, keys.phoneHour, 3600),
    redisIncr(redis, keys.phoneDay, 86400),
    redisIncr(redis, keys.ipMinute, 60),
    redisIncr(redis, keys.ipHour, 3600),
    redisIncr(redis, keys.ipDay, 86400),
    redisIncr(redis, keys.deviceTenMinute, 600),
    redisIncr(redis, keys.deviceDay, 86400),
    keys.phoneNight ? redisIncr(redis, keys.phoneNight, 10 * 3600) : Promise.resolve(0),
  ]);

  return { allowed: true };
}

async function registerCodeFailure({ phone, scene, codeId }) {
  const redis = await clientOrFallback();
  const key = `sms:code:fail:${scene}:${stableHash(phone)}:${codeId}`;
  const count = await redisIncr(redis, key, 10 * 60);
  return { count, exhausted: count >= 5 };
}

async function clearCodeFailures({ phone, scene, codeId }) {
  const redis = await clientOrFallback();
  await redisDel(redis, `sms:code:fail:${scene}:${stableHash(phone)}:${codeId}`);
}

module.exports = {
  LIMIT_MESSAGE,
  enforceSendLimit,
  registerCodeFailure,
  clearCodeFailures,
  _private: {
    memoryStore,
    nightWindowKey,
    stableHash,
  },
};
