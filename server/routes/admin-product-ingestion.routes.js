'use strict';
const express = require('express');
const { success, error } = require('../utils/response');
const { createControl } = require('../services/product-ingestion-control');
const { createRunner } = require('../services/product-ingestion-runner');
const { createPublicProductLibrary } = require('../services/public-product-library');
const { createPublicProductTaxonomy } = require('../services/public-product-taxonomy');
const { createFieldReview } = require('../services/product-ingestion-field-review');
const { createRecoveryControl } = require('../services/product-ingestion-recovery-control');
const { createSiteRuleControl } = require('../services/product-ingestion-site-rule-sandbox');
const { createSiteCognitionControl } = require('../services/product-ingestion-site-cognition');
const { createOfficialBrandMaterials } = require('../services/official-brand-materials');
const { createMaterialOnboarding } = require('../services/product-ingestion-material-onboarding');
const { PRODUCT_SCHEMA_VERSION,FIELD_STATUSES,ASSET_ROLES,CORRECTION_ACTIONS,FIELD_REGISTRY,PRODUCT_DOCUMENT_V2_SCHEMA } = require('../services/product-schema-v2');
const {createGlobalSlotManager}=require('../services/product-ingestion-global-slots');
const {createWorkerDispatcher}=require('../services/product-ingestion-worker-dispatch');
const {createWorkerMonitor}=require('../services/product-ingestion-worker-monitor');
const {createEcsLifecycleController}=require('../services/product-ingestion-ecs-lifecycle');

