'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createRecoveryControl,localValidation}=require('../services/product-ingestion-recovery-control');
const {createShadowRecoveryPlanner}=require('../services/product-ingestion-recovery-shadow');
const {createRunner}=require('../services/product-ingestion-runner');
const {buildRecoveryEvidencePack,planRecovery}=require('../services/product-ingestion-recovery');

function validStrategy(){return {
  schema_version:'ai-recovery-strategy-v1.0',strategy_id:'shadow-test',
  diagnosis:{failure_type:'NO_PRODUCTS_DISCOVERED',summary:'从页面证据重新识别详情链接',evidence_refs:['E001']},
  scope:{level:'page',allowed_hosts:['example.com'],allowed_path_prefixes:['/']},
  actions:[{action_id:'A1',type:'PARSE_SCOPED_DOM',purpose:'diagnosis',parameters:{selector:'main a[href]'},parameter_source:'evidence',evidence_refs:['E001']}],
  budget:{max_actions:1,max_network_requests:0,max_browser_actions:0,max_response_bytes:100000,max_duration_ms:5000},
  expected_validation:[{check_id:'C1',description:'重新识别后必须产生同源产品详情 URL'}],stop_conditions:['没有新增证据'],human_intervention_conditions:['第二次仍失败'],
};}

test('shadow planner stores a safe plan but never executes an action',async()=>{
  const statements=[];const db={query:async(sql,params=[])=>{statements.push({sql,params});if(sql.startsWith('INSERT INTO product_ingestion_recovery_attempts'))return [{insertId:7}];if(sql.startsWith('UPDATE product_ingestion_recovery_attempts'))return [{affectedRows:1}];throw new Error(`Unexpected query: ${sql}`);}};
  let proposals=0;const planner=createShadowRecoveryPlanner(db,{proposeStrategy:async()=>{proposals+=1;return validStrategy();}});
  const result=await planner({job:{id:2,recovery_mode:'shadow',base_url:'https://example.com/',scope_snapshot:{allowed_hosts:['example.com'],allowed_path_prefixes:['/']}},sourceUrl:'https://example.com/',failure:Object.assign(new Error('没有发现产品'),{code:'NO_PRODUCTS_DISCOVERED'}),evidence:{pages_scanned:3}});
  assert.deepEqual(result,{status:'awaiting_business_review',attempt_id:7});assert.equal(proposals,1);
  assert.equal(statements.filter(item=>item.sql.startsWith('UPDATE')).length,1);
  assert.match(statements.at(-1).sql,/status='awaiting_business_review'/);
  assert.doesNotMatch(statements.map(item=>item.sql).join('\n'),/recovery_events/);
});

