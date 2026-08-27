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
  const projectContextPath = require.resolve('../utils/project-context');
  const controllerPath = require.resolve('../controllers/merchant-products.controller');
  delete require.cache[dbPath];
  delete require.cache[verifiedMerchantPath];
  delete require.cache[projectContextPath];
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
      if (/COUNT\(\*\) AS total FROM merchant_product_categories/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ total: 2 }]];
      }
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
    async query(sql, params) {
      if (/FROM user_roles/.test(sql)) return [[{ 1: 1 }]];
      if (/COUNT\(\*\) AS total FROM merchant_products/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ total: 3 }]];
      }
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

test('merchant product categories reject more than ten categories', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM user_roles/.test(sql)) return [[{ 1: 1 }]];
      if (/COUNT\(\*\) AS total FROM merchant_product_categories/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ total: 10 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createCategory({
    user: { id: 42, role: 'merchant' },
    body: { name: '阳台砖' },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多 10 个/);
});

test('merchant products reject more than fifty products', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM user_roles/.test(sql)) return [[{ 1: 1 }]];
      if (/COUNT\(\*\) AS total FROM merchant_products/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ total: 50 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProduct({
    user: { id: 42, role: 'merchant' },
    body: { name: '柔光砖' },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多 50 个/);
});

test('merchant product management only requires the merchant role', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push(sql);
      if (/FROM user_roles/.test(sql)) {
        assert.deepEqual(params, [42]);
        assert.doesNotMatch(sql, /verified_status/);
        return [[{ 1: 1 }]];
      }
      if (/COUNT\(\*\) AS total FROM merchant_products/.test(sql)) return [[{ total: 50 }]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProduct({
    user: { id: 42, role: 'merchant' },
    body: { name: '柔光砖' },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多 50 个/);
  assert.equal(queries.filter((sql) => /FROM user_roles/.test(sql)).length, 1);
});

test('merchant product management rejects accounts without the merchant role', async () => {
  const dbMock = {
    async query(sql) {
      if (/FROM user_roles/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProduct({
    user: { id: 42, role: 'owner' },
    body: { name: '柔光砖' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.message, '当前账号没有商家身份，暂不能管理产品');
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

test('merchant product favorite creates one user product favorite', async () => {
  const writes = [];
  const dbMock = {
    async query(sql, params) {
      assert.doesNotMatch(sql, /FROM renovation_projects p/);
      if (/FROM merchant_products p/.test(sql) && /WHERE p\.id = \?/.test(sql)) {
        assert.deepEqual(params, [9]);
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
          summary: '',
          description: '',
          brand: '',
          spec: '',
          price_text: '',
          sort_order: 0,
          status: 'active',
          merchant_name: '木序家居',
          merchant_intro: '',
          consultation_enabled: 1,
        }]];
      }
      if (/INSERT IGNORE INTO merchant_product_favorites/.test(sql)) {
        writes.push(params);
        return [{ insertId: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.favoriteProduct({
    user: { id: 7 },
    params: { id: '9' },
    body: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.favorited, true);
  assert.deepEqual(writes, [[7, 9, 42]]);
});

test('merchant product favorite rejects own product', async () => {
  const dbMock = {
    async query(sql) {
      assert.doesNotMatch(sql, /FROM renovation_projects p/);
      if (/FROM merchant_products p/.test(sql) && /WHERE p\.id = \?/.test(sql)) {
        return [[{
          id: 9,
          merchant_user_id: 7,
          name: '柔光砖',
          image_urls: JSON.stringify([]),
          status: 'active',
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.favoriteProduct({
    user: { id: 7 },
    params: { id: '9' },
    body: {},
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '不能收藏自己的产品');
});

test('merchant product favorites list returns product and merchant display data', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM merchant_product_favorites f/.test(sql) && /ORDER BY f\.created_at/.test(sql)) {
        assert.deepEqual(params, [7, 20, 0]);
        return [[{
          favorite_id: 5,
          favorite_created_at: '2026-07-03T10:00:00.000Z',
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
          brand: '木序',
          spec: '750x1500',
          price_text: '¥199/㎡ 起',
          sort_order: 0,
          status: 'active',
          merchant_name: '木序家居',
          merchant_intro: '建材家居好物',
          consultation_enabled: 1,
        }]];
      }
      if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listFavoriteProducts({
    user: { id: 7 },
    query: { page: '1', pageSize: '20' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.items.length, 1);
  assert.equal(res.payload.data.items[0].merchant_name, '木序家居');
  assert.equal(res.payload.data.items[0].product.name, '柔光砖');
  assert.equal(res.payload.data.items[0].product.price_text, '¥199/㎡ 起');
});
