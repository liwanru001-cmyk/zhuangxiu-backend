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

test('consultation messages only enable company rating for the requester', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/FROM designer_consultations c/.test(sql) && /WHERE c\.id = \?/.test(sql)) {
        assert.match(sql, /AS evaluation_company_id/);
        assert.deepEqual(params, [88, 7, 7]);
        return [[{
          id: 88,
          designer_id: 42,
          target_role: 'merchant',
          user_id: 7,
          content: '想了解整装服务',
          status: 'pending',
          evaluation_company_id: 15,
        }]];
      }
      if (/INSERT IGNORE INTO consultation_message_reads/.test(sql)) {
        return [{ affectedRows: 0 }];
      }
      if (/FROM consultation_messages m/.test(sql)) {
        return [[]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController('../controllers/user.controller', dbMock);
  const res = mockResponse();

  await controller.getConsultationMessages({
    user: { id: 7 },
    params: { id: '88' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.consultation.evaluation_company_id, 15);
  assert.equal(res.payload.data.consultation.can_evaluate_communication, true);
});

test('legacy merchant consultation resolves its company and accepts rating', async () => {
  let feedbackParams = null;
  const dbMock = {
    async query(sql, params) {
      if (/FROM designer_consultations c/.test(sql) && /AS company_id/.test(sql)) {
        assert.match(sql, /merchant_company\.owner_user_id = c\.designer_id/);
        assert.deepEqual(params, [88]);
        return [[{
          consultation_id: 88,
          user_id: 7,
          designer_id: 42,
          company_id: 15,
          project_id: null,
        }]];
      }
      if (/INSERT INTO company_evaluation_feedback/.test(sql)) {
        feedbackParams = params;
        return [{ insertId: 1 }];
      }
      if (/FROM company_evaluation_daily_snapshots snapshot/.test(sql)) {
        return [[]];
      }
      if (/SELECT DISTINCT p\.id/.test(sql)) return [[]];
      if (/SELECT user_id FROM company_members/.test(sql)) return [[]];
      if (/SELECT COUNT\(DISTINCT c\.id\)/.test(sql)) {
        return [[{ consultation_count: 1, message_count: 2 }]];
      }
      if (/SELECT AVG\(score\)/.test(sql)) {
        return [[{ avg_score: 5, feedback_count: 1 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(
    '../controllers/marketplace.controller',
    dbMock,
  );
  const res = mockResponse();

  await controller.submitConsultationEvaluationFeedback({
    user: { id: 7 },
    params: { id: '88' },
    body: { score: 5, comment_private: '沟通及时' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(feedbackParams, [
    15,
    null,
    88,
    7,
    'communication',
    5,
    '沟通及时',
  ]);
});

test('professional consultation returns a clear unsupported response', async () => {
  const dbMock = {
    async query(sql, params) {
      assert.match(sql, /FROM designer_consultations c/);
      assert.deepEqual(params, [66]);
      return [[{
        consultation_id: 66,
        user_id: 7,
        designer_id: 9,
        company_id: null,
        project_id: null,
      }]];
    },
  };
  const controller = loadController(
    '../controllers/marketplace.controller',
    dbMock,
  );
  const res = mockResponse();

  await controller.submitConsultationEvaluationFeedback({
    user: { id: 7 },
    params: { id: '66' },
    body: { score: 4 },
  }, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.payload.message, '该咨询未关联装修公司，暂不支持评价');
});
