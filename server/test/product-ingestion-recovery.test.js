'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecoveryEvidencePack, planRecovery, executeRecoveryPlan, validateRecoveryResult, runRecoveryLoop } = require('../services/product-ingestion-recovery');
const { proposeRecoveryStrategy } = require('../services/product-ingestion-recovery-ai');

function input(overrides = {}) {
  return { failure: { type: 'FIELD_EMPTY' }, source: { url: 'https://example.com/products/1' }, initial_result: {}, evidence: [{ evidence_id: 'E1', kind: 'html', observed: { product_id: '42', text: 'Chair' } }], authorized_scope: { allowed_hosts: ['example.com'], allowed_path_prefixes: ['/products', '/api'], read_only_post_endpoints: ['https://example.com/api'], read_only_post_commands: ['detail'] }, ...overrides };
}
function strategy(actions, overrides = {}) {
  return { schema_version: 'ai-recovery-strategy-v1.0', strategy_id: 'S001', diagnosis: { failure_type: 'FIELD_EMPTY', summary: 'retry with cited evidence', evidence_refs: ['E1'] }, scope: { level: 'page', allowed_hosts: ['example.com'], allowed_path_prefixes: ['/products'] }, actions, budget: { max_actions: actions.length, max_network_requests: actions.filter(a => /^(?:GET_|POST_)/.test(a.type)).length, max_browser_actions: 0, max_response_bytes: 100000, max_duration_ms: 5000 }, expected_validation: [{ check_id: 'C1', description: 'trusted validator will check output' }], stop_conditions: ['budget exhausted'], human_intervention_conditions: ['second failure'], ...overrides };
}

test('evidence pack is stable, bounded and removes prototype keys', () => {
  const pack = buildRecoveryEvidencePack(input({ evidence: [{ evidence_id: 'E1', observed: JSON.parse('{"ok":1,"__proto__":{"polluted":true}}') }] }));
  assert.equal(pack.schema_version, 'recovery-evidence-pack-v1.0');
  assert.equal(pack.evidence[0].observed.ok, 1);
  assert.equal(Object.hasOwn(pack.evidence[0].observed, '__proto__'), false);
});

test('planner rejects unknown evidence, scope expansion, HTTP and unsafe bypass text', () => {
  const pack = buildRecoveryEvidencePack(input());
  assert.throws(() => planRecovery(pack, strategy([{ action_id: 'A1', type: 'PRESERVE_MISSING_FIELDS', evidence_refs: ['missing'] }])), { code: 'RECOVERY_EVIDENCE_REFERENCE_INVALID' });
  assert.throws(() => planRecovery(pack, strategy([{ action_id: 'A1', type: 'GET_SAME_ORIGIN_PAGE', target_url: 'https://evil.test/products/1', evidence_refs: ['E1'] }], { scope: { level: 'page', allowed_hosts: ['evil.test'], allowed_path_prefixes: ['/products'] } })), { code: 'RECOVERY_SCOPE_EXPANSION_DENIED' });
  assert.throws(() => planRecovery(pack, strategy([{ action_id: 'A1', type: 'GET_SAME_ORIGIN_PAGE', target_url: 'http://example.com/products/1', evidence_refs: ['E1'] }])), { code: 'RECOVERY_HTTP_DENIED' });
  assert.throws(() => planRecovery(pack, strategy([{ action_id: 'A1', type: 'PRESERVE_MISSING_FIELDS', evidence_refs: ['E1'] }], { diagnosis: { failure_type: 'FIELD_EMPTY', summary: 'use curl -k', evidence_refs: ['E1'] } })), { code: 'RECOVERY_UNSAFE_INSTRUCTION' });
});

test('planner rejects certificate actions without certificate evidence',()=>{
  const evidence=buildRecoveryEvidencePack(input({failure:{type:'NO_PRODUCTS_DISCOVERED',stage:'url_discovery'}}));
  assert.throws(()=>planRecovery(evidence,strategy([{action_id:'A1',type:'RECORD_CERTIFICATE_ERROR',evidence_refs:['E1']}])),{code:'RECOVERY_ACTION_MISMATCH'});
});

test('planner rejects duplicate technical operations even when action ids differ',()=>{
  const evidence=buildRecoveryEvidencePack(input());
  const actions=[
    {action_id:'A1',type:'PRESERVE_MISSING_FIELDS',evidence_refs:['E1']},
    {action_id:'A2',type:'PRESERVE_MISSING_FIELDS',evidence_refs:['E1']},
  ];
  assert.throws(()=>planRecovery(evidence,strategy(actions)),{code:'RECOVERY_STRATEGY_SCHEMA_INVALID'});
});

