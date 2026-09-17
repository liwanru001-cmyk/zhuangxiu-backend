'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {STATES,TRANSITIONS,canTransition,nextAction}=require('../services/product-ingestion-recovery-state');
const {buildRecoveryEvidencePack,planRecovery}=require('../services/product-ingestion-recovery');
const {assessPlanReadiness,evidenceRequest}=require('../services/product-ingestion-recovery-contracts');
const {localValidation}=require('../services/product-ingestion-recovery-control');
const {pageFacts}=require('../services/product-ingestion-recovery-actions');

function strategy(actions){return {schema_version:'ai-recovery-strategy-v1.0',strategy_id:'closed-loop',diagnosis:{failure_type:'NO_PRODUCTS_DISCOVERED',summary:'find product urls',evidence_refs:['E1']},scope:{level:'page',allowed_hosts:['example.com'],allowed_path_prefixes:['/']},actions,budget:{max_actions:actions.length,max_network_requests:0,max_browser_actions:0,max_response_bytes:100000,max_duration_ms:5000},expected_validation:[{check_id:'V1',description:'must return product urls'}],stop_conditions:['no result'],human_intervention_conditions:['third failure']};}
function pack(evidence){return buildRecoveryEvidencePack({failure:{type:'NO_PRODUCTS_DISCOVERED'},source:{url:'https://example.com/'},evidence,authorized_scope:{allowed_hosts:['example.com'],allowed_path_prefixes:['/']}});}

test('every non-terminal recovery state has an explicit transition and next action',()=>{
  for(const state of Object.values(STATES)){
    if(['resumed','superseded','exhausted'].includes(state))continue;
    assert.ok((TRANSITIONS[state]||[]).length>0,state);
    assert.ok(nextAction(state),state);
  }
});

test('DOM recovery cannot claim readiness without an HTML snapshot',()=>{
  const action={action_id:'A1',type:'PARSE_SCOPED_DOM',purpose:'diagnosis',evidence_refs:['E1']};
  const plan=planRecovery(pack([{evidence_id:'E1',kind:'summary',observed:{pages:200}}]),strategy([action]));
  assert.equal(plan.readiness.ready,false);
  assert.ok(plan.readiness.missing_artifacts.some(item=>item.artifact_type==='html_snapshot'));
  const uncited=planRecovery(pack([{evidence_id:'E1',kind:'summary',observed:{pages:200}},{evidence_id:'H1',kind:'html_snapshot',observed:{content:'<html></html>'}}]),strategy([action]));
  assert.equal(uncited.readiness.ready,false);
});

test('discovery parser emits the unified URL, field and image contract inputs',()=>{
  const facts=pageFacts('<main><h1>Chair</h1><a href="/products/chair">Chair</a><img src="/chair.jpg"></main>','https://example.com/');
  assert.deepEqual(facts.product_urls,['https://example.com/products/chair']);
  assert.equal(facts.fields.name,'Chair');assert.deepEqual(facts.images,['https://example.com/chair.jpg']);
});

test('validator separates execution error from normal no improvement',()=>{
  assert.equal(localValidation({status:'failed',action_results:[]},'NO_PRODUCTS_DISCOVERED').status,'execution_error');
  assert.equal(localValidation({status:'completed',action_results:[]},'NO_PRODUCTS_DISCOVERED').status,'no_improvement');
});

test('a rejected historical plan can still prepare a bounded evidence request',()=>{
  const evidence=pack([{evidence_id:'E1',kind:'summary',observed:{pages:0}}]);
  const readiness=assessPlanReadiness(evidence,null),request=evidenceRequest(evidence,null,readiness);
  assert.equal(readiness.ready,false);assert.deepEqual(request.urls,['https://example.com/']);assert.equal(request.max_pages,1);
});
