const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcryptjs');

process.env.NODE_ENV = 'test';
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

function loadController(dbMock, serviceMocks = {}) {
  const dbPath = require.resolve('../config/db');
  const controllerPath = require.resolve('../controllers/auth.controller');
  const limiterPath = require.resolve('../services/sms-rate-limiter.service');
  const smsPath = require.resolve('../services/aliyun-sms.service');
  delete require.cache[dbPath];
  delete require.cache[controllerPath];
  delete require.cache[limiterPath];
  delete require.cache[smsPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  if (serviceMocks.rateLimiter) {
    require.cache[limiterPath] = {
      id: limiterPath,
      filename: limiterPath,
      loaded: true,
      exports: serviceMocks.rateLimiter,
    };
  }
  if (serviceMocks.aliyunSms) {
    require.cache[smsPath] = {
      id: smsPath,
      filename: smsPath,
      loaded: true,
      exports: serviceMocks.aliyunSms,
    };
  }
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

test('password login returns a clear message when the password is wrong', async () => {
  const passwordHash = await bcrypt.hash('correct123', 4);
  const dbMock = {
    async query(sql, params) {
      if (/FROM users WHERE phone = \?/.test(sql)) {
        assert.deepEqual(params, ['13800138000']);
        return [[{
          id: 3,
          phone: '13800138000',
          password_hash: passwordHash,
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

  await controller.passwordLogin({
    body: { phone: '13800138000', password: 'wrong123' },
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.message, '密码错误，请重新输入');
});

test('test login only accepts a pre-created approved allowlisted account', async () => {
  const previousPassword = process.env.TEST_LOGIN_PASSWORD;
  const previousPhones = process.env.TEST_LOGIN_PHONES;
  process.env.TEST_LOGIN_PASSWORD = '123456';
  process.env.TEST_LOGIN_PHONES = '13800138000, 13900139000';
  const dbMock = {
    async query(sql, params) {
      if (/FROM users WHERE phone = \?/.test(sql)) {
        assert.deepEqual(params, ['13800138000']);
        return [[{
          id: 52,
          phone: '13800138000',
          role: 'owner',
          nickname: '测试账号',
          avatar: '',
          bio: '',
          city: '',
          admin_status: 'approved',
          identity_onboarding_completed: 1,
        }]];
      }
      if (/SELECT role FROM user_roles/.test(sql)) {
        return [[{ role: 'owner' }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  try {
    await controller.testLogin({ body: { phone: '13800138000', password: '123456' } }, res);
  } finally {
    if (previousPassword === undefined) {
      delete process.env.TEST_LOGIN_PASSWORD;
    } else {
      process.env.TEST_LOGIN_PASSWORD = previousPassword;
    }
    if (previousPhones === undefined) {
      delete process.env.TEST_LOGIN_PHONES;
    } else {
      process.env.TEST_LOGIN_PHONES = previousPhones;
    }
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.user.phone, '13800138000');
});

test('test login rejects non-allowlisted phones before querying the database', async () => {
  const previousPassword = process.env.TEST_LOGIN_PASSWORD;
  const previousPhones = process.env.TEST_LOGIN_PHONES;
  process.env.TEST_LOGIN_PASSWORD = '123456';
  process.env.TEST_LOGIN_PHONES = '13900139000';
  let queried = false;
  const dbMock = {
    async query() {
      queried = true;
      throw new Error('should not query db for wrong test password');
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  try {
    await controller.testLogin({ body: { phone: '13800138000', password: '123456' } }, res);
  } finally {
    if (previousPassword === undefined) {
      delete process.env.TEST_LOGIN_PASSWORD;
    } else {
      process.env.TEST_LOGIN_PASSWORD = previousPassword;
    }
    if (previousPhones === undefined) {
      delete process.env.TEST_LOGIN_PHONES;
    } else {
      process.env.TEST_LOGIN_PHONES = previousPhones;
    }
  }

  assert.equal(res.statusCode, 401);
  assert.match(res.payload.message, /错误/);
  assert.equal(queried, false);
});

test('test login never creates a missing allowlisted account', async () => {
  const previousPassword = process.env.TEST_LOGIN_PASSWORD;
  const previousPhones = process.env.TEST_LOGIN_PHONES;
  process.env.TEST_LOGIN_PASSWORD = '123456';
  process.env.TEST_LOGIN_PHONES = '13800138000';
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM users WHERE phone = \?/);
      assert.deepEqual(params, ['13800138000']);
      return [[]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  try {
    await controller.testLogin({ body: { phone: '13800138000', password: '123456' } }, res);
  } finally {
    if (previousPassword === undefined) delete process.env.TEST_LOGIN_PASSWORD;
    else process.env.TEST_LOGIN_PASSWORD = previousPassword;
    if (previousPhones === undefined) delete process.env.TEST_LOGIN_PHONES;
    else process.env.TEST_LOGIN_PHONES = previousPhones;
  }

  assert.equal(res.statusCode, 403);
  assert.match(res.payload.message, /不存在或未审核/);
});

test('test login rejects an allowlisted account that is not approved', async () => {
  const previousPassword = process.env.TEST_LOGIN_PASSWORD;
  const previousPhones = process.env.TEST_LOGIN_PHONES;
  process.env.TEST_LOGIN_PASSWORD = '123456';
  process.env.TEST_LOGIN_PHONES = '13800138000';
  const dbMock = {
    async query(sql) {
      assert.match(sql, /FROM users WHERE phone = \?/);
      return [[{
        id: 52,
        phone: '13800138000',
        role: 'owner',
        nickname: '待审核测试账号',
        avatar: '',
        bio: '',
        city: '',
        admin_status: 'pending',
      }]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  try {
    await controller.testLogin({ body: { phone: '13800138000', password: '123456' } }, res);
  } finally {
    if (previousPassword === undefined) delete process.env.TEST_LOGIN_PASSWORD;
    else process.env.TEST_LOGIN_PASSWORD = previousPassword;
    if (previousPhones === undefined) delete process.env.TEST_LOGIN_PHONES;
    else process.env.TEST_LOGIN_PHONES = previousPhones;
  }

  assert.equal(res.statusCode, 403);
  assert.match(res.payload.message, /不存在或未审核/);
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

test('send sms rejects when Redis limiter blocks a frequent phone', async () => {
  let aliyunCalled = false;
  const dbMock = {
    async query(sql, params) {
      if (/FROM users WHERE phone = \?/.test(sql)) {
        assert.deepEqual(params, ['13800138000']);
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock, {
    rateLimiter: {
      async enforceSendLimit({ phone, scene }) {
        assert.equal(phone, '13800138000');
        assert.equal(scene, 'register');
        return { allowed: false, message: '验证频繁，稍后再试', statusCode: 429 };
      },
    },
    aliyunSms: {
      async sendVerificationCode() {
        aliyunCalled = true;
      },
    },
  });
  const res = mockResponse();

  await controller.sendSmsCode({
    body: { phone: '13800138000', scene: 'register' },
    ip: '127.0.0.1',
  }, res);

  assert.equal(res.statusCode, 429);
  assert.equal(res.payload.message, '验证频繁，稍后再试');
  assert.equal(aliyunCalled, false);
});

test('sms verify invalidates a code after five wrong attempts', async () => {
  const writes = [];
  const dbMock = {
    async query(sql, params) {
      if (/FROM sms_codes/.test(sql)) {
        return [[{ id: 9, code: '123456', expires_at: new Date(Date.now() + 60000), used: 0 }]];
      }
      if (/UPDATE sms_codes SET used = 1/.test(sql)) {
        writes.push(params);
        return [{}];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock, {
    rateLimiter: {
      async registerCodeFailure({ codeId }) {
        assert.equal(codeId, 9);
        return { count: 5, exhausted: true };
      },
      async clearCodeFailures() {
        throw new Error('should not clear failures on wrong code');
      },
    },
  });
  const res = mockResponse();

  await controller.verifySms({ body: { phone: '13800138000', code: '999999' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '验证码错误次数过多，请重新获取');
  assert.deepEqual(writes, [[9]]);
});
