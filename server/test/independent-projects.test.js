const test = require('node:test');
const assert = require('node:assert/strict');
const { isIndependentProjectManager, canManageProjectPreparation } = require('../services/independent-project-policy');

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function load(module, db) {
  const dbPath = require.resolve('../config/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  delete require.cache[require.resolve('../utils/project-context')];
  delete require.cache[require.resolve(module)];
  return require(module);
}

function fixture() {
  const project = { id: 91, user_id: null, created_by: 7, creation_source: 'designer', preparation_stage: 'preparation', lifecycle_status: 'active' };
  let invitation = null;
  let creatorActive = true;
  const members = [{ project_id: 91, user_id: 7, role: 'designer', status: 1 }];
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO renovation_projects')) {
        assert.match(sql, /VALUES \(NULL, \?, 'designer', 'preparation'/);
        assert.match(sql, /0, NULL, 0, 1, 1/);
        assert.equal(params[0], 7);
        return [{ insertId: 91 }];
      }
      if (sql.includes('INSERT INTO project_members')) {
        const role = sql.includes("'owner'") ? 'owner' : 'designer';
        if (!members.some(m => m.user_id === params[1] && m.role === role)) members.push({ project_id: params[0], user_id: params[1], role, status: 1 });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT * FROM renovation_projects')) return [[project]];
      if (sql.includes('SELECT role FROM project_members')) return [members.filter(m => m.project_id === params[0] && m.user_id === params[1] && (m.user_id !== 7 || creatorActive))];
      if (sql.includes('SELECT id FROM users')) return [[{ id: params[0] === '13800000008' ? 8 : 7 }]];
      if (sql.includes('SELECT id FROM project_owner_invitations')) return [invitation && invitation.target_user_id === params[1] && invitation.status === 'pending' && invitation.unexpired ? [{ id: invitation.id }] : []];
      if (sql.includes("SET status = 'cancelled'")) { if (invitation) invitation.status = 'cancelled'; return [{}]; }
      if (sql.includes('INSERT INTO project_owner_invitations')) {
        invitation = { id: 12, project_id: params[0], invited_by: params[1], target_user_id: params[2], status: 'pending', unexpired: 1 };
        return [{ insertId: 12 }];
      }
      if (sql.includes('SELECT project_id FROM project_owner_invitations')) return [invitation && invitation.id === params[0] && invitation.target_user_id === params[1] ? [{ project_id: invitation.project_id }] : []];
      if (sql.includes('SELECT *, expires_at')) return [[invitation]];
      if (sql.includes('UPDATE renovation_projects SET user_id')) { project.user_id = params[0]; return [{}]; }
      if (sql.includes('UPDATE project_owner_invitations SET status = ?')) { invitation.status = params[0]; return [{}]; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const db = { query: connection.query, async getConnection() { return connection; } };
  const controller = load('../controllers/independent-projects.controller', db);
  const req = { user: { id: 7, role: 'designer' }, params: { id: '91' }, body: { project_name: '王女士住宅' } };
  return { controller, req, project, calls, members, db, connection,
    invitation: () => invitation, deactivateCreator() { creatorActive = false; } };
}

test('name-only creation creates a designer member without owner or construction tasks', async () => {
  const f = fixture(); const res = response();
  await f.controller.create(f.req, res);
  assert.equal(res.body.data.id, 91);
  assert.equal(f.project.user_id, null);
  assert.deepEqual(f.members.map(m => m.role), ['designer']);
  assert.ok(!f.calls.some(c => c.sql?.includes('renovation_tasks') || c.sql?.includes('change_requests')));
  assert.ok(f.calls.includes('commit'));
});

test('creation rejects non-designers and empty names before writing', async () => {
  const f = fixture(); const denied = response();
  await f.controller.create({ ...f.req, user: { id: 8, role: 'owner' } }, denied);
  assert.equal(denied.statusCode, 403);
  const empty = response();
  await f.controller.create({ ...f.req, body: { project_name: ' ' } }, empty);
  assert.notEqual(empty.body.code, 0);
  assert.deepEqual(f.calls, []);
});

test('failed member creation rolls back the project transaction', async () => {
  const f = fixture(); const original = f.connection.query;
  f.connection.query = async (sql, params) => {
    if (sql.includes('INSERT INTO project_members')) throw new Error('member write failed');
    return original(sql, params);
  };
  await assert.rejects(f.controller.create(f.req, response()), /member write failed/);
  assert.ok(f.calls.includes('rollback'));
  assert.ok(!f.calls.includes('commit'));
});

test('invitation grants no access until acceptance; acceptance preserves project and designer', async () => {
  const f = fixture();
  await f.controller.inviteOwner({ ...f.req, body: { phone: '13800000008' } }, response());
  assert.equal(f.project.user_id, null);
  assert.equal(f.members.length, 1);
  const res = response();
  await f.controller.respondInvitation({ user: { id: 8 }, params: { invitationId: '12' }, body: { action: 'accept' } }, res);
  assert.equal(res.body.data.project_id, 91);
  assert.equal(f.project.user_id, 8);
  assert.equal(f.project.created_by, 7);
  assert.deepEqual(f.members.map(m => m.role), ['designer', 'owner']);
  assert.equal(f.invitation().status, 'accepted');
  assert.ok(!f.calls.some(c => /DELETE FROM|UPDATE project_design_documents/.test(c.sql || '')));
});

test('duplicate invite reuses the current invitation', async () => {
  const f = fixture(); const req = { ...f.req, body: { phone: '13800000008' } };
  await f.controller.inviteOwner(req, response());
  await f.controller.inviteOwner(req, response());
  assert.equal(f.calls.filter(c => c.sql?.includes('INSERT INTO project_owner_invitations')).length, 1);
});

for (const scenario of ['wrong-user', 'expired', 'rejected', 'creator-removed', 'owner-exists', 'archived']) {
  test(`invitation acceptance is blocked when ${scenario}`, async () => {
    const f = fixture();
    await f.controller.inviteOwner({ ...f.req, body: { phone: '13800000008' } }, response());
    if (scenario === 'expired') f.invitation().unexpired = 0;
    if (scenario === 'rejected') f.invitation().status = 'rejected';
    if (scenario === 'creator-removed') f.deactivateCreator();
    if (scenario === 'owner-exists') f.project.user_id = 10;
    if (scenario === 'archived') f.project.lifecycle_status = 'archived';
    const res = response();
    await f.controller.respondInvitation({ user: { id: scenario === 'wrong-user' ? 9 : 8 }, params: { invitationId: '12' }, body: { action: 'accept' } }, res);
    assert.ok(res.statusCode >= 400);
    assert.equal(f.members.length, 1);
  });
}

test('rejecting invitation preserves independent preparation', async () => {
  const f = fixture();
  await f.controller.inviteOwner({ ...f.req, body: { phone: '13800000008' } }, response());
  await f.controller.respondInvitation({ user: { id: 8 }, params: { invitationId: '12' }, body: { action: 'reject' } }, response());
  assert.equal(f.project.user_id, null);
  assert.equal(f.invitation().status, 'rejected');
  assert.ok(isIndependentProjectManager(f.project, 7, 'designer'));
});

test('creator rights require matching source, account, and active designer membership', async () => {
  const project = { creation_source: 'designer', created_by: 7 };
  assert.ok(isIndependentProjectManager(project, 7, 'designer'));
  assert.ok(!isIndependentProjectManager(project, 8, 'designer'));
  assert.ok(!isIndependentProjectManager(project, 7, 'merchant'));
  assert.ok(!isIndependentProjectManager({ ...project, creation_source: 'owner' }, 7, 'designer'));
  const db = { async query(sql) {
    assert.match(sql, /pm.status = 1/);
    assert.match(sql, /lifecycle_status, 'active'\) = 'active'/);
    return [[]];
  } };
  assert.equal(await canManageProjectPreparation(db, 91, 7), false);
});

test('ownerless project context uses designer role and rejects non-members', async () => {
  let authorized = true;
  const db = { async query(sql, params) {
    assert.match(sql, /p.user_id = \? OR pm.id IS NOT NULL/);
    assert.deepEqual(params, [7, 91, 7]);
    return [authorized ? [{ id: 91, user_id: null, role: 'designer', lifecycle_status: 'active' }] : []];
  } };
  const context = load('../utils/project-context', db);
  const req = { user: { id: 7 }, params: { id: '91' }, originalUrl: '/api/renovation/projects/91/info' };
  assert.equal((await context.requireProjectContext(req, response())).role, 'designer');
  authorized = false;
  assert.equal((await context.requireProjectContext(req, response())).ok, false);
});

for (const independent of [true, false]) {
  test(`${independent ? 'independent creator creates space directly' : 'legacy designer still waits for owner approval'}`, async () => {
    const writes = [];
    const db = { async query(sql, params) {
      if (sql.includes('SELECT p.id, p.user_id, p.lifecycle_status')) return [[{ id: 91, user_id: independent ? null : 8, role: 'designer', lifecycle_status: 'active' }]];
      if (sql.includes('SELECT id FROM project_members')) return [sql.includes("role = 'owner'") ? [] : [{ id: 1 }]];
      if (sql.includes('SELECT p.created_by')) return [[{ created_by: independent ? 7 : null, creation_source: independent ? 'designer' : 'owner', role: 'designer' }]];
      if (sql.includes('COUNT(*) AS total FROM project_spaces')) return [[{ total: 0 }]];
      if (sql.includes('INSERT INTO project_spaces') || sql.includes('INSERT INTO project_space_change_requests')) { writes.push(sql); return [{ insertId: 32 }]; }
      if (sql.includes('FROM project_spaces WHERE id')) return [[{ id: 32, project_id: 91, name: '书房', is_default: 0 }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const controller = load('../controllers/renovation.controller', db);
    const res = response();
    await controller.createProjectSpace({ user: { id: 7 }, params: { id: '91' }, body: { name: '书房', project_id: 91 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(writes.length, 1);
    assert.match(writes[0], independent ? /INSERT INTO project_spaces/ : /INSERT INTO project_space_change_requests/);
    if (independent) assert.equal(res.body.data.id, 32);
    else assert.match(res.body.message, /等待业主确认/);
  });
}

test('creator can save partial needs without an area or owner and cannot alter identity', async () => {
  let saved;
  const project = { id: 91, user_id: null, created_by: 7, creation_source: 'designer', preparation_stage: 'preparation', project_name: '准备项目', house_area: 0, current_stage: 1, status: 1 };
  const db = { async query(sql, params) {
    if (sql.includes('SELECT p.id, p.user_id, p.lifecycle_status')) return [[{ ...project, role: 'designer' }]];
    if (sql.includes('SELECT id FROM project_members')) return [[]];
    if (sql.includes('SELECT p.created_by')) return [[{ ...project, role: 'designer' }]];
    if (sql.includes('SELECT * FROM renovation_projects') || sql.includes('SELECT p.*, u.nickname AS designer_name')) return [[project]];
    if (sql.includes('UPDATE renovation_projects')) {
      assert.ok(!/created_by =|user_id =|creation_source =/.test(sql));
      saved = params;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM renovation_tasks')) return [[]];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const controller = load('../controllers/renovation.controller', db);
  const res = response();
  await controller.updateProjectInfo({ headers: { 'x-zxw-projects': 'independent-desktop-v1' }, user: { id: 7 }, params: { id: '91' }, body: { project_id: 91, style_preference: '原木风', created_by: 99, user_id: 99 } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(saved.includes('原木风'));
  assert.equal(res.body.data.project.owner_joined, false);
  assert.equal(res.body.data.project.created_by, 7);
});

test('independent creator cannot confirm documents as the client', async () => {
  const db = { async query(sql) {
    if (sql.includes('SELECT p.id, p.user_id, p.lifecycle_status')) return [[{ id: 91, user_id: null, role: 'designer' }]];
    if (sql.includes('SELECT role FROM project_members')) return [[{ role: 'designer' }]];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const controller = load('../controllers/renovation.controller', db);
  const res = response();
  await controller.updateProjectDesignDocumentStatus({ user: { id: 7 }, params: { id: '91', documentId: '3' }, body: { project_id: 91, status: 'confirmed' } }, res);
  assert.equal(res.statusCode, 403);
});
