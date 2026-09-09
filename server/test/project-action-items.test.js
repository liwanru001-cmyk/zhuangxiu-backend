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

function deleteRequest(userId = 7) {
  return {
    user: { id: userId },
    params: { id: '9', itemId: '51' },
    body: { project_id: 9 },
  };
}

function projectContextResult() {
  return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
}

test('only the action item creator can delete it', async () => {
  let connectionRequested = false;
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) return projectContextResult();
      if (/FROM project_action_items/.test(sql)) {
        assert.deepEqual(params, [51, 9]);
        return [[{ id: 51, created_by: 8 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      connectionRequested = true;
      throw new Error('non-creator must not start a delete transaction');
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.deleteProjectActionItem(deleteRequest(), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.message, '只有事项创建人可以删除');
  assert.equal(connectionRequested, false);
});

test('creator deletion removes all shared calendar records in one transaction', async () => {
  const deletedTables = [];
  let committed = false;
  const connection = {
    async beginTransaction() {},
    async commit() {
      committed = true;
    },
    async rollback() {
      throw new Error('successful deletion must not roll back');
    },
    release() {},
    async query(sql, params) {
      const match = sql.match(/DELETE FROM\s+([a-z_]+)/i);
      assert.ok(match, `expected delete query, received: ${sql}`);
      deletedTables.push(match[1]);
      if (match[1] === 'project_action_items') {
        assert.deepEqual(params, [51, 9, 7]);
      } else {
        assert.deepEqual(params, [51]);
      }
      return [{ affectedRows: 1 }];
    },
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) return projectContextResult();
      if (/FROM project_action_items/.test(sql)) {
        assert.deepEqual(params, [51, 9]);
        return [[{ id: 51, created_by: 7 }]];
      }
      if (/SELECT media_url FROM project_action_item_media/.test(sql)) {
        assert.deepEqual(params, [51]);
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.deleteProjectActionItem(deleteRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.message, '待办事项已删除');
  assert.equal(committed, true);
  assert.deepEqual(deletedTables, [
    'project_action_notifications',
    'project_action_item_media',
    'project_action_item_feedback',
    'project_action_item_assignees',
    'project_action_items',
  ]);
});
