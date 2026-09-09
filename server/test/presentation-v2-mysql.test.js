'use strict';
// Optional integration test starts its own temporary MySQL instance, without TCP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const execFile = require('util').promisify(require('child_process').execFile);
const mysql = require('mysql2/promise');
const { ensureSchema, createContext } = require('../services/presentation-v2/job-store');
const { limits } = require('../services/presentation-v2/config');
test('durable MySQL reservations survive recovery and serialize competing requests', { skip: process.env.PRESENTATION_MYSQL_TEST !== '1', timeout: 90000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zxwpptdb-'));
  const socket = path.join('/tmp', `zxwppt-${process.pid}.sock`);
  const binary = process.env.PRESENTATION_TEST_MYSQLD || '/opt/homebrew/bin/mysqld';
  await execFile(binary, ['--no-defaults', '--initialize-insecure', `--datadir=${dir}`], { timeout: 60000 });
  const server = spawn(binary, ['--no-defaults', `--datadir=${dir}`, `--socket=${socket}`, '--skip-networking', `--pid-file=${dir}/mysqld.pid`, `--log-error=${dir}/error.log`], { stdio: 'ignore' });
  let db;
  t.after(async () => {
    if (db) await db.end();
    if (server.exitCode === null) { const exited = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await exited; }
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) {
    try { db = mysql.createPool({ socketPath: socket, user: 'root', connectionLimit: 4 }); await db.query('SELECT 1'); break; }
    catch { await db.end(); db = null; await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(db, 'isolated MySQL should start');
  await db.query('CREATE DATABASE presentation_test'); await db.query('USE presentation_test');
  // Pools need a database on every connection for concurrent queries.
  await db.end(); db = mysql.createPool({ socketPath: socket, user: 'root', database: 'presentation_test', connectionLimit: 4 });
  await db.query(`CREATE TABLE project_presentation_jobs (id CHAR(36) PRIMARY KEY, project_id INT, user_id INT, title VARCHAR(200), settings_json LONGTEXT, source_json LONGTEXT, outline_json LONGTEXT, result_file VARCHAR(120), error_message VARCHAR(500), attempts INT DEFAULT 0, worker_token CHAR(36), status VARCHAR(16), phase VARCHAR(32), lease_until DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await ensureSchema(db);
  await db.query("INSERT INTO project_presentation_jobs (id, worker_token, status, phase, lease_until) VALUES ('j', 'owner', 'running', 'outline', DATE_ADD(NOW(), INTERVAL 5 MINUTE))");
  const args = { db, job: { id: 'j' }, token: 'owner', limits: limits(), signal: new AbortController().signal };
  const first = await createContext(args);
  const competition = await Promise.allSettled([first.reserve('initial'), first.reserve('initial')]);
  assert.equal(competition.filter(r => r.status === 'fulfilled').length, 1);
  await first.save({ design: { unchanged: true } });
  const recovered = await createContext(args);
  assert.deepEqual(recovered.state, { design: { unchanged: true } });
  await assert.rejects(recovered.reserve('initial'), /额度已占用/);
  await recovered.claimRepair('model'); await recovered.reserve('model_repair');
  await assert.rejects(recovered.claimRepair('server'), /修正额度已使用/);
  await recovered.claimFallback({ code: 'test' }); await recovered.reserve('legacy');
  const [[row]] = await db.query("SELECT * FROM project_presentation_runs WHERE job_id = 'j'");
  assert.equal(row.model_requests, 3); assert.equal(row.repair_used, 1); assert.equal(row.fallback_used, 1);
  const again = await createContext(args); await assert.rejects(again.reserve('legacy'));
  await db.query("UPDATE project_presentation_jobs SET worker_token = 'new-owner' WHERE id = 'j'");
  await assert.rejects(again.checkpoint(), /执行权已失效/);
  const current = await createContext({ ...args, token: 'new-owner' });
  await db.query("UPDATE project_presentation_runs SET deadline_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE job_id = 'j'");
  await assert.rejects(current.checkpoint(), /已超时/);
  await current.fail({ generation_status: 'failed' });
  const [[failed]] = await db.query("SELECT result_json FROM project_presentation_runs WHERE job_id = 'j'");
  assert.equal(JSON.parse(failed.result_json).generation_status, 'failed');
  await db.query('CREATE TABLE renovation_projects (id INT PRIMARY KEY, user_id INT, lifecycle_status VARCHAR(32))');
  await db.query('CREATE TABLE project_members (id INT, project_id INT, user_id INT, role VARCHAR(32), status INT)');
  await db.query("INSERT INTO renovation_projects VALUES (1, 7, 'active')");
  const dbPath = require.resolve('../config/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  const jobs = require('../services/presentation-jobs');
  const pipeline = require('../services/presentation-v2/pipeline');
  const source = { project: { id: 1 }, spaces: [], whole_house_documents: [] };
  const settings = { spaces: [], sections: { whole_house_plan: true, space_solutions: true, product_summary: true } };
  const design = { schema_version: 2, presentation: { title: '测试' }, slides: [{ id: 's', elements: [] }] };
  const legacy = { loadPresentationSource: async () => structuredClone(source), normalizeSettings: () => structuredClone(settings), sourceForModel: () => ({ spaces: [] }),
    generateOutline: async (src, options, hooks) => { assert.deepEqual(src, source); await hooks.beforeRequest(); return { outline: { schema_version: 1, slides: [] } }; },
    buildRenderPlan: (src, options, outline) => ({ source: src, outline }),
  };
  for (const useFallback of [false, true]) {
    const id = useFallback ? 'fallback-job' : 'success-job';
    await db.query("INSERT INTO project_presentation_jobs (id, project_id, user_id, title, settings_json, status, phase) VALUES (?, 1, 7, '报告', ?, 'queued', 'queued')", [id, JSON.stringify({ ...settings, _generation_version: 2 })]);
    await jobs.runNext({ db, locked: true, directory: dir, presentation: legacy, render: async (plan, file) => fs.writeFile(file, 'legacy'),
      pipeline: args => pipeline.run({ ...args, adapters: { preflight: async () => ({}), prepare: async () => [],
        request: async ({ reserve }) => { await reserve('initial'); return structuredClone(design); },
        validate: async () => ({ issues: useFallback ? [{ severity: 'error', code: 'schema' }] : [] }),
        render: async (d, m, file) => fs.writeFile(file, 'pptx'), renderedValidation: async () => ({ issues: [] }),
      } }),
    });
    const [[completed]] = await db.query('SELECT * FROM project_presentation_jobs WHERE id = ?', [id]);
    assert.equal(completed.status, 'completed', completed.error_message);
    const [[generation]] = await db.query('SELECT * FROM project_presentation_runs WHERE job_id = ?', [id]);
    assert.equal(generation.model_requests, useFallback ? 2 : 1);
    assert.equal(JSON.parse(generation.result_json).generation_status, useFallback ? 'legacy_fallback_success' : 'ai_success');
    assert.ok(await fs.readFile(path.join(dir, completed.result_file)));
  }

});
