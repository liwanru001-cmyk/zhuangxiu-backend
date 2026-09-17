'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {validateMaterialRule,extractMaterialPage,discoverLinks,canonicalUrl}=require('../services/product-ingestion-related-resources');
const {effectiveSelection}=require('../services/official-brand-materials');
const {normalizeBrand,selectionState,linkOfficialMaterialsToProduct}=require('../services/official-material-selection');
const {materialDomEvidence,buildMaterialAiContext,linkedMaterialCandidates,normalizeRule,normalizeSampleFeedback,feedbackOutcomeIssue,validateMaterialSamples,reusableCatalogSample,reusableCatalogsForUrl,MATERIAL_SCOPE,eligibleBrandSources,createMaterialOnboarding}=require('../services/product-ingestion-material-onboarding');

function rule(overrides={}){
  return {
    schema_version:'official-material-rule-v1',item_selector:'.material-card',
    fields:{
      name:{required:true,sources:[{type:'css_text',selector:'.name'}]},
      code:{required:false,sources:[{type:'css_attr',selector:'.material-card',attribute:'data-code'}]},
      kind:{required:false,sources:[{type:'css_text',selector:'.kind'}]},
      color:{required:false,sources:[{type:'css_text',selector:'.color'}]},
      composition:{required:false,sources:[{type:'css_text',selector:'.composition'}]},
    },
    swatches:[{type:'dom_attribute',selector:'img',attribute:'data-src'}],
    pagination:{link_sources:[{selector:'a.next',attribute:'href'}]},related_link_sources:[{selector:'a.materials',attribute:'href'}],
    limits:{max_pages:5,max_items:100,max_assets:50},...overrides,
  };
}

test('official material rule is brand-neutral and uses the shared field source contract',()=>{
  const result=validateMaterialRule(rule());
  assert.equal(result.valid,true,JSON.stringify(result));
  assert.equal(JSON.stringify(rule()).includes('HC28'),false);
});

test('material extraction returns executable locators, stable identity and swatch evidence',()=>{
  const html=`<main><article class="material-card" data-code="A-01"><h3 class="name">Cloud</h3><span class="kind">Fabric</span><span class="color">Warm white</span><span class="composition">90% wool</span><img data-src="/swatches/a-01.jpg"></article><a class="next" href="/materials?page=2">Next</a></main>`;
  const result=extractMaterialPage({url:'https://example.com/materials',html},rule());
  assert.equal(result.items.length,1);
  assert.deepEqual(result.items[0].fields,{name:'Cloud',code:'A-01',kind:'Fabric',color:'Warm white',composition:'90% wool'});
  assert.equal(result.items[0].evidence.name.source.type,'css_text');
  assert.equal(result.items[0].swatch_url,'https://example.com/swatches/a-01.jpg');
  assert.equal(result.pagination_links[0].url,'https://example.com/materials?page=2');
});

test('an empty image value never resolves to the current HTML page URL',()=>{
  assert.equal(canonicalUrl(null,'https://example.com/materials'),null);
  assert.equal(canonicalUrl('','https://example.com/materials'),null);
  const noImageRule=rule({swatches:[{type:'css_background',selector:'.material-card'}]});
  const result=extractMaterialPage({url:'https://example.com/materials',html:'<article class="material-card"><b class="name">Fabric A</b><span class="kind">Fabric</span></article>'},noImageRule);
  assert.equal(result.items[0].swatch_url,null);
  assert.equal(result.items[0].swatch_evidence,null);
});

test('related HTML discovery is bounded by the authorized hosts',()=>{
  const html='<a class="materials" href="/materials/p1">inside</a><a class="materials" href="https://other.example/x">outside</a>';
  const links=discoverLinks(html,'https://example.com/products/p1',rule().related_link_sources,new Set(['example.com']));
  assert.deepEqual(links.map(item=>item.url),['https://example.com/materials/p1']);
  assert.equal(links[0].locator.type,'dom_attribute');
});

test('grouped catalog fields are inherited by every material without a site-specific handler',()=>{
  const grouped=rule({item_selector:'.material-card',group:{selector:'dl.group',item_selector:'dd .material-card',fields:{kind:{required:true,sources:[{type:'css_text',selector:'dt'}]}}}});
  const html='<dl class="group"><dt>Leather</dt><dd><article class="material-card" data-code="L-1"><b class="name">Tan</b></article><article class="material-card" data-code="L-2"><b class="name">Black</b></article></dd></dl>';
  const result=extractMaterialPage({url:'https://example.com/materials',html},grouped);
  assert.equal(result.items.length,2);
  assert.deepEqual(result.items.map(item=>item.fields.kind),['Leather','Leather']);
  assert.equal(result.items[0].evidence.kind.inherited_from_group,true);
});

