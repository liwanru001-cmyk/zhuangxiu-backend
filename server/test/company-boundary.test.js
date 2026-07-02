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
  const resolvedControllerPath = require.resolve(controllerPath);
  delete require.cache[dbPath];
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
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].project_name, '旧房翻新');
  assert.deepEqual(res.payload.data[0].image_urls, ['/api/uploads/case-1.jpg']);
  assert.deepEqual(res.payload.data[0].visible_fields, { area: true });
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
  assert.deepEqual(res.payload.data[0].project_names, ['旧房翻新', '客厅改造']);
  assert.equal(res.payload.data[0].memberRole, 'client');
  assert.equal(res.payload.data[0].canManage, false);
  assert.equal(queries.length, 1);
});

test('project member candidate API rejects merchant role before querying users', async () => {
  const dbMock = {
    async query() {
      throw new Error('merchant candidate lookup should not hit db');
    },
  };
  const controller = loadController('../controllers/renovation.controller', dbMock);
  const res = mockResponse();

  await controller.getMemberCandidates({
    query: { role: 'merchant', project_id: '1', keyword: 'abc' },
    user: { id: 1 },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '成员身份不正确');
});

test('project member invitation API rejects merchant role before querying users', async () => {
  const dbMock = {
    async query() {
      throw new Error('merchant invitation should not hit db');
    },
  };
  const controller = loadController('../controllers/renovation.controller', dbMock);
  const res = mockResponse();

  await controller.requestProjectMember({
    body: { project_id: 1, target_user_id: 2, member_role: 'merchant' },
    user: { id: 1 },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '成员身份不正确');
});
