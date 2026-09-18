'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createControl, normalizeSourceInput, normalizeTaskInput, validateUrlAgainstSource } = require('../services/product-ingestion-control');

function source(overrides = {}) {
  return {
    status: 'active',
    allowed_hosts: ['www.example.com'],
    allowed_path_prefixes: ['/products/furniture/'],
    max_pages_per_run: 20,
    max_products_per_run: 50,
    request_interval_ms: 2000,
    ...overrides,
  };
}

test('source configuration fixes safety controls and accepts only exact hosts and paths', () => {
  const value = normalizeSourceInput({
    brand_name: '示例品牌', base_url: 'https://www.example.com/',
    allowed_hosts: 'www.example.com', allowed_asset_hosts: 'static.example.com',
    allowed_path_prefixes: '/products/furniture/',
    product_group: 'soft_furnishings', product_type: 'furniture', adapter_key: 'generic_jsonld_v1',
    max_pages_per_run: 20, max_products_per_run: 50, request_interval_ms: 2000,
  });
  assert.deepEqual(value.allowed_hosts, ['www.example.com']);
  assert.deepEqual(value.allowed_asset_hosts, ['www.example.com', 'static.example.com']);
  assert.equal(value.product_group, null);
  assert.equal(value.product_type, null);
  assert.equal(value.adapter_key, 'universal_web_v1');
  assert.equal(value.obey_robots, 1);
  assert.equal(value.manual_review_required, 1);
  for (const bad of [
    { allowed_hosts: '*.example.com' },
    { allowed_asset_hosts: '*.example.com' },
    { allowed_asset_hosts: 'static.example.com:8443' },
    { allowed_asset_hosts: 'https://static.example.com/images/' },
    { base_url: 'http://127.0.0.1/', allowed_hosts: '127.0.0.1' },
    { base_url: 'http://localhost/', allowed_hosts: 'localhost' },
    { base_url: 'http://catalog.internal.local/', allowed_hosts: 'catalog.internal.local' },
    { allowed_path_prefixes: '/products/../admin' },
    { request_interval_ms: 999 },
  ]) assert.throws(() => normalizeSourceInput({ ...value, ...bad }));
});

