const test = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { payload, blockedAddress } = require('../controllers/personal-products.controller');
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

test('web products keep at most five archived image urls', () => {
  const urls = ['https://example.com/1.jpg', 'https://example.com/2.jpg'];
  const value = payload({ name: '官网产品', source_url: 'https://example.com/product', image_urls: urls });
  assert.deepEqual(JSON.parse(value.image_urls), urls);
  assert.throws(() => payload({ name: '过多图片', image_urls: Array.from({ length: 6 }, (_, index) => `https://example.com/${index}.jpg`) }), /最多保留5张图片/);
});

test('remote image import rejects local and private network addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', 'ff02::1']) {
    assert.equal(blockedAddress(address), true, address);
  }
  assert.equal(blockedAddress('8.8.8.8'), false);
  assert.equal(blockedAddress('2001:4860:4860::8888'), false);
});
