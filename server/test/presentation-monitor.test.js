'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filters, classify, summarize, redact, createMonitor } = require('../services/presentation-monitor');
const v2 = { id: '18d5bbf8-59ca-4be4-a11f-c1157700bf66', title: '项目', project_id: 21, requested_version: '2', run_id: 'run', status: 'completed', created_at: new Date('2026-09-10T04:00:00Z'), updated_at: new Date('2026-09-10T04:03:00Z'), model_requests: 2,
  result_json: { generation_mode: 'ai_design_v2', schema_version: 2, generation_status: 'ai_success_unverified_render' } };
test('monitor separates V2 delivery, repair, fallback, failures and unfinished jobs', () => {
  const rows = [classify(v2), classify({ ...v2, repair_used: 1, warning_count: 2, result_json: { ...v2.result_json, generation_status: 'ai_repaired_success_unverified_render' } }),
    classify({ ...v2, warning_count: 3, result_json: { ...v2.result_json, generation_status: 'ai_draft', draft: true, draft_issue_count: 3 } }),
    classify({ ...v2, fallback_used: 1, result_json: { generation_status: 'legacy_fallback_success' } }),
    classify({ ...v2, status: 'failed' }), classify({ ...v2, status: 'running' }),
    classify({ ...v2, requested_version: null, run_id: null, result_json: {} }), classify({ ...v2, result_json: {} })];
  const s = summarize(rows);
  assert.equal(s.v2_finished, 6); assert.equal(s.v2_successful, 2); assert.equal(s.v2_success_rate, 1 / 3);
  assert.equal(s.counts.draft, 1);
  assert.equal(s.counts.legacy, 1); assert.equal(s.counts.unknown, 1); assert.equal(s.render_verified, 0);
  assert.equal(s.with_warnings, 1); assert.equal(s.repair_success_rate, 1);
  assert.equal(summarize([]).v2_success_rate, null);
  assert.equal(classify({ ...v2, result_json: { generation_mode: 'legacy' } }).outcome, 'fallback');
});
test('monitor validates inclusive date ranges, project and pagination without SQL interpolation', () => {
  const f = filters({ from: '2026-09-01', to: '2026-09-10', project: '21' });
  assert.equal(f.project, '21');
  for (const q of [{ from: '2026-02-30' }, { from: '2026-01-01', to: '2026-09-10' }, { project: '21 OR 1=1' }, { page: '-1' }, { outcome: 'invalid' }]) assert.throws(() => filters(q));
});
test('redaction preserves model token counts and dates while hiding nested secrets and URL parameters', () => {
  const source = { created: new Date('2026-09-10T00:00:00Z'), api_key: 'secret', accessToken: 'secret2', usage: { prompt_tokens: 42 },
    raw_response: JSON.stringify({ password: 'secret3', text: '图片 https://cdn.example/a.png?Signature=private#fragment', auth: 'Bearer abc.def' }) };
  const safe = redact(source), text = JSON.stringify(safe);
  assert.equal(safe.usage.prompt_tokens, 42); assert.equal(safe.created, '2026-09-10T00:00:00.000Z');
  assert.ok(!/secret|private|abc.def/.test(text)); assert.ok(text.includes('cdn.example/a.png'));
  assert.equal(source.api_key, 'secret');
});
test('summary counts each problem once per task, and compares versions independently of outcome filter', async () => {
  const rows = [{ ...v2, generator_version: { code: 'new' }, prompt_version: 'v2.3' },
    { ...v2, id: 'other', status: 'failed', generator_version: null, prompt_version: 'v2.2' }];
  const issue = { severity: 'error', code: 'text_overflow', slide_id: 's1' };
  const db = { async query(sql, params) {
    assert.deepEqual(params, ['2026-09-01', '2026-09-10']);
    if (sql.includes('r.result_json')) return [rows];
    return [[{ job_id: v2.id, issues: [issue, issue] }, { job_id: v2.id, issues: JSON.stringify([issue]) }, { job_id: 'other', issues: null, code: 'repair_failed' }]];
  } };
  const s = await createMonitor(db).summary({ from: '2026-09-01', to: '2026-09-10', outcome: 'direct' });
  assert.equal(s.total, 1); assert.equal(s.problems[0].jobs, 1); assert.equal(s.problems[0].pages, 1);
  assert.equal(s.versions.length, 2); assert.equal(s.versions[1].code_version, 'unrecorded');
});
test('monitor paginates filtered tasks and never silently truncates aggregate statistics', async () => {
  const q = { from: '2026-09-01', to: '2026-09-10', page: '2' };
  const monitor = createMonitor({ query: async () => [Array.from({ length: 23 }, (_, i) => ({ ...v2, id: String(i) }))] });
  const result = await monitor.jobs(q); assert.equal(result.total, 23); assert.equal(result.items.length, 3);
  await assert.rejects(createMonitor({ query: async () => [Array(10001).fill(v2)] }).summary(q), { status: 422 });
});
test('diagnosis preserves input, output and repair events, performs only SELECT and rejects oversized records', async () => {
  const db = { async query(sql, args) {
    assert.ok(sql.startsWith('SELECT')); assert.deepEqual(args, [v2.id]);
    if (sql.includes('AS bytes')) return [[{ bytes: 100 }]];
    if (sql.includes('settings_json')) return [[{ ...v2, settings_json: '{"_generation_version":2}', source_json: '{"api_key":"hidden"}', outline_json: '{"slides":[]}' }]];
    if (sql.includes('FROM project_presentation_runs')) return [[{ result_json: v2.result_json, state_json: { design: { slides: [] }, repaired_design: { slides: [] } } }]];
    return [[{ id: 1, created_at: v2.created_at, event_json: { event: 'repair_actions', actions: [{ before: 15, after: 14.4 }] } }]];
  } };
  const d = await createMonitor(db).diagnosis(v2.id);
  assert.equal(d.input.source.api_key, '[已隐藏]'); assert.equal(d.events[0].actions[0].after, 14.4);
  assert.equal(d.events[0].time, v2.created_at.toISOString());
  await assert.rejects(createMonitor({ query: async () => [[{ bytes: 13 * 1024 * 1024 }]] }).diagnosis(v2.id), { status: 413 });
  await assert.rejects(createMonitor(db).diagnosis('../etc/passwd'), { status: 400 });
});
test('all monitor routes use existing administrator authentication and return no-store responses', async t => {
  const fs = require('fs'), vm = require('vm'), jwt = require('jsonwebtoken'), express = require('express');
  const source = fs.readFileSync(require.resolve('../app'), 'utf8');
  assert.match(source, /app\.use\('\/api\/admin\/presentations', adminAuth,/);
  const authSource = source.slice(source.indexOf('function adminAuth('), source.indexOf("app.use('/api/admin/presentations'"));
  const auth = vm.runInNewContext(`(${authSource.trim()})`, { jwt, process: { env: { JWT_SECRET: 'test-only-key' } }, error: require('../utils/response').error });
  const app = express(); app.use('/api/admin/presentations', auth, require('../routes/admin-presentations.routes')({ query: async () => [[]] }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/admin/presentations`;
  for (const endpoint of ['/summary', '/jobs', `/jobs/${v2.id}/diagnosis`]) {
    assert.equal((await fetch(base + endpoint)).status, 401);
    assert.equal((await fetch(base + endpoint, { headers: { Authorization: `Bearer ${jwt.sign({ role: 'owner' }, 'test-only-key')}` } })).status, 403);
  }
  const r = await fetch(base + '/summary', { headers: { Authorization: `Bearer ${jwt.sign({ role: 'admin' }, 'test-only-key')}` } });
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal((await r.json()).data.total, 0);
});
