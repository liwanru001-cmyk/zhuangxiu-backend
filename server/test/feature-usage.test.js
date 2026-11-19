const test = require('node:test');
const assert = require('node:assert/strict');
const { FEATURES, options, eventSql, getUsage } = require('../services/feature-usage');

function fixture({ missing = [], events = [], users = [], testFlag = true } = {}) {
  const columns = FEATURES.filter(f => !missing.includes(f.key)).flatMap(f =>
    (f.sources || [f]).flatMap(source => {
      const actors = f.key === 'projects' ? ['created_by', 'user_id'] : [source.actor];
      const extras = { joined: ['status', 'role', 'project_id'], images: ['source_type'], materials: ['deleted_at'], notes: ['status'] }[f.key] || [];
      return [source.time || 'created_at', ...actors, ...extras].map(column_name => ({ table_name: source.table, column_name }));
    }));
  if (!missing.includes('projects')) columns.push({ table_name: 'renovation_projects', column_name: 'id' });
  if (testFlag) columns.push({ table_name: 'users', column_name: 'is_test_account' });
  const queries = [];
  return { queries, async query(sql) {
    queries.push(sql);
    if (sql.includes('information_schema')) return [columns];
    if (sql.startsWith('SELECT DISTINCT rel.user_id')) return [[]];
    if (sql.startsWith('SELECT id')) return [users.filter(u => !sql.includes('WHERE COALESCE') || !u.is_test_account)];
    return [events];
  } };
}

test('counts are attributed to operators, exclude test/deleted accounts, and rank by people', async () => {
  const db = fixture({ users: [{ id: 1, nickname: '业主', phone: '13800000000' }, { id: 2, nickname: '设计师' }, { id: 3, nickname: '测试', is_test_account: 1 }, { id: 4, nickname: '新用户' }],
    events: [
      { user_id: 1, feature: 'projects', total: '1', last_at: '2026-10-10T00:00:00Z' },
      { user_id: 2, feature: 'documents', total: '8', last_at: '2026-10-11T00:00:00Z' },
      { user_id: 1, feature: 'documents', total: '2', last_at: '2026-10-12T00:00:00Z' },
      { user_id: 1, feature: 'expenses', total: '1', last_at: '2026-10-13T00:00:00Z' },
      { user_id: 3, feature: 'projects', total: '50', last_at: '2026-10-14T00:00:00Z' },
      { user_id: 99, feature: 'projects', total: '50', last_at: '2026-10-14T00:00:00Z' },
    ] });
  const data = await getUsage(db, {});
  assert.deepEqual(data.summary, { total_users: 3, used_users: 2, project_users: 1, document_users: 2, multi_feature_users: 1 });
  assert.equal(data.ranking[0].key, 'documents');
  assert.equal(data.ranking[0].operations, 10);
  assert.equal(data.ranking[0].users, 2);
  assert.equal(data.users[0].last_feature, '装修记账');
  assert.equal(data.users[0].phone, '13800000000');
  assert.equal(data.users.find(u => u.id === 2).counts.projects, undefined);
  assert.equal(data.users.find(u => u.id === 4).total, 0);
});

test('user filters preserve overall summary; pagination is stable and clamps empty pages', async () => {
  const users = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, nickname: `用户${i + 1}` }));
  const events = [{ user_id: 1, feature: 'projects', total: 1, last_at: '2026-10-14' }];
  const db = fixture({ users, events });
  const page = await getUsage(db, { page: '999' });
  assert.equal(page.page, 2);
  assert.equal(page.users.length, 5);
  const filtered = await getUsage(db, { keyword: '1', feature: 'projects' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.summary.total_users, 25);
  assert.equal(filtered.users[0].id, 1);
  const empty = await getUsage(db, { keyword: '<不存在>' });
  assert.equal(empty.total, 0);
  assert.equal(empty.page, 1);
});

test('missing source is unavailable, never silently shown as zero', async () => {
  const db = fixture({ missing: ['documents'] });
  const data = await getUsage(db, { days: 'all' });
  assert.equal(data.features.find(f => f.key === 'documents').available, false);
  assert.ok(!data.ranking.some(f => f.key === 'documents'));
  assert.ok(!db.queries.at(-1).includes('FROM project_design_documents'));
  assert.ok(!db.queries.at(-1).includes('INTERVAL'));
  await assert.rejects(getUsage(fixture({ testFlag: false }), {}), /测试账号标记/);
});

test('validates filters before SQL and supports explicit test inclusion', async () => {
  assert.throws(() => options({ days: '30; DROP TABLE users' }), /时间范围/);
  await assert.rejects(getUsage(fixture(), { feature: 'unknown' }), /功能筛选/);
  const db = fixture({ users: [{ id: 1, is_test_account: 1 }] });
  assert.equal((await getUsage(db, { includeTests: '1' })).summary.total_users, 1);
});