test('open-world selection never treats absence as unavailable',()=>{
  assert.deepEqual(effectiveSelection('open_world',[]),{effective_status:'unconfirmed',selectable:true,selection_basis:'open_world'});
  assert.equal(effectiveSelection('open_world',['confirmed_available']).selectable,true);
  assert.equal(effectiveSelection('open_world',['confirmed_unavailable']).selectable,false);
  assert.equal(effectiveSelection('closed_allowlist',[]).selectable,false);
  assert.equal(effectiveSelection('open_world',['confirmed_available','confirmed_unavailable']).effective_status,'needs_review');
});

test('official material selection shares one open-world decision contract',()=>{
  assert.equal(effectiveSelection,selectionState);
  assert.equal(normalizeBrand('  ＨＣ２８   Maison '),normalizeBrand('HC28 Maison'));
});

test('product material linking requires one exact URL relation inside the matching brand',async()=>{
  const calls=[];
  const mock={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes('FROM public_product_library_products product'))return [[{id:7,source_url:'https://example.com/p/7',brand_name:'Example',product_source_id:1,source_brand_name:'Example'}]];
    if(sql.includes('SELECT DISTINCT catalog.source_id'))return [[{source_id:9,brand_name:' example '}]];
    if(sql.includes('SELECT * FROM official_product_material_constraints'))return [[{id:3,source_id:9,product_id:null,product_url_hash:'hash'}]];
    if(sql.startsWith('UPDATE official_product_material_constraints'))return [{affectedRows:1}];
    if(sql.startsWith('UPDATE official_product_material_assertions'))return [{affectedRows:4}];
    throw new Error(`unexpected SQL ${sql}`);
  }};
  const result=await linkOfficialMaterialsToProduct(mock,7);
  assert.equal(result.linked,true);
  assert.equal(result.material_source_id,9);
  assert.equal(calls.filter(call=>call.sql.startsWith('UPDATE ')).length,2);
});

test('ambiguous brand material sources are never auto-linked',async()=>{
  const mock={query:async(sql)=>{
    if(sql.includes('FROM public_product_library_products product'))return [[{id:8,source_url:'https://example.com/p/8',brand_name:'Example'}]];
    if(sql.includes('SELECT DISTINCT catalog.source_id'))return [[{source_id:9,brand_name:'Example'},{source_id:10,brand_name:'example'}]];
    throw new Error('an update must not run for an ambiguous brand');
  }};
  const result=await linkOfficialMaterialsToProduct(mock,8);
  assert.deepEqual(result,{linked:false,reason:'brand_ambiguous',product_id:8});
});

test('closed allowlist and negative assertions require explicit evidence rules',()=>{
  const closed=validateMaterialRule(rule({constraint:{mode:'closed_allowlist',evidence:{required:false,sources:[{type:'css_text',selector:'.notice'}]}}}));
  assert.equal(closed.valid,false);
  assert.match(closed.semantic_errors.join(' '),/完整白名单/);
  const negative=validateMaterialRule(rule({item_assertion:'confirmed_unavailable'}));
  assert.equal(negative.valid,false);
  assert.match(negative.semantic_errors.join(' '),/确认不可用/);
});

test('migration is additive and does not alter Product Schema v2 or merchant materials',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'..','migrations','20260929_official_brand_material_library.sql'),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS official_brand_materials/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS official_brand_material_catalog_items/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS official_product_material_assertions/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS product_ingestion_related_resource_snapshots/);
  assert.match(sql,/frozen_rule_hash CHAR\(64\)/);
  assert.match(sql,/validation_evidence JSON/);
  assert.match(sql,/frozen_at DATETIME/);
  assert.doesNotMatch(sql,/ALTER TABLE\s+merchant_materials/i);
  assert.doesNotMatch(sql,/ALTER TABLE\s+product_ingestion_candidates/i);
  assert.doesNotMatch(sql,/ALTER TABLE\s+public_product_library_versions/i);
});

