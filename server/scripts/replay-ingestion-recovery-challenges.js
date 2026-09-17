'use strict';

const fs = require('fs');
const path = require('path');
const { buildRecoveryEvidencePack, planRecovery, executeRecoveryPlan, validateRecoveryResult } = require('../services/product-ingestion-recovery');
const { NETWORK_ACTIONS } = require('../services/product-ingestion-recovery-schema');

const defaultInput = path.resolve(__dirname, '../../outputs/furniture_brand_site_research_20260913/cross_site_challenge_cases_v1.json');
const inputPath = path.resolve(process.argv[2] || defaultInput);
const outputPath = path.resolve(process.argv[3] || path.join(path.dirname(inputPath), 'cross_site_challenge_replay_v1.json'));

function normalizeAction(raw, item, index) {
  if (raw.startsWith('ALLOW_PARAMETER:')) return null;
  const type = raw.split(':')[0];
  const action = { action_id: `A${String(index + 1).padStart(2, '0')}`, type, evidence_refs: ['E001'] };
  const page = new URL(item.page_url); page.hash = '';
  if (NETWORK_ACTIONS.has(type)) {
    if (type === 'GET_SITE_ROOT') action.target_url = `${page.protocol}//${page.host}/`;
    else if (type === 'GET_SAME_HANDLE_PUBLIC_JSON_ONCE') action.target_url = `${page.toString()}.js`;
    else if (type === 'CHECK_CURRENT_OFFICIAL_SITEMAP') action.target_url = `${page.protocol}//${page.host}/sitemap.xml`;
    else if (type === 'POST_SAME_ORIGIN_PUBLIC_API') {
      action.target_url = `${page.protocol}//${page.host}/cgi`;
      action.method = 'POST'; action.parameters = { cmd: raw.split(':')[1], spuId: String(item.retry_result.spu_id) };
      action.parameter_source = 'evidence';
    } else action.target_url = page.toString();
    action.purpose = type.includes('SITEMAP') ? 'sitemap' : 'product';
  }
  return action;
}

function rulesFor(item, lastId) {
  const base = `outputs.${lastId}`;
  if (item.outcome_class === 'safe_stop_validated') return [
    { check_id: 'SAFE_STOP', path: 'execution.status', operator: 'equals', expected: 'safe_stopped' },
    { check_id: 'NO_CONTENT_EXTRACTION', path: `${base}.content_extraction_attempted`, operator: 'equals', expected: false },
  ];
  if (item.outcome_class === 'stale_baseline_diagnosed') return [
    { check_id: 'DIAGNOSIS_PRESENT', path: `${base}.diagnosis`, operator: 'exists' },
    { check_id: 'NOT_IN_SITEMAP', path: `${base}.handle_in_current_sitemaps`, operator: 'equals', expected: false },
  ];
  if (item.outcome_class === 'interface_strategy_identified') return [
    { check_id: 'APP_ROOT_PRESENT', path: `${base}.app_root_present`, operator: 'equals', expected: true },
    { check_id: 'JS_BUNDLE_PRESENT', path: `${base}.js_bundle_present`, operator: 'equals', expected: true },
  ];
  if (item.outcome_class === 'page_role_corrected') return [
    { check_id: 'PAGE_ROLE', path: `${base}.page_role`, operator: 'equals', expected: item.retry_result.page_role },
    { check_id: 'HTTP_200', path: `${base}.http_status`, operator: 'equals', expected: 200 },
  ];
  return [
    { check_id: 'HTTP_200', path: `${base}.http_status`, operator: 'equals', expected: 200 },
    { check_id: 'RESULT_PRESENT', path: base, operator: 'exists' },
  ];
}

