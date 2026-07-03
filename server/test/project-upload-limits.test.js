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

function loadController(dbMock, storageMock = {}) {
  const dbPath = require.resolve('../config/db');
  const storagePath = require.resolve('../services/storage.service');
  const projectContextPath = require.resolve('../utils/project-context');
  const controllerPath = require.resolve('../controllers/renovation.controller');
  delete require.cache[dbPath];
  delete require.cache[storagePath];
  delete require.cache[projectContextPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  require.cache[storagePath] = {
    id: storagePath,
    filename: storagePath,
    loaded: true,
    exports: storageMock,
  };
  return require('../controllers/renovation.controller');
}

test('project check-in enforces daily quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/COUNT\(\*\) AS total FROM project_checkins/.test(sql) && /created_at >= CURDATE/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ total: 3 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProjectCheckIn({
    user: { id: 7 },
    params: { id: '9' },
    body: { project_id: 9, description: '今天水电验收', checkin_date: '2026-07-03' },
    files: [],
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /每天最多发布 3 条工地打卡/);
});

test('project inspection rejects more than three images', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT id FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ id: 1 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProjectInspection({
    user: { id: 7 },
    params: { id: '9' },
    body: { project_id: 9, task_id: '3', description: '现场验收' },
    files: [
      { path: '/tmp/no-a.jpg' },
      { path: '/tmp/no-b.jpg' },
      { path: '/tmp/no-c.jpg' },
      { path: '/tmp/no-d.jpg' },
    ],
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /验收图片最多上传 3 张/);
});

test('design document upload enforces project total quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'designer' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'designer' }]];
      }
      if (/COUNT\(\*\) AS total FROM project_design_documents/.test(sql) && !/uploaded_by/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{ total: 30 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock, {
    async storeDesignDocument() {
      throw new Error('storage should not be called when quota is exceeded');
    },
  });
  const res = mockResponse();

  await controller.uploadProjectDesignDocument({
    user: { id: 7 },
    params: { id: '9' },
    body: { project_id: 9 },
    file: {
      path: '/tmp/no-design.jpg',
      originalname: 'design.jpg',
      mimetype: 'image/jpeg',
      size: 100,
    },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多保存 30 份设计文档/);
});
