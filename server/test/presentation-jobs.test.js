const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dbPath = require.resolve('../config/db');
let query;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (...args) => query(...args) } };
const jobs = require('../services/presentation-jobs');
function fixture(overrides = {}) {
  const row = { id: 'test-job', project_id: 91, status: 'queued', attempts: 0, settings_json: '{}', ...overrides };
  const updates = [];
  const db = { async query(sql, params = []) {
    if (sql.includes('ORDER BY created_at LIMIT 1')) {
      assert.match(sql, /lease_until < NOW\(\)/);
      if (row.status === 'completed') return [{ affectedRows: 0 }];
      row.worker_token = params[0]; row.status = 'running'; row.attempts++;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT')) return [[{ ...row }]];
    updates.push({ sql, params });
    if (sql.includes("status = 'completed'")) { row.status = 'completed'; row.result_file = params[0]; }
    if (sql.includes("status = 'failed'")) { row.status = 'failed'; row.error = params[0]; }
    return [{ affectedRows: 1 }];
  } };
  return { row, db, updates };
}
const presentation = {
  loadPresentationSource: async () => ({ project: { name: '测试' } }),
  generateOutline: async () => ({ outline: { slides: [{ title: '封面' }] } }),
  buildRenderPlan: (source, settings, outline) => ({ source, settings, outline }),
};
test('worker persists generated file independently of HTTP', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'presentation-job-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = fixture();
  await jobs.runNext({ ...f, directory, presentation, render: async (plan, output) => {
    assert.equal(plan.outline.slides[0].title, '封面'); await fs.writeFile(output, 'pptx contents');
  } });
  assert.equal(f.row.status, 'completed');
  assert.equal(await fs.readFile(path.join(directory, f.row.result_file), 'utf8'), 'pptx contents');
  assert.ok(f.updates.some(u => u.sql.includes('outline_json')));
  assert.equal(await jobs.runNext({ ...f, directory, presentation }), false);
});
test('model failure persists a retryable status', async () => {
  const f = fixture();
  await jobs.runNext({ ...f, presentation: { ...presentation, generateOutline: async () => { throw new Error('模型权限不足'); } } });
  assert.equal(f.row.status, 'failed'); assert.equal(f.row.error, '模型权限不足');
});
test('recovered job reuses persisted source and outline', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'presentation-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = fixture({ status: 'running', source_json: '{"saved":true}', outline_json: '{"slides":[]}' });
  await jobs.runNext({ ...f, directory, presentation: { ...presentation,
    loadPresentationSource: async () => { throw new Error('must reuse snapshot'); },
    generateOutline: async () => { throw new Error('must not call AI twice'); },
  }, render: async (plan, file) => { assert.equal(plan.source.saved, true); await fs.writeFile(file, 'pptx'); } });
  assert.equal(f.row.status, 'completed');
});
test('repeated process interruption has bounded recovery attempts', async () => {
  const f = fixture({ attempts: 3 }); await jobs.runNext({ ...f, presentation });
  assert.equal(f.row.status, 'failed'); assert.match(f.row.error, /多次中断/);
});
test('list response never exposes private files or snapshots', () => {
  const result = jobs.publicJob({ id: 'j', title: '报告', result_file: '/private/file', worker_token: 'secret', source_json: 'sensitive',
    generation_result: JSON.stringify({ generation_status: 'ai_success_unverified_render', render_validation: 'skipped', render_validation_reason: 'render_engine_disabled' }) });
  assert.equal(result.filename, '报告.pptx');
  assert.equal(result.render_validation, 'skipped');
  assert.equal(result.render_validation_reason, 'render_engine_disabled');
  for (const key of ['result_file', 'worker_token', 'source_json']) assert.equal(result[key], undefined);
});

test('list response identifies downloadable V2 drafts and reports their remaining issues', () => {
  const result = jobs.publicJob({ id: 'j', title: '报告', status: 'completed',
    generation_result: JSON.stringify({ generation_mode: 'ai_design_v2', schema_version: 2, generation_status: 'ai_draft', draft: true, draft_issue_count: 3 }) });
  assert.equal(result.is_draft, true);
  assert.equal(result.draft_issue_count, 3);
  assert.match(result.notice, /V2 草稿已生成/);
});

test('submission is idempotent and persists queued work without calling the model', async () => {
  const records = new Map();
  query = async (sql, params = []) => {
    if (sql.startsWith('CREATE TABLE')) return [{}];
    if (sql.includes('COUNT(*) AS total')) return [[{ total: records.size }]];
    if (sql.startsWith('INSERT')) {
      assert.match(sql, /ON DUPLICATE KEY/);
      const key = params.slice(1, 4).join(':');
      if (!records.has(key)) records.set(key, { id: params[0], title: params[4], status: 'queued' });
      return [{ affectedRows: 1 }];
    }
    return [[records.get(params.join(':'))]];
  };
  const key = '12345678-1234-1234-1234-123456789012';
  const first = await jobs.submit(91, 7, { title: '方案' }, key);
  const second = await jobs.submit(91, 7, { title: '方案' }, key);
  assert.equal(first.status, 'queued'); assert.equal(first.id, second.id);
  assert.equal(records.size, 1);
});

test('retry creates a fresh V2 job instead of reusing exhausted run state', async () => {
  const oldId = '11111111-1111-1111-1111-111111111111';
  let inserted;
  query = async (sql, params = []) => {
    if (sql.startsWith('CREATE TABLE')) return [{}];
    if (sql.includes("id = ? AND status = 'failed'")) {
      assert.deepEqual(params, [91, oldId]);
      return [[{ title: '原方案', settings_json: JSON.stringify({ title: '旧标题', _generation_version: 2, _asset_base_url: 'https://old.example' }) }]];
    }
    if (sql.includes('request_key = ?') && sql.startsWith('SELECT')) {
      if (!inserted) return [[]];
      return [[inserted]];
    }
    if (sql.includes('COUNT(*) AS total')) return [[{ total: 0 }]];
    if (sql.startsWith('INSERT INTO project_presentation_jobs')) {
      inserted = { id: params[0], project_id: params[1], user_id: params[2], request_key: params[3], title: params[4], settings_json: params[5], status: 'queued', phase: 'queued' };
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  const retried = await jobs.retry(91, 8, oldId, { assetBaseUrl: 'https://new.example' });
  assert.equal(retried.status, 'queued');
  assert.notEqual(retried.id, oldId);
  assert.equal(inserted.user_id, 8);
  const settings = JSON.parse(inserted.settings_json);
  assert.equal(settings.title, '原方案');
  assert.equal(settings._asset_base_url, 'https://new.example');
  assert.equal(settings._generation_version, 2);
});

test('download rejects a non-member before accessing files', async () => {
  const controller = require('../controllers/project-presentations.controller');
  query = async sql => {
    assert.match(sql, /SELECT p.id, p.user_id, p.lifecycle_status/);
    return [[]];
  };
  const res = { status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; } };
  await controller.downloadJob({ user: { id: 99 }, originalUrl: '/api/renovation/projects/91/presentations/job/download', params: { id: '91', jobId: 'job' } }, res);
  assert.equal(res.code, 404);
});