async function replay(item) {
  const page = new URL(item.page_url); const apiCommand = item.controlled_actions.find(value => value.startsWith('POST_SAME_ORIGIN_PUBLIC_API:'))?.split(':')[1];
  const evidence = { case: item.available_evidence, retry_result: item.retry_result };
  const pack = buildRecoveryEvidencePack({
    failure: { type: item.failure_type, description: item.initial_attempt }, source: { url: item.page_url, challenge_id: item.challenge_id }, initial_result: item.initial_attempt,
    evidence: [{ evidence_id: 'E001', kind: 'research_challenge_case', source_url: item.page_url, locator: item.challenge_id, observed: evidence }],
    authorized_scope: { allowed_hosts: [page.hostname], allowed_path_prefixes: ['/'], read_only_post_endpoints: apiCommand ? [`${page.protocol}//${page.host}/cgi`] : [], read_only_post_commands: apiCommand ? [apiCommand] : [], budget_limits: { max_actions: 12, max_network_requests: 4, max_browser_actions: 5, max_response_bytes: 5242880, max_duration_ms: 30000 } },
  });
  const normalizations = [];
  if (item.controlled_actions.some(value => value.startsWith('ALLOW_PARAMETER:'))) normalizations.push('ALLOW_PARAMETER pseudo-action converted to POST parameter provenance constraint');
  const actions = item.controlled_actions.map((raw, index) => normalizeAction(raw, item, index)).filter(Boolean);
  const strategy = {
    schema_version: 'ai-recovery-strategy-v1.0', strategy_id: `replay:${item.challenge_id}`,
    diagnosis: { failure_type: item.failure_type, summary: item.ai_strategy_suggestion, evidence_refs: ['E001'] },
    scope: { level: item.strategy_scope.startsWith('template:') ? 'template' : 'page', template_fingerprint: item.strategy_scope.replace(/^template:\s*/, '').slice(0, 160), allowed_hosts: [page.hostname], allowed_path_prefixes: ['/'] },
    actions, budget: { max_actions: actions.length, max_network_requests: actions.filter(action => NETWORK_ACTIONS.has(action.type)).length, max_browser_actions: 0, max_response_bytes: 5242880, max_duration_ms: 30000 },
    expected_validation: [{ check_id: 'RESEARCH_EXPECTATION', description: item.unified_validation.status }], stop_conditions: ['budget exhausted', 'policy denied', 'evidence conflict'], human_intervention_conditions: [item.human_intervention_condition],
  };
  const plan = planRecovery(pack, strategy);
  const handlers = Object.fromEntries(actions.map(action => [action.type, async () => item.retry_result]));
  const execution = await executeRecoveryPlan(plan, handlers);
  const validation = validateRecoveryResult(execution, { outcome_class: item.outcome_class, rules: rulesFor(item, actions.at(-1).action_id) });
  return { challenge_id: item.challenge_id, brand: item.brand, failure_type: item.failure_type, normalized_actions: actions.map(action => action.type), normalizations, plan_status: 'accepted', execution_status: execution.status, validation_status: validation.status, validation, audit_event_count: execution.audit_events.length };
}

(async () => {
  const cases = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const results = [];
  for (const item of cases) {
    try { results.push(await replay(item)); }
    catch (error) { results.push({ challenge_id: item.challenge_id, brand: item.brand, plan_status: 'rejected', validation_status: 'fail', error_code: error.code || 'REPLAY_FAILED', error: error.message }); }
  }
  const summary = { schema_version: 'cross-site-recovery-replay-v1.0', generated_at: new Date().toISOString(), source: inputPath, case_count: results.length, plan_accepted: results.filter(item => item.plan_status === 'accepted').length, validation_passed: results.filter(item => item.validation_status === 'pass').length, issues: results.filter(item => item.validation_status !== 'pass').map(item => ({ challenge_id: item.challenge_id, error_code: item.error_code, error: item.error })), normalizations: [...new Set(results.flatMap(item => item.normalizations || []))], results };
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: outputPath, case_count: summary.case_count, plan_accepted: summary.plan_accepted, validation_passed: summary.validation_passed, issues: summary.issues }, null, 2)}\n`);
  if (summary.issues.length) process.exitCode = 1;
})();
