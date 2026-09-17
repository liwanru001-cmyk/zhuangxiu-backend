'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGlobalSlotManager, configuredLimit, lockName } = require('../services/product-ingestion-global-slots');
const { createRunner } = require('../services/product-ingestion-runner');

function mysqlPool() {
  const held = new Set();
  const connections = [];
  return {
    held,
    connections,
    async getConnection() {
      const connection = {
        released: false,
        async query(sql, params) {
          const name = params[0];
          if (sql.includes('GET_LOCK')) {
            if (held.has(name)) return [[{ acquired: 0 }]];
            held.add(name);
            return [[{ acquired: 1 }]];
          }
          if (sql.includes('RELEASE_LOCK')) {
            held.delete(name);
            return [[{ released: 1 }]];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() { this.released = true; },
      };
      connections.push(connection);
      return connection;
    },
  };
}

test('global ingestion slots use bounded MySQL advisory locks across managers', async () => {
  const pool = mysqlPool();
  const env = { DB_HOST: 'db', DB_PORT: '3306', DB_NAME: 'prod', INGESTION_GLOBAL_CONCURRENCY: '2' };
  const firstManager = createGlobalSlotManager(pool, { env });
  const secondManager = createGlobalSlotManager(pool, { env });
  const first = await firstManager.acquire({ jobId: 1, phase: 'discovery' });
  const second = await secondManager.acquire({ jobId: 2, phase: 'extraction' });
  assert.deepEqual([first.slot, second.slot], [1, 2]);
  assert.equal(await firstManager.acquire({ jobId: 3 }), null);
  assert.equal(pool.held.size, 2);
  await first.release();
  const replacement = await secondManager.acquire({ jobId: 3 });
  assert.equal(replacement.slot, 1);
  await second.release();
  await replacement.release();
  assert.equal(pool.held.size, 0);
  assert.equal(pool.connections.every(connection => connection.released), true);
});

test('global concurrency configuration is bounded and lock names are deployment scoped', () => {
  assert.equal(configuredLimit({ INGESTION_GLOBAL_CONCURRENCY: '2' }), 2);
  assert.throws(() => configuredLimit({ INGESTION_GLOBAL_CONCURRENCY: '0' }), /between 1 and 8/);
  assert.notEqual(lockName(1, { DB_NAME: 'one' }), lockName(1, { DB_NAME: 'two' }));
  assert.equal(lockName(1, { DB_HOST: 'db-a', DB_NAME: 'shared' }), lockName(1, { DB_HOST: 'db-b', DB_NAME: 'shared' }));
  assert.ok(lockName(8, { DB_NAME: 'production' }).length <= 64);
});

test('a runner without a global slot stays queued and retries without database writes', async () => {
  const scheduled = [];
  const db = { query: async sql => { throw new Error(`Unexpected query while capacity is full: ${sql}`); } };
  const runner = createRunner(db, {
    globalSlots: { acquire: async () => null },
    scheduleAt: callback => { scheduled.push(callback); },
    globalSlotRetryMs: 100,
  });
  await runner.run(901);
  assert.equal(scheduled.length, 1);
});

test('production slot manager refuses a non-pool database backend', () => {
  assert.throws(
    () => createGlobalSlotManager({ query: async () => {} }, { env: { NODE_ENV: 'production', INGESTION_GLOBAL_CONCURRENCY: '2' } }),
    error => error.code === 'INGESTION_GLOBAL_SLOT_BACKEND_REQUIRED'
  );
});
