'use strict';

const crypto = require('crypto');
const { fetchHtml } = require('./product-ingestion-fetch');
const { extractProduct, classifyProduct } = require('./product-ingestion-extractor');
const { discoverProducts } = require('./product-ingestion-discovery');
const { discoverSitemapUrls } = require('./product-ingestion-sitemap');
const { createFieldReview } = require('./product-ingestion-field-review');
const { analyzeWebsite } = require('./product-ingestion-qwen-analyzer');
const { canonicalImageKey } = require('./product-ingestion-image-recognizer');
const { collectOcrEvidence } = require('./product-ingestion-site-rule-ocr');
const { createShadowRecoveryPlanner } = require('./product-ingestion-recovery-shadow');
const { classifyIngestionOutcome } = require('./product-ingestion-outcome-classifier');
const { boundedBackoffAt } = require('./product-ingestion-access-preflight');
const { fetchVirtualProduct } = require('./product-ingestion-public-json-api');
const { createGlobalSlotManager } = require('./product-ingestion-global-slots');
const { assessSingleProductEvidence,templateFailureSignature,recordTemplateObservation,templateDriftDecision } = require('./product-ingestion-page-role');
const {
  loadFrozenSiteRules,
  discoverProductsWithSiteRule,
  extractProductWithSiteRule,
  extractProductWithSiteRuleSet,
} = require('./product-ingestion-site-rule-runtime');

const running = new Set();
const PAGE_OPERATION_TIMEOUT_MS = 45000;
const NO_PROGRESS_TIMEOUT_MS = 120000;
const MAX_FULL_CRAWL_RATE_LIMIT_WAITS = 3;
function json(value) { return value == null ? null : JSON.stringify(value); }
function parsed(value,fallback=null){if(typeof value!=='string')return value??fallback;try{return JSON.parse(value);}catch(_){return fallback;}}
function issue(error) { return [{ code:error.code || 'EXTRACTION_FAILED', message:String(error.message || '产品解析失败').slice(0, 500),...(error.page_role_assessment?{page_role_assessment:error.page_role_assessment}:{}),...(error.template_drift_decision?{template_drift_decision:error.template_drift_decision}:{}) }]; }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function frozenDiscoveryMustStop(summary) { return summary?.discovery_coverage?.status === 'sample_only'; }
function imageDecisionUrls(payload){
  const parsedPayload=parsed(payload,{}),decisions=parsedPayload?.image_recognition?.decisions||[];
  return [...new Set(decisions.map(item=>canonicalImageKey(item?.url)).filter(Boolean))];
}
function productSchemaSiteMetrics(rows){
  const metrics={products_seen:rows.length,products_passed:0,products_failed:0,with_configurations:0,with_option_groups:0,with_dimensions:0,with_display_images:0,field_status:{},exceptions:[]};
  for(const row of rows){const payload=parsed(row.normalized_payload,{}),document=payload?.product_document;if(row.validation_status==='valid')metrics.products_passed+=1;else{metrics.products_failed+=1;metrics.exceptions.push({url:row.source_url,reasons:parsed(row.validation_issues,[])});}if(payload?.product_schema_version!==2||document?.schema_version!==2)continue;if(document.data.configurations.length)metrics.with_configurations+=1;if(document.data.option_groups.some(group=>group.options.length))metrics.with_option_groups+=1;if(document.data.configurations.some(item=>item.dimensions.length))metrics.with_dimensions+=1;if(document.data.assets.some(item=>['hero','product_gallery','scene','detail','configuration_image'].includes(item.role)))metrics.with_display_images+=1;for(const state of Object.values(document.field_status||{}))metrics.field_status[state.status]=(metrics.field_status[state.status]||0)+1;}
  return metrics;
}
async function loadCommonImageKeys(db,sourceId,currentJobId){
  try{
    const [rows]=await db.query(`SELECT source_url,extracted_payload FROM product_ingestion_candidates
      WHERE source_id=? AND job_id<>? AND extracted_payload IS NOT NULL ORDER BY id DESC LIMIT 300`,[sourceId,currentJobId]);
    const byPage=new Map();
    for(const row of rows){if(!byPage.has(row.source_url))byPage.set(row.source_url,new Set());for(const url of imageDecisionUrls(row.extracted_payload))byPage.get(row.source_url).add(url);}
    const counts=new Map();for(const urls of byPage.values())for(const url of urls)counts.set(url,(counts.get(url)||0)+1);
    return [...counts].filter(([,count])=>count>=2).map(([url])=>url).slice(0,2000);
  }catch(_){return [];}
}
async function loadRepresentativePages(db,sourceId,currentJobId){
  try{
    const [rows]=await db.query(`SELECT source_url,raw_html FROM product_ingestion_candidates
      WHERE source_id=? AND job_id<>? AND raw_html IS NOT NULL ORDER BY id DESC LIMIT 40`,[sourceId,currentJobId]);
    const seen=new Set(),pages=[];
    for(const row of rows){if(seen.has(row.source_url))continue;seen.add(row.source_url);const html=Buffer.isBuffer(row.raw_html)?row.raw_html.toString('utf8'):String(row.raw_html||'');if(html){pages.push({url:row.source_url,html});if(pages.length>=3)break;}}
    return pages;
  }catch(_){return [];}
}
function preferredContentUrl(sourceUrl) {
  return new URL(sourceUrl).toString();
}
function policyAuthorizer(db, sourceId, jobId) {
  return async () => {
    const [rows]=await db.query(`SELECT source.status source_status,job.status job_status
      FROM product_ingestion_sources source JOIN product_ingestion_jobs job ON job.source_id=source.id
      WHERE source.id=? AND job.id=?`,[sourceId,jobId]);
    return rows[0]||{source_status:'missing',job_status:'missing'};
  };
}
async function fetchPreferredHtml(sourceUrl, scope, fetcher = fetchHtml) {
  return fetcher(preferredContentUrl(sourceUrl), scope);
}
function withTimeout(promise, timeoutMs, sourceUrl) {
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{const error=new Error(`处理页面超时：${sourceUrl}`);error.code='PAGE_PROCESS_TIMEOUT';reject(error);},timeoutMs);});
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}
function retryablePageError(error){const code=String(error?.code||'');const status=Number(error?.response?.status||0);return ['ECONNRESET','ETIMEDOUT','FETCH_TIMEOUT','UND_ERR_SOCKET','PAGE_PROCESS_TIMEOUT'].includes(code)||status>=500;}
function fullCrawlRateLimitWait(error,scope,now=Date.now()){
  const outcome=classifyIngestionOutcome(error,{stage:'full_crawl_extraction'});
  if(outcome.category!=='RATE_LIMITED')return null;
  const attempt=Number(scope?.full_crawl_rate_limit_waits||0)+1;
  return {attempt,exhausted:attempt>MAX_FULL_CRAWL_RATE_LIMIT_WAITS,resume_at:boundedBackoffAt(attempt,error?.response?.headers||{},now),outcome};
}
async function fetchPageWithRetry(sourceUrl,scope,fetcher){
  let lastError,renderedAttempted=false;for(let attempt=1;attempt<=2;attempt+=1){try{return await withTimeout(fetchPreferredHtml(sourceUrl,scope,fetcher),PAGE_OPERATION_TIMEOUT_MS,sourceUrl);}catch(error){
    lastError=error;const outcome=classifyIngestionOutcome(error,{stage:'full_crawl_extraction'});
    if(!renderedAttempted&&['ACCESS_RESTRICTED','HUMAN_CHALLENGE','JS_RENDER_REQUIRED'].includes(outcome.category)){
      renderedAttempted=true;
      try{return await withTimeout(fetchPreferredHtml(sourceUrl,{...scope,force_rendered_channel:true,allow_same_site_subresources:true},fetcher),PAGE_OPERATION_TIMEOUT_MS,sourceUrl);}catch(renderedError){lastError=renderedError;error=renderedError;}
    }
    if(attempt>=2||!retryablePageError(error)||Number(scope.page_quota?.used||0)>=Number(scope.page_quota?.limit||0))throw error;
  }}
  throw lastError;
}

