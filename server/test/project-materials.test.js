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
  const projectContextPath = require.resolve('../utils/project-context');
  const controllerPath = require.resolve('../controllers/renovation.controller');
  delete require.cache[dbPath];
  delete require.cache[projectContextPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/renovation.controller');
}

function materialRequest(body = {}, files = []) {
  return {
    user: { id: 7 },
    params: { id: '9' },
    body: {
      project_id: 9,
      name: '客厅地砖',
      category: 'tile',
      supplier_type: 'merchant',
      arrival_status: 'ordered',
      ...body,
    },
    files,
    protocol: 'https',
    get(name) {
      assert.equal(name, 'host');
      return 'yinnkhome.com';
    },
  };
}

function materialDb(connection, options = {}) {
  return {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/COUNT\(\*\) AS total/.test(sql) && /project_material_media/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ total: 0 }]];
      }
      if (/FROM merchant_products product/.test(sql)) {
        assert.deepEqual(params, [options.merchantProductId]);
        return [[{ id: options.merchantProductId }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
}

test('material create without attachments inserts the complete nullable schema', async () => {
  let insertParams;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {
      throw new Error('should not rollback when material creation succeeds');
    },
    release() {},
    async query(sql, params) {
      assert.match(sql, /INSERT INTO project_material_items/);
      assert.match(sql, /arrival_date, merchant_product_id/);
      insertParams = params;
      return [{ insertId: 51 }];
    },
  };
  const controller = loadController(materialDb(connection));
  const res = mockResponse();

  await controller.createProjectMaterial(materialRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.id, 51);
  assert.deepEqual(insertParams, [
    9, '客厅地砖', 'tile', null, null, null, null, null,
    null, null, 'merchant', 'ordered', null, null, null, 7,
  ]);
});

test('material create stores arrival date, merchant product, image and link', async () => {
  const queries = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {
      throw new Error('should not rollback when material creation succeeds');
    },
    release() {},
    async query(sql, params) {
      queries.push({ sql, params });
      if (/INSERT INTO project_material_items/.test(sql)) return [{ insertId: 52 }];
      if (/INSERT INTO project_material_media/.test(sql)) return [{ affectedRows: 2 }];
      throw new Error(`unexpected connection query: ${sql}`);
    },
  };
  const controller = loadController(materialDb(connection, { merchantProductId: 88 }));
  const res = mockResponse();
  const image = {
    path: '/tmp/material-image.jpg',
    filename: 'material-image.jpg',
    mimetype: 'image/jpeg',
    storageUrl: 'oss://bucket/material-image.jpg',
  };

  await controller.createProjectMaterial(materialRequest({
    arrival_date: '2026-08-20',
    merchant_product_id: 88,
    link_url: 'https://example.com/product',
  }, [image]), res);

  assert.equal(res.statusCode, 200);
  const itemInsert = queries.find(({ sql }) => /INSERT INTO project_material_items/.test(sql));
  assert.equal(itemInsert.params[12], '2026-08-20');
  assert.equal(itemInsert.params[13], 88);
  const mediaInsert = queries.find(({ sql }) => /INSERT INTO project_material_media/.test(sql));
  assert.deepEqual(mediaInsert.params, [
    52, 'image', 'oss://bucket/material-image.jpg', 7,
    52, 'link', 'https://example.com/product', 7,
  ]);
});

test('material create rolls back and releases its connection on database failure', async () => {
  const databaseError = Object.assign(new Error('database write failed'), {
    code: 'ER_BAD_FIELD_ERROR',
  });
  let rolledBack = false;
  let released = false;
  const connection = {
    async beginTransaction() {},
    async commit() {
      throw new Error('should not commit after insert failure');
    },
    async rollback() {
      rolledBack = true;
    },
    release() {
      released = true;
    },
    async query(sql) {
      assert.match(sql, /INSERT INTO project_material_items/);
      throw databaseError;
    },
  };
  const controller = loadController(materialDb(connection));
  const res = mockResponse();

  await assert.rejects(
    controller.createProjectMaterial(materialRequest(), res),
    (error) => error === databaseError
  );
  assert.equal(rolledBack, true);
  assert.equal(released, true);
  assert.equal(res.statusCode, null);
});