module.exports = function routes(db) {
  const executionDisabled=async()=>{const problem=new Error('抓取执行已迁移到独立 Worker');problem.code='INGESTION_EXECUTION_NOT_AVAILABLE_IN_API';problem.status=503;throw problem;};
  const noSchedule=()=>undefined;
  const globalSlots=createGlobalSlotManager(db);
  const router = express.Router(), control = createControl(db), library = createPublicProductLibrary(db), taxonomy = createPublicProductTaxonomy(db), fieldReview=createFieldReview(db), siteRules=createSiteRuleControl(db,{fetchHtml:executionDisabled}), officialMaterials=createOfficialBrandMaterials(db), materialOnboarding=createMaterialOnboarding(db,{fetchHtml:executionDisabled,officialMaterials}), dispatcher=createWorkerDispatcher(db), workerMonitor=createWorkerMonitor(db), ecsLifecycle=createEcsLifecycleController(db);
  let runner;
  const cognition=createSiteCognitionControl(db,{siteRules,fetchHtml:executionDisabled,renderedFetchHtml:executionDisabled,globalSlots,schedule:noSchedule,scheduleAt:noSchedule,onFullCrawlReady:noSchedule});
  runner=createRunner(db,{
    fetchHtml:executionDisabled,
    globalSlots,
    schedule:noSchedule,
    scheduleAt:noSchedule,
  });
  const recovery=createRecoveryControl(db,{fetchHtml:executionDisabled});
  const actor = req => String(req.admin?.adminUsername || req.admin?.role || 'admin').slice(0, 80);
  const handle = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return success(res, await fn(req)); }
    catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return error(res, '产品抓取数据表尚未初始化，请先执行 20260910_product_ingestion_control.sql', 503);
      if (err.code === 'ER_DUP_ENTRY') return error(res, '提交的数据与现有记录冲突', 409);
      if (err.status) return error(res, err.message, err.status);
      console.error('Product ingestion control:', err.code || err.name);
      return error(res, '产品抓取控制台操作失败，请稍后重试', 500);
    }
  };
  router.get('/summary', handle(() => control.summary()));
  router.get('/worker-status',handle(async()=>({...(await workerMonitor.status()),ecs_lifecycle:await ecsLifecycle.status()})));
  router.get('/product-schema-v2',handle(()=>({schema_version:PRODUCT_SCHEMA_VERSION,field_statuses:FIELD_STATUSES,asset_roles:ASSET_ROLES,correction_actions:CORRECTION_ACTIONS,field_registry:FIELD_REGISTRY,json_schema:PRODUCT_DOCUMENT_V2_SCHEMA})));
  router.get('/sources', handle(() => control.listSources()));
  router.post('/official-materials/rules/validate',handle(req=>officialMaterials.validateRule(req.body?.rule||req.body||{})));
  router.get('/official-materials/catalogs',handle(req=>officialMaterials.listCatalogs(req.query||{})));
  router.post('/official-materials/catalogs',handle(req=>officialMaterials.saveCatalog(req.body||{},actor(req))));
  router.get('/official-materials/catalogs/:id',handle(req=>officialMaterials.getCatalog(req.params.id)));
  router.post('/official-materials/catalogs/:id/freeze',handle(req=>officialMaterials.freezeCatalog(req.params.id,req.body||{},actor(req))));
  router.post('/official-materials/catalogs/:id/scan',handle(req=>{if(req.body?.confirmed!==true){const problem=new Error('请确认开始受控扫描品牌材料总库');problem.status=400;throw problem;}return dispatcher.enqueue('official_material_catalog_scan',{catalog_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req));}));
  router.post('/official-materials/catalogs/:id/product-subset-scan',handle(req=>{if(req.body?.confirmed!==true){const problem=new Error('请确认受控读取产品关联材料页面');problem.status=400;throw problem;}return dispatcher.enqueue('official_material_product_subset_scan',{catalog_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req));}));
  router.get('/official-materials/scans',handle(req=>officialMaterials.listScans(req.query||{})));
  router.get('/official-materials/scans/:id',handle(req=>officialMaterials.getScan(req.params.id)));
  router.get('/official-materials/materials',handle(req=>officialMaterials.listMaterials(req.query||{})));
  router.get('/official-materials/library/facets',handle(()=>officialMaterials.materialFacets()));
  router.get('/official-materials/library/materials',handle(req=>officialMaterials.browseMaterials(req.query||{})));
  router.get('/official-materials/library/product-declarations',handle(req=>officialMaterials.listProductDeclarations(req.query||{})));
  router.get('/official-materials/library/materials/:id',handle(req=>officialMaterials.materialWorkbench(req.params.id)));
  router.get('/official-materials/materials/:id',handle(req=>officialMaterials.getMaterial(req.params.id)));
  router.get('/official-materials/product-materials',handle(req=>officialMaterials.productMaterials(req.query||{})));
  router.get('/official-materials/onboarding/eligible-sources',handle(()=>materialOnboarding.eligibleSources()));
  router.post('/official-materials/onboarding/prepare',handle(req=>dispatcher.enqueue('material_onboarding_prepare',{body:req.body||{},actor:actor(req)},actor(req))));
  router.post('/official-materials/onboarding/catalogs/:id/reject-sample',handle(req=>materialOnboarding.rejectSample(req.params.id,req.body||{},actor(req))));
  router.post('/official-materials/onboarding/catalogs/:id/text-only-revision',handle(req=>dispatcher.enqueue('material_onboarding_text_revision',{catalog_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req))));
  router.post('/official-materials/onboarding/catalogs/:id/approve-and-scan',handle(req=>dispatcher.enqueue('material_onboarding_approve_scan',{catalog_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req))));
  router.post('/sources', handle(req => control.createSource(req.body || {}, actor(req))));
  router.put('/sources/:id', handle(req => control.updateSource(req.params.id, req.body || {})));
  router.post('/sources/:id/status', handle(req => control.changeSourceStatus(req.params.id, req.body || {}, actor(req))));
  router.post('/sources/:id/recovery-mode', handle(req => control.changeSourceRecoveryMode(req.params.id, req.body || {}, actor(req))));
  router.post('/site-rules/validate', handle(req => siteRules.validate(req.body?.config || req.body || {})));
  router.get('/site-rules', handle(req => siteRules.list(req.query || {})));
  router.post('/site-rules', handle(req => {
    if(req.body?.confirmed!==true){const problem=new Error('请确认保存站点规则草稿');problem.status=400;throw problem;}
    return siteRules.create(req.body.source_id,req.body.config || {},actor(req));
  }));
  router.get('/site-rules/:id', handle(req => siteRules.get(req.params.id)));
  router.get('/site-rules/:id/sandbox-runs', handle(req => siteRules.listRuns(req.params.id)));
  router.post('/site-rules/:id/sandbox-runs', handle(req => {
    if(req.body?.confirmed!==true){const problem=new Error('请确认开始受控沙箱抽样');problem.status=400;throw problem;}
    return dispatcher.enqueue('site_rule_sandbox',{rule_id:Number(req.params.id),actor:actor(req)},actor(req));
  }));
  router.post('/site-rules/:id/freeze', handle(req => siteRules.freeze(req.params.id,req.body || {},actor(req))));
  router.get('/site-cognition/workflows',handle(req=>cognition.list(req.query||{})));
  router.get('/site-cognition/workflows/:id',handle(req=>cognition.get(req.params.id)));
  router.post('/site-cognition/jobs/:id/start',handle(req=>{
    if(req.body?.confirmed!==true){const problem=new Error('请确认开始 AI 网站分析');problem.status=400;throw problem;}
    return dispatcher.enqueue('site_cognition_start',{job_id:Number(req.params.id),actor:actor(req)},actor(req));
  }));
  router.post('/site-cognition/workflows/:id/feedback',handle(req=>dispatcher.enqueue('site_cognition_feedback',{workflow_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req))));
  router.post('/site-cognition/workflows/:id/retry',handle(req=>{
    if(req.body?.confirmed!==true){const problem=new Error('请确认重新尝试生成网站规则');problem.status=400;throw problem;}
    return dispatcher.enqueue('site_cognition_retry',{workflow_id:Number(req.params.id),actor:actor(req)},actor(req));
  }));
  router.post('/site-cognition/workflows/:id/ai-budget',handle(req=>{
    if(req.body?.confirmed!==true){const problem=new Error('请确认提高本次 AI 分析额度');problem.status=400;throw problem;}
    return dispatcher.enqueue('site_cognition_ai_budget',{workflow_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req));
  }));
  router.get('/recovery/summary', handle(() => recovery.summary()));
  router.get('/recovery/attempts', handle(req => recovery.list(req.query)));
  router.get('/recovery/attempts/:id', handle(req => recovery.get(req.params.id)));
  router.post('/recovery/attempts/:id/feedback', handle(req => recovery.feedback(req.params.id, req.body || {}, actor(req))));
  router.post('/recovery/attempts/:id/try-existing-data', handle(req => dispatcher.enqueue('recovery_try_existing_data',{attempt_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req))));
  router.post('/recovery/attempts/:id/system-review', handle(req => recovery.resolveSystemReview(req.params.id, req.body || {}, actor(req))));
  router.post('/recovery/attempts/:id/prepare-evidence', handle(req => recovery.prepareEvidence(req.params.id, req.body || {})));
  router.post('/recovery/attempts/:id/acquire-evidence', handle(req => dispatcher.enqueue('recovery_acquire_evidence',{attempt_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req))));
  router.post('/recovery/attempts/:id/retry-plan', handle(req => dispatcher.enqueue('recovery_retry_plan',{attempt_id:Number(req.params.id),body:req.body||{},actor:actor(req)},actor(req))));
  router.post('/recovery/attempts/:id/manual-takeover', handle(req => recovery.manualTakeover(req.params.id, req.body || {}, actor(req))));
  router.get('/jobs', handle(req => control.listJobs(req.query)));
  router.get('/jobs/:id/workbench',handle(async req=>{
    const job=await control.getJob(req.params.id);
    const [workflowSummary,recoveryResult,candidates]=await Promise.all([cognition.latestForJob(job.id),recovery.list({job_id:job.id,limit:1}),control.listCandidates({job_id:job.id})]);
    const workflow=workflowSummary?await cognition.get(workflowSummary.id):null,recoveryAttempt=recoveryResult.items?.[0]||null;
    const counts={total:candidates.length,valid:0,invalid:0,pending_review:0,approved:0,rejected:0,published:0};
    for(const candidate of candidates){if(candidate.validation_status==='valid')counts.valid+=1;if(candidate.validation_status==='invalid')counts.invalid+=1;if(candidate.review_status==='pending')counts.pending_review+=1;if(candidate.review_status==='approved')counts.approved+=1;if(candidate.review_status==='rejected')counts.rejected+=1;if(candidate.published_product_id)counts.published+=1;}
    return {job,workflow,recovery:recoveryAttempt,candidates,counts};
  }));
  router.post('/jobs', handle(req => control.createJob(req.body || {}, actor(req))));
  router.post('/automatic-collections', handle(async req => {
    const created=await control.createAutomaticCollection(req.body || {},actor(req));
    await runner.startDiscovery(created.job_id);
    return {...created,status:'discovery_approved'};
  }));
  router.post('/jobs/:id/collect', handle(async req => {
    await control.authorizeAutomaticCollection(req.params.id,req.body || {},actor(req));
    return runner.startDiscovery(req.params.id);
  }));
  router.post('/jobs/:id/recollect', handle(async req => {
    const created=await control.createRecollection(req.params.id,req.body||{},actor(req));
    await runner.startDiscovery(created.job_id);
    return created;
  }));
  router.post('/jobs/:id/approve-discovery', handle(req => control.approveDiscovery(req.params.id, req.body || {}, actor(req))));
  router.post('/jobs/:id/start-discovery', handle(req => {
    if (req.body?.confirmed !== true) { const problem = new Error('请确认开始分析'); problem.status = 400; throw problem; }
    return runner.startDiscovery(req.params.id);
  }));
  router.post('/jobs/:id/approve', handle(req => control.approveJob(req.params.id, req.body || {}, actor(req))));
  router.post('/jobs/:id/start', handle(req => {
    if (req.body?.confirmed !== true) { const problem = new Error('请确认开始抓取'); problem.status = 400; throw problem; }
    return runner.start(req.params.id);
  }));
  router.post('/jobs/:id/pause',handle(req=>{if(req.body?.confirmed!==true){const problem=new Error('请确认暂停任务');problem.status=400;throw problem;}return control.pauseJob(req.params.id);}));
  router.post('/jobs/:id/resume',handle(async req=>{if(req.body?.confirmed!==true){const problem=new Error('请确认继续任务');problem.status=400;throw problem;}const resumed=await control.resumeJob(req.params.id);if(resumed.resume_mode==='extraction')await runner.start(req.params.id);else await runner.startDiscovery(req.params.id);return resumed;}));
  router.post('/jobs/:id/cancel', handle(async req => {const stopped=await control.cancelJob(req.params.id);await cognition.stopForJob(req.params.id,actor(req));return stopped;}));
  router.post('/jobs/:id/recovery/shadow', handle(req => {
    if(req.body?.confirmed!==true){const problem=new Error('请确认生成历史失败任务的影子恢复建议');problem.status=400;throw problem;}
    return dispatcher.enqueue('historical_failure_shadow',{job_id:Number(req.params.id),options:{enableShadow:req.body?.enable_shadow===true},actor:actor(req)},actor(req));
  }));
  router.get('/candidates', handle(req => control.listCandidates(req.query)));
  router.put('/candidates/classification', handle(req => control.reclassifyCandidates(req.body || {}, actor(req))));
  router.get('/candidates/:id', handle(req => control.getCandidate(req.params.id)));
  router.get('/candidates/:id/field-candidates', handle(req => fieldReview.listFields(req.params.id)));
  router.put('/candidates/:id/field-selections', handle(req => fieldReview.saveSelections(req.params.id,req.body||{},actor(req))));
  router.post('/candidates/:id/field-mapping-preview', handle(req => fieldReview.previewFieldMapping(req.params.id,req.body||{})));
  router.post('/candidates/:id/field-mapping-apply', handle(req => fieldReview.applyFieldMapping(req.params.id,req.body||{},actor(req))));
  router.post('/candidates/:id/images/exclusion-preview', handle(req => fieldReview.previewImageExclusion(req.params.id,req.body||{})));
  router.post('/candidates/:id/images/exclude', handle(req => fieldReview.excludeImage(req.params.id,req.body||{},actor(req))));
  router.put('/candidates/:id/configurations/:configurationId/images', handle(req => control.updateCandidateConfigurationImages(req.params.id, req.params.configurationId, req.body || {}, actor(req))));
  router.get('/candidates/:id/categories', handle(req => taxonomy.effectiveCandidateCategories(req.params.id)));
  router.put('/candidates/:id/classification', handle(req => control.saveCandidateClassification(req.params.id,req.body||{},actor(req))));
  router.put('/candidates/:id/categories', handle(req => taxonomy.setCandidateCategories(req.params.id, req.body || {}, actor(req))));
  router.post('/candidates/:id/review', handle(req => control.reviewCandidate(req.params.id, req.body || {}, actor(req))));
  router.post('/candidates/:id/publish', handle(req => {
    if (req.body?.confirmation !== '发布到素材库') { const problem=new Error('请输入“发布到素材库”完成确认'); problem.status=400; throw problem; }
    return library.publishCandidate(req.params.id, actor(req));
  }));
  router.get('/library', handle(req => library.listProducts(req.query)));
  router.get('/library/facets', handle(() => library.facets({includeInactive:true})));
  router.get('/library/:id/versions/:versionId', handle(req => library.getProduct(req.params.id,false,req.params.versionId)));
  router.post('/library/status', handle(req => {
    const target=String(req.body?.status||'');
    if(req.body?.confirmed!==true){const problem=new Error('请确认产品状态操作');problem.status=400;throw problem;}
    if(target==='deleted'&&req.body?.confirmation!=='移入回收站'){const problem=new Error('请输入“移入回收站”完成确认');problem.status=400;throw problem;}
    return library.changeProductStatus(req.body?.product_ids,target,actor(req));
  }));
  router.get('/library/:id', handle(req => library.getProduct(req.params.id)));
  router.put('/library/:id/categories', handle(req => taxonomy.setProductCategories(req.params.id, req.body || {}, actor(req))));
  router.post('/library/:id/categories/reset', handle(req => taxonomy.resetProductCategories(req.params.id)));
  router.get('/taxonomy', handle(() => taxonomy.listGovernance()));
  router.put('/taxonomy/source-categories/:id', handle(req => taxonomy.saveSourceMapping(req.params.id, req.body || {}, actor(req))));
  return router;
};
