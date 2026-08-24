const assert = require('node:assert/strict');
const test = require('node:test');

function response() {
  return {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function controllerWith(dbMock) {
  const dbPath = require.resolve('../config/db');
  const controllerPath = require.resolve('../controllers/public-help.controller');
  delete require.cache[dbPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
  return require('../controllers/public-help.controller');
}

test('public FAQ endpoint returns only active FAQs without authentication', async () => {
  const expectedFaqs = [
    {
      id: 3,
      question: '如何反馈问题？',
      answer: '请在设置中打开帮助与反馈。',
      updated_at: new Date('2026-08-24T12:00:00Z'),
    },
  ];
  const controller = controllerWith({
    async query(sql, params) {
      assert.match(sql, /WHERE is_active = 1/);
      assert.match(sql, /ORDER BY sort_order ASC, id ASC/);
      assert.match(sql, /LIMIT 10/);
      assert.equal(params, undefined);
      return [expectedFaqs];
    },
  });
  const res = response();

  // Deliberately omit req.user: this endpoint must work for signed-out users.
  await controller.listHelpFaqs({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    code: 200,
    message: 'success',
    data: { faqs: expectedFaqs },
  });
  assert.deepEqual(Object.keys(res.payload.data.faqs[0]), [
    'id',
    'question',
    'answer',
    'updated_at',
  ]);
});