test('official material backend runtime stays brand-neutral',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','services','official-brand-materials.js'),'utf8');
  const selection=fs.readFileSync(path.join(__dirname,'..','services','official-material-selection.js'),'utf8');
  for(const marker of ['HC28','hc28maison','Poliform','Fendi']){
    assert.equal(source.includes(marker),false,`runtime contains brand marker ${marker}`);
    assert.equal(selection.includes(marker),false,`selection runtime contains brand marker ${marker}`);
  }
  assert.match(source,/FROZEN_MATERIAL_RULE_IMMUTABLE/);
  assert.match(source,/FROZEN_MATERIAL_RULE_CHANGED/);
});

test('public app only receives product-scoped sanitized official materials',()=>{
  const routes=fs.readFileSync(path.join(__dirname,'..','routes','public-product-library.routes.js'),'utf8');
  const selection=fs.readFileSync(path.join(__dirname,'..','services','official-material-selection.js'),'utf8');
  assert.match(routes,/\/:id\/materials/);
  assert.doesNotMatch(routes,/router\.get\('\/materials/);
  assert.match(selection,/constraint:\{mode:/);
  assert.doesNotMatch(selection,/policy_evidence:/);
});

test('admin material library exposes read-only browse, detail and product declaration views',()=>{
  const routes=fs.readFileSync(path.join(__dirname,'..','routes','admin-product-ingestion.routes.js'),'utf8');
  const frontend=fs.readFileSync(path.join(__dirname,'..','public','admin','modules','product-ingestion.js'),'utf8');
  assert.match(routes,/official-materials\/library\/facets/);
  assert.match(routes,/official-materials\/library\/materials/);
  assert.match(routes,/official-materials\/library\/product-declarations/);
  assert.match(frontend,/品牌材质库/);
  assert.match(frontend,/未出现的材料不等于不可用/);
  assert.doesNotMatch(frontend,/产品子集外[^<]{0,30}不可用/);
});

test('material onboarding sends only bounded repeated DOM evidence to AI',()=>{
  const html='<main><article class="material-card"><h3>Fabric A</h3><img src="/a.jpg"></article><article class="material-card"><h3>Leather B</h3><img src="/b.jpg"></article><script>secret()</script></main>';
  const evidence=materialDomEvidence(html,'https://example.com/materials');
  const card=evidence.candidates.find(item=>item.selector==='article.material-card');
  assert.ok(card);
  assert.equal(card.count,2);
  assert.equal(JSON.stringify(evidence).includes('secret()'),false);
  assert.deepEqual(MATERIAL_SCOPE,['fabric','leather','upholstery_swatch']);
});

test('material AI Context Builder deduplicates, layers and bounds repeated DOM evidence',()=>{
  const cards=Array.from({length:30},(_,index)=>`<article class="material-card" data-code="F-${index}" data-tracking="${'x'.repeat(100)}"><div class="card-inner"><h3 class="name">Fabric ${index}</h3><span class="composition">90% wool</span><img data-src="/swatches/${index}.jpg"></div></article>`).join('');
  const evidence=materialDomEvidence(`<main><section class="materials">${cards}</section></main>`,'https://example.com/materials');
  const context=buildMaterialAiContext(evidence);
  const candidates=Object.values(context.layers).flat();
  assert.ok(candidates.length>0);
  assert.ok(candidates.length<=10);
  assert.equal(new Set(candidates.map(item=>JSON.stringify(item.samples))).size,candidates.length);
  assert.ok(candidates.every(item=>item.samples.length<=2&&item.samples.every(sample=>sample.html.length<=900)));
  assert.equal(JSON.stringify(context).includes('data-tracking'),false);
  assert.ok(context.budget.estimated_input_tokens<10000);
});

test('material revision context keeps only the failed rule checkpoint and nearby evidence',()=>{
  const html='<main><div class="cover"><b class="name">皮革篇</b></div><div class="cover"><b class="name">面料篇</b></div><article class="material-card"><b class="name">Leather L1</b><span class="composition">100% leather</span></article><article class="material-card"><b class="name">Fabric F1</b><span class="composition">90% wool</span></article></main>';
  const evidence=materialDomEvidence(html,'https://example.com/materials'),previous=rule({item_selector:'.cover',fields:{name:{required:true,sources:[{type:'css_text',selector:'.name'}]}}}),context=buildMaterialAiContext(evidence,{mode:'revision',rule:previous,failure:{reason:'栏目入口'}}),candidates=Object.values(context.layers).flat();
  assert.equal(context.task,'revise_catalog_rule');
  assert.equal(context.checkpoint.previous_rule.item_selector,'.cover');
  assert.ok(candidates.length<=6);
  assert.ok(candidates.some(item=>item.selector==='div.cover'));
});

test('material onboarding keeps repeated leather rows even when the official page has no swatch images',()=>{
  const html='<table><tr><td>N级皮革</td><td>DANI</td></tr><tr><td>O级皮革</td><td>LEALPELL</td></tr><tr><td>G级皮革</td><td>NOPE</td></tr></table>';
  const evidence=materialDomEvidence(html,'https://example.com/materials');
  assert.ok(evidence.candidates.some(item=>item.selector==='tr'&&item.count===3));
});

test('material sample gate rejects maintenance rows and requires every evidenced upholstery category',()=>{
  const evidence={title:'面料与皮革',headings:['皮革篇','面料篇'],candidates:[]};
  const mixed=validateMaterialSamples([
    {fields:{name:'N级皮革',kind:'皮革篇'}},
    {fields:{name:'N、X',kind:'皮革篇'}},
  ],evidence);
  assert.equal(mixed.valid,false);
  assert.match(mixed.reason,/N、X/);
  const leatherOnly=validateMaterialSamples([{fields:{name:'N级皮革',kind:'皮革篇'}}],evidence);
  assert.equal(leatherOnly.valid,false);
  assert.match(leatherOnly.reason,/面料/);
  assert.equal(validateMaterialSamples([
    {fields:{name:'N级皮革',kind:'皮革篇'}},
    {fields:{name:'E级面料',kind:'面料篇'}},
  ],evidence).valid,true);
  const mislabeled=validateMaterialSamples([
    {fields:{name:'N级皮革',kind:'皮革篇',composition:'工艺类型-头层牛皮半苯染鞣制'}},
    {fields:{name:'E级面料',kind:'面料篇',composition:'细腻颗粒质感面料'}},
  ],evidence);
  assert.equal(mislabeled.valid,false);
  assert.match(mislabeled.reason,/不是官网成分/);
});

test('material sample gate rejects category cover cards that are not selectable materials',()=>{
  const evidence={title:'面料与皮革',headings:['皮革篇','面料篇'],candidates:[]};
  const result=validateMaterialSamples([
    {fields:{name:'皮革篇',kind:'皮革篇'}},
    {fields:{name:'面料篇',kind:'面料篇'}},
  ],evidence);
  assert.equal(result.valid,false);
  assert.match(result.reason,/栏目入口/);
});

test('material onboarding reuses a frozen executable rule before active or draft rules',()=>{
  const catalogs=[
    {id:13,status:'draft',source_url:'https://example.com/materials'},
    {id:12,status:'active',source_url:'https://example.com/materials'},
    {id:11,status:'frozen',source_url:'https://example.com/materials'},
  ];
  assert.deepEqual(reusableCatalogsForUrl(catalogs,'https://example.com/materials','https://example.com/materials').map(item=>item.id),[11,12]);
});

test('a previously confirmed generic material rule is locally sampled without AI inference',()=>{
  const html='<main><section class="group"><h2 class="kind">Leather</h2><article class="material-card"><b class="name">Leather L1</b><span class="composition">100% leather</span></article></section><section class="group"><h2 class="kind">Fabric</h2><article class="material-card"><b class="name">Fabric F1</b><span class="composition">90% wool</span></article></section></main>';
  const catalog={id:11,status:'frozen',source_url:'https://example.com/materials',catalog_rule:rule({group:{selector:'.group',item_selector:'.material-card',fields:{kind:{required:true,sources:[{type:'css_text',selector:'.kind'}]}}},swatches:[]})};
  const page={url:catalog.source_url,html},result=reusableCatalogSample(catalog,page,materialDomEvidence(html,page.url));
  assert.ok(result);
  assert.equal(result.catalog.id,11);
  assert.deepEqual(result.samples.map(item=>item.fields.name),['Leather L1','Fabric F1']);
});

test('material sample feedback is bounded and uses an enumerated business vocabulary',()=>{
  assert.deepEqual(normalizeSampleFeedback({reason:'mixed_content',note:'混入了产品卡片'}),{reason:'mixed_content',label:'样品混入了产品、木石金属或其他无关内容',note:'混入了产品卡片'});
  assert.throws(()=>normalizeSampleFeedback({reason:'run_any_code'}),/请选择样品不正确的原因/);
  assert.throws(()=>normalizeSampleFeedback({reason:'other'}),/请简要说明/);
  assert.throws(()=>normalizeSampleFeedback({reason:'other',note:'x'.repeat(501)}),/不能超过 500/);
});

test('an explicit missing-swatch correction cannot silently create another no-swatch draft',()=>{
  const feedback=normalizeSampleFeedback({reason:'other',note:'没有看到色板图案'});
  const issue=feedbackOutcomeIssue(feedback,[{fields:{name:'Leather N'},swatch_url:null}]);
  assert.equal(issue.code,'MATERIAL_FEEDBACK_NO_IMPROVEMENT');
  assert.equal(issue.next_action,'choose_material_page_or_keep_text_only');
  assert.equal(feedbackOutcomeIssue(feedback,[{fields:{name:'Leather N'},swatch_url:'https://example.com/n.jpg'}]),null);
  assert.equal(feedbackOutcomeIssue(normalizeSampleFeedback({reason:'field_mapping',note:'编号错了'}),[{fields:{name:'Leather N'},swatch_url:null}]),null);
});

test('a no-improvement AI revision is audited and never saved as another material draft',async()=>{
  const prior={id:11,source_id:4,brand_name:'Example',base_url:'https://example.com',source_url:'https://example.com/materials',catalog_rule:rule({swatches:[]}),status:'frozen'};
  const queries=[],db={query:async(sql,params=[])=>{
    queries.push({sql,params});
    if(sql.startsWith('SELECT source.*'))return [[{id:4,brand_name:'Example',base_url:'https://example.com',allowed_hosts:'["example.com"]',allowed_asset_hosts:'["example.com"]',allowed_path_prefixes:'["/"]',request_interval_ms:0,status:'active'}]];
    if(sql.includes('FROM public_product_library_products'))return [[{brand_name:'Example',product_count:2}]];
    if(sql.includes('official_brand_material_ai_calls'))return [{insertId:1}];
    throw new Error(`unexpected SQL ${sql}`);
  }};
  const generated=rule({swatches:[]}),aiCall=async()=>({body:{id:'response-no-swatch',output:[{type:'function_call',name:'submit_material_catalog_rule',arguments:JSON.stringify(generated)}],usage:{input_tokens:100,output_tokens:50,total_tokens:150}},elapsed_ms:5});
  const html='<main><article class="material-card" data-code="L-1"><b class="name">Leather L1</b><span class="kind">Leather</span><span class="composition">100% leather</span></article><article class="material-card" data-code="F-1"><b class="name">Fabric F1</b><span class="kind">Fabric</span><span class="composition">90% wool</span></article></main>';
  let saved=false;const officialMaterials={getCatalog:async()=>prior,saveCatalog:async()=>{saved=true;throw new Error('must not save');}};
  const onboarding=createMaterialOnboarding(db,{fetchHtml:async url=>({url,html,status:200,contentType:'text/html'}),callResponses:aiCall,officialMaterials,env:{QWEN_API_KEY:'test'}});
  await assert.rejects(()=>onboarding.prepare({source_id:4,source_url:prior.source_url,previous_catalog_id:prior.id,sample_feedback:{reason:'other',note:'没有看到色板图案'},confirmed:true},'tester'),error=>error.code==='MATERIAL_FEEDBACK_NO_IMPROVEMENT'&&error.details?.next_action==='choose_material_page_or_keep_text_only');
  assert.equal(saved,false);
  assert.ok(queries.some(call=>call.sql.includes('official_brand_material_ai_calls')&&call.params.includes('feedback_no_improvement')));
});

test('rejecting a material sample persists the feedback and returns a reachable next step',async()=>{
  const calls=[],db={query:async(sql,params=[])=>{calls.push({sql,params});return [{affectedRows:1,insertId:1}];}};
  const officialMaterials={getCatalog:async()=>({id:12,source_id:4,brand_name:'Example',base_url:'https://example.com',source_url:'https://example.com/materials',catalog_rule:rule(),status:'draft'})};
  const onboarding=createMaterialOnboarding(db,{fetchHtml:async()=>({}),officialMaterials});
  const result=await onboarding.rejectSample(12,{reason:'wrong_page',note:'只是栏目封面',confirmed:true},'tester');
  assert.equal(result.status,'source_review_required');
  assert.equal(result.next_action,'choose_or_rediscover_material_page');
  assert.ok(calls.some(call=>call.sql.includes("status='sample_rejected'")));
  assert.ok(calls.some(call=>call.sql.includes('official_brand_material_ai_calls')));
});

test('feedback on a frozen material rule preserves the live rule and opens a new revision path',async()=>{
  const calls=[],db={query:async(sql,params=[])=>{calls.push({sql,params});return [{affectedRows:1,insertId:1}];}};
  const officialMaterials={getCatalog:async()=>({id:11,source_id:4,brand_name:'Example',base_url:'https://example.com',source_url:'https://example.com/materials',catalog_rule:rule(),status:'frozen'})};
  const onboarding=createMaterialOnboarding(db,{fetchHtml:async()=>({}),officialMaterials});
  const result=await onboarding.rejectSample(11,{reason:'field_mapping',note:'色板对应错误',confirmed:true},'tester');
  assert.equal(result.status,'rule_revision_required');
  assert.equal(result.preserved_rule,true);
  assert.equal(result.catalog.status,'frozen');
  assert.equal(calls.some(call=>call.sql.includes("status='sample_rejected'")),false);
  assert.ok(calls.some(call=>call.sql.includes('official_brand_material_ai_calls')));
});

test('every material sample feedback reason has a deterministic next step without disabling a frozen rule',async()=>{
  const reasons=['wrong_page','not_upholstery','mixed_content','missing_materials','field_mapping','text_only','other'];
  for(const reason of reasons){
    const calls=[],db={query:async(sql,params=[])=>{calls.push({sql,params});return [{affectedRows:1,insertId:1}];}};
    const officialMaterials={getCatalog:async()=>({id:11,source_id:4,brand_name:'Example',base_url:'https://example.com',source_url:'https://example.com/materials',catalog_rule:rule(),status:'frozen'})};
    const onboarding=createMaterialOnboarding(db,{fetchHtml:async()=>({}),officialMaterials});
    const result=await onboarding.rejectSample(11,{reason,note:reason==='other'?'具体问题说明':'',confirmed:true},'tester');
    assert.equal(result.preserved_rule,true,reason);
    assert.equal(result.status,['wrong_page','not_upholstery'].includes(reason)?'source_review_required':reason==='text_only'?'text_only_revision_required':'rule_revision_required',reason);
    assert.ok(result.next_action,reason);
    assert.equal(calls.some(call=>call.sql.includes("status='sample_rejected'")),false,reason);
  }
});

test('text-only material revision removes unbound swatches without calling AI',async()=>{
  const prior=rule({swatches:[{type:'css_background',selector:'.material-card'}]}),queries=[];
  const db={query:async(sql,params=[])=>{queries.push({sql,params});if(sql.startsWith('SELECT source.*'))return [[{id:4,brand_name:'Example',base_url:'https://example.com',allowed_hosts:'["example.com"]',allowed_asset_hosts:'["example.com"]',allowed_path_prefixes:'["/"]',request_interval_ms:0,status:'active'}]];if(sql.includes('FROM public_product_library_products'))return [[{brand_name:'Example',product_count:2}]];if(sql.includes('official_brand_material_ai_calls'))return [{insertId:1}];throw new Error(`unexpected SQL ${sql}`);}};
  let savedBody=null;const officialMaterials={getCatalog:async()=>({id:11,source_id:4,brand_name:'Example',base_url:'https://example.com',source_url:'https://example.com/materials',catalog_rule:prior,status:'frozen'}),listCatalogs:async()=>[{id:11}],saveCatalog:async body=>{savedBody=body;return {id:12,status:'draft',source_url:body.source_url,catalog_rule:body.catalog_rule};}};
  const html='<main><article class="material-card" data-code="L-1"><b class="name">Leather L1</b><span class="kind">Leather</span></article><article class="material-card" data-code="F-1"><b class="name">Fabric F1</b><span class="kind">Fabric</span></article></main>';
  const onboarding=createMaterialOnboarding(db,{fetchHtml:async url=>({url,html,status:200,contentType:'text/html'}),officialMaterials,callResponses:async()=>{throw new Error('AI must not run');}});
  const result=await onboarding.createTextOnlyRevision(11,{confirmation:'保留文字不使用色板'},'tester');
  assert.equal(result.status,'sample_ready');
  assert.equal(result.text_only_revision,true);
  assert.deepEqual(savedBody.catalog_rule.swatches,[]);
  assert.ok(result.samples.every(item=>item.swatch_url===null));
  assert.equal(result.usage.total_tokens,0);
  assert.ok(queries.some(call=>call.sql.includes('official_brand_material_ai_calls')&&call.params.includes('human_text_only_revision')));
});

test('approving a sample always activates the rule and returns a reachable scan state',async()=>{
  const calls=[],officialMaterials={
    activateCatalog:async(id,body,actor)=>{calls.push({step:'activate',id,body,actor});return {id:Number(id),status:'active'};},
    queueCatalogScan:async(id,body,actor)=>{calls.push({step:'scan',id,body,actor});return {id:91,catalog_id:Number(id),status:'queued'};},
  };
  const onboarding=createMaterialOnboarding({query:async()=>[[]]},{fetchHtml:async()=>({}),officialMaterials});
  await assert.rejects(()=>onboarding.approveAndScan(11,{confirmation:'wrong'},'tester'),/confirm|\u786e认/i);
  const result=await onboarding.approveAndScan(11,{confirmation:'确认样品并抓取'},'tester');
  assert.equal(result.status,'scan_queued');
  assert.equal(result.scan.status,'queued');
  assert.deepEqual(calls.map(item=>item.step),['activate','scan']);
  assert.equal(calls[1].body.auto_freeze,true);
});

test('failed material samples reuse an AI checkpoint and send only a revision slice',async()=>{
  const db={query:async sql=>{if(sql.startsWith('SELECT source.*'))return [[{id:4,brand_name:'Example',base_url:'https://example.com',allowed_hosts:'["example.com"]',allowed_asset_hosts:'["example.com"]',allowed_path_prefixes:'["/"]',request_interval_ms:0,status:'active'}]];if(sql.includes('FROM public_product_library_products'))return [[{brand_name:'Example',product_count:2}]];if(sql.includes('official_brand_material_ai_calls'))return [{insertId:1}];throw new Error(`unexpected SQL ${sql}`);}},aiCalls=[];
  const coverRule=rule({item_selector:'.cover',fields:{name:{required:true,sources:[{type:'css_text',selector:'.name'}]},kind:{required:false,sources:[{type:'css_text',selector:'.name'}]}},swatches:[]});
  const invalidRule=rule({group:{selector:'main',item_selector:'.material-card',fields:{kind:{required:false,sources:[{type:'css_text',selector:'.kind'}]},name:{required:true,sources:[{type:'css_text',selector:'.name'}]}}}}),goodRule=rule({swatches:[]}),responses=[invalidRule,coverRule,goodRule];
  const aiCall=async payload=>{aiCalls.push(payload);const generated=responses.shift();return {body:{id:`response-${aiCalls.length}`,output:[{type:'function_call',name:'submit_material_catalog_rule',arguments:JSON.stringify(generated)}],usage:{input_tokens:aiCalls.length===1?800:180,output_tokens:100,total_tokens:aiCalls.length===1?900:280}},elapsed_ms:5};};
  const html='<main><div class="cover"><b class="name">皮革篇</b></div><div class="cover"><b class="name">面料篇</b></div><article class="material-card" data-code="L-1"><b class="name">Leather L1</b><span class="kind">Leather</span><span class="composition">100% leather</span></article><article class="material-card" data-code="F-1"><b class="name">Fabric F1</b><span class="kind">Fabric</span><span class="composition">90% wool</span></article></main>';
  const officialMaterials={listCatalogs:async()=>[],saveCatalog:async body=>({id:21,...body}),getCatalog:async()=>null};
  const onboarding=createMaterialOnboarding(db,{fetchHtml:async url=>({url,html,status:200,contentType:'text/html'}),callResponses:aiCall,officialMaterials,env:{QWEN_API_KEY:'test'}});
  const result=await onboarding.prepare({source_id:4,source_url:'https://example.com/materials',confirmed:true},'tester');
  assert.equal(result.status,'sample_ready');
  assert.equal(aiCalls.length,3);
  assert.equal(aiCalls[1].previous_response_id,'response-1');
  assert.match(aiCalls[1].input,/结构契约错误/);
  assert.equal(aiCalls[2].previous_response_id,'response-2');
  assert.match(aiCalls[2].input,/局部失败检查点/);
  assert.doesNotMatch(aiCalls[2].input,/重新搜索网站.*受限 DOM 证据/);
  assert.deepEqual(result.usage,{input_tokens:1160,output_tokens:300,total_tokens:1460});
  assert.ok(result.context_budget.final.candidate_count<=6);
});

test('material onboarding refines a parent page through bounded same-host material links',()=>{
  const candidates=linkedMaterialCandidates({links:[
    {text:'材质与工艺',href:'https://example.com/about/materials'},
    {text:'Leather collection',href:'https://example.com/leather'},
    {text:'Materials',href:'https://outside.example/materials'},
    {text:'News',href:'https://example.com/news'},
  ]},'https://example.com/about',new Set(['example.com']));
  assert.deepEqual(candidates.map(item=>item.url),['https://example.com/leather','https://example.com/about/materials']);
});

test('material onboarding keeps an open-world catalog rule and clamps scan budgets',()=>{
  const normalized=normalizeRule(rule({
    item_assertion:'confirmed_unavailable',
    assertion_evidence:{required:true,sources:[{type:'css_text',selector:'.ban'}]},
    constraint:{mode:'closed_allowlist',evidence:{required:true,sources:[{type:'css_text',selector:'.only'}]}},
    limits:{max_pages:999,max_items:99999,max_assets:9999},
  }));
  assert.equal(normalized.item_assertion,undefined);
  assert.equal(normalized.constraint,undefined);
  assert.deepEqual(normalized.limits,{max_pages:100,max_items:10000,max_assets:1000});
  assert.equal(validateMaterialRule(normalized).valid,true);
});

test('material onboarding eligibility requires formal products and safely reuses one existing material source',()=>{
  const rows=eligibleBrandSources([
    {source_id:1,brand_name:'HC28',product_brand_name:'HC28',base_url:'https://products.example',product_count:180},
    {source_id:4,brand_name:'班兰',product_brand_name:'班兰',base_url:'https://banlan.example',product_count:50},
  ],[
    {source_id:9,brand_name:' hc28 ',catalog_count:2},
    {source_id:10,brand_name:'Flexform',catalog_count:1},
  ]);
  assert.equal(rows.length,2);
  assert.deepEqual(rows.find(item=>item.brand_name==='HC28'),{
    source_id:9,product_source_id:1,material_source_id:9,brand_name:'HC28',base_url:'https://products.example',status:'active',product_count:180,catalog_count:2,
  });
  assert.equal(rows.find(item=>item.brand_name==='班兰').source_id,4);
  assert.equal(rows.some(item=>item.brand_name==='Flexform'),false);
});

test('material onboarding is additive, brand neutral and connected to the admin workbench',()=>{
  const migration=fs.readFileSync(path.join(__dirname,'..','migrations','20260930_official_material_onboarding.sql'),'utf8');
  const service=fs.readFileSync(path.join(__dirname,'..','services','product-ingestion-material-onboarding.js'),'utf8');
  const routes=fs.readFileSync(path.join(__dirname,'..','routes','admin-product-ingestion.routes.js'),'utf8');
  const frontend=fs.readFileSync(path.join(__dirname,'..','public','admin','modules','product-ingestion.js'),'utf8');
  assert.match(migration,/official_brand_material_ai_calls/);
  assert.doesNotMatch(migration,/ALTER TABLE\s+(merchant_materials|public_product_library_versions|product_ingestion_candidates)/i);
  for(const marker of ['HC28','hc28maison','Poliform','Fendi'])assert.equal(service.includes(marker),false);
  assert.match(routes,/official-materials\/onboarding\/eligible-sources/);
  assert.match(routes,/official-materials\/onboarding\/catalogs\/:id\/reject-sample/);
  assert.match(routes,/official-materials\/onboarding\/catalogs\/:id\/text-only-revision/);
  assert.match(frontend,/添加品牌材料/);
  assert.match(frontend,/布料、皮革、软包面料和色板/);
  assert.match(frontend,/样品不对，继续修正/);
  assert.match(frontend,/提交原因并继续处理/);
  assert.match(frontend,/改选官网材料页/);
  assert.match(frontend,/材料文字正确，但官网没有逐项色板/);
  assert.match(frontend,/修正规则草案/);
  assert.match(frontend,/重新扫描未完成部分/);
  assert.match(frontend,/有一次材料扫描仍在进行/);
  assert.match(frontend,/data-material-scan-id/);
  assert.match(frontend,/重新读取品牌材质库/);
  assert.match(frontend,/catalogs\.find\(item=>item\.status==='frozen'\).*catalogs\.find\(item=>item\.status==='active'\)/);
  assert.doesNotMatch(frontend,/样品不对，暂不抓取/);
});
