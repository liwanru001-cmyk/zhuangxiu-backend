const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createBackendAlerts } = require('../services/backend-alerts');

function response(alerts, pathname, status, { method = 'GET', unmatched = false, route, baseUrl } = {}) {
  const req = { method, originalUrl: pathname, route: route && { path: route }, baseUrl };
  const res = Object.assign(new EventEmitter(), { statusCode: status, locals: { unmatchedApi: unmatched } });
  alerts.middleware(req, res, () => {});
  res.emit('finish');
}

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backend-alerts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('records missing API routes and server failures, grouping without query strings or record IDs', async t => {
  const directory = await setup(t);
  const alerts = createBackendAlerts(directory, { clock: () => new Date('2026-11-25T09:00:00Z') });
  await alerts.list(1);
  for (let i = 0; i < 2; i++) {
    response(alerts, '/api/renovation/owner-projects?token=example', 404, { method: 'POST', unmatched: true });
  }
  response(alerts, '/api/renovation/projects/981', 500, { route: '/projects/:id', baseUrl: '/api/renovation' });
  response(alerts, '/api/renovation/projects/981', 404, { route: '/projects/:id' });
  response(alerts, '/api/auth/password-login', 401);
  response(alerts, '/api/admin/backend-alerts', 500);
  response(alerts, '/wp-login.php', 404, { unmatched: true });

  const result = await alerts.list(1);
  assert.deepEqual(result.counts, { missing: 2, server: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.rows.find(row => row.status === 404).route, '/api/renovation/owner-projects');
  assert.equal(result.rows.find(row => row.status === 404).count, 2);
  assert.equal(result.rows.find(row => row.status === 500).route, '/api/renovation/projects/:id');
  assert.doesNotMatch(await fs.readFile(path.join(directory, '2026-11-25.jsonl'), 'utf8'), /example|981/);
});

test('uses Beijing calendar dates and reads historical alerts after restart', async t => {
  const directory = await setup(t);
  let now = new Date('2026-11-25T15:59:00Z');
  const clock = () => now;
  const alerts = createBackendAlerts(directory, { clock });
  response(alerts, '/api/health', 503);
  await alerts.list(1);
  now = new Date('2026-11-25T16:00:00Z');
  const restarted = createBackendAlerts(directory, { clock });
  assert.deepEqual((await restarted.list(1)).counts, { missing: 0, server: 0 });
  assert.deepEqual((await restarted.list(7)).counts, { missing: 0, server: 1 });
  response(restarted, '/api/health', 503);
  await restarted.list(1);
  const group = (await restarted.list(7)).rows[0];
  assert.equal(group.count, 2);
  assert.equal(group.first_at, '2026-11-25T15:59:00.000Z');
  assert.equal(group.last_at, '2026-11-25T16:00:00.000Z');
});
