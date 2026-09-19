'use strict';

const crypto = require('crypto');
const { classifyIngestionOutcome } = require('./product-ingestion-outcome-classifier');
const { preflightAccess, boundedBackoffAt } = require('./product-ingestion-access-preflight');
const { acquireBoundedOfficialEvidence } = require('./product-ingestion-bounded-official-evidence');
const { createHybridFetcher } = require('./product-ingestion-rendered-fetch');
const { buildSiteMap, augmentProductEvidence, pageCard } = require('./product-ingestion-site-map');
const { generateSiteRule, PROMPT_VERSION } = require('./product-ingestion-site-rule-ai');
const { generateDiscoveryRule, normalizeDiscoveryRule } = require('./product-ingestion-site-discovery-ai');
const { generateCognitionDecision, probeCognitionDecision, PROMPT_VERSION:COGNITION_PROMPT_VERSION } = require('./product-ingestion-site-cognition-ai');
const { createSiteRuleControl } = require('./product-ingestion-site-rule-sandbox');
const { loadFrozenSiteRule,loadFrozenSiteRules } = require('./product-ingestion-site-rule-runtime');
const { roleFor } = require('./product-ingestion-site-rule-sandbox');
const { transition, allowedEvents } = require('./product-ingestion-site-cognition-state');
const { validateCorrectionIssues } = require('./product-schema-v2');
const { buildExtractionContexts, sliceTasksForFeedback } = require('./product-ingestion-ai-context-builder');
const {generatePublicJsonApiRule,getPath,recordToCanonicalHtml,addApiRoutableEvidence,virtualProductUrl,sameOfficialSite}=require('./product-ingestion-public-json-api');
const {urlRole}=require('./product-ingestion-url-role-contract');

const running = new Set();
const { createGlobalSlotManager } = require('./product-ingestion-global-slots');
const AI_TOKEN_BUDGET=60000;
const MAX_AI_TOKEN_BUDGET=480000;
const MAX_EVIDENCE_PROBE_ROUNDS=3;
function evidenceProbeFingerprint(requests=[]){
  const normalized=requests.map(item=>({
    target_page_id:item?.target_page_id||null,
    evidence_type:item?.evidence_type||null,
    purpose:item?.purpose||null,
  })).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return digest(normalized);
}
const BUSINESS_ERROR_TYPES = new Set(['product_page_wrong','product_page_missing','name_wrong','model_wrong','material_wrong','dimensions_wrong','images_mixed','images_missing_or_order','variant_wrong','relationship_wrong','attachment_wrong','scope_or_brand_wrong']);
const DISCOVERY_ERROR_TYPES = new Set(['product_page_wrong','product_page_missing','scope_or_brand_wrong']);
function parsed(value, fallback = null) { if(value == null)return fallback;if(typeof value === 'object')return value;try{return JSON.parse(value);}catch(_){return fallback;} }
function json(value) { return value == null ? null : JSON.stringify(value); }
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function fail(message, status=409, code='SITE_COGNITION_INVALID') { const error=new Error(message);error.status=status;error.code=code;throw error; }
function mapWorkflow(row) { return {...row,id:Number(row.id),source_id:Number(row.source_id),job_id:Number(row.job_id),rule_id:row.rule_id==null?null:Number(row.rule_id),attempt_counters:parsed(row.attempt_counters,{}),next_allowed_events:parsed(row.next_allowed_events,[]),resume_payload:parsed(row.resume_payload,null)}; }
function attemptBudgetUsed(total,counters={}){return Math.max(0,Number(total||0)-Number(counters.ai_budget_baseline_tokens||0));}
function aiBudgetLimit(counters={}){return Math.max(AI_TOKEN_BUDGET,Math.min(MAX_AI_TOKEN_BUDGET,Number(counters.ai_budget_limit_tokens||AI_TOKEN_BUDGET)));}
function nextAiBudgetLimit(counters={}){const current=aiBudgetLimit(counters);return current>=MAX_AI_TOKEN_BUDGET?null:Math.min(MAX_AI_TOKEN_BUDGET,current*2);}
function evidenceUrls(...manifests){
  const urls=[];
  for(const manifest of manifests.filter(Boolean)){
    for(const page of manifest.pages||[])if(page?.url)urls.push(page.url);
    for(const cluster of manifest.clusters||[])urls.push(...(cluster.url_examples||[]),...(cluster.representative_urls||[]));
    // AI Context Builder wraps each task-specific evidence pack in contexts.
    // Only pages actually routed to a Slice count as AI-seen; hidden pages in
    // the complete site map remain eligible for the blind sandbox set.
    for(const context of manifest.contexts||[]){
      const evidence=context?.evidence||{};
      for(const page of evidence.pages||[])if(page?.url)urls.push(page.url);
    }
  }
  return [...new Set(urls.filter(Boolean))];
}
function sandboxValidationRows(result={}){
  return [...(result.accepted_products||[]).map(item=>({url:validationUrlKey(item.source_url),errors:[]})),...(result.rejected_products||[]).map(item=>({url:validationUrlKey(item.source_url),errors:[...(item.validation_errors||[])].sort()})),...(result.failures||[]).map(item=>({url:validationUrlKey(item.source_url||item.url),errors:[item.code||item.error_code||item.message||'EXECUTION_FAILED']}))].sort((a,b)=>a.url.localeCompare(b.url));
}
function sandboxValidationFingerprint(result={}){return digest(sandboxValidationRows(result));}
function sandboxValidationProgress(previous,current){
  if(!previous||!current)return {comparable:false,improved:true};
  const before=sandboxValidationRows(previous),after=sandboxValidationRows(current),beforeUrls=before.map(item=>item.url),afterUrls=after.map(item=>item.url);
  if(JSON.stringify(beforeUrls)!==JSON.stringify(afterUrls))return {comparable:false,improved:true};
  const beforeTotal=Math.max(1,Number(previous.summary?.products_accepted||0)+Number(previous.summary?.products_rejected||0)+Number(previous.summary?.failures||0));
  const afterTotal=Math.max(1,Number(current.summary?.products_accepted||0)+Number(current.summary?.products_rejected||0)+Number(current.summary?.failures||0));
  const beforeRate=Number(previous.summary?.products_accepted||0)/beforeTotal,afterRate=Number(current.summary?.products_accepted||0)/afterTotal;
  return {comparable:true,improved:current.passed===true||afterRate>beforeRate,before_rate:beforeRate,after_rate:afterRate,same_failure:sandboxValidationFingerprint(previous)===sandboxValidationFingerprint(current)};
}

