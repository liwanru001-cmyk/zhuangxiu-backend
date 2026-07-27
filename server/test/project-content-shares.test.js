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
  const controllerPath = require.resolve('../controllers/project-content-shares.controller');
  delete require.cache[dbPath];
  delete require.cache[verifiedPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
  return require('../controllers/project-content-shares.controller');
}

test('project member can share an active merchant product to all members', async () => {
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      if (/INSERT INTO project_content_shares/.test(sql)) {
        assert.deepEqual(params, [5, 7, 'merchant_product', 88, '这个灯可以看看', 1]);
        return [{ insertId: 31 }];
      }
      throw new Error(`unexpected transaction query: ${sql}`);
    },
  };
  const dbMock = {
    async query(sql) {
      if (/FROM renovation_projects p/.test(sql)) return [[{ id: 5 }]];
      if (/FROM merchant_products product/.test(sql)) {
        assert.match(sql, /verified_status = 'approved'/);
        return [[{ id: 88, title: '吊灯', source_name: '灯具店' }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() { return connection; },
  };
  const controller = controllerWith(dbMock);
  const res = response();
  await controller.createShare({
    user: { id: 7 },
    params: { id: '5' },
    body: {
      content_type: 'merchant_product',
      content_id: 88,
      shared_to_all: true,
      share_note: '这个灯可以看看',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.id, 31);
});

test('project share rejects recipients outside the project', async () => {
  const dbMock = {
    async query(sql) {
      if (/FROM renovation_projects p/.test(sql)) return [[{ id: 5 }]];
      if (/FROM merchant_cases merchant_case/.test(sql)) {
        return [[{ id: 19, title: '客厅案例' }]];
      }
      if (/SELECT user_id FROM project_members/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = controllerWith(dbMock);
  const res = response();
  await controller.createShare({
    user: { id: 7 },
    params: { id: '5' },
    body: {
      content_type: 'merchant_case',
      content_id: 19,
      recipient_user_ids: [99],
    },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '所选成员不在当前项目中');
});
