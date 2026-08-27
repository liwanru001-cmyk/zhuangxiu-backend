const assert = require('node:assert/strict');
const test = require('node:test');

function mockResponse() {
  return {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function loadController(dbMock) {
  const dbPath = require.resolve('../config/db');
  const verifiedMerchantPath = require.resolve('../utils/verified-merchant');
  const controllerPath = require.resolve('../controllers/merchant-cases.controller');
  delete require.cache[dbPath];
  delete require.cache[verifiedMerchantPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/merchant-cases.controller');
}

test('merchant case management only requires the merchant role', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM user_roles/.test(sql)) {
        assert.deepEqual(params, [42]);
        assert.doesNotMatch(sql, /verified_status/);
        return [[{ 1: 1 }]];
      }
      if (/FROM merchant_cases/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listDashboardCases({ user: { id: 42, role: 'owner' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, []);
});

test('merchant case management rejects accounts without the merchant role', async () => {
  const dbMock = {
    async query(sql) {
      if (/FROM user_roles/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listDashboardCases({ user: { id: 42, role: 'owner' } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.message, '当前账号没有商家身份，暂不能管理案例');
});
