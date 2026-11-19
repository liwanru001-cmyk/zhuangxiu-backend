const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeMembers, eventQuery, projectId, list, detail } = require('../services/admin-project-directory');

test('member roles merge without counting a person twice, retaining former and pending members and operators', () => {
  const rows = [{ user_id: 1, nickname: '业主', role: 'owner', status: 1 },
    { user_id: 2, nickname: '设计师', phone: '13800000000', role: 'designer', status: 1 },
    { user_id: 2, role: 'project_manager', status: 1 }, { user_id: 3, role: 'merchant', status: 0 },
    { user_id: 4, role: 'designer', status: 2 }];
  const members = mergeMembers(rows, { user_id: 1, creator_id: 2 }, [
    { actor_id: 2, feature: 'documents', total: '3', last_at: '2026-10-14' },
    { actor_id: 5, nickname: '历史参与者', feature: 'expenses', total: '2', last_at: '2026-10-13' },
  ]);
  assert.equal(members.length, 5);
  assert.equal(members[0].user_id, 1);
  const designer = members.find(m => m.user_id === 2);
  assert.equal(designer.roles.length, 2);
  assert.equal(designer.is_creator, true);
  assert.equal(designer.counts.documents, 3);
  assert.equal(designer.phone, '13800000000');
  assert.equal(members.find(m => m.user_id === 4).roles[0].status, 2);
  assert.deepEqual(members.find(m => m.user_id === 5).roles, []);
});

test('events are project scoped, parameterized, exclude generated images and deleted materials', () => {
  const q = eventQuery([10, 11]);
  assert.equal(q.params.length, 14);
  assert.match(q.sql, /s.project_id IN \(\?,\?\)/);
  assert.match(q.sql, /JOIN project_spaces/);
  assert.match(q.sql, /b.deleted_at IS NULL/);
  assert.match(q.sql, /source_type IN \('manual_upload', 'designer_upload'\)/);
  assert.ok(!q.sql.includes('renovation_tasks'));
});

test('filters bind user input, exclude deleted and test-owned projects, clamp pagination', async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return sql.startsWith('SELECT COUNT') ? [[{ total: 0 }]] : [[]]; } };
  const value = "' OR 1=1 --";
  const d = await list(db, { keyword: value, lifecycle: 'archived', page: '999' });
  assert.equal(d.page, 1); assert.equal(d.total, 0);
  assert.match(calls[0].sql, /owner.is_test_account/);
  assert.match(calls[0].sql, /creator.is_test_account/);
  assert.match(calls[0].sql, /<> 'deleted'/);
  assert.ok(!calls[0].sql.includes(value));
  assert.ok(calls[0].params.includes(`%${value}%`));
  assert.ok(calls[0].params.includes('archived'));
  assert.deepEqual(calls[1].params.slice(-2), [20, 0]);
  await assert.rejects(list(db, { lifecycle: 'deleted' }), /工地状态/);
});

test('list aggregates counts without row multiplication and includes legacy owner once', async () => {
  const db = { async query(sql) {
    if (sql.startsWith('SELECT COUNT')) return [[{ total: 1 }]];
    if (sql.startsWith('SELECT p.id')) return [[{ id: 10, user_id: 1, owner_nickname: '业主', created_at: '2026-10-01' }]];
    if (sql.startsWith('SELECT project_id, feature')) return [[{ project_id: 10, feature: 'documents', total: '8' }]];
    if (sql.includes('FROM project_members pm')) return [[{ project_id: 10, user_id: 2, role: 'designer' }, { project_id: 10, user_id: 2, role: 'project_manager' }]];
    if (sql.startsWith('SELECT * FROM')) return [[{ project_id: 10, feature: 'documents', happened_at: '2026-10-13', nickname: '设计师', rn: 1 }]];
    throw new Error(sql);
  } };
  const d = await list(db);
  const p = d.projects[0];
  assert.equal(p.counts.documents, 8); assert.equal(p.member_count, 2);
  assert.equal(p.role_counts.owner, 1); assert.equal(p.role_counts.designer, 1);
  assert.equal(p.last_feature, '上传设计资料');
});

test('invalid and absent project IDs fail clearly', async () => {
  for (const id of ['-1', '0', 'abc', '1 OR 1=1', '9007199254740993']) assert.throws(() => projectId(id));
  assert.equal(projectId('123'), 123);
  await assert.rejects(detail({ query: async () => [[]] }, '123'), e => e.status === 404);
});
