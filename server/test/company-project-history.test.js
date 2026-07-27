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
  const projectContextPath = require.resolve('../utils/project-context');
  const controllerPath = require.resolve('../controllers/marketplace.controller');
  delete require.cache[dbPath];
  delete require.cache[projectContextPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/marketplace.controller');
}

test('desktop company project history includes removed links and project status', async () => {
  const queries = [];
  const dbMock = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queries.length === 1) {
        assert.match(sql, /FROM companies c/);
        return [[{ id: 9 }]];
      }
      if (queries.length === 2) {
        assert.match(sql, /p\.status AS project_status/);
        assert.match(sql, /WHERE 1 = 1/);
        assert.doesNotMatch(sql, /WHERE ppe\.status <> 'removed'/);
        return [[{
          project_id: 31,
          project_code: 'XM31',
          project_name: '历史工地',
          house_area: 86,
          current_stage: 8,
          project_status: 2,
          lifecycle_status: 'active',
          role_type: 'contractor',
          participant_status: 'removed',
          source: 'project_participants_ext',
          responsible_user_id: 7,
          responsible_name: '负责人',
          responsible_avatar: '',
          joined_at: null,
          updated_at: null,
        }]];
      }
      assert.match(sql, /FROM company_members cm/);
      assert.match(sql, /p\.status AS project_status/);
      return [[]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listCompanyProjects({
    params: { id: '9' },
    query: { include_history: '1' },
    user: { id: 7 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.items.length, 1);
  assert.equal(res.payload.data.items[0].projectStatus, 2);
  assert.equal(res.payload.data.items[0].participantStatus, 'removed');
  assert.equal(queries.length, 3);
});

test('default company project request keeps removed links out for app clients', async () => {
  const dbMock = {
    callCount: 0,
    async query(sql) {
      this.callCount += 1;
      if (this.callCount === 1) return [[{ id: 9 }]];
      if (this.callCount === 2) {
        assert.match(sql, /WHERE ppe\.status <> 'removed'/);
        return [[]];
      }
      return [[]];
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.listCompanyProjects({
    params: { id: '9' },
    query: {},
    user: { id: 7 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data.items, []);
});
