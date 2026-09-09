'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../config/db');
const presentation = require('./project-presentation.service');
const { generateFromPlan, safeFileName } = require('../scripts/generate-ppt-from-plan');

// Outside the deployed app directory and its public /storage mount. Stable
// across release swaps; files are served only by the authorized download route.
const resultsDirectory = path.resolve(process.env.PRESENTATION_RESULTS_DIR || path.join(__dirname, '../../private-presentation-results'));
let schemaPromise;
function ensureSchema() {
  if (!schemaPromise) schemaPromise = db.query(`CREATE TABLE IF NOT EXISTS project_presentation_jobs (
    id CHAR(36) PRIMARY KEY, project_id INT NOT NULL, user_id INT NOT NULL,
    request_key CHAR(36) NOT NULL, title VARCHAR(200) NOT NULL,
    settings_json LONGTEXT NOT NULL, source_json LONGTEXT NULL, outline_json LONGTEXT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued', phase VARCHAR(24) NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0, worker_token CHAR(36) NULL, lease_until DATETIME NULL,
    result_file VARCHAR(120) NULL, error_message VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY presentation_request (project_id, user_id, request_key),
    KEY presentation_project (project_id, created_at), KEY presentation_queue (status, lease_until)
  )`).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function parse(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function publicJob(row) {
  return { id: row.id, title: row.title, status: row.status, phase: row.phase,
    created_at: row.created_at, updated_at: row.updated_at, error: row.error_message,
    outline: row.outline_json ? parse(row.outline_json) : null,
    filename: `${safeFileName(row.title)}.pptx` };
}
async function list(projectId) {
  await ensureSchema();
  const [rows] = await db.query('SELECT * FROM project_presentation_jobs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [projectId]);
  return rows.map(publicJob);
}
async function find(projectId, id) {
  await ensureSchema();
  const [rows] = await db.query('SELECT * FROM project_presentation_jobs WHERE project_id = ? AND id = ?', [projectId, id]);
  return rows[0];
}
async function submit(projectId, userId, settings, requestKey) {
  await ensureSchema();
  if (!/^[0-9a-f-]{36}$/i.test(requestKey || '')) throw new Error('任务标识不正确，请重新提交');
  const id = randomUUID();
  const title = String(settings.title || '设计方案汇报').trim().slice(0, 200);
  await db.query(`INSERT INTO project_presentation_jobs (id, project_id, user_id, request_key, title, settings_json)
    VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`, [id, projectId, userId, requestKey, title, JSON.stringify(settings)]);
  const [rows] = await db.query('SELECT * FROM project_presentation_jobs WHERE project_id = ? AND user_id = ? AND request_key = ?', [projectId, userId, requestKey]);
  return publicJob(rows[0]);
}
async function retry(projectId, id) {
  await ensureSchema();
  await db.query(`UPDATE project_presentation_jobs SET status = 'queued', phase = 'queued', attempts = 0,
    error_message = NULL, worker_token = NULL, lease_until = NULL WHERE project_id = ? AND id = ? AND status = 'failed'`, [projectId, id]);
  return find(projectId, id);
}

// A database lease prevents deployment smoke processes / multiple instances
// from claiming the same job. Expired leases are recovered after a restart.
async function runNext(deps = {}) {
  const database = deps.db || db;
  const model = deps.presentation || presentation;
  const render = deps.render || generateFromPlan;
  const directory = deps.directory || resultsDirectory;
  const token = randomUUID();
  const [claimed] = await database.query(`UPDATE project_presentation_jobs SET status = 'running', phase = 'preparing',
    worker_token = ?, lease_until = DATE_ADD(NOW(), INTERVAL 3 MINUTE), attempts = attempts + 1
    WHERE status = 'queued' OR (status = 'running' AND lease_until < NOW()) ORDER BY created_at LIMIT 1`, [token]);
  if (!claimed.affectedRows) return false;
  const [rows] = await database.query('SELECT * FROM project_presentation_jobs WHERE worker_token = ?', [token]);
  const job = rows[0];
  if (!job) return false;
  const ownedUpdate = (sql, values = []) => database.query(`UPDATE project_presentation_jobs SET ${sql} WHERE id = ? AND worker_token = ? AND status = 'running'`, [...values, job.id, token]);
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    ownedUpdate('lease_until = DATE_ADD(NOW(), INTERVAL 3 MINUTE)').then(([r]) => { if (!r.affectedRows) leaseLost = true; }).catch(() => { leaseLost = true; });
  }, 20000);
  heartbeat.unref();
  let output;
  try {
    if (job.attempts > 3) throw new Error('服务重启导致任务多次中断，请重试');
    const settings = parse(job.settings_json);
    const source = job.source_json ? parse(job.source_json) : await model.loadPresentationSource(job.project_id, { baseUrl: settings._asset_base_url });
    await ownedUpdate("source_json = ?, phase = 'outline'", [JSON.stringify(source)]);
    const outline = job.outline_json ? parse(job.outline_json) : (await model.generateOutline(source, settings, {
      timeoutMs: Number(process.env.PRESENTATION_JOB_MODEL_TIMEOUT_MS || 300000),
    })).outline;
    if (leaseLost) return true;
    await ownedUpdate("outline_json = ?, phase = 'rendering'", [JSON.stringify(outline)]);
    const plan = model.buildRenderPlan(source, settings, outline);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${job.id}-${token}.pptx`;
    output = path.join(directory, filename);
    await render(plan, output);
    if (leaseLost) { await fs.rm(output, { force: true }); return true; }
    const [saved] = await ownedUpdate("status = 'completed', phase = 'completed', result_file = ?, error_message = NULL, lease_until = NULL", [filename]);
    if (!saved.affectedRows) await fs.rm(output, { force: true });
  } catch (error) {
    if (output) await fs.rm(output, { force: true }).catch(() => {});
    const message = error.name === 'AbortError' ? '模型生成超时，请稍后重试' : String(error.message || '生成失败').slice(0, 500);
    await ownedUpdate("status = 'failed', phase = 'failed', error_message = ?, lease_until = NULL", [message]);
  } finally { clearInterval(heartbeat); }
  return true;
}
let started = false;
function start() {
  if (started || process.env.FEATURE_PROJECT_PRESENTATIONS === 'false') return;
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await ensureSchema(); await runNext(); }
    catch (error) { console.error('Presentation worker:', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 3000); timer.unref();
  void tick();
}
module.exports = { list, find, submit, retry, publicJob, runNext, start, resultsDirectory };
