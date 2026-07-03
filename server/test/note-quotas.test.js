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
  const controllerPath = require.resolve('../controllers/note.controller');
  delete require.cache[dbPath];
  delete require.cache[controllerPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: dbMock,
  };
  return require('../controllers/note.controller');
}

const validNoteBody = {
  title: '工地记录',
  content: '今天完成墙面验收',
  source_type: 'site_photos',
  publish_role: 'owner',
  category: 'site_photos',
  images: ['https://example.com/a.jpg'],
  tags: [],
};

test('note create rejects users above total note quota', async () => {
  const dbMock = {
    async query(sql, params) {
      if (/COUNT\(\*\) AS total FROM notes/.test(sql) && /status IN \(1, 3\)/.test(sql)) {
        assert.deepEqual(params, [7]);
        return [[{ total: 50 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const controller = loadController(dbMock);
  const res = mockResponse();

  await controller.create({ user: { id: 7 }, body: validNoteBody }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多 50 篇/);
});

test('note create rejects video payloads', async () => {
  const controller = loadController({
    async query() {
      throw new Error('quota queries should not run for video payload');
    },
  });
  const res = mockResponse();

  await controller.create({
    user: { id: 7 },
    body: {
      ...validNoteBody,
      images: [],
      video: { url: 'https://example.com/a.mp4' },
    },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.message, '暂不支持发布视频');
});

test('comment create enforces length and daily quota', async () => {
  const controller = loadController({
    async query(sql, params) {
      if (/COUNT\(\*\) AS total FROM comments/.test(sql) && /created_at >= CURDATE/.test(sql)) {
        assert.deepEqual(params, [7]);
        return [[{ total: 10 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  });
  const res = mockResponse();

  await controller.createComment({
    user: { id: 7 },
    params: { id: '9' },
    body: { content: '这是一条正常长度的评论' },
  }, res);

  assert.equal(res.statusCode, 429);
  assert.match(res.payload.message, /最多评论 10 条/);
});

test('comment create rejects content over 60 chars before quota checks', async () => {
  const controller = loadController({
    async query() {
      throw new Error('quota queries should not run for invalid comment length');
    },
  });
  const res = mockResponse();

  await controller.createComment({
    user: { id: 7 },
    params: { id: '9' },
    body: { content: '一'.repeat(61) },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.payload.message, /最多 60 个字/);
});
