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

function loadController(controllerPath, dbMock) {
  const dbPath = require.resolve('../config/db');
  const projectContextPath = require.resolve('../utils/project-context');
  const resolvedControllerPath = require.resolve(controllerPath);
  delete require.cache[dbPath];
  delete require.cache[projectContextPath];
  delete require.cache[resolvedControllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require(controllerPath);
}

test('public company search only queries verified companies and never merchant profiles', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /c\.status = 'active'/);
      assert.match(sql, /c\.verification_status = 'verified'/);
      assert.match(sql, /be\.subject_type = 'company'/);
      assert.match(sql, /be\.subject_id = c\.id/);
      assert.match(sql, /company_visible/);
      assert.doesNotMatch(sql, /c\.paid_display_status = 'active'/);
      assert.doesNotMatch(sql, /paid_display_starts_at IS NULL/);
      assert.doesNotMatch(sql, /paid_display_ends_at IS NULL/);
      assert.doesNotMatch(sql, /merchant_profiles/);
      return [[{
        id: 7,
        owner_user_id: 1,
        name: '靠谱装修',
        logo_url: 'https://example.com/logo.png',
        intro: '整装服务',
        service_area: '上海',
        city: '上海',
        address: '徐汇',
        contact_phone: '13800000000',
        source: 'manual',
        legacy_merchant_user_id: null,
        license_url: 'https://example.com/license.png',
        verification_status: 'verified',
        paid_display_status: 'none',
        paid_display_starts_at: null,
        paid_display_ends_at: null,
        rating_avg: '4.80',
        review_count: 12,
        case_count: 5,
        created_at: null,
        updated_at: null,
        status: 'active',
        businesses: JSON.stringify([{
          id: 1,
          code: 'whole_renovation',
          name: '整装公司',
          parent_code: 'find_renovation',
          parent_name: '找装修',
          is_primary: 1,
        }]),
        members: JSON.stringify([]),
      }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.searchPublicCompanies({
    query: { parent_code: 'find_renovation' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.source, 'companies_public');
  assert.equal(res.payload.data.items.length, 1);
  assert.equal(res.payload.data.items[0].paid_display_status, 'none');
  assert.equal(res.payload.data.items[0].verification_status, 'verified');
  assert.equal(queries.length, 1);
});

test('public company detail requires an active verified company without paid display entitlement', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /c\.status = 'active'/);
      assert.match(sql, /c\.verification_status = 'verified'/);
      assert.doesNotMatch(sql, /be\.subject_type = 'company'/);
      assert.doesNotMatch(sql, /be\.subject_id = c\.id/);
      assert.doesNotMatch(sql, /c\.paid_display_status = 'active'/);
      assert.doesNotMatch(sql, /paid_display_starts_at IS NULL/);
      assert.doesNotMatch(sql, /paid_display_ends_at IS NULL/);
      assert.deepEqual(params, [99]);
      return [[]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.getPublicCompany({ params: { id: '99' } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.message, '公司不存在');
  assert.equal(queries.length, 1);
});

test('public company case shares return approved works for a visible company card', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === 1) {
        assert.match(sql, /status <> 'deleted'/);
        assert.doesNotMatch(sql, /verification_status = 'verified'/);
        assert.doesNotMatch(sql, /be\.subject_type = 'company'/);
        assert.doesNotMatch(sql, /be\.subject_id = companies\.id/);
        assert.deepEqual(params, [9]);
        return [[{ id: 9 }]];
      }
      if (queries.length === 2) {
        assert.match(sql, /FROM project_participants_ext ppe/);
        assert.deepEqual(params, [9, 9]);
        return [[{ project_id: 11 }, { project_id: 12 }]];
      }
      if (queries.length === 3) {
        assert.match(sql, /FROM company_members cm/);
        assert.deepEqual(params, [9]);
        return [[{ project_id: 12 }, { project_id: 13 }]];
      }
      if (queries.length === 4) {
        assert.match(sql, /FROM companies c/);
        assert.match(sql, /c\.owner_user_id/);
        assert.match(sql, /c\.legacy_merchant_user_id/);
        assert.deepEqual(params, [9]);
        return [[{ project_id: 14 }]];
      }
      if (queries.length === 5) {
        assert.match(sql, /COUNT\(DISTINCT share\.project_id\) AS total/);
        assert.match(sql, /project_case_shares share/);
        assert.deepEqual(params, [[11, 12, 13, 14]]);
        return [[{ total: 1 }]];
      }
      assert.match(sql, /FROM project_case_shares share/);
      assert.match(sql, /share\.status = 1/);
      assert.deepEqual(params, [[11, 12, 13, 14]]);
      return [[{
        id: 3,
        project_id: 11,
        project_name: '旧房翻新',
        designer_id: 21,
        owner_id: 42,
        title: '小户型改造',
        style: '现代简约',
        summary: '客厅和厨房重新规划',
        highlights: '动线更顺',
        image_urls: JSON.stringify(['/api/uploads/case-1.jpg']),
        visible_fields: JSON.stringify({ area: true }),
        designer_name: '设计师A',
        owner_name: '业主B',
        reviewed_at: null,
        created_at: null,
        updated_at: null,
      }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.listPublicCompanyCaseShares({ params: { id: '9' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.participated_project_count, 4);
  assert.equal(res.payload.data.authorized_project_count, 1);
  assert.equal(res.payload.data.items.length, 1);
  assert.equal(res.payload.data.items[0].project_name, '旧房翻新');
  assert.deepEqual(res.payload.data.items[0].image_urls, ['/api/uploads/case-1.jpg']);
  assert.deepEqual(res.payload.data.items[0].visible_fields, { area: true });
  assert.equal(queries.length, 6);
});

test('public company reviews require verified company and return review list', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === 1) {
        assert.match(sql, /status = 'active'/);
        assert.match(sql, /verification_status = 'verified'/);
        assert.doesNotMatch(sql, /be\.subject_type = 'company'/);
        assert.doesNotMatch(sql, /be\.subject_id = companies\.id/);
        assert.deepEqual(params, [9]);
        return [[{ id: 9 }]];
      }
      assert.match(sql, /FROM company_reviews review/);
      assert.match(sql, /review\.status = 1/);
      assert.deepEqual(params, [9]);
      return [[{
        id: 12,
        company_id: 9,
        project_id: 11,
        project_name: '旧房翻新',
        reviewer_user_id: 42,
        reviewer_name: '业主B',
        reviewer_avatar: '/uploads/avatar.jpg',
        rating: 5,
        content: '沟通及时，施工配合顺畅',
        created_at: null,
        updated_at: null,
      }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.listPublicCompanyReviews({ params: { id: '9' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].rating, 5);
  assert.equal(res.payload.data[0].content, '沟通及时，施工配合顺畅');
  assert.equal(res.payload.data[0].project_name, '旧房翻新');
  assert.equal(queries.length, 2);
});

test('my companies can include an owner company that is not publicly displayed', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /c\.status <> 'deleted'/);
      assert.doesNotMatch(sql, /paid_display_status = 'active'/);
      assert.deepEqual(params, [42, 42]);
      return [[{
        id: 8,
        owner_user_id: 42,
        name: '后台可见公司',
        logo_url: '',
        intro: '',
        service_area: '',
        city: '',
        address: '',
        contact_phone: '',
        status: 'draft',
        source: 'manual',
        license_url: '',
        verification_status: 'unverified',
        paid_display_status: 'none',
        paid_display_starts_at: null,
        paid_display_ends_at: null,
        rating_avg: '0.00',
        review_count: 0,
        case_count: 0,
        legacy_merchant_user_id: null,
        created_at: null,
        updated_at: null,
        member_role: null,
        businesses: JSON.stringify([]),
        members: JSON.stringify([]),
      }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.listMyCompanies({ user: { id: 42 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].paid_display_status, 'none');
  assert.equal(res.payload.data[0].canManage, true);
  assert.equal(queries.length, 1);
});

test('my project companies come from project participants and are read only', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /project_participants_ext ppe/);
      assert.match(sql, /ppe\.participant_type = 'company'/);
      assert.match(sql, /p\.user_id = \? OR pm\.id IS NOT NULL/);
      assert.doesNotMatch(sql, /paid_display_status = 'active'/);
      assert.deepEqual(params, [42, 42]);
      return [[{
        id: 9,
        owner_user_id: 7,
        name: '项目合作装修公司',
        logo_url: '',
        intro: '项目合作方',
        service_area: '杭州',
        city: '杭州',
        address: '',
        contact_phone: '',
        status: 'active',
        source: 'manual',
        license_url: '',
        verification_status: 'verified',
        paid_display_status: 'none',
        paid_display_starts_at: null,
        paid_display_ends_at: null,
        rating_avg: '0.00',
        review_count: 0,
        case_count: 0,
        legacy_merchant_user_id: null,
        created_at: null,
        updated_at: null,
        businesses: JSON.stringify([]),
        members: JSON.stringify([]),
        latest_project_updated_at: null,
        project_ids: '11||12',
        project_names: '旧房翻新||客厅改造',
      }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.listMyProjectCompanies({ user: { id: 42 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].name, '项目合作装修公司');
  assert.deepEqual(res.payload.data[0].project_ids, [11, 12]);
  assert.deepEqual(res.payload.data[0].project_names, ['旧房翻新', '客厅改造']);
  assert.equal(res.payload.data[0].memberRole, 'client');
  assert.equal(res.payload.data[0].canManage, false);
  assert.equal(queries.length, 1);
});

test('company workbench summary uses explicit and company-member project links', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT c\.id, c\.owner_user_id, cm\.member_role/.test(sql)) {
        assert.deepEqual(params, [42, 9, 42]);
        return [[{ id: 9, owner_user_id: 42, member_role: null }]];
      }
      if (/COUNT\(DISTINCT item\.id\) AS total/.test(sql)) {
        assert.match(sql, /project_participants_ext ppe/);
        assert.match(sql, /ppe\.company_id = \?/);
        assert.match(sql, /participant_type = 'company'/);
        assert.match(sql, /JOIN project_members project_member/);
        assert.match(sql, /company_member\.company_id = \?/);
        assert.match(sql, /item\.due_date <= CURDATE\(\)/);
        assert.doesNotMatch(sql, /renovation_tasks/);
        assert.deepEqual(params, [9, 9, 9, 9]);
        return [[{
          total: 18,
          project_count: 6,
          member_count: 4,
          owner_count: 3,
        }]];
      }
      if (/COUNT\(\*\) AS total[\s\S]*FROM consultation_targets target/.test(sql)) {
        assert.deepEqual(params, [9, 9]);
        return [[{
          total: 5,
          conversation_count: 5,
          oldest_waiting_at: new Date(Date.now() - 18 * 3600000).toISOString(),
        }]];
      }
      if (/nearest_due_at/.test(sql)) {
        assert.match(sql, /project_progress_items item/);
        assert.match(sql, /item\.status <> 'completed'/);
        assert.doesNotMatch(sql, /project_action_items action/);
        assert.deepEqual(params, [9, 9, 9]);
        return [[{
          total: 4,
          project_count: 3,
          nearest_due_at: new Date(Date.now() + 24 * 3600000).toISOString(),
          overdue_count: 1,
          upcoming_count: 3,
        }]];
      }
      if (/inspection_issues/.test(sql) && /COUNT\(\*\) AS total/.test(sql)) {
        assert.match(sql, /inspection\.status = 'rework'/);
        assert.match(sql, /record\.status = 'rework'/);
        assert.deepEqual(params, [9, 9, 9]);
        return [[{
          total: 3,
          project_count: 3,
          oldest_updated_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        }]];
      }
      if (sql.includes("SELECT 'action' AS item_type")
        && sql.includes('FROM project_action_items item')) {
        assert.deepEqual(params, [9, 9, 9, 9]);
        assert.match(sql, /item\.due_date <= CURDATE\(\)/);
        return [[{
          item_type: 'action',
          item_id: 101,
          title: '确认水电验收',
          project_id: 11,
          project_name: '星河湾工地',
          person_id: 42,
          person_name: '业主张三',
          person_role: '业主',
          due_at: new Date().toISOString(),
          submitted_at: new Date().toISOString(),
          waiting_hours: null,
        }]];
      }
      if (/SELECT 'consultation' AS item_type/.test(sql)) {
        assert.deepEqual(params, [9, 9]);
        return [[{
          item_type: 'consultation',
          item_id: 201,
          title: '咨询待回复',
          project_id: null,
          project_name: '杭州',
          person_id: 51,
          person_name: '业主李四',
          person_role: '咨询用户',
          due_at: null,
          submitted_at: new Date(Date.now() - 18 * 3600000).toISOString(),
          waiting_hours: 18,
        }]];
      }
      if (sql.includes("SELECT 'task' AS item_type")
        && sql.includes('FROM renovation_tasks task')
        && sql.includes('task.planned_end <= DATE_ADD')) {
        assert.match(sql, /responsible\.id = project\.user_id/);
        assert.deepEqual(params, [9, 9, 9]);
        return [[]];
      }
      if (sql.includes("SELECT 'progress' AS item_type")
        && sql.includes('FROM project_progress_items item')) {
        assert.match(sql, /project_progress_items item/);
        assert.match(sql, /item\.status <> 'completed'/);
        assert.doesNotMatch(sql, /ppe_resp\./);
        assert.deepEqual(params, [9, 9, 9]);
        return [[{
          item_type: 'progress',
          item_id: 301,
          title: '泥木阶段验收',
          project_id: 12,
          project_name: '江南里工地',
          person_id: 61,
          person_name: '工长王五',
          person_role: '创建人',
          due_at: new Date(Date.now() + 24 * 3600000).toISOString(),
          submitted_at: new Date().toISOString(),
          waiting_hours: null,
        }]];
      }
      if (/SELECT issue_items\.\*/.test(sql)) {
        assert.deepEqual(params, [9, 9, 9]);
        return [[{
          item_type: 'inspection',
          item_id: 401,
          title: '水电验收问题',
          project_id: 13,
          project_name: '湖滨工地',
          person_id: 71,
          person_name: '项目经理赵六',
          person_role: '整改负责人',
          due_at: null,
          submitted_at: new Date(Date.now() - 2 * 86400000).toISOString(),
          waiting_hours: null,
        }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.getCompanyWorkbenchSummary({
    user: { id: 42 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.companyId, 9);
  assert.equal(res.payload.data.todayTodos.total, 18);
  assert.equal(res.payload.data.todayTodos.projectCount, 6);
  assert.equal(res.payload.data.todayTodos.memberCount, 4);
  assert.equal(res.payload.data.todayTodos.ownerCount, 3);
  assert.match(res.payload.data.todayTodos.summary, /共18项今日到期或已逾期待办/);
  assert.equal(res.payload.data.pendingConsultations.total, 5);
  assert.equal(res.payload.data.upcomingDeadlines.total, 4);
  assert.match(res.payload.data.upcomingDeadlines.summary, /已延期1项/);
  assert.equal(res.payload.data.inspectionIssues.total, 3);
  assert.equal(res.payload.data.todayTodos.items[0].projectName, '星河湾工地');
  assert.equal(res.payload.data.todayTodos.items[0].personName, '业主张三');
  assert.equal(res.payload.data.pendingConsultations.items[0].personRole, '咨询用户');
  assert.equal(res.payload.data.upcomingDeadlines.items[0].projectName, '江南里工地');
  assert.equal(res.payload.data.inspectionIssues.items[0].personName, '项目经理赵六');
  assert.equal(queries.length, 10);
});

test('company workbench summary rejects ordinary company members', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /SELECT c\.id, c\.owner_user_id, cm\.member_role/);
      assert.deepEqual(params, [42, 9, 42]);
      return [[{ id: 9, owner_user_id: 7, member_role: 'staff' }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.getCompanyWorkbenchSummary({
    user: { id: 42 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.message, '当前成员不能查看公司工作台');
});

test('company deadline detail lists only construction tasks and progress items', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT c\.id, c\.owner_user_id, cm\.member_role/.test(sql)) {
        assert.deepEqual(params, [42, 9, 42]);
        return [[{ id: 9, owner_user_id: 42, member_role: null }]];
      }
      assert.match(sql, /FROM renovation_tasks task/);
      assert.match(sql, /FROM project_progress_items item/);
      assert.doesNotMatch(sql, /FROM project_action_items/);
      assert.match(sql, /ORDER BY deadline_items\.due_at ASC/);
      assert.deepEqual(params, [9, 9, 9]);
      return [[{
        item_type: 'task',
        item_id: 7,
        title: '木工施工',
        project_id: 11,
        project_name: '星河湾工地',
        person_id: 42,
        person_name: '业主张三',
        person_role: '业主',
        due_at: '2026-08-03',
        submitted_at: '2026-08-01',
        waiting_hours: null,
      }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.listCompanyDeadlineItems({
    user: { id: 42 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].type, 'task');
  assert.equal(res.payload.data[0].projectName, '星河湾工地');
});

test('company inspection issue detail lists inspection and step rework records', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT c\.id, c\.owner_user_id, cm\.member_role/.test(sql)) {
        assert.deepEqual(params, [42, 9, 42]);
        return [[{ id: 9, owner_user_id: 42, member_role: null }]];
      }
      assert.match(sql, /FROM project_inspections inspection/);
      assert.match(sql, /FROM project_inspection_step_records record/);
      assert.match(sql, /inspection\.status = 'rework'/);
      assert.match(sql, /record\.status = 'rework'/);
      assert.deepEqual(params, [9, 9, 9]);
      return [[{
        item_type: 'inspection_step',
        item_id: 8,
        title: '闭水试验待整改',
        project_id: 11,
        project_name: '星河湾工地',
        person_id: 61,
        person_name: '项目经理王五',
        person_role: '整改负责人',
        due_at: null,
        submitted_at: '2026-08-11',
        waiting_hours: null,
      }]];
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.listCompanyInspectionIssues({
    user: { id: 42 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].type, 'inspection_step');
  assert.equal(res.payload.data[0].personName, '项目经理王五');
});

test('company workbench summary tolerates detail query schema drift', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT c\.id, c\.owner_user_id, cm\.member_role/.test(sql)) {
        assert.deepEqual(params, [42, 9, 42]);
        return [[{ id: 9, owner_user_id: 42, member_role: null }]];
      }
      if (/COUNT\(DISTINCT item\.id\) AS total/.test(sql)) {
        return [[{ total: 1, project_count: 1, member_count: 0, owner_count: 0 }]];
      }
      if (/COUNT\(\*\) AS total[\s\S]*FROM consultation_targets target/.test(sql)) {
        return [[{ total: 0, conversation_count: 0, oldest_waiting_at: null }]];
      }
      if (/nearest_due_at/.test(sql)) {
        return [[{ total: 0, project_count: 0, nearest_due_at: null }]];
      }
      if (/inspection_issues/.test(sql) && /COUNT\(\*\) AS total/.test(sql)) {
        return [[{ total: 0, project_count: 0, oldest_updated_at: null }]];
      }
      if (/SELECT '(task|action|progress|consultation)' AS item_type/.test(sql)
        || /SELECT issue_items\.\*/.test(sql)) {
        const err = new Error('Unknown column');
        err.code = 'ER_BAD_FIELD_ERROR';
        throw err;
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.getCompanyWorkbenchSummary({
    user: { id: 42 },
    params: { id: '9' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.todayTodos.total, 1);
  assert.deepEqual(res.payload.data.todayTodos.items, []);
  assert.deepEqual(res.payload.data.pendingConsultations.items, []);
  assert.deepEqual(res.payload.data.upcomingDeadlines.items, []);
  assert.deepEqual(res.payload.data.inspectionIssues.items, []);
});

test('legacy company review submit is disabled after evaluation redesign', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.submitCompanyReview({
    user: { id: 42 },
    projectContext: { projectId: 11 },
    params: { id: '9' },
    body: { project_id: 11, rating: 5, content: '整体服务很顺畅' },
  }, res);

  assert.equal(res.statusCode, 410);
  assert.equal(res.payload.message, '公司评价体系已升级，请使用四维评价入口');
  assert.equal(queries.length, 0);
});

test('company logo or license changes move company verification back to pending', async () => {
  const updates = [];
  const dbMock = {
    async query(sql, params) {
      if (/SELECT c\.id/.test(sql) && /LEFT JOIN company_members cm/.test(sql)) {
        assert.deepEqual(params, [42, 9, 42]);
        return [[{ id: 9 }]];
      }
      if (/SELECT logo_url, license_url FROM companies/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{
          logo_url: 'https://example.com/old-logo.jpg',
          license_url: 'https://example.com/old-license.jpg',
        }]];
      }
      if (/UPDATE companies/.test(sql)) {
        updates.push({ sql, params });
        assert.match(sql, /verification_status = CASE/);
        assert.equal(params[11], 1);
        return [{ affectedRows: 1 }];
      }
      if (/FROM companies c/.test(sql) && /WHERE c\.id = \?/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{
          id: 9,
          owner_user_id: 42,
          name: '靠谱装修',
          logo_url: 'https://example.com/new-logo.jpg',
          intro: '',
          service_area: '',
          city: '',
          address: '',
          contact_phone: '',
          status: 'active',
          source: 'manual',
          license_url: 'https://example.com/old-license.jpg',
          verification_status: 'pending',
          paid_display_status: 'none',
          paid_display_starts_at: null,
          paid_display_ends_at: null,
          rating_avg: '0.00',
          review_count: 0,
          case_count: 0,
          legacy_merchant_user_id: null,
          created_at: null,
          updated_at: null,
          businesses: JSON.stringify([]),
          members: JSON.stringify([]),
        }]];
      }
      if (/FROM company_members cm/.test(sql) && /WHERE cm\.company_id = \?/.test(sql)) {
        assert.deepEqual(params, [9, 5]);
        return [[]];
      }
      if (/SELECT id AS user_id, nickname, avatar FROM users/.test(sql)) {
        assert.deepEqual(params, [42]);
        return [[{ user_id: 42, nickname: '负责人', avatar: '' }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.updateCompany({
    user: { id: 42 },
    params: { id: '9' },
    body: {
      name: '靠谱装修',
      logo_url: 'https://example.com/new-logo.jpg',
      license_url: 'https://example.com/old-license.jpg',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.verification_status, 'pending');
  assert.equal(updates.length, 1);
});

test('project member candidate API can search merchant role', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT id FROM project_members/.test(sql) && /role = 'owner'/.test(sql)) {
        assert.deepEqual(params, [1, 1]);
        return [[{ id: 1 }]];
      }
      if (/FROM user_roles ur/.test(sql) && /WHERE ur\.role = \?/.test(sql)) {
        assert.deepEqual(params, [1, 1, 'merchant', 1, '%abc%', '%abc%', '%abc%']);
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/renovation.controller', dbMock);
  const res = mockResponse();

  await controller.getMemberCandidates({
    query: { role: 'merchant', project_id: '1', keyword: 'abc' },
    user: { id: 1 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, []);
});

test('project member invitation API can invite merchant role', async () => {
  const writes = [];
  const dbMock = {
    async query(sql, params) {
      if (/SELECT id FROM project_members/.test(sql) && /role = 'owner'/.test(sql)) {
        assert.deepEqual(params, [1, 1]);
        return [[{ id: 1 }]];
      }
      if (/SELECT id FROM user_roles/.test(sql)) {
        assert.deepEqual(params, [2, 'merchant']);
        return [[{ id: 2 }]];
      }
      if (/SELECT id FROM project_members/.test(sql) && /role = \?/.test(sql)) {
        assert.deepEqual(params, [1, 2, 'merchant']);
        return [[]];
      }
      if (/INSERT INTO project_member_requests/.test(sql)) {
        writes.push(params);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/renovation.controller', dbMock);
  const res = mockResponse();

  await controller.requestProjectMember({
    body: { project_id: 1, target_user_id: 2, member_role: 'merchant' },
    user: { id: 1 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.message, '关联申请已发送');
  assert.deepEqual(writes, [[1, 1, 2, 'merchant', null]]);
});

test('company project detail only returns the linked project summary without member contact data', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/SELECT c\.id[\s\S]*FROM companies c/.test(sql)) {
        assert.deepEqual(params, [42, 9, 42]);
        return [[{ id: 9 }]];
      }
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [88]);
        return [[{
          id: 88,
          project_code: 'MC20260712',
          project_name: '三居改造',
          house_area: 100,
          house_layout: '三室两厅',
          project_type: 'rough',
          renovation_method: 'company',
          budget_range: '20-30万',
          start_date: '2026-07-01',
          expected_move_in_date: '2026-10-01',
          current_stage: 3,
          status: 1,
          lifecycle_status: 'active',
        }]];
      }
      if (/FROM project_participants_ext ppe/.test(sql)) {
        assert.deepEqual(params, [88, 9, 9]);
        return [[{ role_type: 'contractor', responsible_name: '项目经理' }]];
      }
      if (/SELECT name FROM companies/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{ name: '装修不凡软装' }]];
      }
      if (/SELECT user\.nickname AS display_name, pm\.role/.test(sql)) {
        assert.deepEqual(params, [88]);
        return [[{ display_name: '业主Lee', role: 'owner' }, { display_name: '项目经理', role: 'project_manager' }]];
      }
      if (/FROM renovation_tasks/.test(sql)) {
        assert.deepEqual(params, [88]);
        return [[{ total: 10, completed: 4, delayed: 1 }]];
      }
      if (/FROM project_progress_items/.test(sql)) {
        assert.deepEqual(params, [88]);
        return [[{ total: 12, completed: 4, delayed: 2 }]];
      }
      if (/design_document_count/.test(sql)) {
        assert.deepEqual(params, [88, 88, 88, 88, 88]);
        return [[{
          design_document_count: 3,
          handover_count: 2,
          pending_handover_count: 1,
          material_count: 8,
          pending_material_count: 2,
        }]];
      }
      if (/FROM project_inspections/.test(sql)) {
        assert.deepEqual(params, [88]);
        return [[{ total: 3, passed: 2, rework: 1 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.getCompanyProjectDetail({
    user: { id: 42 },
    params: { id: '9', projectId: '88' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.project.currentStageName, '水电改造');
  assert.equal(res.payload.data.progress.percent, 40);
  assert.equal(res.payload.data.members.length, 2);
  assert.doesNotMatch(JSON.stringify(res.payload.data), /phone/i);
});

test('company project detail falls back when historical summary fields or tables are unavailable', async () => {
  const schemaDrift = (code) => Object.assign(new Error('historical schema differs'), { code });
  const dbMock = {
    async query(sql, params) {
      if (/SELECT c\.id[\s\S]*FROM companies c/.test(sql)) {
        assert.deepEqual(params, [42, 9, 42]);
        return [[{ id: 9 }]];
      }
      if (/FROM renovation_projects p/.test(sql)) {
        assert.deepEqual(params, [88]);
        if (/expected_move_in_date/.test(sql)) throw schemaDrift('ER_BAD_FIELD_ERROR');
        return [[{
          id: 88,
          project_code: 'MC20260712',
          project_name: '旧项目',
          house_area: 80,
          start_date: '2026-07-01',
          current_stage: 2,
          status: 1,
          lifecycle_status: 'active',
        }]];
      }
      if (/FROM project_participants_ext ppe/.test(sql)) {
        assert.deepEqual(params, [88, 9, 9]);
        if (/ppe\.updated_at/.test(sql)) throw schemaDrift('ER_BAD_FIELD_ERROR');
        return [[{ role_type: 'contractor', responsible_name: '项目经理' }]];
      }
      if (/SELECT name FROM companies/.test(sql)) {
        assert.deepEqual(params, [9]);
        return [[{ name: '装修不凡软装' }]];
      }
      if (/SELECT user\.nickname AS display_name, pm\.role/.test(sql)) {
        throw schemaDrift('ER_NO_SUCH_TABLE');
      }
      if (/FROM renovation_tasks/.test(sql)) {
        return [[{ total: 2, completed: 1, delayed: 0 }]];
      }
      if (/FROM project_progress_items/.test(sql)) {
        return [[{ total: 0, completed: 0, delayed: 0 }]];
      }
      if (/design_document_count/.test(sql)) {
        return [[{
          design_document_count: 0,
          handover_count: 0,
          pending_handover_count: 0,
          material_count: 0,
          pending_material_count: 0,
        }]];
      }
      if (/FROM project_inspections/.test(sql)) {
        throw schemaDrift('ER_NO_SUCH_TABLE');
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/marketplace.controller', dbMock);
  const res = mockResponse();

  await controller.getCompanyProjectDetail({
    user: { id: 42 },
    params: { id: '9', projectId: '88' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.project.projectName, '旧项目');
  assert.equal(res.payload.data.project.expectedMoveInDate, null);
  assert.equal(res.payload.data.members.length, 0);
  assert.equal(res.payload.data.progress.percent, 50);
  assert.equal(res.payload.data.inspection.total, 0);
});
