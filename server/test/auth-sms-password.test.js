const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

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
  const controllerPath = require.resolve('../controllers/auth.controller');
  delete require.cache[dbPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/auth.controller');
}

test('sms verify creates a formal account for a new phone', async () => {
  const writes = [];
  const dbMock = {
    async query(sql, params) {
      if (/FROM sms_codes/.test(sql)) {
        assert.deepEqual(params, ['13800138000', 'register']);
        return [[{ id: 7, code: '123456', expires_at: new Date(Date.now() + 60000), used: 0 }]];
      }
      if (/UPDATE sms_codes SET used = 1/.test(sql)) {
        writes.push({ type: 'consume', params });
        return [{}];
      }
      if (/FROM users WHERE phone = \?/.test(sql)) {
        return [[]];
      }
      if (/INSERT INTO users/.test(sql)) {
        assert.match(sql, /'approved'/);
        writes.push({ type: 'insert-user', params });
        return [{ insertId: 42 }];
      }
      if (/INSERT IGNORE INTO user_roles/.test(sql)) {
        writes.push({ type: 'insert-role', params });
        return [{}];
      }
      if (/SELECT role FROM user_roles/.test(sql)) {
        return [[{ role: 'owner' }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.verifySms({ body: { phone: '13800138000', code: '123456' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.user.phone, '13800138000');
  assert.equal(typeof res.payload.data.token, 'string');
  assert.equal(writes.some((item) => item.type === 'insert-user'), true);
});

test('sms verify rejects an already registered phone', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM sms_codes/.test(sql)) {
        assert.deepEqual(params, ['13800138000', 'register']);
        return [[{ id: 8, code: '123456', expires_at: new Date(Date.now() + 60000), used: 0 }]];
      }
      if (/UPDATE sms_codes SET used = 1/.test(sql)) {
        return [{}];
      }
      if (/FROM users WHERE phone = \?/.test(sql)) {
        return [[{
          id: 3,
          phone: '13800138000',
          password_hash: 'hash',
          nickname: '已注册用户',
          avatar: '',
          bio: '',
          city: '',
          role: 'owner',
          admin_status: 'approved',
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.verifySms({ body: { phone: '13800138000', code: '123456' } }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.message, /已注册/);
});

test('password login does not create an account for an unknown phone', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM users WHERE phone = \?/);
      assert.deepEqual(params, ['13800138000']);
      return [[]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.passwordLogin({ body: { phone: '13800138000', password: 'abc12345' } }, res);

  assert.equal(res.statusCode, 404);
  assert.match(res.payload.message, /未注册/);
});

test('send sms register scene rejects an existing phone', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM users WHERE phone = \?/);
      assert.deepEqual(params, ['13800138000']);
      return [[{
        id: 3,
        phone: '13800138000',
        password_hash: 'hash',
        nickname: '已注册用户',
        avatar: '',
        bio: '',
        city: '',
        role: 'owner',
        admin_status: 'approved',
      }]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.sendSmsCode({
    body: { phone: '13800138000', scene: 'register' },
    ip: '127.0.0.1',
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.message, /已注册/);
});

test('send sms reset password scene rejects an unknown phone', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM users WHERE phone = \?/);
      assert.deepEqual(params, ['13800138000']);
      return [[]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.sendSmsCode({
    body: { phone: '13800138000', scene: 'reset_password' },
    ip: '127.0.0.1',
  }, res);

  assert.equal(res.statusCode, 404);
  assert.match(res.payload.message, /未注册/);
});
