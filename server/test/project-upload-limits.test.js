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

function loadController(dbMock, storageMock = {}) {
  const dbPath = require.resolve('../config/db');
  const storagePath = require.resolve('../services/storage.service');
  const projectContextPath = require.resolve('../utils/project-context');
  const controllerPath = require.resolve('../controllers/renovation.controller');
  delete require.cache[dbPath];
  delete require.cache[storagePath];
  delete require.cache[projectContextPath];
  delete require.cache[controllerPath];
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
    exports: storageMock,
  };
  return require('../controllers/renovation.controller');
}

test('project check-in enforces daily quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/COUNT\(\*\) AS total FROM project_checkins/.test(sql) && /created_at >= CURDATE/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ total: 3 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProjectCheckIn({
    user: { id: 7 },
    params: { id: '9' },
    body: { project_id: 9, description: '今天水电验收', checkin_date: '2026-07-03' },
    files: [],
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /每天最多发布 3 条工地打卡/);
});

test('owner family member sees only own and explicitly shared check-ins', async () => {
  let visibilityChecked = false;
  const dbMock = {
    async query(sql, params) {
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 8]);
        return [[{ role: 'owner_member' }]];
      }
      if (/CREATE TABLE IF NOT EXISTS project_checkin_circle_shares/.test(sql)) {
        return [{ affectedRows: 0 }];
      }
      if (/FROM project_checkins checkin/.test(sql)) {
        assert.match(sql, /checkin\.user_id = \?/);
        assert.match(sql, /visible_share\.shared_with_user_id = \?/);
        assert.deepEqual(params, [9, 8, 8]);
        visibilityChecked = true;
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getProjectCheckIns({
    user: { id: 8 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(visibilityChecked, true);
  assert.deepEqual(res.payload.data, []);
});

test('company admin read-only viewer sees all project inspection step records', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT id FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 42]);
        return [[]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 42]);
        return [[]];
      }
      if (/SELECT c\.id[\s\S]*FROM companies c/.test(sql)) {
        assert.deepEqual(params, [42, 42, 9, 9]);
        return [[{ id: 3 }]];
      }
      if (/FROM project_inspection_step_records record/.test(sql)) {
        assert.deepEqual(params, [9]);
        assert.doesNotMatch(sql, /record\.created_by = \?/);
        return [[{
          id: 501,
          project_id: 9,
          stage_id: 3,
          progress_item_id: null,
          step_key: 'water-pressure',
          step_title: '水压测试',
          step_action: null,
          record_type: 'member_checked',
          status: 'rework',
          description: '压力不足',
          review_remark: '重新加压',
          response_description: null,
          response_by: null,
          response_at: null,
          created_by: 7,
          member_role: 'project_manager',
          target_user_id: 8,
          reviewed_by: 6,
          reviewed_at: null,
          created_at: null,
          updated_at: null,
          creator_name: '项目经理',
          target_name: '水电工',
          target_role: 'merchant',
          reviewer_name: '业主',
          responder_name: null,
        }]];
      }
      if (/FROM project_inspection_step_record_images/.test(sql)) {
        assert.deepEqual(params, [501]);
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getProjectInspectionStepRecords({
    user: { id: 42 },
    params: { id: '9' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].step_title, '水压测试');
});

