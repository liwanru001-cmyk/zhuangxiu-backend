'use strict';

const crypto = require('crypto');
const { isIP } = require('net');
const { isBlockedAddress } = require('./product-ingestion-runtime-safety');
const { NETWORK_ACTIONS, validateRecoveryStrategy } = require('./product-ingestion-recovery-schema');
const { assessPlanReadiness, normalizeOutput } = require('./product-ingestion-recovery-contracts');
const { nextAction } = require('./product-ingestion-recovery-state');

const EVIDENCE_PACK_VERSION = 'recovery-evidence-pack-v1.0';
const PLAN_VERSION = 'safe-recovery-plan-v1.0';
const DEFAULT_LIMITS = Object.freeze({
  max_actions: 12,
  max_network_requests: 4,
  max_browser_actions: 5,
  max_response_bytes: 5 * 1024 * 1024,
  max_duration_ms: 30_000,
});
const UNSAFE_PATTERN = /(?:curl\s+-k\b|--insecure\b|rejectUnauthorized\s*[:=]\s*false|NODE_TLS_REJECT_UNAUTHORIZED|ignoreHTTPSErrors\s*[:=]\s*true|bypass\s+(?:login|captcha|waf|robots))/iu;

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function recoveryError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function cloneSafe(value, depth = 0, maxStringLength = 20_000) {
  if (depth > 8) return '[truncated-depth]';
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value === 'string') return value.slice(0, maxStringLength);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => cloneSafe(item, depth + 1, maxStringLength));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      result[String(key).slice(0, 160)] = cloneSafe(item, depth + 1, maxStringLength);
    }
    return result;
  }
  return String(value).slice(0, 1000);
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function normalizeScope(scope = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(scope.budget_limits || {}) };
  for (const [key, ceiling] of Object.entries(DEFAULT_LIMITS)) {
    const value = Number(limits[key]);
    if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) {
      throw recoveryError('RECOVERY_SCOPE_INVALID', `授权预算 ${key} 不合法`);
    }
  }
  return {
    allowed_hosts: [...new Set((scope.allowed_hosts || []).map(normalizeHost).filter(Boolean))],
    allowed_path_prefixes: [...new Set((scope.allowed_path_prefixes || ['/']).map(String))],
    read_only_post_endpoints: [...new Set((scope.read_only_post_endpoints || []).map(String))],
    read_only_post_commands: [...new Set((scope.read_only_post_commands || []).map(String))],
    allow_http: scope.allow_http === true,
    budget_limits: limits,
  };
}

function buildRecoveryEvidencePack(input = {}) {
  if (!input.failure?.type || !input.source?.url) {
    throw recoveryError('RECOVERY_EVIDENCE_INVALID', '恢复证据包缺少 failure.type 或 source.url');
  }
  const authorizedScope = normalizeScope(input.authorized_scope);
  if (!authorizedScope.allowed_hosts.length) {
    throw recoveryError('RECOVERY_EVIDENCE_INVALID', '恢复证据包缺少授权域名');
  }
  const sourceUrl = new URL(input.source.url).toString();
  if (!authorizedScope.allowed_hosts.includes(normalizeHost(new URL(sourceUrl).hostname))) {
    throw recoveryError('RECOVERY_EVIDENCE_INVALID', '证据包源 URL 不在授权域名内');
  }
  const evidence = (input.evidence || []).map((item, index) => {
    const evidenceId = String(item.evidence_id || `E${String(index + 1).padStart(3, '0')}`);
    return {
      evidence_id: evidenceId,
      kind: String(item.kind || 'observation').slice(0, 100),
      source_url: item.source_url ? String(item.source_url).slice(0, 1000) : sourceUrl,
      locator: String(item.locator || '').slice(0, 1000),
      observed: cloneSafe(item.observed, 0, item.kind === 'html_snapshot' ? 131_072 : 20_000),
      content_sha256: item.content_sha256 || digest(cloneSafe(item.observed, 0, item.kind === 'html_snapshot' ? 131_072 : 20_000)),
    };
  });
  if (!evidence.length || new Set(evidence.map((item) => item.evidence_id)).size !== evidence.length) {
    throw recoveryError('RECOVERY_EVIDENCE_INVALID', '恢复证据必须存在且 evidence_id 唯一');
  }
  const pack = {
    schema_version: EVIDENCE_PACK_VERSION,
    evidence_pack_id: input.evidence_pack_id || `REP-${digest({ sourceUrl, failure: input.failure, evidence }).slice(0, 20)}`,
    created_at: input.created_at || new Date().toISOString(),
    attempt_no: Math.max(1, Math.min(3, Number(input.attempt_no || 1))),
    parent_evidence_pack_id: input.parent_evidence_pack_id || null,
    failure: cloneSafe(input.failure),
    source: { ...cloneSafe(input.source), url: sourceUrl },
    initial_result: cloneSafe(input.initial_result || {}),
    evidence,
    authorized_scope: authorizedScope,
  };
  pack.content_sha256 = digest(pack);
  return pack;
}

