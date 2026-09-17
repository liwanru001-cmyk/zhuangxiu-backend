'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { validateProductionContract } = require('../scripts/check-production-contract');

function environment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    APP_RUNTIME_MODE: 'normal',
    PRODUCTION_NODE_MAJOR: '22',
    DB_HOST: 'db.internal',
    DB_USER: 'app',
    DB_PASSWORD: 'test-database-password',
    DB_NAME: 'app',
    JWT_SECRET: 'test-only-secret-longer-than-thirty-two-characters',
    ADMIN_USERNAME: 'release-admin',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4),
    ADMIN_TOKEN_VERSION: '1',
    ADMIN_JWT_EXPIRES_IN: '8h',
    INGESTION_GLOBAL_CONCURRENCY: '2',
    INGESTION_AI_API_KEY: 'test-key',
    INGESTION_AI_MODEL: 'test-model',
    INGESTION_AI_BASE_URL: 'https://ai.example.invalid/v1',
    REDIS_URL: 'redis://redis.internal:6379',
    SMS_RATE_LIMIT_ALLOW_MEMORY_FALLBACK: 'false',
    STORAGE_DRIVER: 'local',
    PRESENTATION_FC_MATCH: '/usr/bin/fc-match',
    PRESENTATION_V2_FALLBACK_FONT: 'Test Font',
    ...overrides,
  };
}

const runtime = { nodeVersion: '22.18.0', checkFont: false, executable: value => value, chromiumExecutablePath: () => '/usr/bin/chromium' };

test('production contract accepts an explicit bounded runtime configuration', () => {
  const result = validateProductionContract(environment(), runtime);
  assert.equal(result.node_major, 22);
  assert.equal(result.ingestion_global_concurrency, 2);
  assert.equal(result.redis_protocol, 'redis:');
});

test('production contract rejects missing services, version drift and unsafe fallback', () => {
  assert.throws(
    () => validateProductionContract(environment({
      INGESTION_AI_API_KEY: '', PRESENTATION_V2_API_KEY: '', DASHSCOPE_API_KEY: '', PRESENTATION_AI_API_KEY: '',
      REDIS_URL: '', SMS_RATE_LIMIT_ALLOW_MEMORY_FALLBACK: 'true', INGESTION_GLOBAL_CONCURRENCY: '20',
    }), { ...runtime, nodeVersion: '24.0.0', chromiumExecutablePath: () => null }),
    error => error.code === 'PRODUCTION_CONTRACT_INVALID'
      && error.message.includes('Node.js major must be 22')
      && error.message.includes('Ingestion AI API key')
      && error.message.includes('INGESTION_GLOBAL_CONCURRENCY')
      && error.message.includes('Chromium')
  );
});

test('production contract requires complete OSS configuration only when enabled', () => {
  assert.throws(
    () => validateProductionContract(environment({ STORAGE_DRIVER: 'oss', OSS_BUCKET: '' }), runtime),
    error => error.code === 'PRODUCTION_CONTRACT_INVALID' && error.message.includes('OSS_BUCKET')
  );
});

test('deployment enforces the production contract before migrations', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy-backend.yml'), 'utf8');
  const contract = workflow.indexOf('npm run check:production-contract -- --connectivity');
  const migrations = workflow.indexOf('node scripts/run-pending-migrations.js');
  assert.ok(contract > 0);
  assert.ok(migrations > contract);
});
