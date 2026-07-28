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

test('project member can share a merchant shop to project members', async () => {
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      if (/INSERT INTO project_content_shares/.test(sql)) {
        assert.deepEqual(params, [5, 7, 'merchant', 42, null, 1]);
        return [{ insertId: 32 }];
      }
      throw new Error(`unexpected transaction query: ${sql}`);
    },
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) return [[{ id: 5 }]];
      if (/FROM merchant_profiles profile/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ id: 42, title: '木作店', merchant_user_id: 42 }]];
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
      content_type: 'merchant',
      content_id: 42,
      shared_to_all: true,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.id, 32);
});

test('project member can share a verified company to project members', async () => {
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      if (/INSERT INTO project_content_shares/.test(sql)) {
        assert.deepEqual(params, [5, 7, 'company', 9, null, 1]);
        return [{ insertId: 33 }];
      }
      throw new Error(`unexpected transaction query: ${sql}`);
    },
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) return [[{ id: 5 }]];
      if (/FROM companies company/.test(sql)) {
        assert.deepEqual(params, [9]);
        assert.match(sql, /verification_status = 'verified'/);
        return [[{ id: 9, title: '不凡装饰', company_id: 9 }]];
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
      content_type: 'company',
      content_id: 9,
      shared_to_all: true,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.id, 33);
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

test('project share list query supports ONLY_FULL_GROUP_BY', async () => {
  let listSql = '';
  const dbMock = {
    async query(sql) {
      if (/FROM renovation_projects p/.test(sql)) return [[{ id: 5 }]];
      if (/FROM project_content_shares share/.test(sql)) {
        listSql = sql;
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = controllerWith(dbMock);
  const res = response();

  await controller.listShares({
    user: { id: 7 },
    params: { id: '5' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(listSql, /\bGROUP BY share\.id\b/);
  assert.match(listSql, /WHERE target\.share_id = share\.id/);
});

test('unread count excludes the current user shares and respects recipients', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) return [[{ id: 5 }]];
      if (/COUNT\(\*\) AS unread_count/.test(sql)) {
        assert.deepEqual(params, [7, 5, 7, 7]);
        assert.match(sql, /share\.shared_by <> \?/);
        assert.match(sql, /target\.user_id = \?/);
        return [[{ unread_count: 3 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = controllerWith(dbMock);
  const res = response();
  await controller.unreadCount({
    user: { id: 7 },
    params: { id: '5' },
  }, res);
  assert.equal(res.payload.data.unread_count, 3);
});

test('mark read upserts the project member read timestamp', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) return [[{ id: 5 }]];
      if (/INSERT INTO project_content_share_reads/.test(sql)) {
        assert.deepEqual(params, [5, 7]);
        assert.match(sql, /ON DUPLICATE KEY UPDATE last_read_at = NOW\(\)/);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = controllerWith(dbMock);
  const res = response();
  await controller.markRead({
    user: { id: 7 },
    params: { id: '5' },
  }, res);
  assert.equal(res.statusCode, 200);
});