function canAutoFreezeRule(rule,sandboxResult){
  const summary=sandboxResult?.summary||{},site=sandboxResult?.site_validation||{},minimum=Number(rule?.config?.validation?.minimum_accepted_products||0);
  if(rule?.config?.schema_version!=='site-rule-config-v2'||sandboxResult?.passed!==true)return false;
  if(minimum<1||Number(summary.products_accepted||0)<minimum)return false;
  if(Number(summary.products_rejected||0)!==0||Number(summary.failures||0)!==0)return false;
  if(Number(site.products_failed||0)!==0||Number(site.network_failures||0)!==0)return false;
  return (sandboxResult.accepted_products||[]).length>=minimum&&(sandboxResult.accepted_products||[]).every(item=>item?.accepted===true&&!(item.validation_errors||[]).length);
}
function renderedEvidenceUsable(siteMap){
  return (siteMap?.pages||[]).some(page=>page.acquisition_channel==='rendered_html'&&(
    String(page.visible_text||'').trim().length>=200||
    (page.links||[]).length>=3||
    (page.json_ld||[]).some(value=>/"@type"\s*:\s*"?Product/i.test(String(value)))||
    (page.public_json_api_evidence||[]).some(item=>(item.arrays||[]).some(array=>(array.sample_records||[]).length>=3))
  ));
}

function businessCopy(state, workflow) {
  const ruleResult=workflow?.resume_payload?.sandbox_result;
  const accepted=Number(ruleResult?.summary?.products_accepted || 0);
  const copies={
    RULE_CHECKING:'正在检查这个网站是否已有可用规则。',SITE_MAPPING:'正在读取少量代表页面，了解网站结构。',AI_HYPOTHESIZING:'AI 正在根据官网证据生成采集规则。',
    DISCOVERY_RULE_TESTING:'正在测试规则能否区分产品页和普通页面。',EXTRACTION_RULE_TESTING:'正在用少量产品测试名称、字段和图片。',
    HUMAN_SAMPLE_REVIEW_REQUIRED:`系统已按新规则抽取 ${accepted} 个技术校验通过的样本。请核对桌面端字段对应关系、图片角色和来源路径；技术通过不代表业务内容已经确认。`,
    RULE_REVISING:'系统正在根据你指出的业务错误修正规则。',FULL_CRAWL_READY:'规则已冻结，可以按同一规则开始全站采集。',
    SYSTEM_REVIEW_QUEUED:'你选择了无法判断，系统将更换样本或检查证据完整性。',HUMAN_ANCHOR_REQUIRED:workflow?.resume_payload?.rejected_anchor_url?'刚才选择的页面没有通过产品页校验，请重新选择一个具体产品详情页。':'自动证据不足，需要你从少量页面中指出具体产品。',
    CANDIDATE_COLLECTION_COMPLETED:'官网候选产品已可靠采集完成，等待人工审核和发布。',
    WAITING_FOR_AI_BUDGET_APPROVAL:'默认 AI 分析额度已用完。现有证据和已完成步骤均已保存，等待你决定是否提高额度继续。',
    HANDOFF_REQUIRED:'自动分析路径已用尽，已安全停止，等待人工处理。',STOPPED_SAFE:'因安全或授权边界已停止，原始数据未修改。',
  };
  return copies[state] || '系统正在推进网站认知流程。';
}

function withBlindTestSeeds(rawConfig,siteMap,seenUrls=[]){
  const config=JSON.parse(JSON.stringify(rawConfig)),seenByAi=new Set(seenUrls.length?seenUrls:(siteMap.pages||[]).slice(0,4).map(page=>page.url));
  const unseen=(siteMap.clusters||[]).flatMap(cluster=>cluster.url_examples||[]).filter(url=>!seenByAi.has(url)&&roleFor(url,config)==='product_detail');
  const seeds=[];const add=url=>{if(url&&!seeds.includes(url)&&seeds.length<5)seeds.push(url);};
  for(const url of (config.discovery.seed_urls||[]).slice(0,2))add(url);
  for(const url of unseen)add(url);
  for(const url of config.discovery.seed_urls||[])add(url);
  config.discovery.seed_urls=seeds;
  config.sandbox.max_pages=5;config.sandbox.max_products=5;
  config.provenance.evidence_ids=appendEvidenceId(config.provenance.evidence_ids,`PROGRAM_BLIND_SET:${digest(seeds).slice(0,16)}`);
  return config;
}

function validationUrlKey(value){
  try{const url=new URL(String(value));url.hash='';return url.href.replace(/\/$/,'');}catch(_){return String(value||'').trim().replace(/\/$/,'');}
}
function withRequiredValidationSeeds(rawConfig,requiredUrls=[]){
  const config=JSON.parse(JSON.stringify(rawConfig)),required=[...new Map(requiredUrls.filter(Boolean).map(url=>[validationUrlKey(url),url])).values()];
  if(!required.length)return config;
  const limit=Math.max(required.length,Math.min(5,Number(config.sandbox?.max_pages||5)));
  const keys=new Set(required.map(validationUrlKey)),remaining=(config.discovery?.seed_urls||[]).filter(url=>!keys.has(validationUrlKey(url)));
  config.discovery={...config.discovery,seed_urls:[...required,...remaining].slice(0,limit)};
  config.sandbox={...config.sandbox,max_pages:limit,max_products:Math.max(required.length,Math.min(5,Number(config.sandbox?.max_products||5)))};
  config.provenance={...config.provenance,evidence_ids:appendEvidenceId(config.provenance?.evidence_ids,`PROGRAM_REQUIRED_REGRESSION_SET:${digest(required).slice(0,16)}`)};
  return config;
}
function enforceRequiredValidation(rawResult,requiredUrls=[]){
  const required=[...new Map(requiredUrls.filter(Boolean).map(url=>[validationUrlKey(url),url])).entries()];
  if(!required.length)return rawResult;
  const accepted=new Set((rawResult?.accepted_products||[]).filter(item=>item?.accepted===true&&!(item.validation_errors||[]).length).map(item=>validationUrlKey(item.source_url)));
  const failed=required.filter(([key])=>!accepted.has(key));
  if(!failed.length)return rawResult;
  const failures=failed.map(([,url])=>({stage:'required_regression_page',source_url:url,code:'REQUIRED_REGRESSION_PAGE_FAILED',message:'触发模板漂移的页面未通过新规则验收'}));
  return {...rawResult,passed:false,outcome:'REQUIRED_REGRESSION_PAGE_FAILED',summary:{...(rawResult?.summary||{}),failures:Number(rawResult?.summary?.failures||0)+failures.length},failures:[...(rawResult?.failures||[]),...failures]};
}

function refineFromValidation(rawConfig,result){
  const config=JSON.parse(JSON.stringify(rawConfig)),errors=(result.rejected_products||[]).flatMap(item=>item.validation_errors||[]);
  const missing=new Set(errors.filter(value=>value.startsWith('TEMPLATE_SIGNALS_MISSING:')).flatMap(value=>value.split(':')[1].split(',')));
  const remaining=config.template.required_signals.filter(signal=>!missing.has(signal));
  if(remaining.length>=2)config.template.required_signals=remaining;
  if(errors.includes('PRIMARY_IMAGE_CONFLICT')||errors.includes('PRIMARY_IMAGE_REUSED_ACROSS_PRODUCTS')){
    const role=config.schema_version==='site-rule-config-v1.1'?{role:'main'}:{};
    config.extraction.images.sources=[
      {type:'meta',property:'og:image',...role},
      {type:'json_ld_product',path:'image',...role},
    ];
  }
  const optionalMissing=new Set(errors.filter(value=>value.startsWith('REQUIRED_FIELD_MISSING:')).map(value=>value.split(':')[1]).filter(name=>name&&name!=='name'));
  if(optionalMissing.size){
    config.validation.required_fields=config.validation.required_fields.filter(name=>!optionalMissing.has(name));
    for(const name of optionalMissing)if(config.extraction.fields[name])config.extraction.fields[name].required=false;
  }
  config.provenance.generator='ai-site-rule-generator+validated-refinement';
  config.provenance.evidence_ids=appendEvidenceId(config.provenance.evidence_ids,`PROGRAM_VALIDATION_REFINEMENT:${digest(errors).slice(0,16)}`);
  return JSON.stringify(config)===JSON.stringify(rawConfig)?null:config;
}
function appendEvidenceId(values,value){const items=[...new Set([...(values||[]),value])];return items.length<=100?items:[...items.slice(0,99),value];}

function discoveryRole(raw,rule){
  return urlRole(raw,{matching_priority:['exclude','product_detail','listing'],...rule});
}

function uncoveredProductFamilyClusters(siteMap,rule){
  const listingPrefixes=(rule.listing_path_prefixes||[]).map(value=>String(value).replace(/\/+$/,'/'));
  if(!listingPrefixes.length)return [];
  const depth=value=>String(value||'').split('/').filter(Boolean).length;
  const gaps=[];
  for(const cluster of siteMap.clusters||[]){
    const examples=cluster.url_examples||cluster.representative_urls||[];
    if(!examples.length||Number(cluster.estimated_count||0)<3)continue;
    const roles=examples.map(url=>discoveryRole(url,rule));
    if(roles.includes('product_detail')||roles.every(role=>role==='exclude'))continue;
    const stable=String(cluster.decoded_path_pattern||'').split(/\{[^/{}]+\}/)[0].replace(/\/+$/,'/');
    const listing=listingPrefixes.find(prefix=>stable.startsWith(prefix)&&depth(stable)>depth(prefix));
    if(!listing)continue;
    gaps.push({cluster_id:cluster.cluster_id,path_pattern:cluster.decoded_path_pattern,estimated_count:Number(cluster.estimated_count||examples.length),sample_urls:examples.slice(0,3)});
  }
  return gaps;
}

function validateDiscoveryAgainstMap(siteMap,rule,seenUrls=[]){
  const all=[...new Set([siteMap.site?.entry_url,...(siteMap.clusters||[]).flatMap(cluster=>cluster.url_examples||[]),...(siteMap.pages||[]).map(page=>page.url)].filter(Boolean))];
  const productUrls=all.filter(url=>discoveryRole(url,rule)==='product_detail');
  const exposed=new Set(seenUrls.length?seenUrls:(rule.seed_urls||[])),unseen=productUrls.filter(url=>!exposed.has(url));
  const negativeUrls=all.filter(url=>url===siteMap.site?.entry_url||['exclude','listing'].includes(discoveryRole(url,rule)));
  const cases=[...(rule.seed_urls||[]).map(url=>({kind:'positive',url,expected_role:'product_detail',actual_role:discoveryRole(url,rule),passed:discoveryRole(url,rule)==='product_detail'})),...unseen.slice(0,3).map(url=>({kind:'blind',url,expected_role:'product_detail',actual_role:'product_detail',passed:true})),...negativeUrls.slice(0,8).map(url=>({kind:'negative',url,expected_role:'non_product',actual_role:discoveryRole(url,rule),passed:discoveryRole(url,rule)!=='product_detail'}))];
  const errors=[];
  if(productUrls.length<3)errors.push(`PRODUCT_CANDIDATE_COVERAGE_TOO_LOW:${productUrls.length}`);
  if(!unseen.length)errors.push('NO_UNSEEN_PRODUCT_CANDIDATE');
  const uncoveredClusters=uncoveredProductFamilyClusters(siteMap,rule);
  for(const cluster of uncoveredClusters.slice(0,8))errors.push(`PRODUCT_FAMILY_CLUSTER_UNCOVERED:${cluster.cluster_id}:${cluster.path_pattern}`);
  for(const item of cases)if(!item.passed)errors.push(`${item.kind.toUpperCase()}_ROLE_MISMATCH:${item.url}`);
  return {passed:!errors.length,errors,candidate_product_urls:productUrls.slice(0,50),unseen_product_urls:unseen.slice(0,20),uncovered_product_family_clusters:uncoveredClusters,cases};
}

function publicApiDiscovery(siteMap){
  const apiRule=siteMap.public_json_api_rule;
  if(!apiRule)return null;
  const apiPages=(siteMap.pages||[]).filter(page=>page.acquisition_channel==='public_json_api');
  if(apiPages.length<3)return null;
  const endpointPath=new URL(apiRule.endpoint_url).pathname||'/';
  const seedUrls=apiPages.slice(0,2).map(page=>page.url);
  return {
    output:{
      product_detail_path_prefixes:[endpointPath],
      listing_path_prefixes:[],
      exclude_path_prefixes:[],
      seed_urls:seedUrls,
      link_sources:[{selector:'.api-source',attribute:'href'}],
      required_signals:['JSON_LD_PRODUCT','H1','OG_IMAGE'],
      evidence_refs:[...(apiRule.evidence_refs||[]),...apiPages.slice(0,3).map(page=>page.page_id)].slice(0,30),
    },
    input_manifest:{
      schema_version:'program-public-json-api-discovery-v1',
      pages:apiPages.slice(0,2).map(page=>({page_id:page.page_id,url:page.url,content_hash:page.content_hash})),
      evidence_refs:apiRule.evidence_refs||[],
    },
    model:'program',
    prompt_version:'program-public-json-api-discovery-v1',
    usage:{input_tokens:0,output_tokens:0,total_tokens:0},
    calls:[],
  };
}

function augmentEvidenceForRule(siteMap,scope,discoveryRule,pageFetcher){
  return augmentProductEvidence(siteMap,scope,discoveryRule,{fetchHtml:pageFetcher});
}

function createSiteCognitionControl(db, dependencies = {}) {
  const schedule=dependencies.schedule||setImmediate;
  const siteRules=dependencies.siteRules || createSiteRuleControl(db,{fetchHtml:dependencies.fetchHtml});
  const siteMapBuilder=dependencies.buildSiteMap || buildSiteMap;
  const ruleGenerator=dependencies.generateSiteRule || generateSiteRule;
  const discoveryGenerator=dependencies.generateDiscoveryRule || generateDiscoveryRule;
  const cognitionGenerator=dependencies.generateCognitionDecision || generateCognitionDecision;
  const cognitionProber=dependencies.probeCognitionDecision || probeCognitionDecision;
  const pageFetcher=dependencies.fetchHtml || require('./product-ingestion-fetch').fetchHtml;
  const accessPreflight=dependencies.preflightAccess || preflightAccess;
  const boundedOfficialEvidence=dependencies.acquireBoundedOfficialEvidence || acquireBoundedOfficialEvidence;
  const renderedPageFetcher=dependencies.renderedFetchHtml || createHybridFetcher({fetchHtml:pageFetcher,renderHtml:dependencies.renderHtml});
  const publicApiRuleGenerator=dependencies.generatePublicJsonApiRule||generatePublicJsonApiRule;
  const now=dependencies.now || (()=>Date.now());
  const scheduleAt=dependencies.scheduleAt || ((callback,delay)=>{const timer=setTimeout(callback,Math.max(0,delay));timer.unref?.();return timer;});
  const globalSlots=dependencies.globalSlots||createGlobalSlotManager(db,{env:dependencies.env});
  const globalSlotRetryMs=Math.max(100,Number(dependencies.globalSlotRetryMs||process.env.INGESTION_GLOBAL_SLOT_RETRY_MS||1000));

  function scheduleAccessResume(workflow,resumeAt,actor='system:access-wait'){
    const delay=Math.max(0,Date.parse(resumeAt)-now());
    scheduleAt(async()=>{
      try{
        let current=await get(workflow.id);if(!current||current.state!=='RATE_LIMIT_WAITING')return;
        current=await move(current,'WAIT_EXPIRED','SUCCESS',{...(current.resume_payload||{}),wait_completed_at:new Date(now()).toISOString()},actor);
        await db.query("UPDATE product_ingestion_jobs SET status='discovering',current_stage='site_cognition',failure_code=NULL,last_error=NULL,finished_at=NULL,heartbeat_at=NOW() WHERE id=?",[current.job_id]);
        schedule(()=>execute(current.id,actor));
      }catch(error){console.error('Access wait resume failed:',{workflowId:workflow.id,code:error.code||error.name,message:error.message});}
    },delay);
  }

  async function stopAccess(workflow,outcome,reason,actor){
    const current=await move(workflow,'SECURITY_BLOCKED',outcome.category,{outcome,reason},actor);
    await db.query("UPDATE product_ingestion_jobs SET status='discovery_failed',current_stage='failed',failure_code=?,last_error=?,finished_at=NOW(),heartbeat_at=NOW() WHERE id=?",[outcome.category,String(reason||outcome.category).slice(0,1000),current.job_id]);
    return current;
  }

  async function runAccessPreflight(workflow,scope,actor){
    const result=await accessPreflight(scope,{fetchHtml:pageFetcher,now}),outcome=result.outcome;
    if(outcome.category==='SUCCESS')return move(workflow,'STATIC_ACCESS_READY','SUCCESS',{access_preflight:result},actor);
    if(outcome.category==='POLICY_BLOCKED'||outcome.category==='REDIRECT_SCOPE_REVIEW')return stopAccess(workflow,outcome,result.error?.message||'官网政策或授权范围不允许继续访问',actor);
    if(outcome.category==='RATE_LIMITED'||outcome.category==='TEMPORARY_NETWORK_FAILURE'||outcome.category==='UPSTREAM_UNAVAILABLE'){
      const attempts=Number(workflow.attempt_counters?.access_wait_attempts||0)+1;
      if(attempts>3){const exhausted={...outcome,category:'ACCESS_UNRELIABLE',terminal:true,next_action:'STOP_ACCESS_UNRELIABLE'};return stopAccess(workflow,exhausted,'有限访问复测已用尽，当前无法稳定读取官网',actor);}
      const resumeAt=result.retry_after_at||boundedBackoffAt(attempts,result.error?.headers,now()),counters={...workflow.attempt_counters,access_wait_attempts:attempts};
      await db.query('UPDATE product_ingestion_site_cognition_workflows SET attempt_counters=? WHERE id=?',[json(counters),workflow.id]);workflow.attempt_counters=counters;
      const event=outcome.category==='RATE_LIMITED'?'RATE_LIMITED':'EXECUTION_FAILED_RETRYABLE';
      const waiting=await move(workflow,event,outcome.category,{access_preflight:result,resume_at:resumeAt,attempt:attempts},actor);
      await db.query("UPDATE product_ingestion_site_cognition_workflows SET lease_expires_at=? WHERE id=?",[new Date(resumeAt),waiting.id]);
      await db.query("UPDATE product_ingestion_jobs SET status='discovering',current_stage='rate_limit_waiting',failure_code=?,last_error=?,heartbeat_at=NOW() WHERE id=?",[outcome.category,`网站访问将在 ${resumeAt} 后自动复测`,waiting.job_id]);
      scheduleAccessResume(waiting,resumeAt);return waiting;
    }
    if(['ACCESS_RESTRICTED','HUMAN_CHALLENGE'].includes(outcome.category))return move(workflow,'ACCESS_RESTRICTED',outcome.category,{access_preflight:result},actor);
    if(outcome.category==='JS_RENDER_REQUIRED')return move(workflow,'JS_REQUIRED',outcome.category,{access_preflight:result},actor);
    return moveToHandoff(workflow,'EXECUTION_FAILED_FINAL',{reason:result.error?.message||'访问预检失败',outcome},actor);
  }

  async function get(id) {
    const [rows]=await db.query('SELECT * FROM product_ingestion_site_cognition_workflows WHERE id=?',[Number(id)]);
    if(!rows[0])return null;
    const workflow=mapWorkflow(rows[0]);
    let totalTokens=0;
    if(workflow.state==='WAITING_FOR_AI_BUDGET_APPROVAL'){const [[tokenRow]]=await db.query('SELECT COALESCE(SUM(total_tokens),0) total_tokens FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=?',[workflow.id]);totalTokens=Number(tokenRow?.total_tokens||0);}
    const attemptTokens=attemptBudgetUsed(totalTokens,workflow.attempt_counters),limit=aiBudgetLimit(workflow.attempt_counters);
    const [events]=await db.query('SELECT * FROM product_ingestion_site_cognition_events WHERE workflow_id=? ORDER BY id',[workflow.id]);
    const rule=workflow.rule_id?await siteRules.get(workflow.rule_id):null;
    let human_anchor_candidates=[];
    if(workflow.state==='HUMAN_ANCHOR_REQUIRED'){
      const [evidence]=await db.query("SELECT content FROM product_ingestion_site_cognition_evidence WHERE workflow_id=? AND evidence_type='SITE_STRUCTURE_MAP' ORDER BY revision DESC,id DESC LIMIT 1",[workflow.id]);
      const map=parsed(evidence[0]?.content,{}),reviewIds=new Set(workflow.resume_payload?.system_review_anchor_page_ids||[]),requested=new Set((workflow.resume_payload?.decision?.probe_requests||[]).map(item=>item.target_page_id)),invalidUrls=new Set(workflow.resume_payload?.invalid_anchor_urls||[]);
      const pages=(map.pages||[]).filter(page=>!invalidUrls.has(page.url)&&(reviewIds.size?reviewIds.has(page.page_id):!requested.size||requested.has(page.page_id)));
      human_anchor_candidates=pages.slice(0,5).map(page=>({page_id:page.page_id,url:page.url,title:page.title,h1:page.h1}));
    }
    return {...workflow,business_summary:workflow.business_summary || businessCopy(workflow.state,workflow),ai_budget:{attempt_used_tokens:attemptTokens,total_used_tokens:totalTokens,current_limit_tokens:limit,next_limit_tokens:nextAiBudgetLimit(workflow.attempt_counters),max_limit_tokens:MAX_AI_TOKEN_BUDGET,approval_count:Number(workflow.attempt_counters?.ai_budget_approvals||0)},human_anchor_candidates,events:events.map(row=>({...row,id:Number(row.id),payload:parsed(row.payload,null)})),rule};
  }

  async function latestForJob(jobId) { const [rows]=await db.query('SELECT * FROM product_ingestion_site_cognition_workflows WHERE job_id=? ORDER BY id DESC LIMIT 1',[Number(jobId)]);return rows[0]?mapWorkflow(rows[0]):null; }
  async function list(query={}) { const params=[];let where='';if(query.job_id){where='WHERE workflow.job_id=?';params.push(Number(query.job_id));}const [rows]=await db.query(`SELECT workflow.*,source.brand_name,rule.status rule_status FROM product_ingestion_site_cognition_workflows workflow JOIN product_ingestion_sources source ON source.id=workflow.source_id LEFT JOIN product_ingestion_site_rules rule ON rule.id=workflow.rule_id ${where} ORDER BY workflow.id DESC LIMIT 100`,params);return rows.map(row=>({...mapWorkflow(row),business_summary:row.business_summary || businessCopy(row.state,mapWorkflow(row))})); }

  async function move(workflow, event, outcome='SUCCESS', payload=null, actor='system:site-cognition') {
    const change=transition(workflow.state,event);
    const summary=businessCopy(change.to,{...workflow,resume_payload:payload || workflow.resume_payload});
    const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{
      if(typeof conn.beginTransaction==='function'){await conn.beginTransaction();transaction=true;}
      const [updated]=await conn.query(`UPDATE product_ingestion_site_cognition_workflows SET state=?,state_version=state_version+1,next_allowed_events=?,last_event=?,business_summary=?,resume_payload=COALESCE(?,resume_payload),entered_at=NOW(),lease_expires_at=NULL,finished_at=? WHERE id=? AND state=? AND state_version=?`,[change.to,json(change.next_allowed_events),event,summary,json(payload),change.terminal?new Date():null,workflow.id,workflow.state,workflow.state_version]);
      if(!updated.affectedRows)fail('网站认知状态已变化，请刷新后重试',409,'SITE_COGNITION_STATE_CHANGED');
      await conn.query('INSERT INTO product_ingestion_site_cognition_events (workflow_id,from_state,to_state,event_type,outcome,payload,actor) VALUES (?,?,?,?,?,?,?)',[workflow.id,workflow.state,change.to,event,outcome,json(payload),actor]);
      if(transaction)await conn.commit();transaction=false;
    }catch(error){if(transaction)await conn.rollback();throw error;}
    finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
    return {...workflow,state:change.to,state_version:workflow.state_version+1,next_allowed_events:change.next_allowed_events,resume_payload:payload || workflow.resume_payload,business_summary:summary};
  }

  async function saveEvidence(workflow, siteMap) {
    const contentHash=digest(siteMap);
    const [existing]=await db.query("SELECT revision,content_hash FROM product_ingestion_site_cognition_evidence WHERE workflow_id=? AND evidence_type='SITE_STRUCTURE_MAP' ORDER BY revision DESC,id DESC LIMIT 1",[workflow.id]);
    if(existing[0]?.content_hash===contentHash){workflow.evidence_revision=Math.max(workflow.evidence_revision,Number(existing[0].revision));return siteMap;}
    const revision=workflow.evidence_revision+1,key=`site-map-r${revision}`;
    await db.query(`INSERT IGNORE INTO product_ingestion_site_cognition_evidence (workflow_id,revision,evidence_level,evidence_type,evidence_key,content,content_hash) VALUES (?,?,'L3','SITE_STRUCTURE_MAP',?,?,?)`,[workflow.id,revision,key,json(siteMap),contentHash]);
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET evidence_revision=? WHERE id=?',[revision,workflow.id]);
    workflow.evidence_revision=revision;
    return siteMap;
  }

  async function latestSavedSiteMap(workflowId){
    const [rows]=await db.query("SELECT content FROM product_ingestion_site_cognition_evidence WHERE workflow_id=? AND evidence_type='SITE_STRUCTURE_MAP' ORDER BY revision DESC,id DESC LIMIT 1",[workflowId]);
    return parsed(rows[0]?.content,null);
  }

  async function acquireOfficialEvidence(workflow,scope,actor){
    let result;
    try{await assertAiBudget(workflow,10000,'限定官网证据发现');result=await boundedOfficialEvidence(scope,{fetchHtml:pageFetcher});}
    catch(error){
      await saveAiAudit(workflow,error.details||null,'invalid',error.details?.validation_errors||[error.message],'bounded_official_page_discovery').catch(()=>{});
      const outcome=classifyIngestionOutcome(error,{stage:'bounded_official_evidence'});
      if(outcome.category==='AI_BUDGET_EXHAUSTED')return moveToHandoff(workflow,'EXECUTION_FAILED_FINAL',{reason:error.message,outcome},actor);
      return stopAccess(workflow,{...outcome,category:'NO_LEGAL_ACQUISITION_CHANNEL',terminal:true,next_action:'STOP_NO_LEGAL_CHANNEL'},'限定官网取证没有找到可供受控执行器稳定读取的官方产品页',actor);
    }
    await saveAiAudit(workflow,result.discovered||{model:'program',prompt_version:'no-ai-call',usage:{},calls:[]},'valid',[],'bounded_official_page_discovery');
    if(result.status==='js_required')return move(workflow,'JS_REQUIRED','JS_RENDER_REQUIRED',{bounded_official_evidence:{official_urls:result.official_urls,failures:result.failures,request_hash:result.discovered?.request_hash||null},access_upgrade:result.outcome},actor);
    if(result.status!=='ready')return stopAccess(workflow,result.outcome,'已找到官方页面线索，但受控执行器无法合法、稳定读取，已停止采集',actor);
    await saveEvidence(workflow,result.site_map);
    return move(workflow,'EVIDENCE_READY','SUCCESS',{bounded_official_evidence:{official_urls:result.official_urls,failures:result.failures,request_hash:result.discovered?.request_hash||null}},actor);
  }

  async function acquireRenderedEvidence(workflow,scope,actor){
    try{
      const officialUrls=workflow.resume_payload?.bounded_official_evidence?.official_urls||[];
      const renderedScope={...scope,seed_urls:officialUrls.length?officialUrls:scope.seed_urls,force_rendered_channel:true,allow_same_site_subresources:true,capture_public_json_api:true};
      const siteMap=await siteMapBuilder(renderedScope,{fetchHtml:renderedPageFetcher,discoverSitemapUrls:dependencies.discoverSitemapUrls});
      if(!(siteMap.pages||[]).length){const error=new Error('受控 JS 渲染没有取得可用的官网页面');error.code='JS_RENDER_EVIDENCE_EMPTY';throw error;}
      if(!renderedEvidenceUsable(siteMap)){
        return stopAccess(workflow,{schema_version:'ingestion-outcome-v1',category:'RENDERED_EVIDENCE_INSUFFICIENT',stage:'js_rendered_evidence',retryability:'none',next_action:'STOP_RENDERED_EVIDENCE_INSUFFICIENT',terminal:true,error_code:'RENDERED_EVIDENCE_INSUFFICIENT',http_status:null},'受控 JS 渲染已执行，但授权范围内没有形成可定位的产品正文或链接；已停止，避免把空页面重复交给 AI',actor);
      }
      siteMap.acquisition={channel:'rendered_html',rendered_pages:(siteMap.pages||[]).filter(page=>page.acquisition_channel==='rendered_html').length};
      const apiEvidence=(siteMap.pages||[]).flatMap(page=>page.public_json_api_evidence||[]).filter(item=>(item.arrays||[]).some(array=>(array.sample_records||[]).length>=3));
      if(apiEvidence.length){
        await saveEvidence(workflow,siteMap);
        try{
          await assertAiBudget(workflow,6500,'生成公开 JSON API 声明式规则');
          const generated=await publicApiRuleGenerator(siteMap,{env:process.env});
          await saveAiAudit(workflow,generated,'valid',[],'public_json_api_rule_generation');
          const rule=generated.rule,endpointHost=new URL(rule.endpoint_url).hostname.toLowerCase(),samples=apiEvidence.flatMap(item=>(item.arrays||[]).filter(array=>array.path===rule.items_path).flatMap(array=>array.sample_records||[])).slice(0,5);
          const assetHosts=new Set(siteMap.site.allowed_asset_hosts||[]);
          for(const record of samples)for(const path of rule.images.paths||[]){const values=getPath(record,path),items=Array.isArray(values)?values:[values];for(const raw of items)try{if(raw&&sameOfficialSite(raw,siteMap.site.entry_url))assetHosts.add(new URL(raw).hostname.toLowerCase());}catch{}}
          siteMap.site.allowed_hosts=[...new Set([...(siteMap.site.allowed_hosts||[]),endpointHost])];
          siteMap.site.allowed_asset_hosts=[...new Set([...assetHosts,endpointHost])];
          siteMap.public_json_api_rule=rule;
          const apiPages=samples.map((record,index)=>{const url=virtualProductUrl(rule,rule.pagination.start_page,index,record);return addApiRoutableEvidence(pageCard({url,status:200,contentType:'text/html; charset=utf-8',html:recordToCanonicalHtml(record,rule,url),acquisition_channel:'public_json_api'},`API-${String(index+1).padStart(3,'0')}`),record,rule);});
          siteMap.pages=[...apiPages,...siteMap.pages];
          siteMap.clusters=[{cluster_id:'API-UC-001',decoded_path_pattern:new URL(rule.endpoint_url).pathname,estimated_count:apiPages.length,representative_urls:apiPages.slice(0,3).map(page=>page.url),url_examples:apiPages.map(page=>page.url),representative_pages:apiPages.slice(0,3).map(page=>page.page_id)},...(siteMap.clusters||[])];
          siteMap.coverage={...siteMap.coverage,public_json_api_samples:apiPages.length};
          await db.query('UPDATE product_ingestion_sources SET allowed_hosts=?,allowed_asset_hosts=? WHERE id=?',[json(siteMap.site.allowed_hosts),json(siteMap.site.allowed_asset_hosts),workflow.source_id]);
          const [jobs]=await db.query('SELECT scope_snapshot FROM product_ingestion_jobs WHERE id=?',[workflow.job_id]),snapshot=parsed(jobs[0]?.scope_snapshot,{});
          snapshot.allowed_hosts=siteMap.site.allowed_hosts;snapshot.allowed_asset_hosts=siteMap.site.allowed_asset_hosts;
          await db.query('UPDATE product_ingestion_jobs SET scope_snapshot=? WHERE id=?',[json(snapshot),workflow.job_id]);
          siteMap.acquisition.public_json_api={endpoint_host:endpointHost,sample_products:apiPages.length,evidence_refs:rule.evidence_refs};
        }catch(error){
          await saveAiAudit(workflow,error.details||null,'invalid',error.details?.validation_errors||[error.message],'public_json_api_rule_generation').catch(()=>{});
          siteMap.acquisition.public_json_api={status:'not_usable',error_code:error.code||'PUBLIC_JSON_API_RULE_FAILED'};
        }
      }
      await saveEvidence(workflow,siteMap);
      return move(workflow,'RENDERED_EVIDENCE_READY','SUCCESS',{rendered_evidence:{pages:siteMap.pages.length,channel:'rendered_html'}},actor);
    }catch(error){
      const outcome=classifyIngestionOutcome(error,{stage:'js_rendered_evidence'});
      return stopAccess(workflow,{...outcome,category:'NO_LEGAL_ACQUISITION_CHANNEL',terminal:true,next_action:'STOP_NO_LEGAL_CHANNEL'},String(error.message||'受控 JS 渲染通道不可用').slice(0,1000),actor);
    }
  }

  async function stopEvidenceExhausted(workflow,reason,actor){
    const payload={reason:String(reason||'有限网站证据路径已用尽').slice(0,1000),outcome:{schema_version:'ingestion-outcome-v1',category:'EVIDENCE_EXHAUSTED',stage:workflow.state,retryability:'none',next_action:'STOP_EVIDENCE_EXHAUSTED',terminal:true}};
    const stopped=await move(workflow,'EVIDENCE_EXHAUSTED','NO_IMPROVEMENT',payload,actor);
    await db.query("UPDATE product_ingestion_jobs SET status='discovery_failed',current_stage='failed',failure_code='EVIDENCE_EXHAUSTED',last_error=?,finished_at=NOW(),heartbeat_at=NOW() WHERE id=?",[payload.reason,stopped.job_id]);
    await db.query("UPDATE product_ingestion_site_cognition_workflows SET last_error_code='EVIDENCE_EXHAUSTED',last_error=? WHERE id=?",[payload.reason,stopped.id]);
    return stopped;
  }

  async function runHypothesisLoop(workflow,siteMap,generated,actor,restartRecovery=false){
    let decision=generated.output,seen=new Set(workflow.attempt_counters?.evidence_probe_fingerprints||[]),rounds=Number(workflow.attempt_counters?.evidence_probe_rounds||0);
    while(true){
      if(decision?.next_decision?.action==='GENERATE_DISCOVERY_RULE')return draftAndTest(workflow,siteMap,actor,null,decision,restartRecovery);
      if(decision?.next_decision?.action!=='REQUEST_EVIDENCE')return stopEvidenceExhausted(workflow,decision?.next_decision?.reason||'AI 没有提出可执行的新证据路径',actor);
      if(rounds>=MAX_EVIDENCE_PROBE_ROUNDS)return stopEvidenceExhausted(workflow,`限定取证已达 ${MAX_EVIDENCE_PROBE_ROUNDS} 轮上限`,actor);
      const requests=decision.probe_requests||[],fingerprint=evidenceProbeFingerprint(requests);
      if(!requests.length||seen.has(fingerprint))return stopEvidenceExhausted(workflow,'AI 没有提出新的可定位证据，已防止重复取证和重复 Token 消耗',actor);
      seen.add(fingerprint);rounds+=1;
      workflow=await move(workflow,'NEED_MORE_EVIDENCE','NEED_MORE_EVIDENCE',{decision,bounded_targets:requests.map(item=>item.target_page_id),probe_round:rounds,probe_fingerprint:fingerprint},actor);
      workflow=await move(workflow,'SUCCESS','SUCCESS',{bounded_targets:requests.map(item=>item.target_page_id),probe_round:rounds},actor);
      await assertAiBudget(workflow,12000,`执行第 ${rounds} 轮限定官网取证`);
      const assessed=await cognitionProber(siteMap,decision);await saveAiAudit(workflow,assessed,'valid',[],`site_cognition_probe_assessment_r${rounds}`);
      const evidenceRecord={round:rounds,fingerprint,exact_urls:assessed.probe_evidence?.exact_urls||[],tool_calls:assessed.probe_evidence?.tool_calls||[],decision:assessed.output};
      const revision=workflow.evidence_revision+1;await db.query(`INSERT INTO product_ingestion_site_cognition_evidence (workflow_id,revision,evidence_level,evidence_type,evidence_key,content,content_hash) VALUES (?,?,'L4','AI_WEB_EXTRACTOR_RESULT',?,?,?)`,[workflow.id,revision,`web-extractor-r${revision}`,json(evidenceRecord),digest(evidenceRecord)]);await db.query('UPDATE product_ingestion_site_cognition_workflows SET evidence_revision=? WHERE id=?',[revision,workflow.id]);workflow.evidence_revision=revision;
      const counters={...workflow.attempt_counters,evidence_probe_rounds:rounds,evidence_probe_fingerprints:[...seen]};await db.query('UPDATE product_ingestion_site_cognition_workflows SET attempt_counters=? WHERE id=?',[json(counters),workflow.id]);workflow.attempt_counters=counters;
      workflow=await move(workflow,'SUCCESS','SUCCESS',{decision:assessed.output,evidence_gain:'bounded_web_extractor',probe_round:rounds,probe_fingerprint:fingerprint},actor);
      decision=assessed.output;
    }
  }

  async function authorizeFullCrawl(workflow,ruleId){
    const [rows]=await db.query('SELECT scope_snapshot,discovered_urls FROM product_ingestion_jobs WHERE id=?',[workflow.job_id]);
    const scope=parsed(rows[0]?.scope_snapshot,{}),rules=await loadFrozenSiteRules(db,workflow.source_id);
    scope.site_cognition_ready_rule_id=Number(ruleId);scope.site_cognition_workflow_id=Number(workflow.id);scope.site_rule_ids=rules.map(rule=>Number(rule.id));
    const checkpoint=scope.template_drift_checkpoint,discovered=parsed(rows[0]?.discovered_urls,[]);
    if(checkpoint?.active&&discovered.length){
      scope.seed_urls=discovered;scope.template_drift_checkpoint={...checkpoint,active:false,resumed_at:new Date().toISOString(),added_rule_id:Number(ruleId)};
      await db.query("UPDATE product_ingestion_jobs SET scope_snapshot=?,status='failed',checkpoint_index=?,current_stage='extraction',current_url=NULL,finished_at=NULL,last_error=NULL,failure_code=NULL WHERE id=?",[json(scope),Math.max(0,Number(checkpoint.resume_checkpoint||0)),workflow.job_id]);
      return {resume_mode:'extraction',checkpoint_index:Math.max(0,Number(checkpoint.resume_checkpoint||0))};
    }
    await db.query("UPDATE product_ingestion_jobs SET scope_snapshot=?,status='discovery_approved',current_stage='source_analysis',finished_at=NULL,last_error=NULL,failure_code=NULL WHERE id=?",[json(scope),workflow.job_id]);
    return {resume_mode:'discovery'};
  }

  async function isTemplateDriftRecovery(workflow){
    const [rows]=await db.query("SELECT id FROM product_ingestion_site_cognition_events WHERE workflow_id=? AND event_type='TEMPLATE_DRIFT' ORDER BY id DESC LIMIT 1",[workflow.id]);
    return Boolean(rows[0]);
  }

  async function saveAiAudit(workflow, generated, status='valid', errors=[], purpose='site_rule_generation') {
    const calls=generated?.calls || [],usage=generated?.usage || {};
    const [reservedRows]=await db.query("SELECT id FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=? AND status='reserved' ORDER BY id DESC LIMIT 1",[workflow.id]);
    if(reservedRows[0]&&generated?.preserve_reservation===true)return Number(reservedRows[0].id);
    if(reservedRows[0]){
      await db.query(`UPDATE product_ingestion_site_cognition_ai_calls SET purpose=?,model=?,prompt_version=?,evidence_revision=?,request_hash=?,input_manifest=?,raw_output=?,parsed_output=?,validation_errors=?,input_tokens=?,output_tokens=?,total_tokens=?,elapsed_ms=?,status=? WHERE id=? AND status='reserved'`,[
        purpose,generated?.model || 'unknown',generated?.prompt_version || (purpose==='site_cognition_hypothesis'?COGNITION_PROMPT_VERSION:PROMPT_VERSION),workflow.evidence_revision,generated?.request_hash || digest(errors),json(generated?.input_manifest || {}),json(calls),json(generated?.config || generated?.output || null),json(errors),Number(usage.input_tokens || 0),Number(usage.output_tokens || 0),Number(usage.total_tokens || 0),calls.reduce((sum,item)=>sum+Number(item.elapsed_ms || 0),0),status,reservedRows[0].id,
      ]);
      return Number(reservedRows[0].id);
    }
    const [result]=await db.query(`INSERT INTO product_ingestion_site_cognition_ai_calls (workflow_id,purpose,model,prompt_version,evidence_revision,request_hash,input_manifest,raw_output,parsed_output,validation_errors,input_tokens,output_tokens,total_tokens,elapsed_ms,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
      workflow.id,purpose,generated?.model || 'unknown',generated?.prompt_version || (purpose==='site_cognition_hypothesis'?COGNITION_PROMPT_VERSION:PROMPT_VERSION),workflow.evidence_revision,generated?.request_hash || digest(errors),json(generated?.input_manifest || {}),json(calls),json(generated?.config || generated?.output || null),json(errors),Number(usage.input_tokens || 0),Number(usage.output_tokens || 0),Number(usage.total_tokens || 0),calls.reduce((sum,item)=>sum+Number(item.elapsed_ms || 0),0),status,
    ]);
    return Number(result.insertId);
  }

  async function returnToHumanAnchor(workflowId,error,actor='system:anchored-rule-failure'){
    let current=await get(workflowId);if(!current)return null;
    const rejected=current.resume_payload?.page_url||current.resume_payload?.rejected_anchor_url||null;
    const payload={
      error_code:String(error?.code||'SITE_RULE_GENERATION_FAILED').slice(0,80),
      message:String(error?.message||error||'站点规则生成失败').slice(0,1000),
      rejected_anchor_url:rejected,
      invalid_anchor_urls:[...new Set([...(current.resume_payload?.invalid_anchor_urls||[]),rejected].filter(Boolean))],
      reason:'人工锚点没有生成可通过程序校验的产品发现规则',
    };
    const budgetEvent=allowedEvents(current.state).includes('EXECUTION_FAILED_FINAL')?'EXECUTION_FAILED_FINAL':allowedEvents(current.state).includes('BUDGET_EXHAUSTED')?'BUDGET_EXHAUSTED':null;
    if(error?.code==='SITE_COGNITION_AI_BUDGET_EXHAUSTED'&&budgetEvent){
      current=await move(current,budgetEvent,'EXECUTION_FAILED_FINAL',{...payload,reason:'本次 AI 调用预算已用尽，继续选择页面也不会改善，已停止等待新任务或人工接管'},actor);
      await db.query('UPDATE product_ingestion_site_cognition_workflows SET last_error_code=?,last_error=? WHERE id=?',[payload.error_code,payload.message,current.id]);
      await db.query("UPDATE product_ingestion_jobs SET status='discovery_failed',current_stage='failed',failure_code=?,last_error=?,finished_at=NOW(),heartbeat_at=NOW() WHERE id=?",[payload.error_code,payload.message,current.job_id]);
      return get(current.id);
    }
    if(current.state==='HYPOTHESIS_EVALUATING'||current.state==='DISCOVERY_RULE_TESTING'||current.state==='RULE_REVISING')current=await move(current,'NEED_HUMAN_ANCHOR','VALIDATION_FAILED',payload,actor);
    else if(['DISCOVERY_RULE_DRAFTING','EXTRACTION_RULE_DRAFTING','EXTRACTION_RULE_TESTING'].includes(current.state)){
      current=await move(current,'VALIDATION_FAILED','VALIDATION_FAILED',payload,actor);
      if(current.state==='RULE_REVISING')current=await move(current,'NEED_HUMAN_ANCHOR','VALIDATION_FAILED',payload,actor);
    }else return current;
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET last_error_code=?,last_error=? WHERE id=?',[payload.error_code,payload.message,current.id]);
    await db.query("UPDATE product_ingestion_jobs SET status='rule_review',current_stage='human_anchor',failure_code=NULL,last_error=NULL,finished_at=NULL,heartbeat_at=NOW() WHERE id=?",[current.job_id]);
    return get(current.id);
  }

  async function cachedAi(workflow,purpose,kind){
    const [rows]=await db.query("SELECT * FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=? AND purpose=? AND evidence_revision=? AND status='valid' ORDER BY id DESC LIMIT 1",[workflow.id,purpose,workflow.evidence_revision]);
    const row=rows[0];if(!row)return null;
    const value=parsed(row.parsed_output,null);if(!value)return null;
    return {
      [kind]:value,model:row.model,prompt_version:row.prompt_version,request_hash:row.request_hash,
      input_manifest:parsed(row.input_manifest,{}),usage:{input_tokens:0,output_tokens:0,total_tokens:0},
      calls:[{attempt:0,status:'valid',cached:true,source_ai_call_id:Number(row.id),elapsed_ms:0,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}],
    };
  }

  async function assertAiBudget(workflow,reserve,purpose){
    const [uncertain]=await db.query("SELECT id,purpose,created_at FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=? AND status='reserved' ORDER BY id DESC LIMIT 1",[workflow.id]);
    if(uncertain[0]){const error=new Error(`上一次 AI 请求在 Worker 中断时结果未知（请求 #${uncertain[0].id}），已阻止自动重复消费`);error.code='SITE_COGNITION_AI_REQUEST_UNCERTAIN';error.status=409;error.details={request_id:Number(uncertain[0].id),purpose:uncertain[0].purpose,created_at:uncertain[0].created_at,preserve_reservation:true};throw error;}
    const [[row]]=await db.query('SELECT COALESCE(SUM(total_tokens),0) used_tokens FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=?',[workflow.id]);
    const total=Number(row?.used_tokens||0),used=attemptBudgetUsed(total,workflow.attempt_counters),limit=aiBudgetLimit(workflow.attempt_counters),nextLimit=nextAiBudgetLimit(workflow.attempt_counters);
    if(used+Number(reserve||0)>limit){const error=new Error(`AI 分析已使用 ${used} token，继续${purpose}可能超过 ${limit} 上限，等待人工确认是否提高额度`);error.code='SITE_COGNITION_AI_BUDGET_EXHAUSTED';error.status=409;error.details={used_tokens:used,total_used_tokens:total,reserved_tokens:Number(reserve||0),limit,next_limit:nextLimit,max_limit:MAX_AI_TOKEN_BUDGET,purpose,approval_available:Boolean(nextLimit)};throw error;}
    const [stored]=await db.query(`INSERT INTO product_ingestion_site_cognition_ai_calls (workflow_id,purpose,model,prompt_version,evidence_revision,request_hash,input_manifest,raw_output,parsed_output,validation_errors,input_tokens,output_tokens,total_tokens,elapsed_ms,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'reserved')`,[workflow.id,String(purpose).slice(0,48),'pending',PROMPT_VERSION,workflow.evidence_revision,digest(`${workflow.id}:${workflow.evidence_revision}:${purpose}:${Date.now()}`),json({reserved_tokens:Number(reserve||0),reserved_at:new Date().toISOString()}),null,null,null,0,0,0,0]);
    return Number(stored.insertId);
  }

  async function extractionCheckpoint(workflow){
    const [events]=await db.query("SELECT payload FROM product_ingestion_site_cognition_events WHERE workflow_id=? AND to_state='EXTRACTION_RULE_DRAFTING' AND JSON_EXTRACT(payload,'$.discovery_rule') IS NOT NULL ORDER BY id DESC LIMIT 1",[workflow.id]);
    const payload=parsed(events[0]?.payload,{}),discoveryRule=payload.discovery_rule;
    if(!discoveryRule)return null;
    const [evidence]=await db.query("SELECT content FROM product_ingestion_site_cognition_evidence WHERE workflow_id=? AND evidence_type='SITE_STRUCTURE_MAP' ORDER BY revision DESC,id DESC LIMIT 1",[workflow.id]);
    const siteMap=parsed(evidence[0]?.content,null);
    let requiredValidationUrls=Array.isArray(payload.required_validation_urls)?payload.required_validation_urls:[];
    // Workflows already waiting for budget approval were created before the
    // regression URL was copied into the drafting event. Recover it from the
    // durable job snapshot so the first post-deploy resume is protected too.
    if(!requiredValidationUrls.length){
      try{
        const [jobs]=await db.query('SELECT scope_snapshot FROM product_ingestion_jobs WHERE id=?',[workflow.job_id]);
        const drift=parsed(jobs[0]?.scope_snapshot,{})?.template_drift_checkpoint;
        if(drift?.active&&drift.failed_url)requiredValidationUrls=[drift.failed_url];
      }catch(_){}
    }
    return siteMap?{siteMap,discoveryRule,requiredValidationUrls}:null;
  }

  async function finishWithHandoff(workflow,error,actor='system:site-cognition'){
    let current=await get(workflow.id).catch(()=>workflow),payload={error_code:error.code||'SITE_COGNITION_FAILED',message:String(error.message||error),reason:'当前阶段执行失败，证据与已通过阶段均已保留',outcome:classifyIngestionOutcome(error,{stage:workflow.state})};
    try{
      if(error.code==='SITE_COGNITION_AI_BUDGET_EXHAUSTED'&&allowedEvents(current.state).includes('BUDGET_EXHAUSTED')){
        current=await move(current,'BUDGET_EXHAUSTED','AI_BUDGET_APPROVAL_REQUIRED',{...payload,budget:{...error.details,failed_state:current.state},previous_payload:current.resume_payload},actor);
        if(!error.details?.approval_available)current=await move(current,'DECLINE','EXECUTION_FAILED_FINAL',{...payload,reason:`AI 分析已达到 ${MAX_AI_TOKEN_BUDGET} token 硬上限，已安全停止`,budget:error.details},actor);
      }
      else if(allowedEvents(current.state).includes('EXECUTION_FAILED_FINAL'))current=await move(current,'EXECUTION_FAILED_FINAL','EXECUTION_FAILED_FINAL',payload,actor);
      else if(allowedEvents(current.state).includes('VALIDATION_FAILED')){current=await move(current,'VALIDATION_FAILED','VALIDATION_FAILED',payload,actor);if(allowedEvents(current.state).includes('EXECUTION_FAILED_FINAL'))current=await move(current,'EXECUTION_FAILED_FINAL','EXECUTION_FAILED_FINAL',payload,actor);}
      else await db.query("UPDATE product_ingestion_site_cognition_workflows SET state='HANDOFF_REQUIRED',next_allowed_events=?,finished_at=NOW(),lease_expires_at=NULL WHERE id=?",[json(allowedEvents('HANDOFF_REQUIRED')),current.id]);
    }catch(_){await db.query("UPDATE product_ingestion_site_cognition_workflows SET state='HANDOFF_REQUIRED',next_allowed_events=?,finished_at=NOW(),lease_expires_at=NULL WHERE id=?",[json(allowedEvents('HANDOFF_REQUIRED')),current.id]).catch(()=>{});}
    const waiting=current.state==='WAITING_FOR_AI_BUDGET_APPROVAL';
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET last_error_code=?,last_error=?,business_summary=? WHERE id=?',[String(payload.error_code).slice(0,80),payload.message.slice(0,1000),waiting?'AI 默认额度已用完；现有证据和步骤已保存，等待确认是否提高额度继续。':'本次自动处理没有完成；已保留通过的步骤，可以从失败阶段重试。',current.id]).catch(()=>{});
    await db.query(`UPDATE product_ingestion_jobs SET status=?,current_stage=?,failure_code=?,last_error=?,finished_at=?,heartbeat_at=NOW() WHERE id=?`,[waiting?'rule_review':'discovery_failed',waiting?'ai_budget_approval':'failed',String(payload.error_code).slice(0,80),payload.message.slice(0,1000),waiting?null:new Date(),current.job_id]).catch(()=>{});
    return get(current.id).catch(()=>current);
  }

  async function moveToHandoff(workflow,outcome,payload,actor='system:site-cognition'){
    const current=await move(workflow,'EXECUTION_FAILED_FINAL',outcome,payload,actor);
    const message=String(payload?.reason||'自动分析路径已用尽，已保留证据并安全停止').slice(0,1000);
    await db.query("UPDATE product_ingestion_jobs SET status='discovery_failed',current_stage='failed',failure_code='SITE_COGNITION_EXHAUSTED',last_error=?,finished_at=NOW(),heartbeat_at=NOW() WHERE id=?",[message,current.job_id]);
    await db.query("UPDATE product_ingestion_site_cognition_workflows SET last_error_code='SITE_COGNITION_EXHAUSTED',last_error=? WHERE id=?",[message,current.id]);
    return current;
  }

  async function stopNoImprovement(workflow,result,comparison,actor,reason='新规则没有提高独立验证集通过率'){
    const counters={...workflow.attempt_counters,handoff_retries:2,no_improvement_retry_blocked:true,no_improvement_fingerprint:sandboxValidationFingerprint(result)};
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET attempt_counters=? WHERE id=?',[json(counters),workflow.id]);workflow.attempt_counters=counters;
    return moveToHandoff(workflow,'NO_IMPROVEMENT',{reason,retry_blocked:true,error_code:'SITE_RULE_NO_IMPROVEMENT',sandbox_result:result,comparison},actor);
  }

  async function saveTests(workflow, rule, siteMap, sandboxResult, analyzedUrls=[]) {
    const analyzed=new Set(analyzedUrls.length?analyzedUrls:(siteMap.pages || []).slice(0,4).map(page=>page.url));
    for(const row of [...(sandboxResult.accepted_products || []),...(sandboxResult.rejected_products || [])]){
      const kind=analyzed.has(row.source_url)?'extraction':'blind';
      await db.query('INSERT INTO product_ingestion_site_rule_test_cases (workflow_id,rule_id,test_kind,page_url,expected_role,actual_role,passed,result) VALUES (?,?,?,?,?,?,?,?)',[workflow.id,rule.id,kind,row.source_url,'product_detail',row.page_role,row.accepted?1:0,json(row)]);
    }
    for(const page of siteMap.pages || []){
      if(analyzed.has(page.url) && (page.url===siteMap.site.entry_url || (!page.json_ld.length && page.links.length>8))){
        const actual=require('./product-ingestion-site-rule-sandbox').roleFor(page.url,rule.config);
        await db.query('INSERT INTO product_ingestion_site_rule_test_cases (workflow_id,rule_id,test_kind,page_url,expected_role,actual_role,passed,result) VALUES (?,?,?,?,?,?,?,?)',[workflow.id,rule.id,'negative',page.url,'non_product',actual,actual!=='product_detail'?1:0,json({title:page.title,h1:page.h1})]);
      }
    }
  }

  async function saveDiscoveryTests(workflow,rule,result){
    for(const item of result.cases||[])await db.query('INSERT INTO product_ingestion_site_rule_test_cases (workflow_id,rule_id,test_kind,page_url,expected_role,actual_role,passed,result) VALUES (?,?,?,?,?,?,?,?)',[workflow.id,rule.id,item.kind,item.url,item.expected_role,item.actual_role,item.passed?1:0,json(item)]);
  }

  async function completeValidatedRule(workflow,rule,run,actor){
    workflow=await move(workflow,'SUCCESS','SUCCESS',{sandbox_result:run.result,rule_id:rule.id},actor);
    if(!canAutoFreezeRule(rule,run.result)){
      await db.query("UPDATE product_ingestion_jobs SET status='rule_review',current_stage='human_sample_review',discovery_summary=?,failure_code=NULL,last_error=NULL,finished_at=NULL,heartbeat_at=NOW() WHERE id=?",[json({site_cognition:{workflow_id:workflow.id,rule_id:rule.id,status:workflow.state},sandbox:run.result.summary}),workflow.job_id]);
      return workflow;
    }
    workflow=await move(workflow,'AUTO_VALIDATION_PASSED','SUCCESS',{rule_id:rule.id,automatic:true,technical_gate:'site-rule-sandbox-v2'},'system:auto-site-rule-gate');
    const preserveExisting=await isTemplateDriftRecovery(workflow);
    await siteRules.freeze(rule.id,{confirmation:'冻结此站点规则',preserve_existing_templates:preserveExisting},'system:auto-site-rule-gate');
    workflow=await move(workflow,'SUCCESS','SUCCESS',{rule_id:rule.id,automatic:true},'system:auto-site-rule-gate');
    const authorized=await authorizeFullCrawl(workflow,rule.id);
    dependencies.onFullCrawlReady?.(workflow.job_id,authorized);
    return workflow;
  }

  async function generateAndTestExtraction(workflow,extractionMap,discoveryRule,actor,feedback=null,{maxAttempts=2,discoveryTest=null,discoveryExposedUrls=[],requiredValidationUrls=[]}={}){
    const baselineRule=workflow.rule_id?await siteRules.get(workflow.rule_id):null,baselineResult=baselineRule?.last_sandbox_result||null;
    let generated;
    const contexts=buildExtractionContexts(extractionMap,{feedback,discoveryRule});
    const reserve=contexts.reduce((sum,item)=>sum+Number(item.budget?.reserved_total_tokens||0),0);
    try {await assertAiBudget(workflow,reserve,'生成字段和图片规则');generated=await ruleGenerator(extractionMap,{feedback,discoveryRule,maxAttempts,contexts});await saveAiAudit(workflow,generated);}
    catch(error){await saveAiAudit(workflow,error.details || null,'invalid',error.details?.validation_errors || [error.message]).catch(()=>{});throw error;}
    const analyzedUrls=evidenceUrls({pages:discoveryExposedUrls.map(url=>({url}))},generated.input_manifest);
    generated.config=withBlindTestSeeds(generated.config,extractionMap,analyzedUrls);
    generated.config=withRequiredValidationSeeds(generated.config,requiredValidationUrls);
    const rule=await siteRules.create(workflow.source_id,generated.config,'ai:site-rule-generator');
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET rule_id=? WHERE id=?',[rule.id,workflow.id]);workflow.rule_id=rule.id;
    workflow=await move(workflow,'SUCCESS','SUCCESS',{rule_id:rule.id},actor);
    const run=await siteRules.runSandbox(rule.id,'system:site-cognition');
    run.result=enforceRequiredValidation(run.result,requiredValidationUrls);
    if(discoveryTest)await saveDiscoveryTests(workflow,rule,discoveryTest);
    await saveTests(workflow,rule,extractionMap,run.result,analyzedUrls);
    if(!run.result.passed) {
      const baselineComparison=sandboxValidationProgress(baselineResult,run.result);
      if(baselineComparison.comparable&&!baselineComparison.improved)return stopNoImprovement(workflow,run.result,baselineComparison,actor);
      const counters={...workflow.attempt_counters,rule_revisions:Number(workflow.attempt_counters.rule_revisions || 0)+1};
      await db.query('UPDATE product_ingestion_site_cognition_workflows SET attempt_counters=? WHERE id=?',[json(counters),workflow.id]);workflow.attempt_counters=counters;
      workflow=await move(workflow,'VALIDATION_FAILED',run.result.outcome,{sandbox_result:run.result,validation_errors:run.result.rejected_products.flatMap(item=>item.validation_errors),rule_id:rule.id},actor);
      if(counters.rule_revisions>1)return moveToHandoff(workflow,'EXECUTION_FAILED_FINAL',{reason:'规则两轮抽样仍未通过',sandbox_result:run.result},actor);
      const refined=refineFromValidation(rule.config,run.result);
      if(refined){
        workflow=await move(workflow,'EXTRACTION_REVISED','SUCCESS',{reason:'只根据统一校验的可证伪信号收敛，不调用 AI'},'system:validation-refinement');
        const refinedRule=await siteRules.create(workflow.source_id,refined,'system:validation-refinement');
        await db.query('UPDATE product_ingestion_site_cognition_workflows SET rule_id=? WHERE id=?',[refinedRule.id,workflow.id]);workflow.rule_id=refinedRule.id;
        const refinedRun=await siteRules.runSandbox(refinedRule.id,'system:site-cognition');refinedRun.result=enforceRequiredValidation(refinedRun.result,requiredValidationUrls);await saveTests(workflow,refinedRule,extractionMap,refinedRun.result,analyzedUrls);
        if(refinedRun.result.passed){
          return completeValidatedRule(workflow,refinedRule,refinedRun,actor);
        }
        workflow=await move(workflow,'VALIDATION_FAILED',refinedRun.result.outcome,{sandbox_result:refinedRun.result,validation_errors:refinedRun.result.rejected_products.flatMap(item=>item.validation_errors),rule_id:refinedRule.id},actor);
        const comparison=sandboxValidationProgress(run.result,refinedRun.result);
        if(comparison.comparable&&!comparison.improved)return stopNoImprovement(workflow,refinedRun.result,comparison,actor);
      }
      return revise(workflow,extractionMap,{error_types:['automatic_validation_failed'],sandbox_summary:run.result.summary,rejected_pages:(run.result.rejected_products||[]).map(item=>({url:item.source_url,validation_errors:item.validation_errors})),execution_failures:run.result.failures},actor);
    }
    return completeValidatedRule(workflow,rule,run,actor);
  }

  async function draftAndTest(workflow, siteMap, actor, feedback=null, cognitionDecision=null, restartRecovery=false) {
    let discoveryGenerated=publicApiDiscovery(siteMap)||(restartRecovery?await cachedAi(workflow,'site_discovery_rule_generation','output'):null);
    if(!discoveryGenerated){
      try {await assertAiBudget(workflow,8000,'生成发现规则');discoveryGenerated=await discoveryGenerator(siteMap,{cognition:cognitionDecision});await saveAiAudit(workflow,discoveryGenerated,'valid',[],'site_discovery_rule_generation');}
      catch(error){await saveAiAudit(workflow,error.details || null,'invalid',error.details?.validation_errors || [error.message],'site_discovery_rule_generation').catch(()=>{});throw error;}
    }
    let discoveryRule=discoveryGenerated.output;
    workflow=await move(workflow,'GENERATE_DISCOVERY_RULE','SUCCESS',{site_map_hash:digest(siteMap),discovery_rule:discoveryRule},actor);
    workflow=await move(workflow,'SUCCESS','SUCCESS',{discovery_rule:discoveryRule},actor);
    let discoveryExposedUrls=evidenceUrls(discoveryGenerated.input_manifest);
    let discoveryTest=validateDiscoveryAgainstMap(siteMap,discoveryRule,discoveryExposedUrls);
    if(!discoveryTest.passed){
      workflow=await move(workflow,'VALIDATION_FAILED','NO_IMPROVEMENT',{discovery_rule:discoveryRule,discovery_test:discoveryTest},actor);
      await assertAiBudget(workflow,8000,'修订发现规则');
      discoveryGenerated=await discoveryGenerator(siteMap,{cognition:cognitionDecision,feedback:{validation_errors:discoveryTest.errors}});
      await saveAiAudit(workflow,discoveryGenerated,'valid',[],'site_discovery_rule_revision');
      discoveryRule=discoveryGenerated.output;
      workflow=await move(workflow,'DISCOVERY_REVISED','SUCCESS',{discovery_rule:discoveryRule},actor);
      discoveryExposedUrls=evidenceUrls(discoveryGenerated.input_manifest);
      discoveryTest=validateDiscoveryAgainstMap(siteMap,discoveryRule,discoveryExposedUrls);
      if(!discoveryTest.passed)return move(workflow,'NEED_HUMAN_ANCHOR','NO_IMPROVEMENT',{discovery_rule:discoveryRule,discovery_test:discoveryTest,reason:'两版发现规则都无法同时通过正例、反例和未见页检查'},actor);
    }
    workflow=await move(workflow,'SUCCESS','SUCCESS',{discovery_rule:discoveryRule,discovery_test:discoveryTest},actor);
    const extractionMap=await augmentEvidenceForRule(siteMap,{...siteMap.site,brand_name:siteMap.site.brand,base_url:siteMap.site.entry_url,allowed_hosts:siteMap.site.allowed_hosts,allowed_asset_hosts:siteMap.site.allowed_asset_hosts,allowed_path_prefixes:siteMap.site.allowed_path_prefixes,request_interval_ms:siteMap.site.request_interval_ms,source_status:'active',job_status:'discovering',source_id:workflow.source_id,job_id:workflow.job_id,policy_db:db,page_quota:{used:0,limit:8}},discoveryRule,pageFetcher);
    discoveryRule=normalizeDiscoveryRule(discoveryRule,extractionMap);
    await saveEvidence(workflow,extractionMap);
    return generateAndTestExtraction(workflow,extractionMap,discoveryRule,actor,feedback,{maxAttempts:2,discoveryTest,discoveryExposedUrls});
  }

  async function revise(workflow, siteMap, feedback, actor) {
    if(workflow.state!=='RULE_REVISING')fail('当前状态不能修订规则');
    // Return to a drafting state through the frozen topology.
    workflow=await move(workflow,'EXTRACTION_REVISED','SUCCESS',{feedback},actor);
    // A new generated version is tested as a complete rule; represent the
    // extraction-test retry without bypassing the state record.
    const previous=workflow.rule_id?await siteRules.get(workflow.rule_id):null,discoveryRule=previous?{seed_urls:previous.config.discovery.seed_urls,product_detail_path_prefixes:previous.config.discovery.product_detail_path_prefixes,listing_path_prefixes:previous.config.discovery.listing_path_prefixes,exclude_path_prefixes:previous.config.discovery.exclude_path_prefixes,product_detail_paths:previous.config.discovery.product_detail_paths||[],listing_paths:previous.config.discovery.listing_paths||[],exclude_paths:previous.config.discovery.exclude_paths||[],product_detail_path_patterns:previous.config.discovery.product_detail_path_patterns||[],listing_path_patterns:previous.config.discovery.listing_path_patterns||[],exclude_path_patterns:previous.config.discovery.exclude_path_patterns||[],link_sources:previous.config.discovery.link_sources,required_signals:previous.config.template.required_signals}:null;
    const allContexts=buildExtractionContexts(siteMap,{feedback,discoveryRule}),requested=sliceTasksForFeedback(feedback),contexts=requested.length?allContexts.filter(item=>requested.includes(item.task)):allContexts;
    if(!contexts.length)return moveToHandoff(workflow,'NO_IMPROVEMENT',{reason:'失败所在的结构 Slice 没有可路由证据，不允许用 AI 猜测修订'},actor);
    await assertAiBudget(workflow,contexts.reduce((sum,item)=>sum+Number(item.budget?.reserved_total_tokens||0),0),`定向修订 ${contexts.map(item=>item.task).join(', ')} Slice`);
    const generated=await ruleGenerator(siteMap,{feedback,discoveryRule,contexts,baseConfig:previous?.config,maxAttempts:1});await saveAiAudit(workflow,generated,'valid',[],'site_rule_slice_revision');
    const analyzedUrls=evidenceUrls(generated.input_manifest);
    generated.config=withBlindTestSeeds(generated.config,siteMap,analyzedUrls);
    let rule=await siteRules.create(workflow.source_id,generated.config,'ai:site-rule-revision');
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET rule_id=? WHERE id=?',[rule.id,workflow.id]);workflow.rule_id=rule.id;
    let run=await siteRules.runSandbox(rule.id,'system:site-cognition');await saveTests(workflow,rule,siteMap,run.result,analyzedUrls);
    if(!run.result.passed){
      const comparison=sandboxValidationProgress(previous?.last_sandbox_result,run.result);
      if(comparison.comparable&&!comparison.improved)return stopNoImprovement(workflow,run.result,comparison,actor);
      const refined=refineFromValidation(rule.config,run.result);
      if(refined){
        const refinedRule=await siteRules.create(workflow.source_id,refined,'system:validation-refinement');
        await db.query('UPDATE product_ingestion_site_cognition_workflows SET rule_id=? WHERE id=?',[refinedRule.id,workflow.id]);workflow.rule_id=refinedRule.id;
        const refinedRun=await siteRules.runSandbox(refinedRule.id,'system:site-cognition');await saveTests(workflow,refinedRule,siteMap,refinedRun.result,analyzedUrls);
        if(refinedRun.result.passed){run=refinedRun;rule=refinedRule;}
        else {const refinedComparison=sandboxValidationProgress(run.result,refinedRun.result);if(refinedComparison.comparable&&!refinedComparison.improved)return stopNoImprovement(workflow,refinedRun.result,refinedComparison,actor);return moveToHandoff(workflow,refinedRun.result.outcome,{sandbox_result:refinedRun.result,reason:'AI 修订和基于盲测证据的安全收敛均未通过'},actor);}
      }else return moveToHandoff(workflow,run.result.outcome,{sandbox_result:run.result,reason:'修订规则仍未通过抽样'},actor);
    }
    return completeValidatedRule(workflow,rule,run,actor);
  }

  async function systemReview(workflow,originState){
    const [evidence]=await db.query("SELECT content FROM product_ingestion_site_cognition_evidence WHERE workflow_id=? AND evidence_type='SITE_STRUCTURE_MAP' ORDER BY revision DESC,id DESC LIMIT 1",[workflow.id]);
    const siteMap=parsed(evidence[0]?.content,null);
    if(!siteMap)return moveToHandoff(workflow,'EXECUTION_FAILED_FINAL',{reason:'系统复核时没有找到已保存的官网证据'},'system:review');
    if(originState==='HUMAN_ANCHOR_REQUIRED'){
      const previouslyShown=new Set((workflow.resume_payload?.previous_payload?.decision?.probe_requests||[]).map(item=>item.target_page_id));
      const pages=(siteMap.pages||[]).filter(page=>!previouslyShown.has(page.page_id));
      const choices=pages.slice(previouslyShown.size?0:5,previouslyShown.size?5:10).map(page=>page.page_id);
      if(!choices.length)return moveToHandoff(workflow,'EXECUTION_FAILED_FINAL',{reason:'系统已更换完所有有限候选，仍需人工提供一个产品页地址'},'system:review');
      return move(workflow,'ANCHOR_SAMPLE_SELECTED','SUCCESS',{system_review_anchor_page_ids:choices,reason:'系统已更换一组页面供业务判断'},'system:review');
    }
    const previous=workflow.rule_id?await siteRules.get(workflow.rule_id):null;
    if(!previous)return move(workflow,'NEED_HUMAN_ANCHOR','NO_IMPROVEMENT',{reason:'系统复核时没有可重新抽样的规则'},'system:review');
    const previousPayload=workflow.resume_payload?.previous_payload||{},prior=new Set([...(previous.config.discovery.seed_urls||[]),...((previousPayload.sandbox_result?.accepted_products||[]).map(item=>item.source_url))]);
    const alternatives=(siteMap.clusters||[]).flatMap(cluster=>cluster.url_examples||[]).filter(url=>!prior.has(url)&&roleFor(url,previous.config)==='product_detail').slice(0,5);
    if(alternatives.length<3)return move(workflow,'NEED_HUMAN_ANCHOR','NO_IMPROVEMENT',{reason:'可用的未见产品页不足 3 个，需要一个最小业务锚点'},'system:review');
    const config=JSON.parse(JSON.stringify(previous.config));
    config.discovery.seed_urls=alternatives;config.provenance.generator='system-review-resample';config.provenance.generated_at=new Date().toISOString();config.provenance.evidence_ids=appendEvidenceId(config.provenance.evidence_ids,`PROGRAM_SYSTEM_REVIEW:${digest(alternatives).slice(0,16)}`);
    const rule=await siteRules.create(workflow.source_id,config,'system:review-resample');
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET rule_id=? WHERE id=?',[rule.id,workflow.id]);workflow.rule_id=rule.id;
    const run=await siteRules.runSandbox(rule.id,'system:review-resample');await saveTests(workflow,rule,siteMap,run.result);
    if(!run.result.passed)return move(workflow,'NEED_HUMAN_ANCHOR',run.result.outcome,{reason:'系统更换样本后仍未通过统一校验',sandbox_result:run.result},'system:review');
    workflow=await move(workflow,'SAMPLE_SELECTED','SUCCESS',{reason:'系统已用未见过的产品页重新抽样',sandbox_result:run.result,rule_id:rule.id},'system:review');
    await db.query("UPDATE product_ingestion_jobs SET status='rule_review',current_stage='human_sample_review',discovery_summary=?,failure_code=NULL,last_error=NULL,finished_at=NULL,heartbeat_at=NOW() WHERE id=?",[json({site_cognition:{workflow_id:workflow.id,rule_id:rule.id,status:workflow.state,system_review:true},sandbox:run.result.summary}),workflow.job_id]);
    return workflow;
  }

  async function execute(id, actor='system:site-cognition') {
    if(running.has(Number(id)))return;
    running.add(Number(id));
    let globalSlot;
    try{
      globalSlot=await globalSlots.acquire({jobId:id,phase:'site-cognition'});
      if(!globalSlot){scheduleAt(()=>execute(Number(id),actor),globalSlotRetryMs);return;}
      let workflow=await get(id);if(!workflow)return;
      const restartRecovery=Boolean(workflow.resume_payload?.restart_recovery);
      const [jobs]=await db.query(`SELECT job.*,source.status source_status,source.brand_name,source.base_url,source.allowed_hosts,source.allowed_asset_hosts,source.allowed_path_prefixes FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=?`,[workflow.job_id]);
      const job=jobs[0];if(!job)fail('认知流程关联的抓取任务不存在',404);
      if(job.source_status!=='active')fail('来源已暂停，网站认知不能继续',409,'SOURCE_NOT_ACTIVE');
      const savedScope=parsed(job.scope_snapshot,{}),driftCheckpoint=savedScope.template_drift_checkpoint,driftSeed=driftCheckpoint?.active&&driftCheckpoint?.failed_url;
      const driftNeighbors=driftSeed?[...new Set([driftSeed,...(savedScope.seed_urls||[]).slice(Number(driftCheckpoint.resume_checkpoint||0),Number(driftCheckpoint.resume_checkpoint||0)+5),...(savedScope.discovery_entry_urls||[])])]:null;
      const scope={...savedScope,...(driftNeighbors?{seed_urls:driftNeighbors}:{}),source_id:workflow.source_id,job_id:workflow.job_id,job_status:'discovering',source_status:job.source_status,brand_name:job.brand_name,base_url:job.base_url,allowed_hosts:parsed(job.allowed_hosts,[]),allowed_asset_hosts:parsed(job.allowed_asset_hosts,[]),allowed_path_prefixes:parsed(job.allowed_path_prefixes,[]),policy_db:db,page_quota:{used:0,limit:Math.min(20,Number(job.max_pages || 20))}};
      if(workflow.state==='RULE_CHECKING'){
        const existing=await loadFrozenSiteRule(db,workflow.source_id),frozen=existing?.config?.schema_version==='site-rule-config-v2'?existing:null;
        workflow=await move(workflow,frozen?'RULE_FOUND':'NO_RULE','SUCCESS',frozen?{rule_id:frozen.id}:null,actor);
        if(frozen){
          await db.query('UPDATE product_ingestion_site_cognition_workflows SET rule_id=? WHERE id=?',[frozen.id,workflow.id]);workflow.rule_id=frozen.id;
          const recheck=await siteRules.revalidateFrozen(frozen.id,'system:site-rule-revalidation');
          if(recheck.result.passed){
            workflow=await move(workflow,'SUCCESS','SUCCESS',{rule_id:frozen.id,revalidation:recheck.result.summary},actor);
            const authorized=await authorizeFullCrawl(workflow,frozen.id);
            dependencies.onFullCrawlReady?.(workflow.job_id,authorized);return;
          }
          workflow=await move(workflow,'VALIDATION_FAILED',recheck.result.outcome,{rule_id:frozen.id,revalidation:recheck.result},actor);
        }
      }
      if(workflow.state==='ACCESS_PREFLIGHT')workflow=await runAccessPreflight(workflow,scope,actor);
      if(workflow.state==='BOUNDED_EVIDENCE_REQUIRED')workflow=await acquireOfficialEvidence(workflow,scope,actor);
      if(workflow.state==='JS_CHANNEL_REQUIRED')workflow=await acquireRenderedEvidence(workflow,scope,actor);
      if(['RATE_LIMIT_WAITING','WAITING_FOR_AI_BUDGET_APPROVAL','STOPPED_SAFE','HANDOFF_REQUIRED'].includes(workflow.state))return workflow;
      if(workflow.state!=='SITE_MAPPING')fail(`当前状态 ${workflow.state} 不能建立网站结构地图`,409,'SITE_COGNITION_STATE_INVALID');
      const savedChannelEvidence=workflow.resume_payload?.bounded_official_evidence||workflow.resume_payload?.rendered_evidence;
      const siteMap=(savedChannelEvidence||restartRecovery)?await latestSavedSiteMap(workflow.id):await siteMapBuilder(scope,{fetchHtml:pageFetcher,discoverSitemapUrls:dependencies.discoverSitemapUrls});
      if(!siteMap)fail('限定官网取证结果缺少已保存的网站结构地图',409,'BOUNDED_EVIDENCE_MAP_MISSING');
      await saveEvidence(workflow,siteMap);
      workflow=await move(workflow,'SUCCESS','SUCCESS',{coverage:siteMap.coverage},actor);
      if(driftCheckpoint?.active){
        const frozenRules=await loadFrozenSiteRules(db,workflow.source_id),baseRule=frozenRules[0];
        if(baseRule){
          const config=baseRule.config,discoveryRule={seed_urls:config.discovery.seed_urls,product_detail_path_prefixes:config.discovery.product_detail_path_prefixes,listing_path_prefixes:config.discovery.listing_path_prefixes,exclude_path_prefixes:config.discovery.exclude_path_prefixes,product_detail_paths:config.discovery.product_detail_paths||[],listing_paths:config.discovery.listing_paths||[],exclude_paths:config.discovery.exclude_paths||[],product_detail_path_patterns:config.discovery.product_detail_path_patterns||[],listing_path_patterns:config.discovery.listing_path_patterns||[],exclude_path_patterns:config.discovery.exclude_path_patterns||[],link_sources:config.discovery.link_sources,required_signals:config.template.required_signals};
          const requiredValidationUrls=[driftCheckpoint.failed_url].filter(Boolean);
          workflow=await move(workflow,'GENERATE_DISCOVERY_RULE','SUCCESS',{reused_rule_id:baseRule.id,reason:'模板漂移只补充提取模板，不重复生成已验证的全站发现规则',required_validation_urls:requiredValidationUrls},'system:template-checkpoint');
          workflow=await move(workflow,'SUCCESS','SUCCESS',{reused_rule_id:baseRule.id,discovery_rule:discoveryRule,required_validation_urls:requiredValidationUrls},'system:template-checkpoint');
          workflow=await move(workflow,'SUCCESS','SUCCESS',{reused_rule_id:baseRule.id,discovery_rule:discoveryRule,required_validation_urls:requiredValidationUrls},'system:template-checkpoint');
          const extractionMap=await augmentEvidenceForRule(siteMap,{...siteMap.site,brand_name:siteMap.site.brand,base_url:siteMap.site.entry_url,allowed_hosts:siteMap.site.allowed_hosts,allowed_asset_hosts:siteMap.site.allowed_asset_hosts,allowed_path_prefixes:siteMap.site.allowed_path_prefixes,request_interval_ms:siteMap.site.request_interval_ms,source_status:'active',job_status:'discovering',source_id:workflow.source_id,job_id:workflow.job_id,policy_db:db,page_quota:{used:0,limit:8}},discoveryRule,pageFetcher);
          await saveEvidence(workflow,extractionMap);
          // Await here so budget and rule-generation failures stay inside this
          // executor's catch block and enter the workflow handoff state.
          return await generateAndTestExtraction(workflow,extractionMap,normalizeDiscoveryRule(discoveryRule,extractionMap),actor,null,{maxAttempts:2,requiredValidationUrls});
        }
      }
      if(siteMap.public_json_api_rule)return await draftAndTest(workflow,siteMap,actor,null,{next_decision:{action:'GENERATE_DISCOVERY_RULE',reason:'已验证的公开 JSON API 合同可直接确定商品记录范围'}},restartRecovery);
      let cognitionDecision=restartRecovery?await cachedAi(workflow,'site_cognition_hypothesis','output'):null;
      try{if(!cognitionDecision){await assertAiBudget(workflow,12000,'形成页面角色假设');cognitionDecision=await cognitionGenerator(siteMap);await saveAiAudit(workflow,cognitionDecision,'valid',[],'site_cognition_hypothesis');}}
      catch(error){await saveAiAudit(workflow,error.details||null,'invalid',error.details?.validation_errors||[error.message],'site_cognition_hypothesis').catch(()=>{});throw error;}
      return await runHypothesisLoop(workflow,siteMap,cognitionDecision,actor,restartRecovery);
    }catch(error){
      console.error('Site cognition failed:',{workflowId:id,code:error.code || error.name,message:error.message});
      const current=await get(id).catch(()=>null);
      if(current){
        if(current.state==='STOPPED_SAFE')return;
        await finishWithHandoff(current,error,actor);
      }
    }finally{await globalSlot?.release();running.delete(Number(id));}
  }

  async function startForJob(jobId, actor='system:site-cognition') {
    const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false,result;
    try{
      if(typeof conn.beginTransaction==='function'){await conn.beginTransaction();transaction=true;}
      const [jobs]=await conn.query('SELECT id,source_id,status FROM product_ingestion_jobs WHERE id=? FOR UPDATE',[Number(jobId)]);const job=jobs[0];
      if(!job)fail('抓取任务不存在',404);
      const [existingRows]=await conn.query('SELECT * FROM product_ingestion_site_cognition_workflows WHERE job_id=? ORDER BY id DESC LIMIT 1',[Number(jobId)]);
      const existing=existingRows[0]?mapWorkflow(existingRows[0]):null;
      if(existing&&!['COMPLETED','CANDIDATE_COLLECTION_COMPLETED','HANDOFF_REQUIRED','STOPPED_SAFE'].includes(existing.state)){
        if(transaction)await conn.commit();transaction=false;return existing;
      }
      if(job.status!=='discovery_approved')fail('任务尚未授权网站分析');
      const [claimed]=await conn.query("UPDATE product_ingestion_jobs SET status='discovering',current_stage='site_cognition',heartbeat_at=NOW(),started_at=COALESCE(started_at,NOW()) WHERE id=? AND status='discovery_approved'",[job.id]);
      if(!claimed.affectedRows)fail('任务状态已变化，请刷新后重试',409,'SITE_COGNITION_JOB_STATE_CHANGED');
      [result]=await conn.query(`INSERT INTO product_ingestion_site_cognition_workflows (source_id,job_id,state,attempt_counters,next_allowed_events,last_event,business_summary,started_by,lease_expires_at,entered_at) VALUES (?,?,'RULE_CHECKING',?,?,?,'正在检查这个网站是否已有可用规则。',?,DATE_ADD(NOW(),INTERVAL 5 MINUTE),NOW())`,[job.source_id,job.id,json({ai_format_retries:0,rule_revisions:0,network_retries:0}),json(allowedEvents('RULE_CHECKING')),'START',actor]);
      if(transaction)await conn.commit();transaction=false;
    }catch(error){if(transaction)await conn.rollback();throw error;}
    finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
    schedule(()=>execute(result.insertId,actor));
    return get(result.insertId);
  }

  async function retryHandoff(id, actor='system:operator') {
    let workflow=await get(id);if(!workflow)fail('网站认知流程不存在',404);
    if(workflow.state!=='HANDOFF_REQUIRED')fail('当前流程不需要人工重试',409,'SITE_COGNITION_RETRY_NOT_REQUIRED');
    if(workflow.resume_payload?.retry_blocked||workflow.attempt_counters?.no_improvement_retry_blocked)fail('新规则未提高独立验证集通过率，已阻止再次进入相同 AI 路径；请直接检查异常候选',409,'SITE_COGNITION_NO_IMPROVEMENT_RETRY_BLOCKED');
    const checkpoint=await extractionCheckpoint(workflow),retries=Number(workflow.attempt_counters?.handoff_retries||0);
    if(retries>=2)fail('同一任务已完成两次受控重试，请新建任务或转人工检查',409,'SITE_COGNITION_RETRY_EXHAUSTED');
    const [[usage]]=await db.query('SELECT COALESCE(SUM(total_tokens),0) total_tokens FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=?',[workflow.id]);
    // A program-owned assembly/validation defect must not silently grant a fresh
    // model budget. Preserve the operator-approved budget window and retry only
    // the failed stage after the program contract has been corrected.
    const preserveApprovedWindow=Number(workflow.attempt_counters?.ai_budget_approvals||0)>0&&['INGESTION_SITE_RULE_ASSEMBLY_INVALID','INGESTION_AI_SCHEMA_INVALID'].includes(workflow.last_error_code);
    const counters={...workflow.attempt_counters,handoff_retries:retries+1,ai_budget_baseline_tokens:preserveApprovedWindow?Number(workflow.attempt_counters?.ai_budget_baseline_tokens||0):Number(usage?.total_tokens||0)};
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET attempt_counters=? WHERE id=?',[json(counters),workflow.id]);workflow.attempt_counters=counters;
    const previous={error_code:workflow.last_error_code,error:workflow.last_error,resume_payload:workflow.resume_payload};
    const priorSandbox=workflow.resume_payload?.sandbox_result;
    const sampleCoverageOnly=Boolean(checkpoint&&workflow.rule&&priorSandbox?.outcome==='PARTIAL_IMPROVEMENT'&&Number(priorSandbox?.summary?.products_accepted||0)>0&&Number(priorSandbox?.summary?.products_rejected||0)===0&&Number(priorSandbox?.summary?.failures||0)===0);
    workflow=await move(workflow,checkpoint?'RETRY_EXTRACTION':'RETRY','SUCCESS',{restart_recovery:true,recovery_stage:checkpoint?'extraction':'site_mapping',previous_payload:previous},actor);
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET last_error_code=NULL,last_error=NULL WHERE id=?',[workflow.id]);
    workflow.last_error_code=null;workflow.last_error=null;
    await db.query("UPDATE product_ingestion_jobs SET status='discovering',current_stage='site_cognition',failure_code=NULL,last_error=NULL,finished_at=NULL,current_url=NULL,heartbeat_at=NOW() WHERE id=?",[workflow.job_id]);
    if(sampleCoverageOnly)schedule(async()=>{
      try{
        const [calls]=await db.query("SELECT input_manifest FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=? AND status='valid' AND purpose IN ('site_rule_generation','site_rule_slice_revision') ORDER BY id DESC LIMIT 1",[workflow.id]);
        const seen=evidenceUrls(parsed(calls[0]?.input_manifest,{})),config=withBlindTestSeeds(workflow.rule.config,checkpoint.siteMap,seen);
        if(config.discovery.seed_urls.length<=workflow.rule.config.discovery.seed_urls.length)fail('没有找到可用的未见产品页补足技术抽样',409,'SITE_COGNITION_BLIND_SAMPLE_EXHAUSTED');
        const rule=await siteRules.create(workflow.source_id,config,'system:blind-sample-recovery');
        await db.query('UPDATE product_ingestion_site_cognition_workflows SET rule_id=? WHERE id=?',[rule.id,workflow.id]);workflow.rule_id=rule.id;
        workflow=await move(workflow,'SUCCESS','SUCCESS',{rule_id:rule.id,recovery:'blind_sample_coverage'},actor);
        const run=await siteRules.runSandbox(rule.id,'system:blind-sample-recovery');await saveTests(workflow,rule,checkpoint.siteMap,run.result,seen);
        if(run.result.passed)return completeValidatedRule(workflow,rule,run,actor);
        workflow=await move(workflow,'VALIDATION_FAILED',run.result.outcome,{sandbox_result:run.result,validation_errors:run.result.rejected_products.flatMap(item=>item.validation_errors),rule_id:rule.id},actor);
        return moveToHandoff(workflow,'EXECUTION_FAILED_FINAL',{reason:'补足未见样品后仍未通过统一校验',sandbox_result:run.result},actor);
      }catch(error){console.error('Site cognition blind sample retry failed:',{workflowId:workflow.id,code:error.code||error.name,message:error.message});await finishWithHandoff(workflow,error,actor);}
    });else if(checkpoint)schedule(async()=>{
      try{
        const siteMap=checkpoint.siteMap;
        const extractionMap=await augmentEvidenceForRule(siteMap,{...siteMap.site,brand_name:siteMap.site.brand,base_url:siteMap.site.entry_url,allowed_hosts:siteMap.site.allowed_hosts,allowed_asset_hosts:siteMap.site.allowed_asset_hosts,allowed_path_prefixes:siteMap.site.allowed_path_prefixes,request_interval_ms:siteMap.site.request_interval_ms,source_status:'active',job_status:'discovering',source_id:workflow.source_id,job_id:workflow.job_id,policy_db:db,page_quota:{used:0,limit:8}},checkpoint.discoveryRule,pageFetcher);
        const discoveryRule=normalizeDiscoveryRule(checkpoint.discoveryRule,extractionMap);
        await saveEvidence(workflow,extractionMap);
        await generateAndTestExtraction(workflow,extractionMap,discoveryRule,actor,null,{maxAttempts:2,requiredValidationUrls:checkpoint.requiredValidationUrls});
      }catch(error){console.error('Site cognition stage retry failed:',{workflowId:workflow.id,code:error.code||error.name,message:error.message});await finishWithHandoff(workflow,error,actor);}
    });else schedule(()=>execute(workflow.id,actor));
    return get(workflow.id);
  }

  async function approveAiBudget(id, body={}, actor='system:operator'){
    let workflow=await get(id);if(!workflow)fail('网站认知流程不存在',404);
    if(workflow.state!=='WAITING_FOR_AI_BUDGET_APPROVAL')fail('当前流程不需要增加 AI 分析额度',409,'SITE_COGNITION_BUDGET_APPROVAL_NOT_REQUIRED');
    const nextLimit=nextAiBudgetLimit(workflow.attempt_counters);if(!nextLimit)fail(`本任务已达到 ${MAX_AI_TOKEN_BUDGET} token 硬上限，不能继续增加`,409,'SITE_COGNITION_BUDGET_HARD_LIMIT');
    const requested=Number(body.limit_tokens||nextLimit);if(requested!==nextLimit)fail(`本次只能将额度提高到 ${nextLimit} token`,400,'SITE_COGNITION_BUDGET_TIER_INVALID');
    const [budgetEvents]=await db.query("SELECT from_state FROM product_ingestion_site_cognition_events WHERE workflow_id=? AND event_type='BUDGET_EXHAUSTED' ORDER BY id DESC LIMIT 1",[workflow.id]);
    const failedState=workflow.resume_payload?.budget?.failed_state!=='LEGACY_BUDGET_HANDOFF'?workflow.resume_payload?.budget?.failed_state:budgetEvents[0]?.from_state;
    const extractionResume=['EXTRACTION_RULE_DRAFTING','EXTRACTION_RULE_TESTING'].includes(failedState)||failedState==='RULE_REVISING'&&/字段|图片|Slice/i.test(String(workflow.resume_payload?.budget?.purpose||''));
    const checkpoint=extractionResume?await extractionCheckpoint(workflow):null,counters={...workflow.attempt_counters,ai_budget_limit_tokens:nextLimit,ai_budget_approvals:Number(workflow.attempt_counters?.ai_budget_approvals||0)+1};
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET attempt_counters=? WHERE id=?',[json(counters),workflow.id]);workflow.attempt_counters=counters;
    const previous=workflow.resume_payload;
    workflow=await move(workflow,checkpoint?'APPROVE_EXTRACTION':'APPROVE_RETRY','SUCCESS',{restart_recovery:true,recovery_stage:checkpoint?'extraction':'site_mapping',budget_approval:{previous_limit:Number(previous?.budget?.limit||Math.floor(nextLimit/2)),new_limit:nextLimit,approved_by:actor,approved_at:new Date().toISOString(),failed_state:failedState||null},previous_payload:previous},actor);
    await db.query('UPDATE product_ingestion_site_cognition_workflows SET last_error_code=NULL,last_error=NULL WHERE id=?',[workflow.id]);workflow.last_error_code=null;workflow.last_error=null;
    await db.query("UPDATE product_ingestion_jobs SET status='discovering',current_stage='site_cognition',failure_code=NULL,last_error=NULL,finished_at=NULL,current_url=NULL,heartbeat_at=NOW() WHERE id=?",[workflow.job_id]);
    if(checkpoint)schedule(async()=>{
      try{
        const extractionMap=checkpoint.siteMap,discoveryRule=normalizeDiscoveryRule(checkpoint.discoveryRule,extractionMap);
        await generateAndTestExtraction(workflow,extractionMap,discoveryRule,actor,null,{maxAttempts:2,requiredValidationUrls:checkpoint.requiredValidationUrls});
      }catch(error){console.error('Site cognition budget resume failed:',{workflowId:workflow.id,code:error.code||error.name,message:error.message});await finishWithHandoff(workflow,error,actor);}
    });else schedule(()=>execute(workflow.id,actor));
    return get(workflow.id);
  }

  async function feedback(id, body, actor) {
    let workflow=await get(id);if(!workflow)fail('网站认知流程不存在',404);
    const decision=String(body.decision || '');
    if(!['confirm','business_error','cannot_judge','anchor'].includes(decision))fail('反馈选项不正确',400);
    const errors=[...new Set(Array.isArray(body.error_types)?body.error_types:[])];if(errors.some(item=>!BUSINESS_ERROR_TYPES.has(item)))fail('业务错误类型不正确',400);
    let issues=[];try{issues=validateCorrectionIssues(body.issues||[]);}catch(error){fail(error.message,400,'PRODUCT_CORRECTION_INVALID');}
    if(decision==='confirm'&&workflow.state!=='HUMAN_SAMPLE_REVIEW_REQUIRED')fail('当前没有待确认的抽样结果');
    if(decision==='business_error'&&workflow.state!=='HUMAN_SAMPLE_REVIEW_REQUIRED')fail('当前没有可修订的抽样结果');
    if(decision==='business_error'&&!errors.length&&!issues.length)fail('请至少提交一个业务错误或结构化纠错项',400);
    if(decision==='anchor'&&workflow.state!=='HUMAN_ANCHOR_REQUIRED')fail('当前不需要产品页面锚点');
    if(decision==='cannot_judge'&&!allowedEvents(workflow.state).includes('CANNOT_JUDGE'))fail('当前阶段不能提交无法判断',409);
    await db.query('INSERT INTO product_ingestion_site_rule_feedback (workflow_id,rule_id,decision,error_types,issues,note,page_url,created_by) VALUES (?,?,?,?,?,?,?,?)',[workflow.id,workflow.rule_id,decision,json(errors),json(issues),String(body.note || '').slice(0,1000)||null,String(body.page_url || '').slice(0,1000)||null,actor]);
    if(decision==='confirm'){
      workflow=await move(workflow,'CONFIRMED','SUCCESS',{confirmed:true,rule_id:workflow.rule_id},actor);
      const preserveExisting=await isTemplateDriftRecovery(workflow);
      await siteRules.freeze(workflow.rule_id,{confirmation:'冻结此站点规则',preserve_existing_templates:preserveExisting},actor);
      workflow=await move(workflow,'SUCCESS','SUCCESS',{rule_id:workflow.rule_id},actor);
      const authorized=await authorizeFullCrawl(workflow,workflow.rule_id);
      dependencies.onFullCrawlReady?.(workflow.job_id,authorized);
      return get(workflow.id);
    }
    if(decision==='cannot_judge'){
      const originState=workflow.state;
      workflow=await move(workflow,'CANNOT_JUDGE','NEED_HUMAN_ANCHOR',{cannot_judge:true,previous_payload:workflow.resume_payload},actor);
      schedule(()=>systemReview(workflow,originState).catch(error=>console.error('System review failed:',error.message)));
      return get(workflow.id);
    }
    if(decision==='anchor'){
      const [evidence]=await db.query("SELECT content FROM product_ingestion_site_cognition_evidence WHERE workflow_id=? AND evidence_type='SITE_STRUCTURE_MAP' ORDER BY revision DESC,id DESC LIMIT 1",[workflow.id]);
      const siteMap=parsed(evidence[0]?.content,null);if(!siteMap)fail('没有保存可用于锚点验证的官网证据');
      const page=(siteMap.pages||[]).find(item=>item.url===body.page_url);if(!page)fail('所选页面不在当前有限候选中',400,'HUMAN_ANCHOR_OUT_OF_SCOPE');
      siteMap.known_labels=[...(siteMap.known_labels||[]),{page_id:page.page_id,url:page.url,role:'product_detail',source:'human_business_anchor'}];
      await saveEvidence(workflow,siteMap);
      workflow=await move(workflow,'ANCHOR_PROVIDED','SUCCESS',{page_url:body.page_url},actor);
      schedule(()=>draftAndTest(workflow,siteMap,actor).catch(async error=>{
        console.error('Anchored site-rule generation failed:',error.message);
        await returnToHumanAnchor(workflow.id,error,actor).catch(recoveryError=>console.error('Anchored site-rule failure recovery failed:',recoveryError.message));
      }));
      return get(workflow.id);
    }
    workflow=await move(workflow,'BUSINESS_ERROR','VALIDATION_FAILED',{error_types:errors,issues,note:body.note || '',page_url:body.page_url||null},actor);
    if(errors.some(item=>DISCOVERY_ERROR_TYPES.has(item))){
      workflow=await move(workflow,'RESTART_COGNITION','SUCCESS',{error_types:errors,issues,note:body.note||'',reason:'产品页或站点范围判断错误，重新认识网站并生成发现规则'},actor);
      setImmediate(()=>execute(workflow.id,actor));
      return get(workflow.id);
    }
    const [evidence]=await db.query("SELECT content FROM product_ingestion_site_cognition_evidence WHERE workflow_id=? AND evidence_type='SITE_STRUCTURE_MAP' ORDER BY revision DESC,id DESC LIMIT 1",[workflow.id]);
    const siteMap=parsed(evidence[0]?.content,null);if(!siteMap)fail('没有保存可用于修订的官网证据');
    setImmediate(()=>revise(workflow,siteMap,{error_types:errors,issues,note:body.note || '',page_url:body.page_url||null},actor).catch(error=>console.error('Site-rule revision failed:',error.message)));
    return get(workflow.id);
  }

  async function recoverInterrupted() {
    // Workflows stopped by the former fixed 60k policy become explicit budget
    // approvals after upgrade. This is a state repair only: no AI or network
    // work starts until an operator approves the next tier.
    const [legacyBudgetRows]=await db.query("SELECT * FROM product_ingestion_site_cognition_workflows WHERE state='HANDOFF_REQUIRED' AND last_error_code='SITE_COGNITION_AI_BUDGET_EXHAUSTED'");
    for(const raw of legacyBudgetRows){
      const item=mapWorkflow(raw),counters={...item.attempt_counters,ai_budget_limit_tokens:aiBudgetLimit(item.attempt_counters)};
      const [[usage]]=await db.query('SELECT COALESCE(SUM(total_tokens),0) total_tokens FROM product_ingestion_site_cognition_ai_calls WHERE workflow_id=?',[item.id]);
      const used=attemptBudgetUsed(Number(usage?.total_tokens||0),counters),limit=aiBudgetLimit(counters),nextLimit=nextAiBudgetLimit(counters),resume={...(item.resume_payload||{}),budget:{...(item.resume_payload?.budget||{}),used_tokens:used,total_used_tokens:Number(usage?.total_tokens||0),limit,next_limit:nextLimit,max_limit:MAX_AI_TOKEN_BUDGET,approval_available:Boolean(nextLimit),failed_state:item.resume_payload?.budget?.failed_state||'LEGACY_BUDGET_HANDOFF'}};
      if(!nextLimit)continue;
      const [updated]=await db.query("UPDATE product_ingestion_site_cognition_workflows SET state='WAITING_FOR_AI_BUDGET_APPROVAL',state_version=state_version+1,attempt_counters=?,next_allowed_events=?,last_event='LEGACY_BUDGET_APPROVAL_MIGRATION',resume_payload=?,business_summary=?,finished_at=NULL,lease_expires_at=NULL WHERE id=? AND state='HANDOFF_REQUIRED'",[json(counters),json(allowedEvents('WAITING_FOR_AI_BUDGET_APPROVAL')),json(resume),'AI 默认额度已用完；现有证据和步骤已保存，等待确认是否提高额度继续。',item.id]);
      if(updated.affectedRows){await db.query("INSERT INTO product_ingestion_site_cognition_events (workflow_id,from_state,to_state,event_type,outcome,payload,actor) VALUES (?,'HANDOFF_REQUIRED','WAITING_FOR_AI_BUDGET_APPROVAL','LEGACY_BUDGET_APPROVAL_MIGRATION','SUCCESS',?,'system:restart-recovery')",[item.id,json({preserved:true,current_limit:limit,next_limit:nextLimit})]);await db.query("UPDATE product_ingestion_jobs SET status='rule_review',current_stage='ai_budget_approval',failure_code='SITE_COGNITION_AI_BUDGET_EXHAUSTED',last_error=?,finished_at=NULL,heartbeat_at=NOW() WHERE id=?",[`AI 默认额度已用完，等待确认是否提高到 ${nextLimit} Token`,item.job_id]);}
    }
    // Repair rows created before HANDOFF_REQUIRED gained its explicit retry exit.
    await db.query("UPDATE product_ingestion_site_cognition_workflows SET next_allowed_events=? WHERE state='HANDOFF_REQUIRED' AND (next_allowed_events IS NULL OR JSON_LENGTH(next_allowed_events)=0)",[json(allowedEvents('HANDOFF_REQUIRED'))]);
    const [rows]=await db.query("SELECT * FROM product_ingestion_site_cognition_workflows WHERE finished_at IS NULL AND state NOT IN ('HUMAN_SAMPLE_REVIEW_REQUIRED','HUMAN_ANCHOR_REQUIRED','PROBE_PERMISSION_REQUIRED','WAITING_FOR_AI_BUDGET_APPROVAL','FULL_CRAWL_READY','FULL_CRAWLING')");
    let recovered=0;
    for(const raw of rows){
      let workflow=mapWorkflow(raw);
      if(workflow.state==='RATE_LIMIT_WAITING'){
        const resumeAt=workflow.resume_payload?.resume_at||new Date(now()).toISOString();scheduleAccessResume(workflow,resumeAt,'system:restart-recovery');recovered+=1;continue;
      }
      if(!['RULE_CHECKING','ACCESS_PREFLIGHT','SITE_MAPPING','BOUNDED_EVIDENCE_REQUIRED','JS_CHANNEL_REQUIRED'].includes(workflow.state))workflow=await move(workflow,'RESTART','SUCCESS',{restart_recovery:true,interrupted_state:workflow.state},'system:restart-recovery');
      setImmediate(()=>execute(workflow.id,'system:restart-recovery'));recovered+=1;
    }
    return {recovered};
  }

  async function markFullCrawlStarted(jobId, actor='system:runner') {
    let workflow=await latestForJob(jobId);if(!workflow||workflow.state!=='FULL_CRAWL_READY')return workflow;
    workflow=await move(workflow,'START','SUCCESS',{job_id:Number(jobId)},actor);return workflow;
  }

  async function markFullCrawlFinished(jobId, outcome, details={}, actor='system:runner') {
    let workflow=await latestForJob(jobId);if(!workflow||workflow.state!=='FULL_CRAWLING')return workflow;
    const event=outcome==='success'?'SUCCESS':outcome==='template_drift'?'TEMPLATE_DRIFT':outcome==='security_blocked'?'SECURITY_BLOCKED':'EXECUTION_FAILED_FINAL';
    workflow=await move(workflow,event,outcome==='success'?'SUCCESS':String(outcome||'EXECUTION_FAILED').toUpperCase(),details,actor);
    if(event==='TEMPLATE_DRIFT'){
      const [rows]=await db.query('SELECT scope_snapshot,checkpoint_index,current_url FROM product_ingestion_jobs WHERE id=?',[Number(jobId)]);
      const scope=parsed(rows[0]?.scope_snapshot,{}),resumeCheckpoint=Math.max(0,Number(details.resume_checkpoint??rows[0]?.checkpoint_index??0));
      scope.template_drift_checkpoint={active:true,resume_checkpoint:resumeCheckpoint,failed_url:details.failed_url||rows[0]?.current_url||null,recorded_at:new Date().toISOString(),preserve_discovery:true};
      await db.query("UPDATE product_ingestion_jobs SET scope_snapshot=?,checkpoint_index=?,status='discovering',current_stage='site_cognition',finished_at=NULL,heartbeat_at=NOW() WHERE id=?",[json(scope),resumeCheckpoint,Number(jobId)]);
      setImmediate(()=>execute(workflow.id,'system:template-drift-recovery'));
    }
    return workflow;
  }

  async function stopForJob(jobId,actor='system:operator'){
    const workflow=await latestForJob(jobId);if(!workflow||['COMPLETED','CANDIDATE_COLLECTION_COMPLETED','HANDOFF_REQUIRED','STOPPED_SAFE'].includes(workflow.state))return workflow;
    const [updated]=await db.query("UPDATE product_ingestion_site_cognition_workflows SET state='STOPPED_SAFE',state_version=state_version+1,next_allowed_events='[]',last_event='SAFE_STOP',business_summary='任务已安全停止，规则证据和已有候选均已保留。',finished_at=NOW(),lease_expires_at=NULL WHERE id=? AND state=? AND state_version=?",[workflow.id,workflow.state,workflow.state_version]);
    if(updated.affectedRows)await db.query("INSERT INTO product_ingestion_site_cognition_events (workflow_id,from_state,to_state,event_type,outcome,payload,actor) VALUES (?,?,'STOPPED_SAFE','SAFE_STOP','SUCCESS',?,?)",[workflow.id,workflow.state,json({job_id:Number(jobId),preserved:true}),actor]);
    await db.query("UPDATE product_ingestion_jobs SET status='cancelled',current_stage='cancelled',current_url=NULL,finished_at=NOW(),heartbeat_at=NOW(),last_error='用户主动停止任务；规则证据和已有候选均已保留' WHERE id=? AND status NOT IN ('completed','cancelled')",[Number(jobId)]);
    return latestForJob(jobId);
  }

  return {startForJob,execute,get,list,feedback,retryHandoff,approveAiBudget,latestForJob,recoverInterrupted,markFullCrawlStarted,markFullCrawlFinished,returnToHumanAnchor,stopForJob};
}

module.exports = { createSiteCognitionControl, businessCopy, BUSINESS_ERROR_TYPES, DISCOVERY_ERROR_TYPES, AI_TOKEN_BUDGET, MAX_AI_TOKEN_BUDGET, MAX_EVIDENCE_PROBE_ROUNDS, evidenceProbeFingerprint, canAutoFreezeRule, renderedEvidenceUsable, withBlindTestSeeds, withRequiredValidationSeeds, enforceRequiredValidation, refineFromValidation, validateDiscoveryAgainstMap, uncoveredProductFamilyClusters, publicApiDiscovery, augmentEvidenceForRule, attemptBudgetUsed, aiBudgetLimit, nextAiBudgetLimit, evidenceUrls, sandboxValidationRows, sandboxValidationFingerprint, sandboxValidationProgress };