function pathAllowed(pathname, prefixes) {
  return prefixes.some((prefix) => prefix === '/' || pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

function normalizeEndpoint(value) {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
}

function assertTargetAllowed(action, authorizedScope) {
  let target;
  try { target = new URL(action.target_url); }
  catch (_) { throw recoveryError('RECOVERY_TARGET_INVALID', `动作 ${action.action_id} 缺少有效 target_url`); }
  target.hash = '';
  if (target.username || target.password || target.port || !['https:', 'http:'].includes(target.protocol)) {
    throw recoveryError('RECOVERY_TARGET_DENIED', `动作 ${action.action_id} 的 URL 协议、账号或端口不允许`);
  }
  if (target.protocol === 'http:' && !authorizedScope.allow_http) {
    throw recoveryError('RECOVERY_HTTP_DENIED', `动作 ${action.action_id} 不允许降级为 HTTP`);
  }
  const host = normalizeHost(target.hostname);
  if (!authorizedScope.allowed_hosts.includes(host)) {
    throw recoveryError('RECOVERY_DOMAIN_DENIED', `动作 ${action.action_id} 的域名 ${host} 不在授权范围`);
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw recoveryError('RECOVERY_SSRF_BLOCKED', `动作 ${action.action_id} 指向内网、环回或保留地址`);
  }
  if (!pathAllowed(target.pathname, authorizedScope.allowed_path_prefixes)) {
    throw recoveryError('RECOVERY_PATH_DENIED', `动作 ${action.action_id} 的路径 ${target.pathname} 不在授权范围`);
  }
  return target.toString();
}

function assertBudget(strategyBudget, authorizedLimits, counts) {
  for (const [key, ceiling] of Object.entries(authorizedLimits)) {
    if (strategyBudget[key] > ceiling) throw recoveryError('RECOVERY_BUDGET_DENIED', `AI 策略预算 ${key}=${strategyBudget[key]} 超过授权上限 ${ceiling}`);
  }
  if (counts.actions > strategyBudget.max_actions || counts.network > strategyBudget.max_network_requests || counts.browser > strategyBudget.max_browser_actions) {
    throw recoveryError('RECOVERY_BUDGET_INCONSISTENT', 'AI 策略的实际动作数超过其自报预算', counts);
  }
}

function parameterValues(parameters = {}) {
  return Object.entries(parameters).filter(([key]) => key !== 'cmd').flatMap(([, value]) => {
    if (value == null || typeof value === 'object') return [JSON.stringify(value)];
    return [String(value)];
  });
}

function assertActionCompatible(failureType,action){
  const failure=String(failureType||'').toUpperCase(),certificateAction=['TLS_VERIFY_REQUIRED','RECORD_CERTIFICATE_ERROR','QUEUE_HUMAN_TRUST_CHAIN_REVIEW'].includes(action.type);
  if(certificateAction&&!/(?:TLS|CERTIFICATE|CERT_)/.test(failure))throw recoveryError('RECOVERY_ACTION_MISMATCH',`动作 ${action.action_id} 与失败类型 ${failureType} 不匹配：没有证书证据时不能提出证书处置`);
  if(action.type==='POST_SAME_ORIGIN_PUBLIC_API'&&!/(?:API|DYNAMIC|DISCOVER|EXTRACT|FIELD|PAGE)/.test(failure))throw recoveryError('RECOVERY_ACTION_MISMATCH',`动作 ${action.action_id} 与失败类型 ${failureType} 不匹配：没有接口线索时不能提出 POST`);
}

function planRecovery(evidencePack, rawStrategy) {
  if (evidencePack?.schema_version !== EVIDENCE_PACK_VERSION || !Number.isInteger(evidencePack.attempt_no) || evidencePack.attempt_no < 1 || evidencePack.attempt_no > 3) {
    throw recoveryError('RECOVERY_EVIDENCE_INVALID', '恢复证据包版本或尝试次数不合法');
  }
  const strategy = validateRecoveryStrategy(cloneSafe(rawStrategy));
  if (UNSAFE_PATTERN.test(JSON.stringify(strategy))) {
    throw recoveryError('RECOVERY_UNSAFE_INSTRUCTION', 'AI 策略包含 TLS/鉴权/robots 绕过或任意执行线索');
  }
  const evidenceIds = new Set(evidencePack.evidence.map((item) => item.evidence_id));
  const referenced = [...strategy.diagnosis.evidence_refs, ...strategy.actions.flatMap((item) => item.evidence_refs)];
  const unknownRefs = [...new Set(referenced.filter((item) => !evidenceIds.has(item)))];
  if (unknownRefs.length) throw recoveryError('RECOVERY_EVIDENCE_REFERENCE_INVALID', `AI 策略引用了不存在的证据：${unknownRefs.join(', ')}`);
  const authorizedScope = evidencePack.authorized_scope;
  for (const host of strategy.scope.allowed_hosts.map(normalizeHost)) {
    if (!authorizedScope.allowed_hosts.includes(host)) throw recoveryError('RECOVERY_SCOPE_EXPANSION_DENIED', `AI 策略试图扩大域名范围：${host}`);
  }
  for (const prefix of strategy.scope.allowed_path_prefixes) {
    if (!authorizedScope.allowed_path_prefixes.some((allowed) => allowed === '/' || prefix === allowed || prefix.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`))) {
      throw recoveryError('RECOVERY_SCOPE_EXPANSION_DENIED', `AI 策略试图扩大路径范围：${prefix}`);
    }
  }
  let network = 0;
  let browser = 0;
  const actions = strategy.actions.map((action) => {
    assertActionCompatible(evidencePack.failure?.type,action);
    const planned = { ...action, network: NETWORK_ACTIONS.has(action.type), browser: action.type.startsWith('BROWSER_') };
    if (planned.network) {
      network += 1;
      planned.target_url = assertTargetAllowed(action, authorizedScope);
      const expectedMethod = action.type === 'POST_SAME_ORIGIN_PUBLIC_API' ? 'POST' : 'GET';
      if ((action.method || expectedMethod) !== expectedMethod) throw recoveryError('RECOVERY_METHOD_DENIED', `动作 ${action.action_id} 只允许 ${expectedMethod}`);
      planned.method = expectedMethod;
      if (expectedMethod === 'POST') {
        const endpoint = normalizeEndpoint(planned.target_url);
        const endpoints = authorizedScope.read_only_post_endpoints.map(normalizeEndpoint);
        if (!endpoints.includes(endpoint)) throw recoveryError('RECOVERY_POST_ENDPOINT_DENIED', `POST 端点未进入只读白名单：${endpoint}`);
        if (!['evidence', 'previous_action'].includes(action.parameter_source)) throw recoveryError('RECOVERY_PARAMETER_PROVENANCE_REQUIRED', `POST 动作 ${action.action_id} 的参数没有可审计来源`);
        const command = action.parameters?.cmd;
        if (!command || !authorizedScope.read_only_post_commands.includes(command)) throw recoveryError('RECOVERY_POST_COMMAND_DENIED', `POST 命令 ${command || '空'} 未进入只读白名单`);
        if (action.parameter_source === 'evidence') {
          const cited = evidencePack.evidence.filter(item => action.evidence_refs.includes(item.evidence_id)).map(item => JSON.stringify(item.observed)).join('\n');
          if (parameterValues(action.parameters).some(value => !cited.includes(value))) throw recoveryError('RECOVERY_PARAMETER_PROVENANCE_INVALID', `POST 动作 ${action.action_id} 的参数不存在于所引证据`);
        }
      }
    }
    if (planned.browser) browser += 1;
    return planned;
  });
  const counts = { actions: actions.length, network, browser };
  assertBudget(strategy.budget, authorizedScope.budget_limits, counts);
  const plan = {
    schema_version: PLAN_VERSION,
    plan_id: `SRP-${digest({ evidencePack: evidencePack.content_sha256, strategy }).slice(0, 20)}`,
    evidence_pack_id: evidencePack.evidence_pack_id,
    strategy_id: strategy.strategy_id,
    approved_at: new Date().toISOString(),
    counts,
    budget: strategy.budget,
    actions,
    stop_conditions: strategy.stop_conditions,
    human_intervention_conditions: strategy.human_intervention_conditions,
    strategy,
  };
  plan.readiness = assessPlanReadiness(evidencePack, plan);
  return plan;
}

async function appendAudit(auditStore, attemptId, event) {
  if (auditStore?.appendEvent) await auditStore.appendEvent(attemptId, event);
}

async function executeRecoveryPlan(plan, handlers = {}, options = {}) {
  if (plan?.schema_version !== PLAN_VERSION) throw recoveryError('RECOVERY_PLAN_INVALID', '执行器只接受 safe-recovery-plan-v1.0');
  if (plan.readiness && !plan.readiness.ready) throw recoveryError('RECOVERY_INPUT_ARTIFACT_MISSING', '当前保存的数据不足以执行该方案', plan.readiness.missing_artifacts);
  const startedAt = Date.now();
  const actionResults = [];
  const auditEvents = [];
  let networkStopped = false;
  const attemptId = options.attempt_id || null;
  for (const action of plan.actions) {
    if (Date.now() - startedAt > plan.budget.max_duration_ms) throw recoveryError('RECOVERY_DURATION_EXCEEDED', '恢复执行超过时间预算');
    if (networkStopped && action.network) throw recoveryError('RECOVERY_NETWORK_AFTER_SAFE_STOP', '安全停止后禁止继续网络请求');
    const handler = handlers[action.type];
    if (typeof handler !== 'function') throw recoveryError('RECOVERY_HANDLER_MISSING', `未注册确定性动作 handler：${action.type}`);
    const started = { event_type: 'action_started', action_id: action.action_id, action_type: action.type, at: new Date().toISOString() };
    auditEvents.push(started); await appendAudit(options.audit_store, attemptId, started);
    try {
      if (action.type === 'POST_SAME_ORIGIN_PUBLIC_API' && action.parameter_source === 'previous_action') {
        const prior = JSON.stringify(actionResults.map(item => item.output));
        if (!actionResults.length || parameterValues(action.parameters).some(value => !prior.includes(value))) throw recoveryError('RECOVERY_PARAMETER_PROVENANCE_INVALID', `POST 动作 ${action.action_id} 的参数无法从前序动作证明`);
      }
      const rawOutput = cloneSafe(await handler(action, { previous_results: actionResults, network_stopped: networkStopped, signal: options.signal }));
      const output = normalizeOutput(rawOutput, plan.readiness?.failure_layer);
      if (Buffer.byteLength(JSON.stringify(output)) > plan.budget.max_response_bytes) throw recoveryError('RECOVERY_RESPONSE_TOO_LARGE', `动作 ${action.action_id} 输出超过响应上限`);
      if (action.type === 'STOP_BEFORE_CONTENT_EXTRACTION') networkStopped = true;
      const result = { action_id: action.action_id, action_type: action.type, status: 'completed', output };
      actionResults.push(result);
      const completed = { event_type: 'action_completed', action_id: action.action_id, action_type: action.type, output_sha256: digest(output), at: new Date().toISOString() };
      auditEvents.push(completed); await appendAudit(options.audit_store, attemptId, completed);
    } catch (error) {
      const failed = { event_type: 'action_failed', action_id: action.action_id, action_type: action.type, error_code: error.code || 'RECOVERY_ACTION_FAILED', message: String(error.message || error).slice(0, 1000), at: new Date().toISOString() };
      auditEvents.push(failed); await appendAudit(options.audit_store, attemptId, failed);
      return { schema_version: 'recovery-execution-v1.0', status: 'failed', network_stopped: networkStopped, action_results: actionResults, audit_events: auditEvents, failure: failed };
    }
  }
  return { schema_version: 'recovery-execution-v1.0', status: networkStopped ? 'safe_stopped' : 'completed', network_stopped: networkStopped, action_results: actionResults, audit_events: auditEvents };
}

function valueAt(object, path) {
  return String(path || '').split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], object);
}

function compare(actual, operator, expected) {
  if (operator === 'equals') return Object.is(actual, expected);
  if (operator === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (operator === 'gte') return Number(actual) >= Number(expected);
  if (operator === 'lte') return Number(actual) <= Number(expected);
  if (operator === 'includes') return Array.isArray(actual) ? actual.includes(expected) : String(actual || '').includes(String(expected));
  if (operator === 'one_of') return Array.isArray(expected) && expected.includes(actual);
  throw recoveryError('RECOVERY_VALIDATION_RULE_INVALID', `不支持的校验操作符：${operator}`);
}

function validateRecoveryResult(execution, trustedValidation = {}) {
  if (!Array.isArray(trustedValidation.rules) || !trustedValidation.rules.length) {
    throw recoveryError('RECOVERY_TRUSTED_VALIDATION_REQUIRED', '独立校验器缺少可信验收规则');
  }
  const outputs = Object.fromEntries(execution.action_results.map((item) => [item.action_id, item.output]));
  const context = { execution, outputs };
  const checks = [{ check_id: 'EXECUTION_NOT_FAILED', path: 'execution.status', operator: 'one_of', expected: ['completed', 'safe_stopped'] }, ...trustedValidation.rules].map((rule) => {
    const actual = valueAt(context, rule.path);
    return { check_id: rule.check_id, path: rule.path, operator: rule.operator, expected: cloneSafe(rule.expected), actual: cloneSafe(actual), pass: compare(actual, rule.operator, rule.expected) };
  });
  return {
    schema_version: 'recovery-validation-v1.0',
    status: checks.every((item) => item.pass) ? 'pass' : 'fail',
    outcome_class: trustedValidation.outcome_class || 'recovery_evaluated',
    checks,
    validated_at: new Date().toISOString(),
  };
}

async function runRecoveryLoop({ input, proposeStrategy, handlers, handlerFactory, trustedValidation, auditStore }) {
  const evidencePack = buildRecoveryEvidencePack(input);
  let attemptId = null;
  if (auditStore?.beginAttempt) attemptId = await auditStore.beginAttempt(evidencePack);
  try {
    const strategy = await proposeStrategy(evidencePack);
    const plan = planRecovery(evidencePack, strategy);
    if (auditStore?.recordPlan) await auditStore.recordPlan(attemptId, strategy, plan);
    const activeHandlers = handlers || await handlerFactory?.(evidencePack, plan);
    const execution = await executeRecoveryPlan(plan, activeHandlers || {}, { audit_store: auditStore, attempt_id: attemptId });
    const validation = validateRecoveryResult(execution, trustedValidation);
    const result = { evidence_pack: evidencePack, strategy, safety_plan: plan, execution, validation };
    if (auditStore?.finishAttempt) await auditStore.finishAttempt(attemptId, result);
    return result;
  } catch (error) {
    if (auditStore?.failAttempt) await auditStore.failAttempt(attemptId, error);
    throw error;
  }
}

function createSqlRecoveryAuditStore(db) {
  const asJson = (value) => value == null ? null : JSON.stringify(value);
  return {
    async beginAttempt(evidencePack) {
      const [result] = await db.query(`INSERT INTO product_ingestion_recovery_attempts
        (job_id,candidate_id,parent_attempt_id,attempt_no,evidence_pack_id,schema_version,status,next_action,evidence_pack,started_at)
        VALUES (?,?,?,?,?,?, 'planning', ?, ?, NOW())`, [evidencePack.source.job_id || null, evidencePack.source.candidate_id || null, evidencePack.source.parent_attempt_id || null, evidencePack.attempt_no || 1, evidencePack.evidence_pack_id, evidencePack.schema_version, nextAction('planning'), asJson(evidencePack)]);
      return Number(result.insertId);
    },
    async recordPlan(id, strategy, plan) {
      await db.query(`UPDATE product_ingestion_recovery_attempts SET strategy_id=?,ai_strategy=?,safety_plan=?,status='executing' WHERE id=?`, [strategy.strategy_id, asJson(strategy), asJson(plan), id]);
    },
    async markShadowReady(id, strategy, plan, riskLevel = 'low', evidenceRequest = null) {
      await db.query(`UPDATE product_ingestion_recovery_attempts SET strategy_id=?,ai_strategy=?,safety_plan=?,readiness=?,evidence_request=?,risk_level=?,status='awaiting_business_review',next_action='business_review',finished_at=NOW() WHERE id=?`, [strategy.strategy_id, asJson(strategy), asJson(plan), asJson(plan.readiness), asJson(evidenceRequest), riskLevel, id]);
    },
    async appendEvent(id, event) {
      if (!id) return;
      await db.query(`INSERT INTO product_ingestion_recovery_events (attempt_id,event_type,action_id,event_payload) VALUES (?,?,?,?)`, [id, event.event_type, event.action_id || null, asJson(event)]);
    },
    async finishAttempt(id, result) {
      const status=result.validation.status === 'pass' ? 'reintegrating' : 'no_improvement';
      await db.query(`UPDATE product_ingestion_recovery_attempts SET execution_result=?,validation_result=?,outcome_class=?,status=?,next_action=?,finished_at=NOW() WHERE id=?`, [asJson(result.execution), asJson(result.validation), result.validation.outcome_class, status,nextAction(status), id]);
    },
    async failAttempt(id, error) {
      if (!id) return;
      await db.query(`UPDATE product_ingestion_recovery_attempts SET status='execution_failed',next_action='retry_or_manual',failure_code=?,last_error=?,finished_at=NOW() WHERE id=?`, [String(error.code || 'RECOVERY_FAILED').slice(0, 80), String(error.message || error).slice(0, 1000), id]);
    },
    async rejectPlan(id, error) {
      if (!id) return;
      await db.query(`UPDATE product_ingestion_recovery_attempts SET status='plan_rejected',next_action='revise_or_manual',failure_code=?,last_error=?,finished_at=NOW() WHERE id=?`, [String(error.code || 'RECOVERY_PLAN_REJECTED').slice(0, 80), String(error.message || error).slice(0, 1000), id]);
    },
  };
}

module.exports = {
  EVIDENCE_PACK_VERSION, PLAN_VERSION, DEFAULT_LIMITS, buildRecoveryEvidencePack, planRecovery,
  executeRecoveryPlan, validateRecoveryResult, runRecoveryLoop, createSqlRecoveryAuditStore,
  cloneSafe, digest,
};
