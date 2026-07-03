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
  const controllerPath = require.resolve('../controllers/user.controller');
  delete require.cache[dbPath];
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
      if (/SELECT u\.id, COALESCE\(profile\.consultation_enabled/.test(sql)) {
        assert.deepEqual(params, [42, 'merchant']);
        return [[{ id: 42, consultation_enabled: 1 }]];
      }
      if (/INSERT INTO designer_consultations/.test(sql)) {
        writes.push({ type: 'consultation', params });
        return [{ insertId: 88 }];
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
      content: '咨询商品：柔光砖\n\n咨询内容：想了解库存',
      has_project: false,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.id, 88);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].type, 'notification');
  assert.equal(writes[1].params[0], 42);
  const payload = JSON.parse(writes[1].params[1]);
  assert.equal(payload.source, 'consultation');
  assert.equal(payload.title, '新的商品咨询');
  assert.equal(payload.deepLink.consultationId, 88);
  assert.equal(payload.route, 'consultation_chat');
});

test('notifications API returns consultation notification routing data', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /LEFT JOIN renovation_projects/);
      assert.deepEqual(params, [42]);
      return [[{
        id: 12,
        item_id: null,
        event_type: 'consultation',
        delivery_status: 'pending',
        payload: JSON.stringify({
          source: 'consultation',
          title: '新的商品咨询',
          content: '你收到一条新的商品咨询',
          route: 'consultation_chat',
          deepLink: { consultationId: 88 },
          entityType: 'consultation',
          entityId: 88,
        }),
        read_at: null,
        created_at: '2026-07-03T12:00:00.000Z',
        project_id: null,
        content: null,
        item_status: null,
        creator_name: null,
        case_share_title: null,
        case_share_creator_name: null,
        project_name: null,
      }]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getNotifications({ user: { id: 42 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].type, 'consultation');
  assert.equal(res.payload.data[0].title, '新的商品咨询');
  assert.equal(res.payload.data[0].route, 'consultation_chat');
  assert.equal(res.payload.data[0].deep_link.consultationId, 88);
  assert.equal(res.payload.data[0].entity_id, 88);
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
    body: { content: '您好，这款砖有现货，可以到店看样。' },
  }, res);

  assert.equal(res.statusCode, 200);
  const notification = connectionCalls.find((item) => item.type === 'notification');
  assert.ok(notification);
  assert.equal(notification.params[0], 7);
  const payload = JSON.parse(notification.params[1]);
  assert.equal(payload.source, 'consultation');
  assert.equal(payload.title, '咨询有新回复');
  assert.equal(payload.consultationId, 88);
  assert.equal(payload.messageId, 501);
  assert.equal(payload.route, 'consultation_chat');
  assert.equal(connectionCalls.at(-2).type, 'commit');
});
