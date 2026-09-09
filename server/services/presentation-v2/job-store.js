'use strict';
const { failure } = require('./config');
async function ensureSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS project_presentation_runs (
    job_id CHAR(36) PRIMARY KEY, schema_version INT NOT NULL DEFAULT 2,
    model_requests INT NOT NULL DEFAULT 0, initial_used INT NOT NULL DEFAULT 0,
    model_repair_used INT NOT NULL DEFAULT 0, legacy_used INT NOT NULL DEFAULT 0,
    repair_used INT NOT NULL DEFAULT 0, fallback_used INT NOT NULL DEFAULT 0,
    state_json LONGTEXT NULL, result_json LONGTEXT NULL,
    started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), deadline_at DATETIME(3) NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS project_presentation_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, job_id CHAR(36) NOT NULL,
    event_json LONGTEXT NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY presentation_event_job (job_id, id)
  )`);
}
async function createContext({ db, job, token, limits, renderLegacy, assetDirectory, signal }) {
  await db.query(`INSERT IGNORE INTO project_presentation_runs (job_id, deadline_at) VALUES (?, DATE_ADD(NOW(3), INTERVAL ? MICROSECOND))`, [job.id, limits.taskTimeout * 1000]);
  const [[run]] = await db.query('SELECT *, TIMESTAMPDIFF(MICROSECOND, NOW(3), deadline_at) DIV 1000 AS remaining_ms FROM project_presentation_runs WHERE job_id = ?', [job.id]);
  const deadline = Date.now() + Number(run.remaining_ms);
  const ownership = `EXISTS (SELECT 1 FROM project_presentation_jobs j WHERE j.id = project_presentation_runs.job_id AND j.worker_token = ? AND j.status = 'running' AND j.lease_until > NOW())`;
  async function update(set, args, condition = '1=1') {
    signal?.throwIfAborted();
    const [result] = await db.query(`UPDATE project_presentation_runs SET ${set} WHERE job_id = ? AND deadline_at > NOW(3) AND ${condition} AND ${ownership}`, [...args, job.id, token]);
    if (!result.affectedRows) throw failure('task_budget_or_lease', '任务额度已使用、已超时或执行权已失效', true);
  }
  const record = async event => {
    const [result] = await db.query(`INSERT INTO project_presentation_events (job_id, event_json)
      SELECT ?, ? FROM project_presentation_jobs WHERE id = ? AND worker_token = ? AND status = 'running'`, [job.id, JSON.stringify(event), job.id, token]);
    if (!result.affectedRows) throw failure('lease_lost', '任务执行权已失效', true);
  };
  return {
    state: run.state_json ? JSON.parse(run.state_json) : {}, deadline, assetDirectory, renderLegacy,
    remaining: () => Math.max(0, deadline - Date.now()),
    checkpoint: () => update('updated_at = NOW()', []),
    save: state => update('state_json = ?', [JSON.stringify(state)]), record,
    async reserve(stage) {
      const column = { initial: 'initial_used', model_repair: 'model_repair_used', legacy: 'legacy_used' }[stage];
      if (!column) throw failure('request_stage', '未知模型调用阶段', true);
      const stageGuard = stage === 'model_repair' ? ' AND repair_used = 1 AND initial_used = 1' : stage === 'legacy' ? ' AND fallback_used = 1' : '';
      try { await update(`model_requests = model_requests + 1, ${column} = 1`, [], `model_requests < 3 AND ${column} = 0${stageGuard}`); }
      catch (error) {
        if (error.code !== 'task_budget_or_lease') throw Object.assign(error, { fatal: true });
        // A consumed initial/model repair call may safely transition to legacy;
        // a lost lease or deadline must never dispatch another request.
        await update('updated_at = NOW()', []);
        throw failure('request_already_consumed', `${stage} 调用额度已占用，禁止重复调用`);
      }
      await record({ event: 'model_request_reserved', stage });
    },
    async claimRepair(mode) {
      try { await update('repair_used = 1', [], 'repair_used = 0'); }
      catch (error) { if (error.code !== 'task_budget_or_lease') throw Object.assign(error, { fatal: true }); await update('updated_at = NOW()', []); throw failure('repair_already_consumed', '修正额度已使用'); }
      await record({ event: 'repair_reserved', mode });
    },
    async claimFallback(reason) {
      await update("fallback_used = 1, state_json = JSON_SET(COALESCE(state_json, JSON_OBJECT()), '$.fallback_started', CAST('true' AS JSON), '$.fallback_reason', CAST(? AS JSON))", [JSON.stringify(reason)], 'fallback_used = 0');
      await db.query("UPDATE project_presentation_jobs SET phase = 'fallback_processing' WHERE id = ? AND worker_token = ? AND status = 'running'", [job.id, token]);
      await record({ event: 'fallback_reserved', fallback_from: 'ai_design_v2', reason });
    },
    async fail(result) {
      await db.query(`UPDATE project_presentation_runs SET result_json = JSON_SET(CAST(? AS JSON), '$.generation_mode', IF(fallback_used = 1, 'legacy', 'ai_design_v2'), '$.fallback_used', fallback_used) WHERE job_id = ? AND ${ownership}`, [JSON.stringify(result), job.id, token]);
    },
    finish: result => update('result_json = ?, schema_version = ?', [JSON.stringify(result), result.schema_version || 2]),
  };
}
module.exports = { ensureSchema, createContext };