test('brand website validation explains the required complete URL format', () => {
  assert.throws(() => normalizeSourceInput({
    brand_name:'Fendi Casa',base_url:'www.fendicasa.com',allowed_hosts:'www.fendicasa.com',
    allowed_path_prefixes:'/',adapter_key:'generic_jsonld_v1',
  }), /https:\/\/ 或 http:\/\/.*www 可有可无.*https:\/\/example\.com\//);
});

test('brand website and exact host support domains without www', () => {
  const value=normalizeSourceInput({brand_name:'Banlan',base_url:'https://banlan.com.cn/',allowed_hosts:'banlan.com.cn',allowed_path_prefixes:'/',adapter_key:'generic_jsonld_v1'});
  assert.equal(value.base_url,'https://banlan.com.cn/');
  assert.deepEqual(value.allowed_hosts,['banlan.com.cn']);
});

test('source automatically derives its primary allowed host from the brand website', () => {
  const value=normalizeSourceInput({brand_name:'Banlan',base_url:'https://banlan.com.cn/',allowed_path_prefixes:'/',adapter_key:'generic_jsonld_v1'});
  assert.deepEqual(value.allowed_hosts,['banlan.com.cn']);
  assert.deepEqual(value.allowed_asset_hosts,['banlan.com.cn']);
  const withExtra=normalizeSourceInput({brand_name:'Banlan',base_url:'https://banlan.com.cn/',additional_allowed_hosts:'shop.banlan.com.cn',allowed_path_prefixes:'/',adapter_key:'generic_jsonld_v1'});
  assert.deepEqual(withExtra.allowed_hosts,['banlan.com.cn','shop.banlan.com.cn']);
});

test('source always uses the universal parser regardless of legacy adapter input', () => {
  const value=normalizeSourceInput({brand_name:'Example',base_url:'https://example.com/',allowed_path_prefixes:'/',adapter_key:'hc28_html_v1'});
  assert.equal(value.adapter_key,'universal_web_v1');
});

test('source permits a bounded discovery budget above 500 pages', () => {
  const value=normalizeSourceInput({brand_name:'Large Catalog',base_url:'https://example.com/',allowed_path_prefixes:['/'],max_pages_per_run:1200});
  assert.equal(value.max_pages_per_run,1200);
  assert.throws(()=>normalizeSourceInput({brand_name:'Too Large',base_url:'https://example.com/',allowed_path_prefixes:['/'],max_pages_per_run:2001}),/1 至 2000/);
});

test('URL scope never permits sibling hosts, credentials, other paths or non-http protocols', () => {
  const allowed = source();
  assert.equal(validateUrlAgainstSource('https://www.example.com/products/furniture/chair#detail', allowed), 'https://www.example.com/products/furniture/chair');
  for (const url of [
    'https://shop.example.com/products/furniture/chair',
    'https://www.example.com/products/lighting/lamp',
    'https://www.example.com/products/furniture-sale/chair',
    'https://user:pass@www.example.com/products/furniture/chair',
    'https://www.example.com:8443/products/furniture/chair',
    'file:///products/furniture/chair',
  ]) assert.throws(() => validateUrlAgainstSource(url, allowed));
});

test('task scope is bounded by the active source and requires a business reason', () => {
  const allowed = source();
  const task = normalizeTaskInput({
    seed_urls: ['https://www.example.com/products/furniture/chair'],
    max_pages: 10, max_products: 30, request_interval_ms: 3000, reason: '首批家具验证',
  }, allowed);
  assert.equal(task.seed_urls.length, 1);
  assert.equal(task.max_pages, 10);
  for (const [change, changedSource] of [
    [{ max_pages: 21 }, allowed],
    [{ max_products: 51 }, allowed],
    [{ request_interval_ms: 1000 }, allowed],
    [{ reason: '' }, allowed],
    [{}, source({ status: 'paused' })],
  ]) assert.throws(() => normalizeTaskInput({ ...task, ...change }, changedSource));
});

test('brand scan automatically uses the website stored on the selected source', () => {
  const allowed=source({base_url:'https://www.example.com/',allowed_path_prefixes:['/']});
  const task=normalizeTaskInput({job_mode:'brand_scan',max_pages:10,max_products:30,request_interval_ms:2000,reason:'全品牌发现'},allowed);
  assert.deepEqual(task.seed_urls,['https://www.example.com/']);
  assert.equal(task.job_mode,'brand_scan');
});

test('one confirmed website URL creates an approved source and automatic collection job', async () => {
  const statements=[];let committed=false;
  const conn={beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{},release:()=>{},query:async(sql,params=[])=>{
    statements.push({sql,params});
    assert.equal((sql.match(/\?/g)||[]).length,params.length,sql);
    if(sql.startsWith('SELECT * FROM product_ingestion_sources'))return [[]];
    if(sql.includes('INSERT INTO product_ingestion_sources'))return [{insertId:41}];
    if(sql.includes('INSERT INTO product_ingestion_jobs'))return [{insertId:51}];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const control=createControl({getConnection:async()=>conn});
  await assert.rejects(()=>control.createAutomaticCollection({base_url:'https://banlan.example/',confirmed:true},'preview-admin'),/请填写品牌名称/);
  const result=await control.createAutomaticCollection({brand_name:'班兰',base_url:'https://banlan.example/',max_pages:1200,confirmed:true},'preview-admin');
  assert.deepEqual(result,{source_id:41,job_id:51,status:'discovery_approved'});
  assert.equal(committed,true);
  const sourceInsert=statements.find(item=>item.sql.includes('INSERT INTO product_ingestion_sources'));
  assert.equal(sourceInsert.params[0],'班兰');
  assert.equal(sourceInsert.params[1],'https://banlan.example/');
  assert.equal(sourceInsert.params[3],'["banlan.example"]');
  assert.equal(sourceInsert.params[8],1200);
  assert.equal(sourceInsert.params[14],'preview-admin');
  assert.match(sourceInsert.sql,/recovery_mode/);
  assert.match(sourceInsert.sql,/'shadow'/);
});

test('control plane exposes no scheduler or arbitrary URL endpoint and requires explicit start confirmation', () => {
  const service = fs.readFileSync(require.resolve('../services/product-ingestion-control'), 'utf8');
  const routes = fs.readFileSync(require.resolve('../routes/admin-product-ingestion.routes'), 'utf8');
  assert.doesNotMatch(service, /\bfetch\s*\(/);
  assert.doesNotMatch(routes, /\bfetch\s*\(/);
  assert.doesNotMatch(routes, /\/execute|\/run|\/schedule|\/fetch-url/);
  assert.match(routes, /confirmed !== true/);
  assert.doesNotMatch(routes, /请输入“开始抓取”/);
  assert.match(service, /manual_review_required:\s*true/);
  assert.match(service, /allow_offsite:\s*false/);
});

test('an active discovery or extraction task can be stopped without deleting its data',async()=>{
  const calls=[];const db={query:async(sql,params)=>{calls.push({sql,params});return [{affectedRows:1}];}};
  const result=await createControl(db).cancelJob(42);
  assert.deepEqual(result,{id:42,status:'cancelled'});
  assert.match(calls[0].sql,/status IN \('draft','discovery_approved','discovering'/);
  assert.match(calls[0].sql,/'running'/);
  assert.match(calls[0].sql,/current_stage='cancelled'/);
});

test('task workbench pause preserves the checkpoint and resume chooses the correct runner stage',async()=>{
  let state={status:'running',current_stage:'extraction',checkpoint_index:37,scope_snapshot:'{}'};
  const calls=[];const db={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT status,current_stage,checkpoint_index,scope_snapshot'))return [[{...state}]];
    if(sql.startsWith('SELECT status,current_stage,checkpoint_index'))return [[{...state}]];
    if(sql.includes("SET status='paused'")){state={...state,status:'paused'};return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE product_ingestion_jobs SET status=?')){state={...state,status:params[0],current_stage:params[1]};return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const control=createControl(db),paused=await control.pauseJob(42);
  assert.equal(paused.status,'paused');assert.equal(paused.checkpoint_index,37);
  const resumed=await control.resumeJob(42);
  assert.equal(resumed.resume_mode,'extraction');assert.equal(resumed.checkpoint_index,37);
  assert.equal(state.status,'queued');assert.equal(state.current_stage,'extraction');
  assert.match(calls.find(item=>item.sql.includes("SET status='paused'")).sql,/last_error='用户暂停任务；进度和已抓取候选均已保留'/);
});

test('site cognition cannot be half-paused and the workbench exposes inline task controls',async()=>{
  const db={query:async sql=>{if(sql.startsWith('SELECT status,current_stage,checkpoint_index'))return [[{status:'discovering',current_stage:'site_cognition',checkpoint_index:0}]];throw new Error(`Unexpected query: ${sql}`);}};
  await assert.rejects(()=>createControl(db).pauseJob(9),/不可拆分.*安全停止/);
  const routes=fs.readFileSync(require.resolve('../routes/admin-product-ingestion.routes'),'utf8');
  const ui=fs.readFileSync(require.resolve('../public/admin/modules/product-ingestion'),'utf8');
  assert.match(routes,/\/jobs\/:id\/workbench/);assert.match(routes,/\/jobs\/:id\/pause/);assert.match(routes,/\/jobs\/:id\/resume/);
  assert.match(routes,/site-cognition\/workflows\/:id\/retry/);
  assert.match(ui,/任务抓取台/);assert.match(ui,/data-workbench-decision/);assert.match(ui,/prepare-pause/);assert.match(ui,/prepare-bulk-publish/);
  assert.match(ui,/candidateStageReady=!review&&counts\.total>0/);
  assert.match(ui,/从错误处继续/);
  assert.match(ui,/data-inline-approve/);
  assert.match(ui,/if\(job\.status==='completed'&&counts\.total>0&&counts\.published===counts\.total\)return 6/);
  assert.match(ui,/scheduleWorkbenchPoll/);assert.match(ui,/data-live-progress/);
  assert.match(ui,/prepare-cognition-retry/);
  assert.match(ui,/data-cognition-error/);assert.match(ui,/请至少勾选一个明显错误/);
  assert.doesNotMatch(ui,/请选择最主要的错误编号/);
  assert.match(ui,/统一规则验证样品/);assert.match(ui,/桌面端字段对应关系/);assert.match(ui,/图片角色与使用位置/);
  assert.match(ui,/sampleEvidenceText/);assert.match(ui,/data-sample-business-error/);
  assert.doesNotMatch(ui,/系统已用新规则正确抽取/);
  assert.doesNotMatch(ui,/panel\.isConnected\)jobWorkbench\(id\)/);
});

test('candidate review refuses invalid data and records a required rejection reason', async () => {
  const updates = [];
  const db = { query: async (sql, params) => {
    if (sql.startsWith('SELECT validation_status')) return [[{ validation_status:'invalid' }]];
    if (sql.startsWith('UPDATE product_ingestion_candidates')) { updates.push(params); return [{ affectedRows:1 }]; }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const control = createControl(db);
  await assert.rejects(() => control.reviewCandidate(7, { action:'approve' }, 'reviewer'), /结构校验未通过/);
  await assert.rejects(() => control.reviewCandidate(7, { action:'reject', note:'' }, 'reviewer'), /请填写审核说明/);
  const result = await control.reviewCandidate(7, { action:'reject', note:'官网缺少明确材质' }, 'reviewer');
  assert.deepEqual(result, { id:7, review_status:'rejected', review_note:'官网缺少明确材质' });
  assert.deepEqual(updates[0], ['rejected', '官网缺少明确材质', 'reviewer', 7]);
});

test('candidate classification and standard categories save in one transaction',async()=>{
  let committed=false,rolledBack=false,released=false;const statements=[];
  const conn={beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{rolledBack=true;},release:()=>{released=true;},query:async(sql,params=[])=>{
    statements.push({sql,params});
    if(sql.startsWith('SELECT candidate.*'))return [[{id:9,published_product_id:null,classification_suggestion:'{"product_group":"soft_furnishings","product_type":"furniture"}',classification_override:null}]];
    if(sql.startsWith('SELECT id FROM public_product_categories'))return [[{id:7},{id:8}]];
    if(sql.startsWith('DELETE FROM product_ingestion_candidate_categories'))return [{affectedRows:1}];
    if(sql.startsWith('INSERT INTO product_ingestion_candidate_categories'))return [{affectedRows:1}];
    if(sql.startsWith('UPDATE product_ingestion_candidates SET manual_revision='))return [{affectedRows:1}];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await createControl({getConnection:async()=>conn}).saveCandidateClassification(9,{product_group:'soft_furnishings',product_type:'furniture',category_ids:[7,8]},'admin');
  assert.deepEqual(result,{id:9,product_group:'soft_furnishings',product_type:'furniture',category_ids:[7,8],classification_updated:false,saved:true});
  assert.equal(committed,true);assert.equal(rolledBack,false);assert.equal(released,true);
  assert.equal(statements.filter(item=>item.sql.startsWith('INSERT INTO product_ingestion_candidate_categories')).length,2);
});

test('candidate list classification save has one live click handler and explicit feedback',()=>{
  const ui=fs.readFileSync(require.resolve('../public/admin/modules/product-ingestion'),'utf8'),routes=fs.readFileSync(require.resolve('../routes/admin-product-ingestion.routes'),'utf8');
  assert.doesNotMatch(ui,/panel\.addEventListener\('click'/);
  assert.match(ui,/data-row-save-status/);assert.match(ui,/正在保存/);assert.match(ui,/保存成功/);assert.match(ui,/保存失败/);
  assert.match(ui,/candidates\/\$\{id\}\/classification/);assert.match(routes,/candidates\/:id\/classification/);
});

test('candidate detail exposes parsed governance payloads but never raw HTML', async () => {
  const db = { query: async sql => {
    assert.match(sql, /OCTET_LENGTH\(candidate\.raw_html\)/);
    assert.doesNotMatch(sql, /candidate\.raw_html(?:,|\s+FROM)/);
    return [[{
      id:9, job_id:3, source_id:2, raw_html_bytes:321,
      extracted_payload:'{"name":"边几"}', normalized_payload:'{"product_type":"furniture"}',
      generated_fields:'[{"path":"configurations[0].name","value":"标准款"}]', validation_issues:'[]',
    }]];
  } };
  const item = await createControl(db).getCandidate(9);
  assert.equal(item.extracted_payload.name, '边几');
  assert.equal(item.normalized_payload.product_type, 'furniture');
  assert.equal(item.generated_fields[0].value, '标准款');
  assert.equal(item.raw_html_bytes, 321);
  assert.equal('raw_html' in item, false);
});

test('candidate list supports server pagination and recovery-state filtering',async()=>{
  const payload={product_document:{data:{product:{names:{primary:'云朵沙发'}},configurations:[{id:'configuration-1',asset_ids:['configuration-image']}],assets:[{id:'hero-image',role:'hero',url:'https://img.example/hero.jpg'},{id:'configuration-image',role:'configuration',url:'https://img.example/configuration.jpg'}]}}};
  const calls=[];const db={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.startsWith('SELECT COUNT(*) total'))return [[{total:73}]];if(sql.includes('SELECT candidate.id'))return [[{id:12,job_id:4,source_id:2,normalized_payload:JSON.stringify(payload),validation_issues:'[]',generated_fields:'[]',classification_suggestion:null,classification_override:null,recovery_status:'shadow_ready',category_ids:'4,7',category_names:'沙发、休闲椅'}]];throw new Error(`Unexpected query: ${sql}`);}};
  const result=await createControl(db).listCandidates({paged:'1',job_id:'4',status:'invalid',recovery_status:'shadow_ready',limit:'25',offset:'50'});
  assert.equal(result.total,73);assert.equal(result.items[0].recovery_status,'shadow_ready');assert.deepEqual(calls[0].params,["invalid",4,"shadow_ready"]);assert.deepEqual(calls[1].params,["invalid",4,"shadow_ready",25,50]);
  assert.deepEqual(result.items[0].category_ids,[4,7]);
  assert.equal(result.items[0].cover_image_url,'https://img.example/hero.jpg');
  assert.equal(result.items[0].first_configuration_image_url,'https://img.example/configuration.jpg');
});

test('candidate list can filter publish-ready products before pagination',async()=>{
  const calls=[];const db={query:async(sql,params=[])=>{calls.push({sql,params});if(sql.startsWith('SELECT COUNT(*) total'))return [[{total:2}]];if(sql.includes('SELECT candidate.id'))return [[]];throw new Error(`Unexpected query: ${sql}`);}};
  const result=await createControl(db).listCandidates({paged:'1',publish_ready:'1',limit:'20',offset:'0'});
  assert.equal(result.total,2);
  assert.match(calls[0].sql,/candidate\.published_product_id IS NULL/);
  assert.match(calls[0].sql,/candidate\.validation_status='valid'/);
  assert.match(calls[0].sql,/candidate\.review_status='approved'/);
  assert.match(calls[0].sql,/source\.status='active'/);
  assert.match(calls[0].sql,/NOT EXISTS \(SELECT 1 FROM public_product_categories child/);
  assert.deepEqual(calls[1].params,[20,0]);
});

test('candidate list exposes inline classification editing and separate product/configuration images',()=>{
  const ui=fs.readFileSync(require.resolve('../public/admin/modules/product-ingestion'),'utf8');
  assert.match(ui,/产品主图/);
  assert.match(ui,/款型配置图/);
  assert.match(ui,/data-row-product-type/);
  assert.match(ui,/data-row-category/);
  assert.match(ui,/data-save-candidate-categories/);
  assert.match(ui,/本页.*项.*共.*项/);
  assert.match(ui,/data-candidate-page-size/);
  assert.match(ui,/data-candidate-page-input/);
  assert.match(ui,/jump-candidate-page/);
  assert.match(ui,/name="publish_ready"/);
  assert.match(ui,/符合发布条件/);
});

test('batch classification correction rebuilds product structure and records an audit entry', async () => {
  let updatedPayload=null,committed=false;
  const conn={
    beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{},release:()=>{},
    query:async(sql,params)=>{
      if(sql.includes('SELECT candidate.*,source.adapter_key'))return [[{id:8,source_id:2,source_url:'https://www.example.com/p/8',raw_html:Buffer.from('<script type="application/ld+json">{"@type":"Product","name":"休闲椅","sku":"C-8"}</script>'),adapter_key:'generic_jsonld_v1',classification_suggestion:JSON.stringify({product_group:'soft_furnishings',product_type:'rugs'})}]];
      if(sql.startsWith('UPDATE product_ingestion_candidates')){updatedPayload=JSON.parse(params[0]);return [{affectedRows:1}];}
      if(sql.startsWith('DELETE FROM product_ingestion_candidate_categories'))return [{affectedRows:1}];
      if(sql.startsWith('INSERT INTO product_ingestion_candidate_categories'))return [{affectedRows:1}];
      if(sql.startsWith('INSERT INTO product_ingestion_candidate_classification_changes'))return [{affectedRows:1}];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result=await createControl({getConnection:async()=>conn}).reclassifyCandidates({candidate_ids:[8],product_type:'furniture'},'admin');
  assert.equal(result.updated_count,1);
  assert.equal(updatedPayload.product_type,'furniture');
  assert.equal(updatedPayload.product_details.configurations[0].shape,'box');
  assert.equal(committed,true);
});