test('recovery control parses records and routes business feedback to an explicit next state',async()=>{
  let feedbackParams;const db={query:async(sql,params=[])=>{
    if(sql.includes('FROM product_ingestion_recovery_attempts attempt')&&sql.includes('ORDER BY attempt.id'))return [[{id:9,job_id:3,candidate_id:null,evidence_pack:'{"failure":{"type":"FIELD_EMPTY"}}',ai_strategy:'{"strategy_id":"S1"}',safety_plan:null,execution_result:null,validation_result:null,status:'awaiting_business_review'}]];
    if(sql.startsWith('SELECT * FROM product_ingestion_recovery_attempts'))return [[{id:9,job_id:3,status:'awaiting_business_review',attempt_no:1,evidence_pack:'{"failure":{"type":"FIELD_EMPTY"}}',safety_plan:'{"counts":{"network":0},"actions":[],"readiness":{"ready":true}}',readiness:'{"ready":true}'}]];
    if(sql.startsWith('UPDATE product_ingestion_recovery_attempts SET review_decision')){feedbackParams=params;return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const control=createRecoveryControl(db),listed=await control.list({status:'awaiting_business_review',limit:'10'});
  assert.equal(listed.items[0].evidence_pack.failure.type,'FIELD_EMPTY');
  await assert.rejects(()=>control.feedback(9,{decision:'unreasonable'},'admin'),/明显不对/);
  assert.equal((await control.feedback(9,{decision:'reasonable'},'admin')).status,'ready_to_execute');
  assert.equal(feedbackParams[0],'reasonable');
});

test('recovery UI asks for business judgment and keeps technical details folded',()=>{
  const ui=require('fs').readFileSync(require.resolve('../public/admin/modules/product-ingestion.js'),'utf8');
  assert.match(ui,/这个方向可以试/);
  assert.match(ui,/这个判断明显不对/);
  assert.match(ui,/我无法判断，交给系统复核/);
  assert.match(ui,/<details class="ingestion-technical"><summary>专业信息/);
  assert.match(ui,/检查已有数据并继续/);
  assert.match(ui,/按这个范围补充证据/);
  assert.doesNotMatch(ui,/data-feedback="reasonable">建议合理/);
  assert.doesNotMatch(ui,/data-feedback="unreasonable">建议不合理/);
});

test('approved local-only suggestion can execute once and gets trusted result feedback',async()=>{
  const evidence=buildRecoveryEvidencePack({
    failure:{type:'NO_PRODUCTS_DISCOVERED'},source:{url:'https://example.com/',job_id:3},
    evidence:[{evidence_id:'E001',kind:'summary',observed:{pages:10}},{evidence_id:'H001',kind:'html_snapshot',observed:{content:'<main><a href="/products/chair">Chair</a></main>'}}],
    authorized_scope:{allowed_hosts:['example.com'],allowed_path_prefixes:['/']},
  });
  const strategy={...validStrategy(),actions:[{...validStrategy().actions[0],evidence_refs:['H001']}]},plan={...planRecovery(evidence,strategy),plan_id:'legacy-order-dependent-id'};let finalParams;
  const row={id:9,job_id:3,status:'ready_to_execute',review_decision:'reasonable',attempt_no:1,evidence_pack:JSON.stringify(evidence),ai_strategy:JSON.stringify(strategy),safety_plan:JSON.stringify(plan),readiness:JSON.stringify(plan.readiness)};
  const db={query:async(sql,params=[])=>{
    if(sql.startsWith('SELECT * FROM product_ingestion_recovery_attempts'))return [[row]];
    if(sql.includes("SET status='executing'"))return [{affectedRows:1}];
    if(sql.startsWith('INSERT INTO product_ingestion_recovery_events'))return [{affectedRows:1}];
    if(sql.startsWith('UPDATE product_ingestion_recovery_attempts')){finalParams=params;return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const execution={status:'completed',action_results:[{action_id:'A1',output:{product_urls:['https://example.com/products/chair']}}]};
  const result=await createRecoveryControl(db,{executeRecoveryPlan:async()=>execution,createRecoveryActionHandlers:()=>({}),resumeRecoveredDiscovery:async()=>({type:'job_resumed',job_id:3})}).executeLocal(9,{confirmed:true},'admin');
  assert.equal(result.status,'resumed');assert.equal(result.confirmed_results,1);
  assert.equal(localValidation({status:'completed',action_results:[]},'NO_PRODUCTS_DISCOVERED').status,'no_improvement');
});

test('historical failure can explicitly enable shadow mode before planning',async()=>{
  const calls=[];let plannedJob=null;const db={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.startsWith('SELECT job.*'))return [[{id:26,source_id:8,status:'discovery_failed',source_status:'active',recovery_mode:'off',base_url:'https://example.com/',failure_code:'NO_PRODUCTS_DISCOVERED',last_error:'没有发现产品',scope_snapshot:'{"allowed_hosts":["example.com"],"allowed_path_prefixes":["/"]}',discovery_summary:'{"pages_scanned":200}'}]];if(sql.startsWith('UPDATE product_ingestion_sources'))return [{affectedRows:1}];throw new Error(`Unexpected query: ${sql}`);}};
  const runner=createRunner(db,{planShadowRecovery:async input=>{plannedJob=input.job;return {status:'shadow_ready',attempt_id:10};}}),result=await runner.planHistoricalFailure(26,{enableShadow:true});
  assert.deepEqual(result,{status:'shadow_ready',attempt_id:10});assert.equal(plannedJob.recovery_mode,'shadow');assert.deepEqual(calls[1].params,[8]);
});