test('inspection step record keeps a formal task link without child items', async () => {
  let insertStatement = null;
  let insertParams = null;
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      if (/INSERT INTO project_inspection_step_records/.test(sql)) {
        insertStatement = sql;
        insertParams = params;
        return [{ insertId: 601 }];
      }
      throw new Error(`unexpected connection query: ${sql}`);
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        return [[{
          id: 9,
          user_id: 7,
          lifecycle_status: 'active',
          role: 'owner',
        }]];
      }
      if (/SELECT id FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ id: 1 }]];
      }
      if (/SELECT id, stage_id FROM renovation_tasks/.test(sql)) {
        assert.deepEqual(params, [12, 9]);
        return [[{ id: 12, stage_id: 6 }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/SELECT id FROM project_inspection_step_records/.test(sql)) {
        assert.deepEqual(params.slice(0, 6), [9, 6, 12, 12, null, null]);
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProjectInspectionStepRecord({
    user: { id: 7, role: 'owner' },
    params: { id: '9' },
    body: {
      project_id: 9,
      stage_id: 6,
      task_id: 12,
      step_key: '墙面',
      step_title: '墙面',
      description: '现场已记录',
    },
    files: [],
  }, res);

  assert.equal(res.statusCode, 200);
  assert.match(insertStatement, /task_id, progress_item_id/);
  assert.deepEqual(insertParams.slice(0, 6), [9, 6, 12, null, '墙面', '墙面']);
  assert.equal(res.payload.data.id, 601);
});

test('inspection workspace returns one main inspection with nested check items', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT id FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ id: 1 }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/SELECT id, project_name, current_stage/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{
          id: 9,
          project_name: '测试项目',
          current_stage: 3,
          renovation_type: 'rough',
          updated_at: '2026-07-30 08:00:00',
        }]];
      }
      if (/FROM project_progress_items/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{
          id: 21,
          task_id: null,
          parent_id: null,
          stage_id: 3,
          title: '水电阶段验收',
          status: 'in_progress',
          requires_inspection: 1,
          inspection_template_key: 'hidden_water_electric',
          sort_order: 10,
        }]];
      }
      if (/FROM inspection_templates template/.test(sql)) {
        assert.equal(params, undefined);
        return [[{
          id: 2,
          code: 'hidden_water_electric',
          title: '水电隐蔽验收',
          stage_id: 3,
          node_type: 'stage',
          description: '水电检查',
          standard_basis: 'standard',
          recommended_tools: '[]',
          sort_order: 10,
          item_id: 11,
          item_code: 'hwe_pressure',
          item_title: '水压测试',
          standard_text: '稳压检查',
          check_method: '试压',
          required_tools: '[]',
          risk_level: 'must',
          failure_action: '整改',
          require_photo: 1,
          item_sort_order: 10,
        }]];
      }
      if (/FROM project_inspections/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{
          id: 31,
          project_id: 9,
          task_id: null,
          progress_item_id: 21,
          stage_id: 3,
          title: '水电阶段验收',
          template_id: 2,
          template_code: 'hidden_water_electric',
          status: 'draft',
          calculation_summary: '{"passed":1}',
          row_version: 2,
        }]];
      }
      if (/FROM project_inspection_items/.test(sql)) {
        assert.deepEqual(params, [[31]]);
        return [[
          {
            id: 41,
            inspection_id: 31,
            item_key: 'hwe_pressure',
            title: '水压测试',
            result: 'passed',
            require_photo: 1,
            sort_order: 10,
          },
          {
            id: 42,
            inspection_id: 31,
            item_key: 'hwe_socket',
            title: '电路测试',
            result: 'pending',
            require_photo: 0,
            sort_order: 20,
          },
        ]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getProjectInspectionWorkspace({
    user: { id: 7 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.inspections.length, 1);
  assert.equal(res.payload.data.inspections[0].items.length, 2);
  assert.equal(res.payload.data.inspections[0].items[0].require_photo, true);
  assert.equal(res.payload.data.progress_items[0].requires_inspection, true);
});

test('confirming a unified record completes its progress item without a second approval', async () => {
  const executed = [];
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      executed.push({ sql, params });
      if (/SELECT id, task_id, progress_item_id, submitted_by/.test(sql)) {
        return [[{
          id: 31,
          task_id: 12,
          progress_item_id: 21,
          submitted_by: 7,
          responsible_user_id: null,
          status: 'in_progress',
          row_version: 2,
        }]];
      }
      if (/COUNT\(\*\) AS total/.test(sql) && /project_inspection_items/.test(sql)) {
        return [[{ total: 2, pending_total: 0, failed_total: 1 }]];
      }
      if (/UPDATE project_inspections/.test(sql)) {
        assert.match(sql, /SET status = \?/);
        assert.deepEqual(params, ['passed', 7, 'passed', 31]);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE project_progress_items/.test(sql)) {
        assert.match(sql, /status = 'completed'/);
        assert.deepEqual(params, [21, 9]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected connection query: ${sql}`);
    },
    async commit() {},
    async rollback() {},
    release() {},
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{
          id: 9,
          user_id: 7,
          lifecycle_status: 'active',
          role: 'owner',
        }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      // Stage refresh happens after the completion transaction. Returning no
      // stages is sufficient for this focused controller test.
      if (/FROM renovation_stages/.test(sql)) return [[]];
      if (/FROM renovation_tasks/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.confirmProjectInspection({
    user: { id: 7 },
    params: { id: '9', inspectionId: '31' },
    body: { project_id: 9, base_version: 2 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.status, 'passed');
  assert.equal(res.payload.data.issue_item_count, 1);
  assert.match(res.payload.message, /确认完成/);
  assert.equal(
    executed.some(({ sql }) => /UPDATE project_progress_items/.test(sql)),
    true
  );
});

test('main owner sees all project check-ins without member visibility filter', async () => {
  let visibilityChecked = false;
  const dbMock = {
    async query(sql, params) {
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/CREATE TABLE IF NOT EXISTS project_checkin_circle_shares/.test(sql)) {
        return [{ affectedRows: 0 }];
      }
      if (/FROM project_checkins checkin/.test(sql)) {
        assert.doesNotMatch(sql, /visible_share/);
        assert.deepEqual(params, [9]);
        visibilityChecked = true;
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getProjectCheckIns({
    user: { id: 7 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(visibilityChecked, true);
  assert.deepEqual(res.payload.data, []);
});

test('project inspection rejects more than three images', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT id FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ id: 1 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.createProjectInspection({
    user: { id: 7 },
    params: { id: '9' },
    body: { project_id: 9, task_id: '3', description: '现场验收' },
    files: [
      { path: '/tmp/no-a.jpg' },
      { path: '/tmp/no-b.jpg' },
      { path: '/tmp/no-c.jpg' },
      { path: '/tmp/no-d.jpg' },
    ],
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /验收图片最多上传 3 张/);
});

test('assigned manager can resubmit a legacy pending owner inspection', async () => {
  let committed = false;
  const connection = {
    async beginTransaction() {},
    async query(sql, params) {
      if (/SELECT id, submission_round FROM project_inspections/.test(sql)) {
        assert.match(sql, /status = 'pending'/);
        assert.match(sql, /submission_round = 1/);
        assert.deepEqual(params, [17, 9, 7]);
        return [[{ id: 17, submission_round: 1 }]];
      }
      if (/UPDATE project_inspections/.test(sql)) {
        assert.deepEqual(params, ['整改完成', 2, 17]);
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO project_inspection_images/.test(sql)) {
        assert.deepEqual(params, [
          17,
          'https://example.test/uploads/inspections/fixed.jpg',
          2,
          7,
        ]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected connection query: ${sql}`);
    },
    async commit() {
      committed = true;
    },
    async rollback() {},
    release() {},
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{
          id: 9,
          user_id: 3,
          lifecycle_status: 'active',
          role: 'project_manager',
        }]];
      }
      if (/SELECT id FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ id: 2 }]];
      }
      if (/information_schema\.COLUMNS/.test(sql)) {
        return [[{ COLUMN_NAME: 'member_role' }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.resubmitProjectInspection({
    user: { id: 7, role: 'project_manager' },
    params: { id: '9', inspectionId: '17' },
    originalUrl: '/api/renovation/projects/9/inspections/17/resubmit',
    protocol: 'https',
    get: () => 'example.test',
    body: { description: '整改完成' },
    files: [{ path: '/tmp/fixed.jpg', filename: 'fixed.jpg' }],
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.submission_round, 2);
  assert.equal(committed, true);
});

test('design document upload enforces project total quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'designer' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'designer' }]];
      }
      if (/COUNT\(\*\) AS total FROM project_design_documents/.test(sql) && !/uploaded_by/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{ total: 30 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock, {
    async storeDesignDocument() {
      throw new Error('storage should not be called when quota is exceeded');
    },
  });
  const res = mockResponse();

  await controller.uploadProjectDesignDocument({
    user: { id: 7 },
    params: { id: '9' },
    body: { project_id: 9 },
    file: {
      path: '/tmp/no-design.jpg',
      originalname: 'design.jpg',
      mimetype: 'image/jpeg',
      size: 100,
    },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多保存 30 份设计文档/);
});

test('project task delete rejects when inspection records exist', async () => {
  let deleteCalled = false;
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/FROM renovation_tasks WHERE id = \? AND project_id = \?/.test(sql)) {
        assert.deepEqual(params, [3, 9]);
        return [[{
          id: 3,
          project_id: 9,
          stage_id: 3,
          task_name: '水电施工',
          is_key: 1,
          planned_start: '2026-08-01',
          planned_end: '2026-08-03',
          status: 1,
          remark: null,
          updated_at: '2026-08-02 10:00:00',
        }]];
      }
      if (/COUNT\(\*\) AS total FROM project_progress_items/.test(sql)) {
        assert.deepEqual(params, [9, 3]);
        return [[{ total: 0 }]];
      }
      if (/FROM project_inspections/.test(sql) && /task_id = \?/.test(sql)) {
        assert.deepEqual(params, [9, 3]);
        return [[{ id: 77 }]];
      }
      if (/DELETE FROM renovation_tasks/.test(sql)) {
        deleteCalled = true;
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.deleteProjectTask({
    user: { id: 7 },
    params: { id: '9', taskId: '3' },
    body: { project_id: 9 },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.message, /已有验收记录/);
  assert.equal(deleteCalled, false);
});

test('progress item delete rejects when inspection step records exist', async () => {
  let deleteCalled = false;
  let rollbackCalled = false;
  const connection = {
    async beginTransaction() {},
    async commit() {
      throw new Error('should not commit when delete is blocked');
    },
    async rollback() {
      rollbackCalled = true;
    },
    release() {},
    async query(sql, params) {
      if (/SELECT id FROM project_progress_items WHERE id = \? AND project_id = \?/.test(sql)) {
        assert.deepEqual(params, [11, 9]);
        return [[{ id: 11 }]];
      }
      if (/SELECT id FROM project_progress_items WHERE project_id = \? AND parent_id = \?/.test(sql)) {
        assert.deepEqual(params, [9, 11]);
        return [[]];
      }
      if (/FROM project_inspections/.test(sql) && /progress_item_id IN/.test(sql)) {
        assert.deepEqual(params, [9, [11]]);
        return [[]];
      }
      if (/FROM project_inspection_step_records/.test(sql)) {
        assert.deepEqual(params, [9, [11]]);
        return [[{ id: 88 }]];
      }
      if (/DELETE FROM project_progress_items|UPDATE project_inspections SET progress_item_id = NULL/.test(sql)) {
        deleteCalled = true;
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.deleteProjectProgressItem({
    user: { id: 7 },
    params: { id: '9', itemId: '11' },
    body: { project_id: 9 },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.message, /已有验收记录/);
  assert.equal(deleteCalled, false);
  assert.equal(rollbackCalled, true);
});

test('progress item update ignores client supplied status', async () => {
  let updateChecked = false;
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/FROM project_progress_items\s+WHERE id = \? AND project_id = \?/.test(sql)) {
        assert.deepEqual(params, [11, 9]);
        return [[{
          id: 11,
          stage_id: 1,
          task_id: 3,
          parent_id: null,
          template_key: null,
          title: '原子事项',
          planned_start: null,
          planned_end: null,
          actual_finish: null,
          status: 'pending',
          remark: null,
          is_key_node: 0,
          requires_inspection: 0,
          inspection_template_key: null,
          sort_order: 0,
        }]];
      }
      if (/FROM renovation_tasks WHERE id = \? AND project_id = \?/.test(sql)) {
        assert.deepEqual(params, [3, 9]);
        return [[{ id: 3, stage_id: 1 }]];
      }
      if (/UPDATE project_progress_items\s+SET status = \?/.test(sql)) {
        assert.deepEqual(params, ['pending', 0, 0, 11, 9]);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE project_progress_items\s+SET stage_id = \?/.test(sql) && /WHERE id = \? AND project_id = \?/.test(sql)) {
        assert.doesNotMatch(sql, /status = \?/);
        assert.deepEqual(params, [
          1,
          3,
          null,
          '新子事项',
          null,
          null,
          null,
          null,
          0,
          null,
          0,
          null,
          0,
          11,
          9,
        ]);
        updateChecked = true;
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO project_progress_item_adjustments/.test(sql)) {
        return [{ insertId: 1 }];
      }
      if (/FROM project_progress_items\s+WHERE project_id = \?/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{
          id: 11,
          project_id: 9,
          stage_id: 1,
          task_id: 3,
          parent_id: null,
          planned_start: null,
          planned_end: null,
          status: 'pending',
        }]];
      }
      if (/FROM project_inspections/.test(sql) && /GROUP BY progress_item_id/.test(sql)) {
        assert.deepEqual(params, [9, 9]);
        return [[]];
      }
      if (/UPDATE renovation_tasks\s+SET status = \?/.test(sql)) {
        assert.deepEqual(params, [0, 0, 0, 3, 9]);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.updateProjectProgressItem({
    user: { id: 7 },
    params: { id: '9', itemId: '11' },
    body: { project_id: 9, title: '新子事项', status: 'completed' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateChecked, true);
});

test('check-in share creates member notification deep link', async () => {
  let notificationPayload = null;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {
      throw new Error('should not rollback when share succeeds');
    },
    release() {},
    async query(sql, params) {
      if (/INSERT IGNORE INTO project_checkin_shares/.test(sql)) {
        assert.deepEqual(params, [55, 8, 7, '请帮忙看看水电走线']);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE project_checkins/.test(sql)) {
        assert.deepEqual(params, [55, 55]);
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO project_action_notifications/.test(sql)) {
        assert.deepEqual(params.slice(0, 1), [8]);
        notificationPayload = JSON.parse(params[1]);
        return [{ insertId: 99 }];
      }
      throw new Error(`unexpected connection query: ${sql}`);
    },
  };
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [7, 9, 7]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'owner' }]];
      }
      if (/SELECT role FROM project_members/.test(sql)) {
        assert.deepEqual(params, [9, 7]);
        return [[{ role: 'owner' }]];
      }
      if (/SELECT id, user_id, description FROM project_checkins/.test(sql)) {
        assert.deepEqual(params, [55, 9]);
        return [[{ id: 55, user_id: 7, description: '水电现场打卡' }]];
      }
      if (/SELECT user_id FROM project_members/.test(sql) && /user_id IN/.test(sql)) {
        assert.deepEqual(params, [9, 8]);
        return [[{ user_id: 8 }]];
      }
      if (/SELECT shared_with_user_id/.test(sql)) {
        assert.deepEqual(params, [55, 8]);
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.updateProjectCheckInShares({
    user: { id: 7 },
    params: { id: '9', checkInId: '55' },
    body: {
      project_id: 9,
      shared_member_ids: [8],
      share_note: '请帮忙看看水电走线',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(notificationPayload.projectEventType, 'SITE_CHECK_IN_SHARED');
  assert.equal(notificationPayload.route, 'received_site_check_in');
  assert.equal(notificationPayload.content, '请帮忙看看水电走线');
  assert.equal(notificationPayload.entityType, 'site_check_in');
  assert.equal(notificationPayload.entityId, 55);
  assert.deepEqual(notificationPayload.deepLink, { projectId: 9, checkInId: 55 });
});

test('received check-in share returns only the recipient view data', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [8, 9, 8]);
        return [[{ id: 9, user_id: 7, lifecycle_status: 'active', role: 'designer' }]];
      }
      if (/FROM project_checkin_shares share/.test(sql)) {
        assert.deepEqual(params, [55, 8, 9]);
        return [[{
          share_id: 18,
          share_note: '请确认水电定位。',
          checkin_date: '2026-07-13',
          project_name: '云栖苑改造',
          current_stage: 3,
          shared_by_name: '项目经理小周',
          shared_by_avatar: '',
        }]];
      }
      if (/FROM project_checkin_media/.test(sql)) {
        assert.deepEqual(params, [55]);
        return [[{
          id: 3,
          media_type: 'image',
          media_url: '/uploads/check-ins/water.jpg',
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.getReceivedProjectCheckInShare({
    user: { id: 8 },
    params: { id: '9', checkInId: '55' },
    originalUrl: '/api/renovation/projects/9/check-ins/55/received-share',
    protocol: 'https',
    get: () => 'api.example.com',
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, {
    share_id: 18,
    project_name: '云栖苑改造',
    current_stage: 3,
    checkin_date: '2026-07-13',
    shared_by_name: '项目经理小周',
    shared_by_avatar: '',
    share_note: '请确认水电定位。',
    images: [{
      id: 3,
      media_type: 'image',
      media_url: 'https://api.example.com/api/uploads/check-ins/water.jpg',
    }],
  });
});
