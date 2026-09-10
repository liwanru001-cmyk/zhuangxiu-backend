'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../config/db');
const v2Store = require('./presentation-v2/job-store');
const v2Pipeline = require('./presentation-v2/pipeline');
const v2Limits = require('./presentation-v2/config').limits;
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
  const generation = row.generation_result ? parse(row.generation_result) : {};
  const isDraft = generation.generation_status === 'ai_draft' || generation.draft === true;
  return { id: row.id, title: row.title, status: row.status, phase: row.phase,
    generation_mode: generation.generation_mode, generation_status: generation.generation_status,
    render_validation: generation.render_validation,
    render_validation_reason: generation.render_validation_reason,
    schema_version: generation.schema_version || (row.outline_json ? parse(row.outline_json).schema_version : 1) || 1,
    fallback_used: generation.fallback_used || Boolean(row.fallback_used),
    is_draft: isDraft,
    draft_issue_count: isDraft ? Number(generation.draft_issue_count || 0) : 0,
    notice: row.status === 'completed' && isDraft
      ? `V2 草稿已生成，可下载查看；仍有 ${Number(generation.draft_issue_count || 0)} 项校验或修复问题，详情已保留在生成监控。`
      : row.status === 'completed' && (generation.fallback_used || row.fallback_used) ? '本次已使用兼容模式完成生成。' : null,
    created_at: row.created_at, updated_at: row.updated_at, error: row.error_message,
    outline: row.outline_json ? parse(row.outline_json) : null,
    filename: `${safeFileName(row.title)}.pptx` };
}
async function list(projectId) {
  await ensureSchema();
  await v2Store.ensureSchema(db);
  const [rows] = await db.query('SELECT j.*, r.result_json AS generation_result, r.fallback_used FROM project_presentation_jobs j LEFT JOIN project_presentation_runs r ON r.job_id = j.id WHERE j.project_id = ? ORDER BY j.created_at DESC, j.id DESC LIMIT 100', [projectId]);
  return rows.map(publicJob);
}
async function find(projectId, id) {
  await ensureSchema();
  await v2Store.ensureSchema(db);
  const [rows] = await db.query('SELECT j.*, r.result_json AS generation_result, r.fallback_used FROM project_presentation_jobs j LEFT JOIN project_presentation_runs r ON r.job_id = j.id WHERE j.project_id = ? AND j.id = ?', [projectId, id]);
  return rows[0];
}
async function submit(projectId, userId, settings, requestKey) {
  await ensureSchema();
  if (!db.getConnection) return submitOn(db, projectId, userId, settings, requestKey);
  const connection = await db.getConnection();
  let acquired = false;
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('zxw_presentation_admission', 5) AS acquired");
    acquired = Number(lock.acquired) === 1;
    if (!acquired) throw Object.assign(new Error('生成队列繁忙，请稍后再试'), { status: 429 });
    return await submitOn(connection, projectId, userId, settings, requestKey);
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK('zxw_presentation_admission')").catch(() => {});
    connection.release();
  }
}
async function submitOn(database, projectId, userId, settings, requestKey) {
  await ensureSchema();
  if (!/^[0-9a-f-]{36}$/i.test(requestKey || '')) throw new Error('任务标识不正确，请重新提交');
  const [existing] = await database.query('SELECT * FROM project_presentation_jobs WHERE project_id = ? AND user_id = ? AND request_key = ?', [projectId, userId, requestKey]);
  if (existing[0]) return publicJob(existing[0]);
  const [[queued]] = await database.query("SELECT COUNT(*) AS total FROM project_presentation_jobs WHERE status IN ('queued', 'running')");
  if (Number(queued.total) >= v2Limits().maxQueue) throw Object.assign(new Error('生成队列已满，请稍后再试'), { status: 429 });
  const id = randomUUID();
  settings = { ...settings, _generation_version: 2 };
  const title = String(settings.title || '设计方案汇报').trim().slice(0, 200);
  await database.query(`INSERT INTO project_presentation_jobs (id, project_id, user_id, request_key, title, settings_json)
    VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`, [id, projectId, userId, requestKey, title, JSON.stringify(settings)]);
  const [rows] = await database.query('SELECT * FROM project_presentation_jobs WHERE project_id = ? AND user_id = ? AND request_key = ?', [projectId, userId, requestKey]);
  return publicJob(rows[0]);
}
async function retry(projectId, userId, id, { assetBaseUrl } = {}) {
  await ensureSchema();
  const [rows] = await db.query(`SELECT title, settings_json FROM project_presentation_jobs
    WHERE project_id = ? AND id = ? AND status = 'failed' LIMIT 1`, [projectId, id]);
  const failed = rows[0];
  if (!failed) return null;
  const settings = { ...parse(failed.settings_json), title: failed.title, project_id: projectId };
  if (assetBaseUrl) settings._asset_base_url = assetBaseUrl;
  // A V2 run owns a fixed deadline and one-shot model budgets. Re-queuing the
  // same row would reuse that exhausted run, so retry as a fresh monitored job.
  return submit(projectId, userId, settings, randomUUID());
}