test('read-only POST needs exact endpoint, command and evidenced parameters', () => {
  const pack = buildRecoveryEvidencePack(input());
  const action = { action_id: 'A1', type: 'POST_SAME_ORIGIN_PUBLIC_API', target_url: 'https://example.com/api', method: 'POST', parameters: { cmd: 'detail', product_id: '42' }, parameter_source: 'evidence', evidence_refs: ['E1'] };
  assert.equal(planRecovery(pack, strategy([action], { scope: { level: 'page', allowed_hosts: ['example.com'], allowed_path_prefixes: ['/api'] } })).actions[0].method, 'POST');
  assert.throws(() => planRecovery(pack, strategy([{ ...action, parameters: { cmd: 'delete', product_id: '42' } }], { scope: { level: 'page', allowed_hosts: ['example.com'], allowed_path_prefixes: ['/api'] } })), { code: 'RECOVERY_POST_COMMAND_DENIED' });
  assert.throws(() => planRecovery(pack, strategy([{ ...action, parameters: { cmd: 'detail', product_id: '99' } }], { scope: { level: 'page', allowed_hosts: ['example.com'], allowed_path_prefixes: ['/api'] } })), { code: 'RECOVERY_PARAMETER_PROVENANCE_INVALID' });
});

test('executor stops network after safe stop and reports missing handlers', async () => {
  const pack = buildRecoveryEvidencePack(input());
  const actions = [{ action_id: 'A1', type: 'STOP_BEFORE_CONTENT_EXTRACTION', evidence_refs: ['E1'] }, { action_id: 'A2', type: 'GET_SAME_ORIGIN_PAGE', target_url: 'https://example.com/products/1', evidence_refs: ['E1'] }, { action_id: 'A3', type: 'PRESERVE_MISSING_FIELDS', evidence_refs: ['E1'] }];
  const plan = planRecovery(pack, strategy(actions));
  await assert.rejects(() => executeRecoveryPlan(plan, { STOP_BEFORE_CONTENT_EXTRACTION: async () => ({ stopped: true }), GET_SAME_ORIGIN_PAGE: async () => ({}) }), { code: 'RECOVERY_NETWORK_AFTER_SAFE_STOP' });
  const localPlan = planRecovery(pack, strategy([{ action_id: 'A1', type: 'PRESERVE_MISSING_FIELDS', evidence_refs: ['E1'] }]));
  await assert.rejects(() => executeRecoveryPlan(localPlan, {}), { code: 'RECOVERY_HANDLER_MISSING' });
});

test('trusted validator ignores AI claims and evaluates actual output', async () => {
  const execution = { action_results: [{ action_id: 'A1', output: { count: 0 } }] };
  const result = validateRecoveryResult(execution, { outcome_class: 'test', rules: [{ check_id: 'real', path: 'outputs.A1.count', operator: 'gte', expected: 1 }] });
  assert.equal(result.status, 'fail');
});

test('full loop records independently validated success', async () => {
  const actions = [{ action_id: 'A1', type: 'PRESERVE_MISSING_FIELDS', evidence_refs: ['E1'] }];
  const result = await runRecoveryLoop({ input: input(), proposeStrategy: async () => strategy(actions), handlers: { PRESERVE_MISSING_FIELDS: async () => ({ preserved: true }) }, trustedValidation: { outcome_class: 'fields_preserved', rules: [{ check_id: 'C1', path: 'outputs.A1.preserved', operator: 'equals', expected: true }] } });
  assert.equal(result.validation.status, 'pass');
});

test('AI proposer retries one invalid schema response with strict response format', async () => {
  const valid = strategy([{ action_id: 'A1', type: 'PRESERVE_MISSING_FIELDS', evidence_refs: ['E1'] }]);
  const replies = ['{}', JSON.stringify(valid)]; let calls = 0;
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.response_format.json_schema.strict, true);
    assert.doesNotMatch(JSON.stringify(request.response_format.json_schema.schema),/uniqueItems/);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: replies[calls++] } }] }) };
  };
  const result = await proposeRecoveryStrategy(buildRecoveryEvidencePack(input()), { fetchImpl, env: { INGESTION_AI_API_KEY: 'test', INGESTION_AI_FORMAT_RETRIES: '1' } });
  assert.equal(result.strategy_id, 'S001'); assert.equal(calls, 2);
});

test('AI proposer turns an aborted upstream request into a bounded timeout',async()=>{
  const fetchImpl=async(_url,options)=>{assert.ok(options.signal);const error=new Error('aborted');error.name='AbortError';throw error;};
  await assert.rejects(()=>proposeRecoveryStrategy(buildRecoveryEvidencePack(input()),{fetchImpl,env:{INGESTION_AI_API_KEY:'test',INGESTION_AI_TIMEOUT_MS:'5000'}}),{code:'RECOVERY_AI_TIMEOUT'});
});
