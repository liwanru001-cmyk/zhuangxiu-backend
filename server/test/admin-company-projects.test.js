const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../services/admin-company-projects');

function row(id, extra = {}) {
  return {
    project_id: id, project_name: `工地 ${id}`, house_area: '100.00',
    source: 'inferred_company_member', role_type: 'designer',
    participant_status: 'active', responsible_name: '设计师',
    joined_at: '2026-10-01', participant_updated_at: '2026-10-02',
    ...extra,
  };
}

test('company counts batch both app membership sources and exclude removed/deleted projects', async () => {
  let calls = 0;
  const db = { async query(sql, params) {
    calls++;
    assert.match(sql, /ppe\.company_id = c\.id/);
    assert.match(sql, /ppe\.participant_type = 'company' AND ppe\.participant_id = c\.id/);
    assert.match(sql, /ppe\.status <> 'removed'/);
    assert.match(sql, /pm\.status = 1/);
    assert.match(sql, /cm\.status = 'active'/);
    assert.match(sql, /COALESCE\(p\.lifecycle_status, 'active'\) <> 'deleted'/);
    assert.match(sql, /COUNT\(DISTINCT p\.id\)/);
    assert.deepEqual(params, [1, 2, 1, 2]);
    return [[{ company_id: '1', project_count: '5' }]];
  }};
  const counts = await service.counts(db, [1, '1', 2]);
  assert.equal(calls, 1);
  assert.equal(counts.get(1), 5);
  assert.equal(counts.get(2) || 0, 0);
});

test('empty company page skips membership query', async () => {
  const db = { query() { throw new Error('unexpected query'); } };
  assert.equal((await service.counts(db, [])).size, 0);
  assert.deepEqual(await service.list(db, 0), []);
});

test('one explicit project plus four additional member projects produces five unique sites', () => {
  const rows = [row(1), row(1, { role_type: 'pm' }), row(1, {
    source: 'project_participants_ext', role_type: 'contractor', responsible_name: '公司负责人',
  }), row(8, { house_area: '500.00' }), row(11), row(21, { house_area: null }), row(24, { house_area: '0.00' })];
  const projects = service.mergeProjects(rows);
  assert.equal(projects.length, 5);
  assert.equal(projects.reduce((sum, p) => sum + (p.house_area || 0), 0), 700);
  assert.deepEqual(projects[0].role_types, ['contractor']);
  assert.equal(projects[0].responsible_names, '公司负责人');
  assert.equal(projects[0].source, 'project_participants_ext');
  assert.equal(projects[1].source, 'inferred_company_member');
});

test('multiple explicit roles remain visible without double-counting a site', () => {
  const projects = service.mergeProjects([
    row(1, { source: 'project_participants_ext', role_type: 'contractor', responsible_name: '负责人A' }),
    row(1, { source: 'project_participants_ext', role_type: 'designer', responsible_name: '负责人B', joined_at: '2026-09-01' }),
    row(1, { source: 'project_participants_ext', role_type: 'designer', responsible_name: '负责人B' }),
  ]);
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].role_types, ['contractor', 'designer']);
  assert.equal(projects[0].responsible_names, '负责人A、负责人B');
  assert.equal(projects[0].joined_at, '2026-09-01');
  assert.equal(projects[0].created_at, projects[0].joined_at);
});

test('project list scopes both branches to the selected company and keeps all results', async () => {
  const db = { async query(sql, params) {
    assert.deepEqual(params, [9, 9]);
    assert.match(sql, /cm\.company_id IN \(\?\)/);
    assert.match(sql, /c\.id IN \(\?\)/);
    assert.match(sql, /COALESCE\(p\.lifecycle_status, 'active'\) <> 'deleted'/);
    assert.match(sql, /ORDER BY p\.updated_at DESC, p\.id DESC/);
    assert.doesNotMatch(sql, /LIMIT (20|100)/);
    return [[row(12), row(12), row(10)]];
  }};
  const projects = await service.list(db, 9);
  assert.deepEqual(projects.map(p => p.project_id), [12, 10]);
});