test('business SQL excludes defaults and uses creation timestamps and true creators', () => {
  const sql = eventSql(FEATURES, '7');
  assert.match(sql, /COALESCE\(created_by, user_id\)/);
  assert.match(sql, /joined_at >= NOW\(\) - INTERVAL 7 DAY/);
  assert.match(sql, /source_type IN \('manual_upload', 'designer_upload'\)/);
  assert.match(sql, /deleted_at IS NULL/);
  assert.ok(!sql.includes('updated_at'));
  assert.ok(!sql.includes('renovation_tasks'));
  assert.ok(!sql.includes('JOIN'));
});


test('participating projects include owners and active members, deduplicate roles, and name unnamed projects', async () => {
  const { attachProjects } = require('../services/feature-usage');
  const users = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const db = { async query(sql, params) {
    assert.match(sql, /WHERE status = 1/);
    assert.match(sql, /lifecycle_status, 'active'\) <> 'deleted'/);
    assert.ok(!sql.includes('INTERVAL'));
    assert.deepEqual(params, [1, 2, 3, 1, 2, 3]);
    return [[{ user_id: 1, id: 10, project_name: '一号工地' }, { user_id: 1, id: 10, project_name: '一号工地' },
      { user_id: 2, id: 10, project_name: '一号工地' }, { user_id: 2, id: 11, project_name: ' ', project_code: 'ABC', lifecycle_status: 'archived' }]];
  } };
  await attachProjects(db, users);
  assert.equal(users[0].projects.length, 1);
  assert.deepEqual(users[1].projects, [{ id: 10, name: '一号工地', archived: false }, { id: 11, name: '工地ABC', archived: true }]);
  assert.deepEqual(users[2].projects, []);
});


test('construction progress counts actual step operators and integrates with user filters and ranking', async () => {
  const db = fixture({
    users: [{ id: 1, nickname: '项目业主' }, { id: 2, nickname: '项目经理' }, { id: 3, nickname: '未操作用户' }],
    events: [
      { user_id: 1, feature: 'projects', total: 1, last_at: '2026-11-01' },
      { user_id: 2, feature: 'progress', total: 6, last_at: '2026-11-03' },
    ],
  });
  const data = await getUsage(db, { feature: 'progress', days: '7' });
  assert.equal(data.total, 1);
  assert.equal(data.users[0].id, 2);
  assert.equal(data.users[0].counts.progress, 6);
  assert.equal(data.users[0].last_feature, '施工进度管理');
  assert.equal(data.summary.used_users, 2);
  assert.equal(data.summary.total_users, 3);
  assert.deepEqual(data.ranking.find(f => f.key === 'progress'), {
    key: 'progress', label: '施工进度管理', users: 1, operations: 6,
  });
  const progress = FEATURES.find(f => f.key === 'progress');
  const sql = eventSql([progress], '7');
  assert.match(sql, /SELECT changed_by AS user_id/);
  assert.match(sql, /FROM project_progress_item_adjustments/);
  assert.match(sql, /FROM project_task_adjustments/);
  assert.match(sql, /SUM\(total\)/);
  assert.match(sql, /created_at >= NOW\(\) - INTERVAL 7 DAY/);
  assert.doesNotMatch(sql, /renovation_tasks|created_by|updated_at/);
});

test('missing progress audit schema shows unavailable without claiming zero use', async () => {
  const data = await getUsage(fixture({ missing: ['progress'] }), { days: 'all' });
  assert.deepEqual(data.features.find(f => f.key === 'progress'), {
    key: 'progress', label: '施工进度管理', available: false,
  });
  assert.equal(data.ranking.some(f => f.key === 'progress'), false);
});


test('primary task and child-step operations are combined before ranking users', async () => {
  const db = fixture({ users: [{ id: 1 }, { id: 2 }], events: [
    { user_id: 1, feature: 'progress', total: '5', last_at: '2026-11-03' },
    { user_id: 2, feature: 'progress', total: '2', last_at: '2026-11-02' },
  ] });
  const data = await getUsage(db, { feature: 'progress' });
  assert.deepEqual(data.users.map(u => u.counts.progress), [5, 2]);
  assert.deepEqual(data.ranking.find(f => f.key === 'progress'), {
    key: 'progress', label: '施工进度管理', users: 2, operations: 7,
  });
  const sql = db.queries.find(q => q.includes('feature_sources'));
  assert.match(sql, /project_task_adjustments/);
  assert.match(sql, /project_progress_item_adjustments/);
  assert.match(sql, /SUM\(total\)/);
});

test('joining counts only active non-owner members of projects created by someone else', async () => {
  const joined = FEATURES.find(feature => feature.key === 'joined');
  const sql = eventSql([joined], 'all');
  assert.match(sql, /status = 1 AND role <> 'owner'/);
  assert.match(sql, /p.id = project_members.project_id/);
  assert.match(sql, /COALESCE\(p.created_by, p.user_id\) <> project_members.user_id/);
  assert.equal((await getUsage(fixture(), {})).features.find(f => f.key === 'joined').available, true);
  const missingProjects = await getUsage(fixture({ missing: ['projects'] }), {});
  assert.equal(missingProjects.features.find(f => f.key === 'joined').available, false);
});
