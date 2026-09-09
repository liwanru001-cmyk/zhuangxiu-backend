const test = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { payload } = require('../controllers/personal-products.controller');
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