function createRunner(db, dependencies = {}) {
  const schedule=dependencies.schedule||setImmediate;
  const launchWhenFree=(jobId,operation,attempt=0)=>{
    const id=Number(jobId);
    if(!running.has(id)){schedule(()=>operation(id));return;}
    if(attempt>=120){console.error('Product ingestion resume wait expired:',{jobId:id});return;}
    const timer=setTimeout(()=>launchWhenFree(id,operation,attempt+1),500);
    if(typeof timer.unref==='function')timer.unref();
  };
  const pageFetcher=dependencies.fetchHtml||fetchHtml;
  const productDiscoverer=dependencies.discoverProducts||discoverProducts;
  const sitemapDiscoverer=dependencies.discoverSitemapUrls||discoverSitemapUrls;
  const frozenRuleSetLoader=dependencies.loadFrozenSiteRules||(dependencies.loadFrozenSiteRule
    ? async(db,sourceId)=>{const rule=await dependencies.loadFrozenSiteRule(db,sourceId);return rule?[rule]:[];}
    : loadFrozenSiteRules);
  const ruleDiscoverer=dependencies.discoverProductsWithSiteRule||discoverProductsWithSiteRule;
  const ruleExtractor=dependencies.extractProductWithSiteRule||extractProductWithSiteRule;
  const ruleSetExtractor=dependencies.extractProductWithSiteRuleSet||extractProductWithSiteRuleSet;
  const fullCrawlStarted=dependencies.onFullCrawlStarted||(()=>Promise.resolve());
  const fullCrawlFinished=dependencies.onFullCrawlFinished||(()=>Promise.resolve());
  const now=dependencies.now||(()=>Date.now());
  const scheduleAt=dependencies.scheduleAt||((callback,delay)=>{const timer=setTimeout(callback,Math.max(0,delay));timer.unref?.();return timer;});
  const globalSlots=dependencies.globalSlots||createGlobalSlotManager(db,{env:dependencies.env});
  const globalSlotRetryMs=Math.max(100,Number(dependencies.globalSlotRetryMs||process.env.INGESTION_GLOBAL_SLOT_RETRY_MS||1000));
  const shadowPlanner=dependencies.planShadowRecovery||createShadowRecoveryPlanner(db,dependencies.recoveryDependencies);
  const fieldReview=createFieldReview(db);
  async function loadJob(id) {
    const [rows] = await db.query(`SELECT job.*,source.status source_status,source.allowed_asset_hosts,source.brand_name,source.base_url,source.ai_analysis_profile,source.recovery_mode,
      (SELECT rule.id FROM product_ingestion_site_rules rule WHERE rule.source_id=job.source_id AND rule.status='frozen' ORDER BY rule.version_number DESC,rule.id DESC LIMIT 1) frozen_site_rule_id
      FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=?`, [id]);
    const row = rows[0]; if (!row) throw new Error('抓取任务不存在');
    row.scope_snapshot = typeof row.scope_snapshot === 'string' ? JSON.parse(row.scope_snapshot) : row.scope_snapshot;
    row.discovery_checkpoint = parsed(row.discovery_checkpoint,null);
    return row;
  }
  async function saveCandidate(job, sourceUrl, page, result, error, classification = null) {
    const normalized = result?.payload || null;
    const extracted = result?.extracted || null;
    if(normalized)await fieldReview.applyRules(job.source_id,normalized,extracted||{});
    const generated = result?.generatedFields || [];
    const issues = error ? issue(error) : [];
    const fingerprint = normalized ? digest(JSON.stringify(normalized)) : page?.html ? digest(page.html) : null;
    const raw = page?.html ? Buffer.from(page.html, 'utf8') : Buffer.isBuffer(error?.response?.body) ? error.response.body : null;
    const externalId = [extracted?.sku, extracted?.mpn, extracted?.productID]
      .find(value => ['string', 'number'].includes(typeof value));
    await db.query(`INSERT INTO product_ingestion_candidates
      (job_id,source_id,source_url,source_url_hash,source_external_id,content_fingerprint,raw_http_status,raw_content_type,raw_html,extracted_payload,normalized_payload,product_schema_version,generated_fields,classification_suggestion,classification_override,validation_status,validation_issues,review_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?, 'pending')
      ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),
        content_fingerprint=IF(manual_revision=0 AND published_product_id IS NULL,VALUES(content_fingerprint),content_fingerprint),
        raw_http_status=VALUES(raw_http_status),raw_content_type=VALUES(raw_content_type),raw_html=VALUES(raw_html),extracted_payload=VALUES(extracted_payload),
        normalized_payload=IF(manual_revision=0 AND published_product_id IS NULL,VALUES(normalized_payload),normalized_payload),
        product_schema_version=IF(manual_revision=0 AND published_product_id IS NULL,VALUES(product_schema_version),product_schema_version),
        generated_fields=IF(manual_revision=0 AND published_product_id IS NULL,VALUES(generated_fields),generated_fields),
        classification_suggestion=VALUES(classification_suggestion),
        validation_status=IF(manual_revision=0 AND published_product_id IS NULL,VALUES(validation_status),validation_status),
        validation_issues=IF(manual_revision=0 AND published_product_id IS NULL,VALUES(validation_issues),validation_issues)`,
      [job.id, job.source_id, sourceUrl, digest(sourceUrl), externalId == null ? null : String(externalId).slice(0,160),
        fingerprint, page?.status || error?.response?.status || null, page?.contentType || error?.response?.headers?.['content-type'] || null,
        raw, json(extracted), json(normalized), Number(normalized?.product_schema_version||1), json(generated), json(classification), error ? 'invalid' : 'valid', json(issues)]);
    const [rows]=await db.query('SELECT id FROM product_ingestion_candidates WHERE job_id=? AND source_url_hash=?',[job.id,digest(sourceUrl)]);
    const storedId=Number(rows[0]?.id || 0);
    if(storedId){
      await db.query("DELETE FROM product_ingestion_candidate_categories WHERE candidate_id=? AND assignment_type='system'",[storedId]);
      if(classification?.product_type){
        await db.query(`INSERT INTO product_ingestion_candidate_categories (candidate_id,category_id,assigned_by,assigned_at,assignment_type)
          SELECT ?,category.id,'system:auto',NOW(),'system' FROM public_product_categories category
          WHERE category.category_code=? AND category.status='active'
            AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories existing WHERE existing.candidate_id=? AND existing.assignment_type='manual')
          LIMIT 1`,[storedId,classification.product_type,storedId]);
      }
    }
    return storedId;
  }
  async function classifyTemplateFailure(job,sourceUrl,page,error,checkpointIndex){
    const assessment=assessSingleProductEvidence(page),signature=templateFailureSignature(page,error);
    const observation={signature,source_url:sourceUrl,error_code:String(error.code||'SITE_RULE_TEMPLATE_STALE'),assessment,checkpoint_index:Number(checkpointIndex)};
    job.scope_snapshot=recordTemplateObservation(job.scope_snapshot||{},observation);
    const decision=templateDriftDecision(job.scope_snapshot,observation);
    error.page_role_assessment=assessment;error.template_drift_decision={...decision,signature};
    await db.query("UPDATE product_ingestion_jobs SET scope_snapshot=?,heartbeat_at=NOW() WHERE id=? AND status='running'",[JSON.stringify(job.scope_snapshot),job.id]);
    return decision;
  }
  async function run(id) {
    if (running.has(Number(id))) return;
    running.add(Number(id));
    let globalSlot;
    try {
      globalSlot=await globalSlots.acquire({jobId:id,phase:'extraction'});
      if(!globalSlot){scheduleAt(()=>launchWhenFree(Number(id),run),globalSlotRetryMs);return;}
      const job = await loadJob(id);
      if (!job.scope_snapshot || job.status !== 'queued') throw new Error('任务没有可执行的授权范围快照');
      const scope = {...job.scope_snapshot,job_id:Number(id),job_status:'running',source_status:job.source_status,policy_db:db};
      scope.policy_authorizer=policyAuthorizer(db,job.source_id,Number(id));
      const frozenRules=job.frozen_site_rule_id?await frozenRuleSetLoader(db,job.source_id):[];
      const frozenRule=frozenRules[0]||null;
      const authorizedRuleIds=(scope.site_rule_ids||[scope.site_rule_id]).filter(Boolean).map(Number);
      if(authorizedRuleIds.length&&!authorizedRuleIds.some(id=>frozenRules.some(rule=>Number(rule.id)===id))){const problem=new Error('任务绑定的冻结站点规则集合已失效，请重新分析网站');problem.code='SITE_RULE_INVALIDATED';throw problem;}
      const checkpoint=Math.min(Math.max(Number(job.checkpoint_index||0),0),scope.seed_urls.length,scope.max_pages);
      let siteProfile=parsed(job.ai_analysis_profile)||scope.ai_analysis_profile||null,aiAnalysisAttempted=Boolean(siteProfile)||Boolean(frozenRule),imageProfileAttempted=Boolean(siteProfile?.image_region_rules)||Boolean(frozenRule),aiAnalysisFailure=null;
      scope.page_quota={used:checkpoint,limit:Math.max(scope.max_pages,Number(scope.network_request_limit||scope.max_pages))};
      if (job.source_status !== 'active') throw new Error('抓取来源已暂停，任务不能执行');
      if (!Number.isInteger(scope.max_pages) || scope.max_pages < 1 || scope.max_pages > 2000 ||
          !Number.isInteger(scope.max_products) || scope.max_products < 1 || scope.max_products > 500 ||
          !Number.isInteger(scope.request_interval_ms) || scope.request_interval_ms < 1000 || scope.request_interval_ms > 60000) {
        throw new Error('任务授权范围超过执行器硬限制');
      }
      const [claimed] = await db.query(`UPDATE product_ingestion_jobs SET status='running',started_at=COALESCE(started_at,NOW()),current_stage='extraction',current_url=NULL,heartbeat_at=NOW(),failure_code=NULL,last_error=NULL WHERE id=? AND status='queued'`, [id]);
      // A queued job can be cancelled before this asynchronous worker claims it.
      // In that case it must stop without making any network request.
      if (!claimed.affectedRows) return;
      // Discovery normally moves the cognition workflow into FULL_CRAWLING. A
      // template-drift recovery can resume directly at extraction, so make the
      // same transition here as well. Without it, a later template drift is
      // recorded only on the job and cannot re-enter the cognition repair loop.
      if(frozenRule)await fullCrawlStarted(Number(id));
      const commonImageKeys=await loadCommonImageKeys(db,job.source_id,Number(id));
      const representativePages=imageProfileAttempted?[]:await loadRepresentativePages(db,job.source_id,Number(id));
      // checkpoint_index is the durable full-crawl cursor. pages_fetched is
      // also used while rebuilding site evidence, so it may be reset to a
      // small number during template-drift recovery and must not be used to
      // restore extraction progress.
      let pages=checkpoint,found=checkpoint?Number(job.candidates_found||checkpoint):0;
      const publicApiPageCache=new Map();
      let accepted=checkpoint?Number(job.accepted_count||0):0,rejected=checkpoint?Number(job.rejected_count||0):0,processed=checkpoint,currentUrl=null,lastProgressAt=Date.now(),watchdogTriggered=false,shadowAttempts=0;
      const watchdog=setInterval(()=>{if(!watchdogTriggered&&Date.now()-lastProgressAt>NO_PROGRESS_TIMEOUT_MS){watchdogTriggered=true;db.query(`UPDATE product_ingestion_jobs SET status='failed',finished_at=NOW(),failure_code='NO_PROGRESS_TIMEOUT',last_error=?,current_stage='failed' WHERE id=? AND status='running'`,[`NO_PROGRESS_TIMEOUT: 超过 ${Math.round(NO_PROGRESS_TIMEOUT_MS/1000)} 秒没有进度；最后页面：${currentUrl||'未知'}`.slice(0,1000),id]).catch(()=>{});}},15000);watchdog.unref?.();
      try {
      for (const sourceUrl of scope.seed_urls.slice(checkpoint, scope.max_pages)) {
        currentUrl=sourceUrl;
        if(watchdogTriggered){const error=new Error('任务长时间没有进度，已自动中止');error.code='NO_PROGRESS_TIMEOUT';throw error;}
        const [active]=await db.query(`UPDATE product_ingestion_jobs SET current_stage='extraction',current_url=?,heartbeat_at=NOW() WHERE id=? AND status='running'`,[sourceUrl,id]);
        if(!active.affectedRows){const error=new Error('任务已被中止，停止继续请求');error.code='JOB_INTERRUPTED';throw error;}
        let page = null, classification = null, fatalError = null;
        try {
          page = frozenRule?.config?.public_json_api
            ? await fetchVirtualProduct(frozenRule.config.public_json_api,sourceUrl,{...scope,base_url:frozenRule.config.scope.base_url,api_quota:scope.api_quota||scope.page_quota},publicApiPageCache)
            : await fetchPageWithRetry(sourceUrl, scope, pageFetcher);
          pages += 1;
          if(!imageProfileAttempted&&representativePages.length){
            imageProfileAttempted=true;aiAnalysisAttempted=true;
            try{
              siteProfile=await analyzeWebsite({brandName:job.brand_name||scope.brand_name,baseUrl:job.base_url||scope.base_url,pageUrl:page.url,html:page.html,representativePages});
              scope.ai_analysis_profile=siteProfile;
              await db.query(`UPDATE product_ingestion_sources SET ai_analysis_profile=?,ai_analysis_updated_at=NOW() WHERE id=?`,[JSON.stringify(siteProfile),job.source_id]);
              await db.query(`UPDATE product_ingestion_jobs SET scope_snapshot=?,heartbeat_at=NOW() WHERE id=? AND status='running'`,[JSON.stringify({...job.scope_snapshot,ai_analysis_profile:siteProfile}),id]);
            }catch(error){aiAnalysisFailure=error;}
          }
          classification=classifyProduct(page.html,scope.adapter_key,page.url,siteProfile);
          if(frozenRule&&!classification.product_type)classification={product_group:'soft_furnishings',product_type:frozenRule.config?.extraction?.product_type||'furniture',confidence:.6,method:frozenRule.config?.schema_version==='site-rule-config-v2'?'frozen_site_rule_contract_v2':'frozen_site_rule_contract_v1',evidence:[`rule:${frozenRule.id}`,'top_level_product_contract']};
          if(!classification.product_type&&!aiAnalysisAttempted){
            aiAnalysisAttempted=true;
            try{
              siteProfile=await analyzeWebsite({brandName:job.brand_name||scope.brand_name,baseUrl:job.base_url||scope.base_url,pageUrl:page.url,html:page.html});
              scope.ai_analysis_profile=siteProfile;
              await db.query(`UPDATE product_ingestion_sources SET ai_analysis_profile=?,ai_analysis_updated_at=NOW() WHERE id=?`,[JSON.stringify(siteProfile),job.source_id]);
              await db.query(`UPDATE product_ingestion_jobs SET scope_snapshot=?,heartbeat_at=NOW() WHERE id=? AND status='running'`,[JSON.stringify({...job.scope_snapshot,ai_analysis_profile:siteProfile}),id]);
              classification=classifyProduct(page.html,scope.adapter_key,page.url,siteProfile);
            }catch(error){aiAnalysisFailure=error;}
          }
          if(!classification.product_type){const error=new Error(aiAnalysisFailure?`无法识别产品分类；千问辅助分析失败：${aiAnalysisFailure.message}`:'无法可靠识别产品分类，请在候选列表中人工指定');error.code=aiAnalysisFailure?.code||'CLASSIFICATION_UNCERTAIN';throw error;}
          let ocr=null,selectedRule=frozenRule,result;
          if(frozenRule){
            const selected=ruleSetExtractor(page,frozenRules,{brandName:job.brand_name||scope.brand_name,productType:classification.product_type,productTypeConfidence:classification.confidence,productTypeMethod:classification.method});
            selectedRule=selected.rule;result=selected.result;
            ocr=await collectOcrEvidence(page,selectedRule,{env:process.env});
            if(ocr&&ocr.status!=='not_configured')result=ruleExtractor(page,selectedRule,{brandName:job.brand_name||scope.brand_name,productType:classification.product_type,productTypeConfidence:classification.confidence,productTypeMethod:classification.method,ocrEvidence:ocr.evidence||{},ocrStatus:ocr});
          }else result=extractProduct(page.html, classification.product_type, page.url,siteProfile,{commonImageKeys});
          if(ocr&&ocr.status!=='not_configured')result.generatedFields.push({path:'ocr',rule:'bounded_image_evidence_v1',value:ocr.status,confidence:ocr.status==='completed'?1:0,evidence:ocr.images||[],error_code:ocr.error_code||null});
          result.generatedFields.push({path:'classification',rule:classification.method,value:`${classification.product_group}/${classification.product_type}`,confidence:classification.confidence,evidence:classification.evidence});
          const detection=scope.product_detection?.[sourceUrl];
          if(detection)result.generatedFields.push({path:'discovery',rule:'multi_evidence_v1',value:detection.origin,confidence:Math.min(1,Number(detection.score||0)/100),evidence:detection.evidence||[]});
          await saveCandidate(job, sourceUrl, page, result, null, classification); found += 1; accepted += 1;
        } catch (error) {
          const rateLimit=fullCrawlRateLimitWait(error,scope,now());
          if(rateLimit){error.code=rateLimit.exhausted?'RATE_LIMIT_RETRY_EXHAUSTED':'RATE_LIMIT_WAITING';error.rate_limit=rateLimit;throw error;}
          if(frozenRule&&error.code==='SITE_RULE_TEMPLATE_STALE'){
            const decision=await classifyTemplateFailure(job,sourceUrl,page,error,processed);
            if(decision.action==='learn_template')fatalError=error;
          }
          const candidateId=await saveCandidate(job, sourceUrl, page, null, error, classification); found += 1; rejected += 1;
          if(shadowAttempts<3&&job.recovery_mode==='shadow'){
            shadowAttempts+=1;
            await shadowPlanner({job,sourceUrl,candidateId,failure:error,page,initialResult:{classification},evidence:{raw_http_status:page?.status||error?.response?.status||null,raw_content_type:page?.contentType||error?.response?.headers?.['content-type']||null}}).catch(()=>{});
          }
          if(String(error.code||'').startsWith('INGESTION_AI_'))fatalError=error;
        }
        processed+=1;
        // Frozen-rule retries upsert the same URL. Recount physical rows so a
        // repaired page does not inflate candidate totals or leave a stale
        // rejected count behind.
        if(frozenRule){
          const [[actual]]=await db.query(`SELECT COUNT(*) candidates,SUM(validation_status='valid') accepted,SUM(validation_status<>'valid') rejected FROM product_ingestion_candidates WHERE job_id=?`,[id]);
          found=Number(actual.candidates||0);accepted=Number(actual.accepted||0);rejected=Number(actual.rejected||0);
        }
        const [progress]=await db.query(`UPDATE product_ingestion_jobs SET pages_fetched=?,candidates_found=?,accepted_count=?,rejected_count=?,checkpoint_index=?,heartbeat_at=NOW() WHERE id=? AND status='running'`, [pages,found,accepted,rejected,processed,id]);
        if(!progress.affectedRows){const error=new Error('任务已被中止，进度不能继续写入');error.code='JOB_INTERRUPTED';throw error;}
        lastProgressAt=Date.now();
        if(fatalError)throw fatalError;
        if (found >= scope.max_products) break;
      }
      let summary=scope.discovery_summary?{...scope.discovery_summary,pipeline:{...(scope.discovery_summary.pipeline||{}),
        extraction:{status:'completed',attempted:found,succeeded:accepted,failed:rejected},
        field_mapping:{status:'completed',mapped:accepted,needs_attention:rejected},
        candidate_ingestion:{status:'completed',created_or_updated:found}}}:null;
      if(frozenRule){
        const [[actual]]=await db.query(`SELECT COUNT(*) candidates,SUM(validation_status='valid') accepted,SUM(validation_status<>'valid') rejected FROM product_ingestion_candidates WHERE job_id=?`,[id]);
        found=Number(actual.candidates||0);accepted=Number(actual.accepted||0);rejected=Number(actual.rejected||0);
        if(summary)summary={...summary,pipeline:{...(summary.pipeline||{}),extraction:{status:rejected?'incomplete':'completed',attempted:found,succeeded:accepted,failed:rejected},field_mapping:{status:rejected?'needs_attention':'completed',mapped:accepted,needs_attention:rejected},candidate_ingestion:{status:'completed',created_or_updated:found}}};
      }
      let siteValidation=null;if(frozenRule){const [metricRows]=await db.query('SELECT source_url,normalized_payload,validation_status,validation_issues FROM product_ingestion_candidates WHERE job_id=?',[id]);siteValidation=productSchemaSiteMetrics(metricRows);if(summary)summary={...summary,site_validation:siteValidation};}
      const partial=Boolean(frozenRule&&rejected>0);
      if(frozenRule)await db.query(`UPDATE product_ingestion_jobs SET status='completed',finished_at=NOW(),pages_fetched=?,candidates_found=?,accepted_count=?,rejected_count=?,checkpoint_index=?,discovery_summary=COALESCE(?,discovery_summary),current_stage='completed',current_url=NULL,heartbeat_at=NOW(),failure_code=?,last_error=? WHERE id=? AND status='running'`, [pages,found,accepted,rejected,processed,json(summary),partial?'SITE_RULE_FULL_CRAWL_PARTIAL':null,partial?'全站采集已完成；个别疑似非产品页或解析异常已跳过并保留，等待人工检查':null,id]);
      else await db.query(`UPDATE product_ingestion_jobs SET status='completed',finished_at=NOW(),pages_fetched=?,candidates_found=?,accepted_count=?,rejected_count=?,discovery_summary=COALESCE(?,discovery_summary),current_stage='completed',current_url=NULL,heartbeat_at=NOW(),failure_code=NULL WHERE id=? AND status='running'`, [pages,found,accepted,rejected,json(summary),id]);
      if(frozenRule)await fullCrawlFinished(Number(id),'success',{pages_fetched:pages,candidates_found:found,accepted_count:accepted,rejected_count:rejected,partial,site_validation:siteValidation});
      } finally { clearInterval(watchdog); }
    } catch (error) {
      console.error('Product ingestion job failed:', { jobId:id, code:error.code || error.name, message:error.message });
      const [latestRows]=await db.query('SELECT status FROM product_ingestion_jobs WHERE id=?',[id]).catch(()=>[[]]);
      if(['cancelled','paused'].includes(latestRows[0]?.status))return;
      if(error.code==='RATE_LIMIT_WAITING'){
        const job=await loadJob(id),resumeAt=error.rate_limit.resume_at,nextScope={...(job.scope_snapshot||{}),full_crawl_rate_limit_waits:error.rate_limit.attempt,full_crawl_rate_limit_resume_at:resumeAt};
        await db.query(`UPDATE product_ingestion_jobs SET status='queued',scope_snapshot=?,failure_code='RATE_LIMIT_WAITING',last_error=?,current_stage='rate_limit_wait',current_url=NULL,finished_at=NULL,heartbeat_at=NOW() WHERE id=? AND status='running'`,[JSON.stringify(nextScope),`官网要求降低访问频率；系统将在 ${resumeAt} 自动继续（第 ${error.rate_limit.attempt}/${MAX_FULL_CRAWL_RATE_LIMIT_WAITS} 次）`,id]);
        scheduleAt(()=>launchWhenFree(Number(id),run),Math.max(0,Date.parse(resumeAt)-now()));
        return;
      }
      await db.query(`UPDATE product_ingestion_jobs SET status='failed',finished_at=NOW(),failure_code=?,last_error=?,current_stage='failed',heartbeat_at=NOW() WHERE id=? AND status IN ('queued','running')`, [String(error.code||'JOB_FAILED').slice(0,80),`${error.code||'JOB_FAILED'}: ${String(error.message || '任务执行失败')}`.slice(0,1000),id]).catch(() => {});
      let driftDetails={};
      if(error.code==='SITE_RULE_TEMPLATE_STALE'){
        const [progressRows]=await db.query('SELECT checkpoint_index,current_url FROM product_ingestion_jobs WHERE id=?',[id]).catch(()=>[[]]);
        driftDetails={failed_url:progressRows[0]?.current_url||null,resume_checkpoint:Math.max(0,Number(error.template_drift_decision?.resume_checkpoint??Number(progressRows[0]?.checkpoint_index||0)-1)),failure_signature:error.template_drift_decision?.signature||null,preserve_discovery:true};
      }
      await fullCrawlFinished(Number(id),error.code==='SITE_RULE_TEMPLATE_STALE'?'template_drift':'execution_failed',{error_code:error.code||'JOB_FAILED',message:String(error.message||'任务执行失败').slice(0,1000),...driftDetails}).catch(()=>{});
    } finally { await globalSlot?.release(); running.delete(Number(id)); }
  }
  async function runDiscovery(id) {
    if (running.has(Number(id))) return;
    running.add(Number(id));
    let continueToExtraction=false;
    let globalSlot;
    try {
      globalSlot=await globalSlots.acquire({jobId:id,phase:'discovery'});
      if(!globalSlot){scheduleAt(()=>launchWhenFree(Number(id),runDiscovery),globalSlotRetryMs);return;}
      const job = await loadJob(id);
      if (!job.scope_snapshot || job.status !== 'discovery_approved' || job.scope_snapshot.job_mode !== 'brand_scan') throw new Error('任务没有可执行的官网分析授权快照');
      const scope = {...job.scope_snapshot,job_id:Number(id),job_status:'discovering',source_status:job.source_status,policy_db:db};
      scope.policy_authorizer=policyAuthorizer(db,job.source_id,Number(id));
      scope.page_quota={used:Number(job.discovery_checkpoint?.attempted||job.discovery_checkpoint?.visited?.length||0),limit:scope.max_pages};
      if (job.source_status !== 'active') throw new Error('抓取来源已暂停，不能分析官网');
      const frozenRules=job.frozen_site_rule_id?await frozenRuleSetLoader(db,job.source_id):[];
      const frozenRule=frozenRules[0]||null;
      if(typeof dependencies.startSiteCognition==='function'&&Number(scope.site_cognition_ready_rule_id)!==Number(frozenRule?.id||0)){
        await dependencies.startSiteCognition(Number(id));
        return;
      }
      const [claimed] = await db.query(`UPDATE product_ingestion_jobs SET status='discovering',started_at=COALESCE(started_at,NOW()),finished_at=NULL,last_error=NULL,failure_code=NULL,current_stage='url_discovery',current_url=NULL,heartbeat_at=NOW() WHERE id=? AND status='discovery_approved'`, [id]);
      if (!claimed.affectedRows) return;
      if(frozenRule)await fullCrawlStarted(Number(id));
      const activeDiscoverer=frozenRule?ruleDiscoverer:productDiscoverer;
      const result = await activeDiscoverer(scope, ...(frozenRule?[frozenRule,pageFetcher]:[pageFetcher]), async progress => {
        const [updated]=await db.query(`UPDATE product_ingestion_jobs SET pages_fetched=?,checkpoint_index=?,discovery_checkpoint=?,heartbeat_at=NOW() WHERE id=? AND status='discovering'`, [progress.pages_scanned,progress.pages_scanned,json(progress.checkpoint),id]);
        if(!updated.affectedRows){const problem=new Error('任务已被中止，停止继续发现页面');problem.code='JOB_INTERRUPTED';throw problem;}
      }, {sitemapDiscoverer,checkpoint:job.discovery_checkpoint});
      await db.query('DELETE FROM product_ingestion_discovered_product_categories WHERE job_id=?', [id]);
      for (const record of result.records || []) {
        for (const category of record.source_categories || []) {
          const [stored] = await db.query(
            `INSERT INTO product_ingestion_source_categories (source_id,external_key,name,source_url)
             VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),name=VALUES(name),source_url=VALUES(source_url)`,
            [job.source_id, category.external_key, category.name, category.source_url]
          );
          await db.query(
            `INSERT INTO product_ingestion_discovered_product_categories
             (job_id,source_id,product_url_hash,product_url,source_category_id) VALUES (?,?,?,?,?)`,
            [id, job.source_id, digest(record.url), record.url, stored.insertId]
          );
        }
      }
      const sampleOnlyFrozenDiscovery=frozenRule&&frozenDiscoveryMustStop(result.summary);
      if(!result.urls.length||sampleOnlyFrozenDiscovery){
        const failureCode=sampleOnlyFrozenDiscovery?'SAMPLE_ONLY_PRODUCT_DISCOVERY':'NO_PRODUCTS_DISCOVERED';
        const failureMessage=sampleOnlyFrozenDiscovery?(result.summary.message||'冻结规则只完成了抽样验证，尚未完成全站产品发现'):(result.summary.message||'未发现产品详情页');
        await db.query(`UPDATE product_ingestion_jobs SET status='discovery_failed',discovered_urls=?,discovery_summary=?,pages_fetched=?,finished_at=NOW(),failure_code=?,current_stage='failed',heartbeat_at=NOW(),last_error=? WHERE id=? AND status='discovering'`,
          [JSON.stringify(result.urls||[]),JSON.stringify(result.summary),result.summary.pages_scanned,failureCode,`${failureCode}: ${failureMessage}`.slice(0,1000),id]);
        if(job.recovery_mode==='shadow'){
          const failure=new Error(failureMessage);failure.code=failureCode;
          await shadowPlanner({job,sourceUrl:job.base_url,failure,initialResult:{discovered_urls:[]},evidence:{discovery_summary:result.summary,snapshots:result.evidence_snapshots||[]}}).catch(()=>{});
        }
        if(frozenRule)await fullCrawlFinished(Number(id),'execution_failed',{error_code:failureCode,message:failureMessage});
      }else{
        const detection=Object.fromEntries((result.records||[]).map(record=>[record.url,record.detection||null]));
        const executionPages=Math.min(Number(job.scope_snapshot.max_pages||500),Number(job.scope_snapshot.max_products||500),500);
        const executionScope={...job.scope_snapshot,seed_urls:result.urls.slice(0,job.scope_snapshot.max_products),
          discovery_entry_urls:job.scope_snapshot.seed_urls,discovery_summary:result.summary,
          product_detection:detection,max_pages:executionPages,network_request_limit:Math.min(Number(job.scope_snapshot.max_pages||executionPages),Math.max(executionPages,result.urls.length*2)),
          ...(frozenRule?{site_rule_id:Number(frozenRule.id),site_rule_ids:frozenRules.map(rule=>Number(rule.id)),site_rule_version:Number(frozenRule.version_number),site_rule_hash:frozenRule.config_hash}: {})};
        await db.query(`UPDATE product_ingestion_jobs SET status='queued',scope_snapshot=?,discovered_urls=?,discovery_summary=?,discovery_checkpoint=NULL,pages_fetched=0,candidates_found=0,accepted_count=0,rejected_count=0,checkpoint_index=0,current_stage='extraction',current_url=NULL,heartbeat_at=NOW(),finished_at=NULL,last_error=NULL,failure_code=NULL WHERE id=? AND status='discovering'`,
          [JSON.stringify(executionScope),JSON.stringify(result.urls),JSON.stringify(result.summary),id]);
        continueToExtraction=true;
      }
    } catch (error) {
      console.error('Product ingestion discovery failed:', { jobId:id, code:error.code || error.name, message:error.message });
      const [latestRows]=await db.query('SELECT status FROM product_ingestion_jobs WHERE id=?',[id]).catch(()=>[[]]);
      if(['cancelled','paused'].includes(latestRows[0]?.status))return;
      await db.query(`UPDATE product_ingestion_jobs SET status='discovery_failed',finished_at=NOW(),failure_code=?,last_error=?,current_stage='failed',heartbeat_at=NOW() WHERE id=? AND status IN ('discovery_approved','discovering')`, [String(error.code||'DISCOVERY_FAILED').slice(0,80),`${error.code||'DISCOVERY_FAILED'}: ${String(error.message || '官网分析失败')}`.slice(0,1000), id]).catch(() => {});
      await fullCrawlFinished(Number(id),error.code==='SITE_RULE_TEMPLATE_STALE'?'template_drift':'execution_failed',{error_code:error.code||'DISCOVERY_FAILED',message:String(error.message||'官网分析失败').slice(0,1000)}).catch(()=>{});
    } finally {
      await globalSlot?.release();
      running.delete(Number(id));
      if(continueToExtraction)setImmediate(()=>run(Number(id)));
    }
  }
  return {
    async recoverInterruptedJobs() {
      const message='PROCESS_INTERRUPTED: 本地服务曾退出或重启，后台执行已中断；可从最后断点重试';
      const [rows]=await db.query(`SELECT id,status,current_stage FROM product_ingestion_jobs WHERE status IN ('discovering','running','queued') AND scope_snapshot IS NOT NULL ORDER BY id`);
      let discovery=0,extraction=0;
      for(const row of rows){
        const jobId=Number(row.id),wasDiscovery=row.status==='discovering'||row.current_stage==='url_discovery'||row.current_stage==='site_cognition';
        if(wasDiscovery){
          const [restored]=await db.query(`UPDATE product_ingestion_jobs SET status='discovery_approved',finished_at=NULL,failure_code='PROCESS_INTERRUPTED_RESUMING',last_error=?,current_stage='source_analysis',current_url=NULL,heartbeat_at=NOW() WHERE id=? AND status IN ('discovering','queued')`,[message,jobId]);
          if(restored.affectedRows){discovery+=1;schedule(()=>runDiscovery(jobId));}
        }else{
          const [restored]=await db.query(`UPDATE product_ingestion_jobs SET status='queued',finished_at=NULL,failure_code='PROCESS_INTERRUPTED_RESUMING',last_error=?,current_stage='extraction',current_url=NULL,heartbeat_at=NOW() WHERE id=? AND status IN ('running','queued')`,[message,jobId]);
          if(restored.affectedRows){extraction+=1;schedule(()=>run(jobId));}
        }
      }
      return {recovered:discovery+extraction,resumed_discovery:discovery,resumed_extraction:extraction};
    },
    async startDiscovery(id) {
      const jobId = Number(id); if (!Number.isSafeInteger(jobId) || jobId <= 0) { const error=new Error('任务 ID 不正确'); error.status=400; throw error; }
      const [result] = await db.query(`UPDATE product_ingestion_jobs SET status='discovery_approved',finished_at=NULL,last_error=NULL,failure_code=NULL,current_stage='source_analysis',current_url=NULL,heartbeat_at=NOW(),checkpoint_index=0 WHERE id=? AND job_mode='brand_scan' AND status IN ('discovery_approved','discovery_failed') AND scope_snapshot IS NOT NULL`, [jobId]);
      if (!result.affectedRows) { const error=new Error('只有已授权或分析失败的全品牌任务可以开始分析'); error.status=409; throw error; }
      launchWhenFree(jobId,runDiscovery);
      return { id:jobId,status:'discovery_approved' };
    },
    async start(id) {
      const jobId = Number(id); if (!Number.isSafeInteger(jobId) || jobId <= 0) { const error=new Error('任务 ID 不正确'); error.status=400; throw error; }
      const [result] = await db.query(`UPDATE product_ingestion_jobs SET status='queued',finished_at=NULL,last_error=NULL,failure_code=NULL,current_stage='extraction',current_url=NULL,heartbeat_at=NOW() WHERE id=? AND status IN ('approved','queued','failed') AND scope_snapshot IS NOT NULL`, [jobId]);
      if (!result.affectedRows) { const error=new Error('只有已授权、排队中或失败的任务可以人工开始'); error.status=409; throw error; }
      launchWhenFree(jobId,run);
      return { id:jobId,status:'queued' };
    },
    async resumeRecoveredDiscovery(id, recoveredUrls, attemptId) {
      const jobId=Number(id),job=await loadJob(jobId),scope=job.scope_snapshot||{};
      if(!['discovery_failed','failed'].includes(job.status)){const error=new Error('原任务当前状态不能接收恢复结果');error.status=409;error.code='RECOVERY_JOB_STATE_INVALID';throw error;}
      const allowedHosts=new Set((scope.allowed_hosts||[]).map(value=>String(value).toLowerCase())),prefixes=scope.allowed_path_prefixes||['/'];
      const urls=[...new Set((recoveredUrls||[]).map(raw=>{const url=new URL(raw);url.hash='';if(!['http:','https:'].includes(url.protocol)||!allowedHosts.has(url.hostname.toLowerCase()))return null;if(!prefixes.some(prefix=>prefix==='/'||url.pathname===prefix||url.pathname.startsWith(prefix.endsWith('/')?prefix:`${prefix}/`)))return null;return url.toString();}).filter(Boolean))].slice(0,Math.min(Number(scope.max_products||500),500));
      if(!urls.length){const error=new Error('恢复结果没有位于原授权范围内的产品地址');error.status=409;error.code='RECOVERY_URL_SCOPE_INVALID';throw error;}
      const summary={...(parsed(job.discovery_summary)||{}),recovery:{attempt_id:Number(attemptId),status:'validated',product_urls:urls.length,resumed_at:new Date().toISOString()},pipeline:{...((parsed(job.discovery_summary)||{}).pipeline||{}),url_discovery:{status:'recovered',urls_found:urls.length},product_detection:{status:'completed',products_found:urls.length},extraction:{status:'pending'},field_mapping:{status:'pending'},candidate_ingestion:{status:'pending'}}};
      const executionScope={...scope,seed_urls:urls,discovery_entry_urls:scope.discovery_entry_urls||scope.seed_urls||[job.base_url],discovery_summary:summary,max_pages:Math.min(urls.length,Number(scope.max_products||500),500)};
      const [updated]=await db.query(`UPDATE product_ingestion_jobs SET status='queued',scope_snapshot=?,discovered_urls=?,discovery_summary=?,pages_fetched=0,candidates_found=0,accepted_count=0,rejected_count=0,checkpoint_index=0,current_stage='extraction',current_url=NULL,heartbeat_at=NOW(),finished_at=NULL,last_error=NULL,failure_code=NULL WHERE id=? AND status IN ('discovery_failed','failed')`,[JSON.stringify(executionScope),JSON.stringify(urls),JSON.stringify(summary),jobId]);
      if(!updated.affectedRows){const error=new Error('原任务状态已变化，恢复结果没有重复写入');error.status=409;error.code='RECOVERY_JOB_STATE_CHANGED';throw error;}
      setImmediate(()=>run(jobId));
      return {type:'job_resumed',job_id:jobId,product_urls:urls.length,status:'queued'};
    },
    async planHistoricalFailure(id,options={}) {
      const jobId=Number(id);if(!Number.isSafeInteger(jobId)||jobId<1){const error=new Error('任务 ID 不正确');error.status=400;throw error;}
      const job=await loadJob(jobId);if(!job){const error=new Error('抓取任务不存在');error.status=404;throw error;}
      if(!['failed','discovery_failed'].includes(job.status)){const error=new Error('只有失败任务可以生成影子恢复建议');error.status=409;throw error;}
      if(job.recovery_mode!=='shadow'){
        if(options.enableShadow!==true){const error=new Error('请先为该来源开启 AI 影子观察');error.status=409;throw error;}
        await db.query("UPDATE product_ingestion_sources SET recovery_mode='shadow' WHERE id=?",[job.source_id]);job.recovery_mode='shadow';
      }
      const discoverySummary=parsed(job.discovery_summary)||null;
      const failure=new Error(job.last_error||discoverySummary?.message||'历史抓取失败');failure.code=job.failure_code||(job.status==='discovery_failed'?'NO_PRODUCTS_DISCOVERED':'EXTRACTION_FAILED');
      return shadowPlanner({job,sourceUrl:job.current_url||job.base_url,failure,initialResult:{status:job.status,pages_fetched:Number(job.pages_fetched||0),candidates_found:Number(job.candidates_found||0)},evidence:{historical:true,discovery_summary:discoverySummary}});
    },
    run, runDiscovery,
  };
}

module.exports = { createRunner, digest, issue, frozenDiscoveryMustStop, preferredContentUrl, fetchPreferredHtml, retryablePageError, fetchPageWithRetry, productSchemaSiteMetrics, fullCrawlRateLimitWait, MAX_FULL_CRAWL_RATE_LIMIT_WAITS };
