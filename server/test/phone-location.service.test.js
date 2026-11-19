const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../services/phone-location.service');

test('normalizes and hashes valid mainland mobile numbers without storing raw values in cache keys', () => {
  assert.equal(service.normalizePhone('138 0013 8000'), '13800138000');
  assert.equal(service.normalizePhone('abc'), null);
  assert.match(service.phoneHash('13800138000'), /^[a-f0-9]{64}$/);
  assert.notEqual(service.phoneHash('13800138000'), '13800138000');
});

test('parses the provider result and never uses AppCode in a URL', async () => {
  let requested;
  const result = await service.queryProvider('13800138000', {
    env: { ALIYUN_MOBILE_LOCATION_APPCODE: 'test-code' },
    fetchImpl: async (url, init) => {
      requested = { url, init };
      return { ok: true, json: async () => ({ data: { province: '浙江', city: '杭州', carrier: '中国移动', num: '1380013' } }) };
    },
  });
  assert.deepEqual(result, { province: '浙江', city: '杭州', carrier: '中国移动', numberSegment: '1380013', found: true });
  assert.equal(requested.url, 'https://sdmobiles.market.alicloudapi.com/mobile_location/check');
  assert.equal(requested.init.headers.Authorization, 'APPCODE test-code');
  assert.ok(!requested.url.includes('test-code'));
  assert.equal(requested.init.body.toString(), 'mobile=13800138000');
});

test('existing cache rows skip external lookup and newly reserved rows are saved once', async () => {
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT IGNORE INTO phone_location_cache')) return [{ affectedRows: 0 }];
    if (sql.startsWith('SELECT status')) return [[{ status: 'success', next_retry_at: null }]];
    throw new Error(sql);
  } };
  const cached = await service.lookupAndCache(db, '13800138000', { fetchImpl: async () => { throw new Error('should not run'); }, env: { ALIYUN_MOBILE_LOCATION_APPCODE: 'x' } });
  assert.deepEqual(cached, { status: 'cached_or_pending' });
  assert.equal(calls.length, 2);

  const writes = [];
  const newDb = { async query(sql, params) {
    writes.push({ sql, params });
    if (sql.startsWith('INSERT IGNORE INTO phone_location_cache')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE phone_location_cache')) return [{ affectedRows: 1 }];
    throw new Error(sql);
  } };
  const fresh = await service.lookupAndCache(newDb, '13800138000', { env: { ALIYUN_MOBILE_LOCATION_APPCODE: 'x' }, fetchImpl: async () => ({ ok: true, json: async () => ({ data: { province: '浙江', city: '杭州' } }) }) });
  assert.deepEqual(fresh, { status: 'success' });
  assert.equal(writes.filter(call => call.sql.startsWith('UPDATE phone_location_cache')).length, 1);
  assert.ok(writes.every(call => !JSON.stringify(call).includes('13800138000')));
});

test('failed calls use a delayed retry rather than being retried on every page view', async () => {
  const writes = [];
  const db = { async query(sql, params) {
    writes.push({ sql, params });
    if (sql.startsWith('INSERT IGNORE INTO phone_location_cache')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE phone_location_cache')) return [{ affectedRows: 1 }];
    throw new Error(sql);
  } };
  const result = await service.lookupAndCache(db, '13800138000', { env: { ALIYUN_MOBILE_LOCATION_APPCODE: 'x' }, fetchImpl: async () => { throw Object.assign(new Error('down'), { code: 'UPSTREAM' }); } });
  assert.deepEqual(result, { status: 'failed' });
  const failure = writes.find(call => call.sql.includes("status = 'failed'"));
  assert.match(failure.sql, /INTERVAL 1 HOUR/);
  assert.equal(failure.params[0], 'UPSTREAM');
});

test('location attachment reads cache only and only exposes resolved locations', async () => {
  const users = [{ phone: '13800138000' }, { phone: 'invalid' }];
  const db = { async query(sql, params) {
    assert.match(sql, /FROM phone_location_cache/);
    assert.equal(params.length, 1);
    return [[{ phone_hash: service.phoneHash('13800138000'), status: 'success', province: '浙江', city: '杭州', carrier: '中国移动' }]];
  } };
  await service.attachLocations(db, users);
  assert.equal(users[0].phone_location.display, '浙江·杭州');
  assert.equal(users[1].phone_location, null);
});
