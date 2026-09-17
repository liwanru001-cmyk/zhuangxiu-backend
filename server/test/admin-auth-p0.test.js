'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const adminAuth = require('../services/admin-auth');

function environment(overrides = {}) {
  return {
    ADMIN_USERNAME: 'release-admin',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('correct horse battery staple', 4),
    ADMIN_TOKEN_VERSION: '7',
    ADMIN_JWT_EXPIRES_IN: '8h',
    JWT_SECRET: 'test-only-secret-that-is-longer-than-thirty-two-characters',
    ...overrides,
  };
}

test('administrator login uses the configured bcrypt hash', async () => {
  const env = environment();
  assert.equal(await adminAuth.authenticate('release-admin', 'correct horse battery staple', env), true);
  assert.equal(await adminAuth.authenticate('release-admin', 'wrong-password', env), false);
  assert.equal(await adminAuth.authenticate('other-admin', 'correct horse battery staple', env), false);
});

test('legacy long-lived administrator tokens without a version are revoked', () => {
  const env = environment();
  const legacy = jwt.sign({ role: 'admin' }, env.JWT_SECRET, { expiresIn: '30d' });
  assert.throws(() => adminAuth.verifyToken(legacy, env), /revoked/);
});

test('incrementing the administrator token version revokes an issued token', () => {
  const env = environment();
  const token = adminAuth.issueToken(env);
  assert.equal(adminAuth.verifyToken(token, env).adminTokenVersion, 7);
  assert.throws(() => adminAuth.verifyToken(token, { ...env, ADMIN_TOKEN_VERSION: '8' }), /revoked/);
});

test('administrator authentication refuses incomplete production configuration', () => {
  assert.throws(
    () => adminAuth.assertConfiguration({ JWT_SECRET: 'short' }),
    error => error.code === 'ADMIN_AUTH_NOT_CONFIGURED'
  );
});

test('application source contains no legacy fixed administrator credential', () => {
  const source = fs.readFileSync(require.resolve('../app'), 'utf8');
  assert.doesNotMatch(source, /admin123|ADMIN_CREDENTIALS/);
});
