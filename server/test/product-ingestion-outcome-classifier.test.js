'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {OUTCOME_CATEGORIES,CONTRACT,classifyIngestionOutcome}=require('../services/product-ingestion-outcome-classifier');

test('every ingestion outcome has one executable governance contract',()=>{
  assert.deepEqual([...OUTCOME_CATEGORIES].sort(),Object.keys(CONTRACT).sort());
  for(const category of OUTCOME_CATEGORIES){
    assert.ok(CONTRACT[category].next_action);
    assert.equal(typeof CONTRACT[category].terminal,'boolean');
  }
});

test('network, policy, rendering, evidence and rule failures use stable categories',()=>{
  assert.equal(classifyIngestionOutcome({response:{status:429}},{stage:'preflight'}).category,'RATE_LIMITED');
  assert.equal(classifyIngestionOutcome({code:'ROBOTS_DISALLOW'}).category,'POLICY_BLOCKED');
  assert.equal(classifyIngestionOutcome({response:{status:403}}).category,'ACCESS_RESTRICTED');
  assert.equal(classifyIngestionOutcome({code:'HUMAN_VERIFICATION_REQUIRED'}).category,'HUMAN_CHALLENGE');
  assert.equal(classifyIngestionOutcome({dynamic_signals:['script_shell']}).category,'JS_RENDER_REQUIRED');
  assert.equal(classifyIngestionOutcome({code:'FETCH_TIMEOUT'}).category,'TEMPORARY_NETWORK_FAILURE');
  assert.equal(classifyIngestionOutcome({response:{status:503}}).category,'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyIngestionOutcome({code:'NO_PRODUCTS_DISCOVERED'}).category,'EVIDENCE_INSUFFICIENT');
  assert.equal(classifyIngestionOutcome({code:'SITE_RULE_TEMPLATE_STALE'}).category,'TEMPLATE_DRIFT');
});

test('the classifier preserves the original error while keeping business schema separate',()=>{
  assert.deepEqual(classifyIngestionOutcome({code:'PAGE_HTTP_STATUS',response:{status:429}},{stage:'site_mapping'}),{
    schema_version:'ingestion-outcome-v1',category:'RATE_LIMITED',stage:'site_mapping',retryability:'wait',next_action:'WAIT_AND_PROBE',terminal:false,error_code:'PAGE_HTTP_STATUS',http_status:429,
  });
});
