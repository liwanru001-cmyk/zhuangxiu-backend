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
  const controllerPath = require.resolve('../controllers/merchant-products.controller');
  delete require.cache[dbPath];
  delete require.cache[verifiedMerchantPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/merchant-products.controller');
}

test('merchant product categories allow two levels and reject a third level', async () => {
  const calls = [];
  const dbMock = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM user_roles/.test(sql)) return [[{ 1: 1 }]];
      if (/FROM merchant_product_categories/.test(sql) && /WHERE id = \?/.test(sql)) {
        return [[{
          id: 7,
          merchant_user_id: 42,
          parent_id: 3,
          name: '客厅砖',
          sort_order: 10,
          status: 'active',
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createCategory({
    user: { id: 42, role: 'merchant' },
    body: { parent_id: 7, name: '亮面砖' },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '产品分类最多支持二级');
});

test('merchant product create requires category owned by the merchant', async () => {
  const dbMock = {
    async query(sql) {
      if (/FROM user_roles/.test(sql)) return [[{ 1: 1 }]];
      if (/FROM merchant_product_categories/.test(sql) && /WHERE id = \?/.test(sql)) {
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProduct({
    user: { id: 42, role: 'merchant' },
    body: { category_id: 99, name: '柔光砖' },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '产品分类不存在');
});

test('merchant product management requires approved verified merchant status', async () => {
  const dbMock = {
    async query(sql) {
      if (/FROM user_roles/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProduct({
    user: { id: 42, role: 'merchant' },
    body: { name: '柔光砖' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.message, '未成为入驻商家，暂不能管理产品展示');
});

test('public merchant products only return active categories and active products', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM merchant_profiles/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ user_id: 42 }]];
      }
      if (/FROM merchant_product_categories/.test(sql)) {
        assert.match(sql, /status = 'active'/);
        return [[{
          id: 1,
          merchant_user_id: 42,
          parent_id: null,
          name: '瓷砖',
          sort_order: 0,
          status: 'active',
        }]];
      }
      if (/FROM merchant_products p/.test(sql)) {
        assert.match(sql, /p\.status = 'active'/);
        return [[{
          id: 9,
          merchant_user_id: 42,
          category_id: 1,
          category_name: '瓷砖',
          parent_category_id: null,
          parent_category_name: null,
          name: '柔光砖',
          cover_url: '',
          image_urls: JSON.stringify([]),
          summary: '适合客厅',
          description: '',
          brand: '',
          spec: '',
          price_text: '到店咨询',
          sort_order: 0,
          status: 'active',
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listPublicProducts({ params: { userId: '42' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.categories.length, 1);
  assert.equal(res.payload.data.products.length, 1);
  assert.equal(res.payload.data.products[0].name, '柔光砖');
  assert.equal(queries.length, 3);
});
