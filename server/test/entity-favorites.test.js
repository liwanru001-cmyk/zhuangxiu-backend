const assert = require('node:assert/strict');
const test = require('node:test');

function mockResponse() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function loadController(dbMock) {
  const dbPath = require.resolve('../config/db');
  const verifiedMerchantPath = require.resolve('../utils/verified-merchant');
  const controllerPath = require.resolve('../controllers/entity-favorites.controller');
  delete require.cache[dbPath];
  delete require.cache[verifiedMerchantPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/entity-favorites.controller');
}

test('shop favorite only accepts an active verified merchant', async () => {
  const calls = [];
  const dbMock = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM merchant_profiles mp/.test(sql)) {
        assert.match(sql, /verified_status = 'approved'/);
        assert.deepEqual(params, [42]);
        return [[{
          entity_id: 42,
          title: '木作店',
          merchant_user_id: 42,
        }]];
      }
      if (/INSERT IGNORE INTO user_entity_favorites/.test(sql)) {
        assert.deepEqual(params, [7, 'shop', 42]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.setFavorite({
    user: { id: 7 },
    params: { type: 'shop', id: '42' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.favorited, true);
  assert.equal(calls.length, 2);
});

test('merchant favorite alias stores as legacy shop type', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM merchant_profiles mp/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{
          entity_id: 42,
          title: '木作店',
          merchant_user_id: 42,
        }]];
      }
      if (/INSERT IGNORE INTO user_entity_favorites/.test(sql)) {
        assert.deepEqual(params, [7, 'shop', 42]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.setFavorite({
    user: { id: 7 },
    params: { type: 'merchant', id: '42' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.favorited, true);
});

test('merchant favorite list reads legacy shop records but returns merchant type', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM user_entity_favorites/.test(sql)) {
        assert.deepEqual(params, [7, 'shop', 20, 0]);
        return [[{ id: 1, entity_id: 42, created_at: '2026-07-28 12:00:00' }]];
      }
      if (/FROM merchant_profiles mp/.test(sql)) {
        return [[{
          entity_id: 42,
          title: '木作店',
          merchant_user_id: 42,
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listFavorites({
    user: { id: 7 },
    params: {},
    query: { type: 'merchant' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.items[0].entity_type, 'merchant');
});

test('company favorite rejects a company that is not publicly visible', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM companies/.test(sql)) {
        assert.match(sql, /verification_status = 'verified'/);
        assert.deepEqual(params, [9]);
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.setFavorite({
    user: { id: 7 },
    params: { type: 'company', id: '9' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.message, '收藏对象不存在或已下架');
});

test('merchant case favorite checks both case state and merchant verification', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM merchant_cases mc/.test(sql)) {
        assert.match(sql, /mc\.status = 'active'/);
        assert.match(sql, /verified_status = 'approved'/);
        assert.deepEqual(params, [88]);
        return [[{
          entity_id: 88,
          title: '原木客厅',
          merchant_user_id: 42,
        }]];
      }
      if (/INSERT IGNORE INTO user_entity_favorites/.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.setFavorite({
    user: { id: 7 },
    params: { type: 'merchant_case', id: '88' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 200);
});

test('favorite status and removal are scoped to the current user', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT id FROM user_entity_favorites/.test(sql)) {
        assert.deepEqual(params, [7, 'company', 9]);
        return [[{ id: 3 }]];
      }
      if (/DELETE FROM user_entity_favorites/.test(sql)) {
        assert.deepEqual(params, [7, 'company', 9]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const statusRes = mockResponse();
  const removeRes = mockResponse();
  const req = {
    user: { id: 7 },
    params: { type: 'company', id: '9' },
    query: {},
  };

  await controller.getFavoriteStatus(req, statusRes);
  await controller.unsetFavorite(req, removeRes);

  assert.equal(statusRes.payload.data.favorited, true);
  assert.equal(removeRes.payload.data.favorited, false);
});

test('favorite list skips entities that are no longer public', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM user_entity_favorites/.test(sql)) {
        assert.deepEqual(params, [7, 'company', 20, 0]);
        return [[
          { id: 1, entity_id: 9, created_at: '2026-07-27 12:00:00' },
          { id: 2, entity_id: 10, created_at: '2026-07-27 11:00:00' },
        ]];
      }
      if (/FROM companies/.test(sql)) {
        return params[0] === 9
          ? [[{ entity_id: 9, title: '公开公司', company_id: 9 }]]
          : [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listFavorites({
    user: { id: 7 },
    params: {},
    query: { type: 'company' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.items.length, 1);
  assert.equal(res.payload.data.items[0].title, '公开公司');
});
