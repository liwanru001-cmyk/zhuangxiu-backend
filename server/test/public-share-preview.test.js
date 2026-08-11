const assert = require('node:assert/strict');
const test = require('node:test');

function response() {
  return {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function controllerWith(dbMock) {
  const dbPath = require.resolve('../config/db');
  const verifiedPath = require.resolve('../utils/verified-merchant');
  const controllerPath = require.resolve('../controllers/public-share-preview.controller');
  delete require.cache[dbPath];
  delete require.cache[verifiedPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
  return require('../controllers/public-share-preview.controller');
}

test('returns a limited active product preview without authentication', async () => {
  const controller = controllerWith({
    async query(sql, params) {
      assert.match(sql, /product\.status = 'active'/);
      assert.match(sql, /verified_status = 'approved'/);
      assert.deepEqual(params, [18]);
      return [[{
        id: 18,
        title: '原木餐桌',
        cover_url: 'https://example.test/table.jpg',
        summary: '适合原木风餐厅',
        merchant_name: '木作店',
      }]];
    },
  });
  const res = response();
  await controller.getSharePreview({ query: { type: 'merchant_product', id: '18' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, {
    type: 'merchant_product',
    id: 18,
    title: '原木餐桌',
    cover_url: 'https://example.test/table.jpg',
    merchant_name: '木作店',
    summary: '适合原木风餐厅',
    available: true,
  });
});

test('returns unavailable for a missing or inactive case', async () => {
  const controller = controllerWith({
    async query(sql, params) {
      assert.match(sql, /merchant_case\.status = 'active'/);
      assert.deepEqual(params, [27]);
      return [[]];
    },
  });
  const res = response();
  await controller.getSharePreview({ query: { type: 'merchant_case', id: '27' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, {
    type: 'merchant_case',
    id: 27,
    available: false,
  });
});

test('rejects unsupported preview types', async () => {
  const controller = controllerWith({ async query() { throw new Error('should not query'); } });
  const res = response();
  await controller.getSharePreview({ query: { type: 'company', id: '1' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '分享内容参数不正确');
});