// A database lease prevents deployment smoke processes / multiple instances
// from claiming the same job. Expired leases are recovered after a restart.
async function runNext(deps = {}) {
  const pool = deps.db || db;
  if (!pool.getConnection || deps.locked) return runClaimed(deps);
  const connection = await pool.getConnection();
  let acquired = false;
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('zxw_presentation_worker', 0) AS acquired");
    acquired = Number(lock.acquired) === 1;
    if (!acquired) return false;
    return await runClaimed({ ...deps, db: connection, locked: true });
  } finally {
    if (acquired) await connection.query("SELECT RELEASE_LOCK('zxw_presentation_worker')").catch(() => {});
    connection.release();
  }
}
async function runClaimed(deps = {}) {
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
  const abort = new AbortController();
  let context;
  let deadlineTimer;
  const heartbeat = setInterval(() => {
    ownedUpdate('lease_until = DATE_ADD(NOW(), INTERVAL 3 MINUTE)').then(([r]) => { if (!r.affectedRows) { leaseLost = true; abort.abort(); } }).catch(() => { leaseLost = true; abort.abort(); });
  }, 20000);
  heartbeat.unref();
  let output;
  try {
    if (job.attempts > 3) throw new Error('任务多次中断，恢复次数已用完，请创建新任务');
    const settings = parse(job.settings_json);
    if (settings._generation_version === 2) {
      const [access] = await database.query(`SELECT p.id FROM renovation_projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
        WHERE p.id = ? AND COALESCE(p.lifecycle_status, 'active') <> 'deleted' AND (p.user_id = ? OR pm.role IN ('owner', 'designer')) LIMIT 1`, [job.user_id, job.project_id, job.user_id]);
      if (!access.length) throw new Error('项目不存在或已无生成权限');
    }
    const source = job.source_json ? parse(job.source_json) : await model.loadPresentationSource(job.project_id, { baseUrl: settings._asset_base_url });
    await ownedUpdate("source_json = ?, phase = 'outline'", [JSON.stringify(source)]);
    const filename = `${job.id}-${token}.pptx`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    output = path.join(directory, filename);
    if (settings._generation_version === 2) {
      await v2Store.ensureSchema(database);
      const limits = v2Limits();
      context = await v2Store.createContext({ db: database, job, token, limits, renderLegacy: deps.render || ((plan, file, options) => require('./presentation-v2/render-process').renderProcess('legacy', { plan, manifest: options.manifest, maxSlides: options.maxSlides }, file, options)), signal: abort.signal, assetDirectory: path.join(directory, 'assets', `project-${job.project_id}`) });
      if (context.remaining() <= 0) throw new Error('任务已超出总时限，请创建新任务');
      deadlineTimer = setTimeout(() => abort.abort(), context.remaining());
      const result = await (deps.pipeline || v2Pipeline.run)({ source, rawSettings: settings, legacy: model, context, output, limits, signal: abort.signal });
      abort.signal.throwIfAborted();
      await fs.access(output);
      await context.finish(result);
      const [saved] = await ownedUpdate("status = 'completed', phase = 'completed', outline_json = ?, result_file = ?, error_message = NULL, lease_until = NULL", [JSON.stringify(result.outline), filename]);
      if (!saved.affectedRows) await fs.rm(output, { force: true });
      return true;
    }
    const outline = job.outline_json ? parse(job.outline_json) : (await model.generateOutline(source, settings, {
      timeoutMs: Number(process.env.PRESENTATION_JOB_MODEL_TIMEOUT_MS || 300000),
    })).outline;
    if (leaseLost) return true;
    await ownedUpdate("outline_json = ?, phase = 'rendering'", [JSON.stringify(outline)]);
    const plan = model.buildRenderPlan(source, settings, outline);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await render(plan, output);
    if (leaseLost) { await fs.rm(output, { force: true }); return true; }
    const [saved] = await ownedUpdate("status = 'completed', phase = 'completed', result_file = ?, error_message = NULL, lease_until = NULL", [filename]);
    if (!saved.affectedRows) await fs.rm(output, { force: true });
  } catch (error) {
    if (context) {
      await context.record({ event: 'task_failed', code: error.code, message: error.message }).catch(() => {});
      await context.fail({ generation_status: 'failed', schema_version: 2, error: error.code || error.message }).catch(() => {});
    }
    if (output) await fs.rm(output, { force: true }).catch(() => {});
    let message = error.name === 'AbortError' ? '模型生成超时，请稍后重试' : String(error.message || '生成失败').slice(0, 500);
    if (context) {
      const messages = { repair_failed: 'V2 排版校验未通过，本次未生成 PPT，也未退回 V1。请提供任务 ID 排查。', design_invalid: 'V2 返回的设计结构未通过校验，本次未退回 V1。请提供任务 ID 排查。', repair_content_changed: 'V2 排版修正改变了文案，已停止生成，本次未退回 V1。请提供任务 ID 排查。', asset_unavailable: '项目素材无法读取，请检查文件后重新生成。', asset_mapping_error: '项目素材关联异常，请联系管理员检查。', asset_task_budget: '所选图片总量过大，请减少素材后重新生成。', font_environment: '生成环境的字体尚未配置完成，请联系管理员。', font_render_environment: '生成环境的中文字体不可用，请联系管理员。', render_environment: '生成环境尚未准备完成，请联系管理员。' };
      message = messages[error.code] || (abort.signal.aborted ? '生成超出任务时限，请减少内容后新建任务。' : '本次生成未完成，请新建任务重试；若持续失败，请联系管理员。');
    }
    await ownedUpdate("status = 'failed', phase = 'failed', error_message = ?, lease_until = NULL", [message]);
  } finally { clearInterval(heartbeat); clearTimeout(deadlineTimer); }
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
