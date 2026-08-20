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
  const controllerPath = require.resolve('../controllers/user.controller');
  delete require.cache[dbPath];
  delete require.cache[projectContextPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/user.controller');
}

test('merchant consultation creates a merchant notification deep link', async () => {
  const writes = [];
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 3, 7]);
        return [[{ id: 3, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT u\.id, COALESCE\(profile\.consultation_enabled/.test(sql)) {
        assert.deepEqual(params, [42, 'merchant']);
        return [[{ id: 42, consultation_enabled: 1 }]];
      }
      if (/COUNT\(\*\) AS total FROM designer_consultations/.test(sql)) {
        return [[{ total: 0 }]];
      }
      if (/INSERT INTO designer_consultations/.test(sql)) {
        writes.push({ type: 'consultation', params });
        return [{ insertId: 88 }];
      }
      if (/INSERT IGNORE INTO entity_relations/.test(sql)) {
        writes.push({ type: 'relation', params });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO project_action_notifications/.test(sql)) {
        writes.push({ type: 'notification', params });
        return [{ insertId: 99 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createDesignerConsultation({
    user: { id: 7 },
    params: { id: '42' },
    body: {
      target_role: 'merchant',
      project_id: 3,
      content: '咨询商品：柔光砖\n\n咨询内容：想了解库存',
      has_project: false,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.id, 88);
  assert.equal(res.payload.data.project_id, 3);
  assert.equal(writes.length, 3);
  assert.equal(writes[1].type, 'relation');
  assert.deepEqual(writes[1].params, [88, 3]);
  assert.equal(writes[2].type, 'notification');
  assert.equal(writes[2].params[0], 42);
  const payload = JSON.parse(writes[2].params[1]);
  assert.equal(payload.source, 'consultation');
  assert.equal(payload.title, '新的商品咨询');
  assert.equal(payload.deepLink.consultationId, 88);
  assert.equal(payload.deepLink.projectId, 3);
  assert.equal(payload.route, 'consultation_chat');
});

test('notifications API excludes merchant consultation notifications', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /LEFT JOIN renovation_projects/);
      assert.match(sql, /targetRole/);
      assert.deepEqual(params, [42]);
      return [[]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getNotifications({ user: { id: 42 } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, []);
});

test('consultation reply creates notification for the other participant', async () => {
  const connectionCalls = [];
  const connection = {
    async beginTransaction() {
      connectionCalls.push({ type: 'begin' });
    },
    async query(sql, params) {
      if (/INSERT INTO consultation_messages/.test(sql)) {
        connectionCalls.push({ type: 'message', params });
        return [{ insertId: 501 }];
      }
      if (/INSERT IGNORE INTO consultation_message_reads/.test(sql)) {
        connectionCalls.push({ type: 'read', params });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO project_action_notifications/.test(sql)) {
        connectionCalls.push({ type: 'notification', params });
        return [{ insertId: 502 }];
      }
      if (/UPDATE designer_consultations/.test(sql)) {
        connectionCalls.push({ type: 'status', params });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected connection query: ${sql}`);
    },
    async commit() {
      connectionCalls.push({ type: 'commit' });
    },
    async rollback() {
      connectionCalls.push({ type: 'rollback' });
    },
    release() {
      connectionCalls.push({ type: 'release' });
    },
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [42, 3, 42]);
        return [[{ id: 3, user_id: 7, lifecycle_status: 'active', role: 'merchant' }]];
      }
      if (/FROM designer_consultations c/.test(sql) && /WHERE c\.id = \?/.test(sql)) {
        assert.deepEqual(params, [88, 42, 42]);
        return [[{
          id: 88,
          designer_id: 42,
          target_role: 'merchant',
          user_id: 7,
          content: '咨询商品：柔光砖',
          status: 'pending',
          designer_nickname: '木序家居',
          designer_avatar: '',
          user_nickname: '用户',
          user_avatar: '',
        }]];
      }
      if (/SELECT target_id AS project_id/.test(sql)) {
        assert.deepEqual(params, [88]);
        return [[{ project_id: 3 }]];
      }
      if (/COUNT\(\*\) AS total FROM consultation_messages/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ total: 0 }]];
      }
      if (/SELECT sender_id FROM consultation_messages/.test(sql)) {
        assert.deepEqual(params, [88, 3]);
        return [[{ sender_id: 7 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.sendConsultationMessage({
    user: { id: 42 },
    params: { id: '88' },
    body: { project_id: 3, content: '您好，这款砖有现货，可以到店看样。' },
  }, res);

  assert.equal(res.statusCode, 200);
  const notification = connectionCalls.find((item) => item.type === 'notification');
  assert.ok(notification);
  assert.equal(notification.params[0], 7);
  const payload = JSON.parse(notification.params[1]);
  assert.equal(payload.source, 'consultation');
  assert.equal(payload.title, '咨询有新回复');
  assert.equal(payload.consultationId, 88);
  assert.equal(payload.projectId, 3);
  assert.equal(payload.messageId, 501);
  assert.equal(payload.route, 'consultation_chat');
  const statusUpdate = connectionCalls.find((item) => item.type === 'status');
  assert.deepEqual(statusUpdate.params, [42, 7]);
  assert.equal(connectionCalls.at(-2).type, 'commit');
});

test('consultation create enforces daily quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 3, 7]);
        return [[{ id: 3, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT u\.id, COALESCE\(profile\.consultation_enabled/.test(sql)) {
        assert.deepEqual(params, [42, 'merchant']);
        return [[{ id: 42, consultation_enabled: 1 }]];
      }
      if (/COUNT\(\*\) AS total FROM designer_consultations/.test(sql) && /user_id = \? AND created_at/.test(sql)) {
        assert.deepEqual(params, [7]);
        return [[{ total: 10 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createDesignerConsultation({
    user: { id: 7 },
    params: { id: '42' },
    body: { project_id: 3, target_role: 'merchant', content: '想了解库存' },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多发起 10 条咨询/);
});

test('consultation reply enforces unanswered continuous message quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 3, 7]);
        return [[{ id: 3, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/FROM designer_consultations c/.test(sql) && /WHERE c\.id = \?/.test(sql)) {
        assert.deepEqual(params, [88, 7, 7]);
        return [[{
          id: 88,
          designer_id: 42,
          target_role: 'merchant',
          user_id: 7,
          content: '咨询商品：柔光砖',
          status: 'pending',
          designer_nickname: '木序家居',
          designer_avatar: '',
          user_nickname: '用户',
          user_avatar: '',
        }]];
      }
      if (/SELECT target_id AS project_id/.test(sql)) {
        assert.deepEqual(params, [88]);
        return [[{ project_id: 3 }]];
      }
      if (/COUNT\(\*\) AS total FROM consultation_messages/.test(sql)) {
        assert.deepEqual(params, [7]);
        return [[{ total: 0 }]];
      }
      if (/SELECT sender_id FROM consultation_messages/.test(sql)) {
        assert.deepEqual(params, [88, 3]);
        return [[{ sender_id: 7 }, { sender_id: 7 }, { sender_id: 7 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.sendConsultationMessage({
    user: { id: 7 },
    params: { id: '88' },
    body: { project_id: 3, content: '再问一下' },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /连续最多 3 条/);
});

test('feedback enforces daily quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/COUNT\(\*\) AS total FROM user_feedback/.test(sql)) {
        assert.deepEqual(params, [7]);
        return [[{ total: 3 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.submitFeedback({
    user: { id: 7 },
    body: { content: '这里需要优化' },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多提交 3 条反馈/);
});

test('avatar upload enforces monthly change quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT avatar, avatar_changed_at FROM users/.test(sql)) {
        assert.deepEqual(params, [7]);
        return [[{
          avatar: 'https://example.com/old.jpg',
          avatar_changed_at: new Date().toISOString(),
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.uploadAvatar({
    protocol: 'https',
    get: () => 'example.com',
    user: { id: 7 },
    file: {
      filename: 'new.jpg',
      path: '/tmp/non-existent-avatar.jpg',
    },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.payload.message, '头像每月只能更换一次，请下月再试');
});

test('merchant image profile changes move verified merchant back to pending review', async () => {
  const writes = [];
  let profileReads = 0;
  const dbMock = {
    async query(sql, params) {
      if (/FROM merchant_profiles/.test(sql) && /WHERE user_id = \?/.test(sql)) {
        profileReads += 1;
        assert.deepEqual(params, [42]);
        return [[{
          user_id: 42,
          shop_name: '旧店铺',
          logo_url: 'https://example.com/old-logo.jpg',
          cover_url: '',
          service_area: '',
          address: '',
          contact_phone: '',
          business_hours: '',
          category_group: '',
          categories: JSON.stringify([]),
          service_types: JSON.stringify([]),
          case_count: 0,
          brand_intro: '',
          after_sales_promise: '',
          license_url: 'https://example.com/old-license.jpg',
          authorization_url: '',
          consultation_enabled: 1,
          updated_at: null,
        }]];
      }
      if (/INSERT INTO merchant_profiles/.test(sql)) {
        writes.push({ type: 'profile', params });
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE user_roles/.test(sql) && /verified_status = 'pending'/.test(sql)) {
        writes.push({ type: 'pending', params });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.upsertMerchantProfile({
    user: { id: 42, role: 'merchant' },
    body: {
      shop_name: '旧店铺',
      logo_url: 'https://example.com/new-logo.jpg',
      license_url: 'https://example.com/old-license.jpg',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.payload.message, /重新审核/);
  assert.equal(profileReads, 2);
  assert.equal(writes.some((item) => item.type === 'pending'), true);
});
