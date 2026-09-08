const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const rollout = require('../services/independent-project-rollout');
const schema = require('../services/independent-project-schema');
const previous = process.env.FEATURE_INDEPENDENT_PROJECTS;
afterEach(() => { if (previous === undefined) delete process.env.FEATURE_INDEPENDENT_PROJECTS; else process.env.FEATURE_INDEPENDENT_PROJECTS = previous; });
const modern = { headers: { 'x-zxw-projects': 'independent-desktop-v1' } };
function response() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
test('default closed, wrong protocol rejected, explicit opt-in permits only compatible client', () => {
  delete process.env.FEATURE_INDEPENDENT_PROJECTS;
  let entered = false;
  const closed = response();
  rollout.featureGate(modern, closed, () => { entered = true; });
  assert.equal(closed.statusCode, 403);
  assert.equal(entered, false);
  process.env.FEATURE_INDEPENDENT_PROJECTS = 'true';
  for (const req of [{}, { headers: { 'x-zxw-projects': 'independent-v0' } }]) {
    const old = response();
    rollout.featureGate(req, old, () => { entered = true; });
    assert.equal(old.statusCode, 409);
    assert.equal(entered, false);
  }
  rollout.featureGate(modern, response(), () => { entered = true; });
  assert.equal(entered, true);
});
test('disabling creation retains compatible read access while hiding projects from old clients', () => {
  process.env.FEATURE_INDEPENDENT_PROJECTS = 'false';
  assert.equal(rollout.legacyProjectFilter(modern), '');
  assert.match(rollout.legacyProjectFilter({}), /<> 'designer'/);
  const res = response();
  rollout.features(modern, res);
  assert.equal(res.body.data.independent_projects, false);
});
function completeColumns() {
  return Object.entries(schema.requiredColumns).flatMap(([table, names]) => names.map(name => ({
    TABLE_NAME: table, COLUMN_NAME: name, IS_NULLABLE: 'YES',
    COLUMN_DEFAULT: name === 'creation_source' ? 'owner' : name === 'preparation_stage' ? 'construction' : null,
  })));
}
test('readiness rejects missing schema, incompatible defaults and NOT NULL dates', async () => {
  await assert.rejects(schema.assertSchema({ query: async () => [[]] }), /migration required/);
  const rows = completeColumns();
  await schema.assertSchema({ query: async () => [rows] });
  rows.find(r => r.COLUMN_NAME === 'start_date').IS_NULLABLE = 'NO';
  rows.find(r => r.COLUMN_NAME === 'creation_source').COLUMN_DEFAULT = 'designer';
  await assert.rejects(schema.assertSchema({ query: async () => [rows] }), /start_date must allow NULL.*creation_source default must be owner/);
});
test('rerunning complete migration never issues an ALTER and releases its lock', async () => {
  const calls = [];
  const connection = { async query(sql) {
    calls.push(sql);
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('information_schema.COLUMNS')) return [completeColumns()];
    return [{}];
  } };
  await schema.migrate(connection);
  assert.equal(calls.some(sql => sql.startsWith('ALTER TABLE')), false);
  assert.match(calls.at(-1), /RELEASE_LOCK/);
});
test('failed DDL releases lock and propagates failure so deployment cannot activate', async () => {
  const calls = [];
  await assert.rejects(schema.migrate({ async query(sql) {
    calls.push(sql);
    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
    if (sql.includes('information_schema.COLUMNS')) return [[]];
    if (sql.startsWith('ALTER TABLE')) throw new Error('metadata lock timeout');
    return [{}];
  } }), /metadata lock timeout/);
  assert.match(calls.at(-1), /RELEASE_LOCK/);
});

test('actual renovation routes enforce authentication, default-off, old-client isolation and designer role', async () => {
  const dbPath = require.resolve('../config/db');
  let writes = 0;
  const dbMock = { async query(sql, params) {
    if (sql.includes('admin_status FROM users')) return [[{ id: params[0], role: params[0] === 7 ? 'designer' : 'owner' }]];
    if (sql.includes('SELECT creation_source FROM renovation_projects')) return [[{ creation_source: 'designer' }]];
    if (sql.includes('FROM project_members pm')) {
      assert.match(sql, /COALESCE\(p.creation_source, 'owner'\) <> 'designer'/);
      return [[]];
    }
    throw new Error(`Unexpected route query: ${sql}`);
  }, async getConnection() { writes++; throw new Error('Creation should be blocked before DB writes'); } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'disposable-rollout-route-test-only';
  const app = express();
  app.use(express.json());
  app.use('/api/renovation', require('../routes/renovation.routes'));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api/renovation`;
  const auth = { authorization: `Bearer ${jwt.sign({ userId: 7 }, process.env.JWT_SECRET)}` };
  try {
    delete process.env.FEATURE_INDEPENDENT_PROJECTS;
    assert.equal((await fetch(base + '/independent-projects', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/independent-projects', { method: 'POST', headers: { ...auth, ...modern.headers } })).status, 403);
    process.env.FEATURE_INDEPENDENT_PROJECTS = 'true';
    assert.equal((await fetch(base + '/independent-projects', { method: 'POST', headers: auth })).status, 409);
    const ownerAuth = { authorization: `Bearer ${jwt.sign({ userId: 8 }, process.env.JWT_SECRET)}` };
    assert.equal((await fetch(base + '/independent-projects', { method: 'POST', headers: { ...ownerAuth, ...modern.headers } })).status, 403);
    const invitations = await fetch(base + '/owner-invitations', { headers: auth });
    assert.deepEqual((await invitations.json()).data, []);
    assert.equal((await fetch(base + '/projects/91', { headers: auth })).status, 409);
    assert.equal((await fetch(base + '/projects/91/info', { method: 'PUT', headers: auth })).status, 409);
    assert.equal((await fetch(base + '/my-projects', { headers: auth })).status, 200);
    assert.equal(writes, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  }
});
