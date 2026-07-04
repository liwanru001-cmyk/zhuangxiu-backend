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

test('public company detail requires an active verified company', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql, /c\.status = 'active'/);
      assert.match(sql, /c\.verification_status = 'verified'/);
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

test('public company case shares require verified company and approved project cases', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === 1) {
        assert.match(sql, /status = 'active'/);
        assert.match(sql, /verification_status = 'verified'/);
        assert.deepEqual(params, [9]);
        return [[{ id: 9 }]];
      }
      if (queries.length === 2) {
        assert.match(sql, /COUNT\(\*\) AS total/);
        assert.match(sql, /company_projects/);
        assert.deepEqual(params, [9, 9, 9]);
        return [[{ total: 4 }]];
      }
      if (queries.length === 3) {
        assert.match(sql, /COUNT\(DISTINCT share\.project_id\) AS total/);
        assert.match(sql, /project_case_shares share/);
        assert.deepEqual(params, [9, 9, 9]);
        return [[{ total: 1 }]];
      }
      assert.match(sql, /project_participants_ext ppe/);
      assert.match(sql, /company_members cm/);
      assert.match(sql, /share\.status = 1/);
      assert.deepEqual(params, [9, 9, 9]);
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
  assert.equal(queries.length, 4);
});

test('public company reviews require verified company and return review list', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === 1) {
        assert.match(sql, /status = 'active'/);
        assert.match(sql, /verification_status = 'verified'/);
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
        assert.equal(params[8], 1);
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
