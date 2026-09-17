'use strict';
const { randomUUID } = require('crypto');
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
  const persistedState = run.state_json ? JSON.parse(run.state_json) : {};
  const loadedAttempts = structuredClone(persistedState.model_attempts || {});
  const pipelineState = structuredClone(persistedState);
  delete pipelineState.model_attempts;
  const deadline = Date.now() + Number(run.remaining_ms);
  const ownership = `EXISTS (SELECT 1 FROM project_presentation_jobs j WHERE j.id = project_presentation_runs.job_id AND j.worker_token = ? AND j.status = 'running' AND j.lease_until > NOW())`;
  async function update(set, args, condition = '1=1') {
    signal?.throwIfAborted();
    const [result] = await db.query(`UPDATE project_presentation_runs SET ${set} WHERE job_id = ? AND deadline_at > NOW(3) AND ${condition} AND ${ownership}`, [...args, job.id, token]);
    if (!result.affectedRows) throw failure('task_budget_or_lease', '任务额度已使用、已超时或执行权已失效', true);
  }
  const record = async event => {
    const [result] = await db.query(`INSERT INTO project_presentation_events (job_id, event_json)
      SELECT ?, ? FROM project_presentation_jobs WHERE id = ? AND worker_token = ? AND status = 'running' AND lease_until > NOW()`, [job.id, JSON.stringify(event), job.id, token]);
    if (!result.affectedRows) throw failure('lease_lost', '任务执行权已失效', true);
  };
  const attemptPath = stage => {
    if (!['initial', 'model_repair', 'legacy'].includes(stage)) throw failure('request_stage', '未知模型调用阶段', true);
    return `$.model_attempts.${stage}`;
  };
  async function inspectModelAttempt(stage) {
    attemptPath(stage);
    const [[latest]] = await db.query('SELECT state_json FROM project_presentation_runs WHERE job_id = ?', [job.id]);
    const state = latest?.state_json ? JSON.parse(latest.state_json) : {};
    return state.model_attempts?.[stage] || null;
  }
  async function writeModelAttempt(stage, attempt, condition = '1=1') {
    await update(`state_json = JSON_SET(
      JSON_SET(COALESCE(state_json, JSON_OBJECT()), '$.model_attempts', COALESCE(JSON_EXTRACT(state_json, '$.model_attempts'), JSON_OBJECT())),
      ?, CAST(? AS JSON))`,
      [attemptPath(stage), JSON.stringify(attempt)], condition);
  }
  async function transitionModelAttempt(stage, attemptId, allowed, patch) {
    const current = await inspectModelAttempt(stage);
    if (!current || current.attempt_id !== attemptId || !allowed.includes(current.status)) {
      throw failure('model_attempt_state', `${stage} 模型调用状态不可继续`, true);
    }
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    await writeModelAttempt(stage, next);
    return next;
  }
  return {
    state: pipelineState, deadline, assetDirectory, renderLegacy,
    remaining: () => Math.max(0, deadline - Date.now()),
    checkpoint: () => update('updated_at = NOW()', []),
    save: state => {
      const patch = structuredClone(state);
      delete patch.model_attempts;
      return update('state_json = JSON_MERGE_PATCH(COALESCE(state_json, JSON_OBJECT()), CAST(? AS JSON))', [JSON.stringify(patch)]);
    },
    record,
    inspectModelAttempt,
    async reserve(stage) {
      const column = { initial: 'initial_used', model_repair: 'model_repair_used', legacy: 'legacy_used' }[stage];
      if (!column) throw failure('request_stage', '未知模型调用阶段', true);
      const loaded = loadedAttempts[stage];
      if (loaded?.status === 'reserved') {
        await record({ event: 'model_request_reservation_resumed', stage, attempt_id: loaded.attempt_id });
        return loaded;
      }
      const stageGuard = stage === 'model_repair' ? ' AND repair_used = 1 AND initial_used = 1' : stage === 'legacy' ? ' AND fallback_used = 1' : '';
      const attempt = { attempt_id: randomUUID(), stage, status: 'reserved', reserved_at: new Date().toISOString() };
      try {
        await update(`model_requests = model_requests + 1, ${column} = 1, state_json = JSON_SET(
          JSON_SET(COALESCE(state_json, JSON_OBJECT()), '$.model_attempts', COALESCE(JSON_EXTRACT(state_json, '$.model_attempts'), JSON_OBJECT())),
          ?, CAST(? AS JSON))`,
          [attemptPath(stage), JSON.stringify(attempt)], `model_requests < 3 AND ${column} = 0${stageGuard}`);
      }
      catch (error) {
        if (error.code !== 'task_budget_or_lease') throw Object.assign(error, { fatal: true });
        // Verify ownership/deadline separately before classifying a zero-row
        // reservation as an already-used stage.
        await update('updated_at = NOW()', []);
        const existing = await inspectModelAttempt(stage);
        if (existing?.status === 'dispatched') {
          throw failure('model_outcome_unknown_after_restart', `${stage} 模型请求在进程中断前已发出，但响应未持久化；为避免重复调用，禁止自动重试`);
        }
        if (existing?.status === 'response_received') {
          throw failure('model_response_pending_recovery', `${stage} 模型响应已保存，等待恢复处理`);
        }
        if (existing?.status === 'failed') {
          throw failure(existing.error_code || 'model_request', existing.error_message || `${stage} 模型请求已失败`);
        }
        throw failure('request_already_consumed', `${stage} 调用额度已占用，禁止重复调用`);
      }
      await record({ event: 'model_request_reserved', stage, attempt_id: attempt.attempt_id });
      return attempt;
    },
    markModelDispatched: (stage, attemptId, metadata = {}) => transitionModelAttempt(stage, attemptId, ['reserved'], {
      status: 'dispatched', dispatched_at: new Date().toISOString(), ...metadata,
    }),
    persistModelResponse: (stage, attemptId, response) => transitionModelAttempt(stage, attemptId, ['dispatched'], {
      status: 'response_received', response_received_at: new Date().toISOString(), response,
    }),
    failModelAttempt: (stage, attemptId, error) => transitionModelAttempt(stage, attemptId, ['reserved', 'dispatched', 'response_received'], {
      status: 'failed', failed_at: new Date().toISOString(), error_code: error.code || 'model_request', error_message: error.message,
    }),
    commitModelAttempt: async stage => {
      const current = await inspectModelAttempt(stage);
      if (!current || current.status === 'committed') return current;
      if (current.status !== 'response_received') return current;
      return transitionModelAttempt(stage, current.attempt_id, ['response_received'], { status: 'committed', committed_at: new Date().toISOString() });
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
