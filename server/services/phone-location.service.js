const crypto = require('crypto');

const API_URL = 'https://sdmobiles.market.alicloudapi.com/mobile_location/check';
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

function normalizePhone(value) {
  const phone = String(value || '').replace(/\D/g, '');
  return /^1\d{10}$/.test(phone) ? phone : null;
}

function phoneHash(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex');
}

function isConfigured(env = process.env) {
  return String(env.ALIYUN_MOBILE_LOCATION_APPCODE || '').trim().length > 0;
}

function displayLocation(row) {
  if (!row || row.status !== 'success') return null;
  return [row.province, row.city].filter(Boolean).join('·') || null;
}

async function attachLocations(db, records) {
  const phones = [...new Set(records.map(record => normalizePhone(record.phone)).filter(Boolean))];
  if (!phones.length) return records;
  const hashes = phones.map(phoneHash);
  const [rows] = await db.query(
    `SELECT phone_hash, status, province, city, carrier, number_segment, queried_at
     FROM phone_location_cache WHERE phone_hash IN (${hashes.map(() => '?').join(',')})`,
    hashes
  );
  const byHash = new Map(rows.map(row => [row.phone_hash, row]));
  for (const record of records) {
    const phone = normalizePhone(record.phone);
    const row = phone ? byHash.get(phoneHash(phone)) : null;
    record.phone_location = row ? {
      status: row.status,
      province: row.province,
      city: row.city,
      carrier: row.carrier,
      display: displayLocation(row),
      queried_at: row.queried_at,
    } : null;
  }
  return records;
}

function extractLocation(payload) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const data = root.data && typeof root.data === 'object' ? root.data : root.result && typeof root.result === 'object' ? root.result : root;
  const province = String(data.province || data.prov || data.provinceName || '').trim() || null;
  const city = String(data.city || data.cityName || '').trim() || null;
  const carrier = String(data.carrier || data.isp || data.operator || data.types || '').trim() || null;
  const numberSegment = String(data.num || data.numberSegment || data.number_segment || '').replace(/\D/g, '').slice(0, 7) || null;
  return { province, city, carrier, numberSegment, found: Boolean(province || city) };
}

async function queryProvider(phone, { fetchImpl = fetch, env = process.env } = {}) {
  const appcode = String(env.ALIYUN_MOBILE_LOCATION_APPCODE || '').trim();
  if (!appcode) throw Object.assign(new Error('未配置手机号归属地服务'), { code: 'PHONE_LOCATION_NOT_CONFIGURED' });
  const body = new URLSearchParams({ mobile: phone });
  const response = await fetchImpl(API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `APPCODE ${appcode}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json',
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('归属地服务暂时不可用'), { code: String(response.status) });
  return extractLocation(payload);
}

async function reservePhone(db, hash) {
  const [result] = await db.query(
    `INSERT IGNORE INTO phone_location_cache (phone_hash, status, next_retry_at)
     VALUES (?, 'pending', DATE_ADD(NOW(), INTERVAL 5 MINUTE))`,
    [hash]
  );
  if (result.affectedRows === 1) return { reserved: true };
  const [[row]] = await db.query(
    `SELECT status, next_retry_at FROM phone_location_cache WHERE phone_hash = ? LIMIT 1`, [hash]
  );
  if (row?.status === 'failed' && (!row.next_retry_at || new Date(row.next_retry_at) <= new Date())) {
    const [retry] = await db.query(
      `UPDATE phone_location_cache SET status = 'pending', next_retry_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE), error_code = NULL
       WHERE phone_hash = ? AND status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= NOW())`, [hash]
    );
    return { reserved: retry.affectedRows === 1 };
  }
  return { reserved: false };
}

async function lookupAndCache(db, phone, options = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { status: 'invalid' };
  const hash = phoneHash(normalized);
  const reservation = await reservePhone(db, hash);
  if (!reservation.reserved) return { status: 'cached_or_pending' };
  try {
    const location = await queryProvider(normalized, options);
    await db.query(
      `UPDATE phone_location_cache
       SET status = ?, province = ?, city = ?, carrier = ?, number_segment = ?, queried_at = NOW(), next_retry_at = NULL, error_code = NULL
       WHERE phone_hash = ?`,
      [location.found ? 'success' : 'not_found', location.province, location.city, location.carrier, location.numberSegment, hash]
    );
    return { status: location.found ? 'success' : 'not_found' };
  } catch (error) {
    await db.query(
      `UPDATE phone_location_cache
       SET status = 'failed', queried_at = NOW(), next_retry_at = DATE_ADD(NOW(), INTERVAL 1 HOUR), error_code = ?
       WHERE phone_hash = ?`, [String(error.code || 'request_failed').slice(0, 64), hash]
    );
    return { status: 'failed' };
  }
}

async function syncUserPhones(db, userIds, options = {}) {
  if (!isConfigured(options.env || process.env)) {
    throw Object.assign(new Error('未配置手机号归属地服务'), { code: 'PHONE_LOCATION_NOT_CONFIGURED' });
  }
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 50);
  if (!ids.length) return { requested: 0, queried: 0, cached: 0, failed: 0 };
  const [users] = await db.query(
    `SELECT DISTINCT phone FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND phone IS NOT NULL AND phone <> ''`, ids
  );
  const phones = [...new Set(users.map(row => normalizePhone(row.phone)).filter(Boolean))];
  const result = { requested: phones.length, queried: 0, cached: 0, failed: 0 };
  for (const phone of phones) {
    const response = await lookupAndCache(db, phone, options);
    if (response.status === 'success' || response.status === 'not_found') result.queried += 1;
    else if (response.status === 'cached_or_pending') result.cached += 1;
    else if (response.status === 'failed') result.failed += 1;
  }
  return result;
}

module.exports = { normalizePhone, phoneHash, isConfigured, displayLocation, attachLocations, extractLocation, queryProvider, reservePhone, lookupAndCache, syncUserPhones };
