const assert = require('node:assert/strict');
const test = require('node:test');

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

function loadController(dbMock) {
  const dbPath = require.resolve('../config/db');
  const storagePath = require.resolve('../services/storage.service');
  const projectContextPath = require.resolve('../utils/project-context');
  const projectEventPath = require.resolve('../services/project-event.service');
  const controllerPath = require.resolve('../controllers/renovation.controller');
  for (const path of [
    dbPath,
    storagePath,
    projectContextPath,
    projectEventPath,
    controllerPath,
  ]) {
    delete require.cache[path];
  }
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  require.cache[storagePath] = {
    id: storagePath,
    filename: storagePath,
    loaded: true,
    exports: {},
  };
  return require('../controllers/renovation.controller');
}

test('non-owner project task creation becomes a pending owner confirmation', async () => {
  let directInsertCalled = false;
  let queuedPayload = null;
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [12, 9, 12]);
        return [[{
          id: 9,
          user_id: 7,
          lifecycle_status: 'active',
          role: 'project_manager',
        }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 12]);
        return [[{ role: 'project_manager' }]];
      }
      if (/INSERT INTO project_progress_change_requests/.test(sql)) {
        queuedPayload = JSON.parse(params[5]);
        return [{ insertId: 81 }];
      }
      if (/SELECT DISTINCT user_id/.test(sql)) {
        assert.deepEqual(params, [9, 'owner']);
        return [[{ user_id: 7 }]];
      }
      if (/INSERT INTO project_action_notifications/.test(sql)) {
        assert.equal(params[0], 7);
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO renovation_tasks/.test(sql)) {
        directInsertCalled = true;
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProjectTask({
    user: { id: 12 },
    params: { id: '9' },
    originalUrl: '/renovation/projects/9/tasks',
    body: {
      stage_id: 4,
      task_name: '墙面找平',
      planned_start: '2026-08-02',
      planned_end: '2026-08-04',
      is_key: true,
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.pending_confirmation, true);
  assert.equal(res.payload.data.request_id, 81);
  assert.equal(directInsertCalled, false);
  assert.deepEqual(queuedPayload, {
    stage_id: 4,
    task_name: '墙面找平',
    planned_start: '2026-08-02',
    planned_end: '2026-08-04',
    is_key: true,
  });
});

test('non-owner task planning supports legacy task tables without updated_at', async () => {
  let taskSnapshotQueryChecked = false;
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        return [[{
          id: 9,
          user_id: 7,
          lifecycle_status: 'active',
          role: 'designer',
        }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        return [[{ role: 'designer' }]];
      }
      if (/FROM renovation_tasks WHERE id = \? AND project_id = \?/.test(sql)) {
        assert.doesNotMatch(sql, /updated_at/);
        assert.deepEqual(params, [242, 9]);
        taskSnapshotQueryChecked = true;
        return [[{
          id: 242,
          project_id: 9,
          stage_id: 4,
          task_name: '木工',
          is_key: 0,
          planned_start: new Date('2026-08-01'),
          planned_end: new Date('2026-08-03'),
          actual_start: null,
          actual_end: null,
          status: 0,
          remark: null,
        }]];
      }
      if (/INSERT INTO project_progress_change_requests/.test(sql)) {
        return [{ insertId: 82 }];
      }
      if (/SELECT DISTINCT user_id/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.planProjectTask({
    user: { id: 12 },
    params: { id: '9', taskId: '242' },
    originalUrl: '/renovation/projects/9/tasks/242/plan',
    body: { planned_end: '2026-08-10' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.pending_confirmation, true);
  assert.equal(taskSnapshotQueryChecked, true);
});

test('owner pending list includes project members submissions and review permission', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT id FROM project_members/.test(sql) && /LIMIT 1/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ id: 1 }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/FROM project_progress_change_requests request/.test(sql)) {
        assert.doesNotMatch(sql, /request\.submitted_by = \?/);
        assert.deepEqual(params, [9, 'pending']);
        return [[{
          id: 81,
          project_id: 9,
          entity_type: 'task',
          target_id: null,
          action: 'create',
          before_snapshot: null,
          proposed_payload: JSON.stringify({ task_name: '墙面找平' }),
          submitted_by: 12,
          submitted_role: 'project_manager',
          submitter_name: '项目经理',
          status: 'pending',
          reviewed_by: null,
          review_note: null,
          reviewed_at: null,
          created_at: '2026-08-02 10:00:00',
          updated_at: '2026-08-02 10:00:00',
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getProjectProgressChangeRequests({
    user: { id: 7 },
    params: { id: '9' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].can_review, true);
  assert.equal(res.payload.data[0].can_cancel, false);
  assert.equal(res.payload.data[0].proposed_payload.task_name, '墙面找平');
});

test('owner approval applies the proposed task changes before closing the request', async () => {
  const statements = [];
  const connection = {
    async beginTransaction() {
      statements.push('begin');
    },
    async commit() {
      statements.push('commit');
    },
    async rollback() {
      statements.push('rollback');
    },
    release() {
      statements.push('release');
    },
    async query(sql, params) {
      if (/FROM project_progress_change_requests/.test(sql) && /FOR UPDATE/.test(sql)) {
        assert.deepEqual(params, [81, 9]);
        return [[{
          id: 81,
          project_id: 9,
          entity_type: 'task',
          target_id: 3,
          action: 'update',
          before_snapshot: JSON.stringify({ task_name: '墙面' }),
          proposed_payload: JSON.stringify({
            task_name: '墙面找平',
            planned_start: '2026-08-02',
            planned_end: '2026-08-05',
            remark: '先挂网再找平',
            is_key: true,
            status: 1,
          }),
          target_updated_at: '2026-08-02 09:00:00',
          submitted_by: 12,
          submitted_role: 'project_manager',
        }]];
      }
      if (/FROM renovation_tasks/.test(sql) && /FOR UPDATE/.test(sql)) {
        assert.deepEqual(params, [3, 9]);
        return [[{
          id: 3,
          project_id: 9,
          stage_id: 6,
          task_name: '墙面',
          planned_start: '2026-08-01',
          planned_end: '2026-08-03',
          remark: null,
          is_key: 0,
          status: 0,
          updated_at: '2026-08-02 09:00:00',
        }]];
      }
      if (/UPDATE renovation_tasks/.test(sql)) {
        assert.equal(params[0], '墙面找平');
        assert.equal(params[1], '2026-08-02');
        assert.equal(params[2], '2026-08-05');
        assert.equal(params[3], '先挂网再找平');
        assert.equal(params[4], 1);
        assert.equal(params[5], 1);
        statements.push('apply-task');
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE project_progress_change_requests/.test(sql)) {
        assert.equal(params[1], 7);
        assert.equal(params[3], 81);
        statements.push('close-request');
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected transaction query: ${sql}`);
    },
  };
  const dbMock = {
    async getConnection() {
      return connection;
    },
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT id FROM project_members/.test(sql) && /role = 'owner'/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ id: 1 }]];
      }
      if (/FROM project_progress_items/.test(sql) && /ORDER BY id DESC/.test(sql)) {
        return [[]];
      }
      if (/FROM renovation_tasks/.test(sql) && /GROUP BY stage_id/.test(sql)) {
        return [[]];
      }
      if (/FROM project_progress_items/.test(sql) && /COUNT\(\*\) AS incomplete/.test(sql)) {
        return [[]];
      }
      if (/INSERT INTO project_action_notifications/.test(sql)) {
        assert.equal(params[0], 12);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.reviewProjectProgressChangeRequest({
    user: { id: 7 },
    params: { id: '9', requestId: '81' },
    originalUrl: '/renovation/projects/9/progress-change-requests/81/review',
    body: { action: 'approve' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.status, 'approved');
  assert.ok(statements.indexOf('apply-task') < statements.indexOf('close-request'));
  assert.deepEqual(statements.slice(-2), ['commit', 'release']);
});
