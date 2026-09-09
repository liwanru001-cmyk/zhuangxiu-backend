const test = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { payload } = require('../controllers/personal-products.controller');
const { canonicalizeStorageUrisDeep } = require('../services/storage.service');
test('uploaded cover remains valid after request middleware canonicalizes OSS URLs', (t) => {
  const previous = process.env.OSS_BUCKET;
  process.env.OSS_BUCKET = 'catalog-test';
  t.after(() => { if (previous === undefined) delete process.env.OSS_BUCKET; else process.env.OSS_BUCKET = previous; });
  const body = canonicalizeStorageUrisDeep({ name: '沙发', cover_url: 'https://catalog-test.oss-cn-hangzhou.aliyuncs.com/uploads/personal-products/cover.webp?Signature=test', source_url: '' });
  assert.equal(body.cover_url, 'oss://catalog-test/uploads/personal-products/cover.webp');
  assert.equal(payload(body).cover_url, body.cover_url);
  for (const cover_url of ['oss://other-bucket/cover.webp', 'oss://catalog-test/', 'file:///tmp/image.png', 'javascript:alert(1)', 'https://user:pass@example.com/image.png']) {
    assert.throws(() => payload({ name: '沙发', cover_url }));
  }
});
test('product groups accept soft furnishings, building materials and woodwork only', () => {
  for (const group of ['soft_furnishings', 'building_materials', 'woodwork']) assert.equal(payload({ name: '测试', product_group: group }).product_group, group);
  for (const group of ['furniture', '', null, 'other']) assert.throws(() => payload({ name: '测试', product_group: group }));
});
test('legacy client omitting group cannot erase or guess the existing classification', () => {
  assert.equal(Object.hasOwn(payload({ name: '旧客户端更新' }), 'product_group'), false);
});
test('six soft furnishing types are accepted only inside soft furnishings', () => {
  for (const type of ['furniture', 'curtains', 'rugs', 'lighting', 'artwork', 'accessories']) assert.equal(payload({ name: '测试', product_group: 'soft_furnishings', product_type: type }).product_type, type);
  assert.throws(() => payload({ name: '测试', product_group: 'soft_furnishings', product_type: 'other' }));
  assert.throws(() => payload({ name: '测试', product_group: 'woodwork', product_type: 'furniture' }));
  assert.equal(payload({ name: '测试', product_group: 'woodwork' }).product_type, null);
  assert.equal(Object.hasOwn(payload({ name: '旧客户端' }), 'product_type'), false);
});
