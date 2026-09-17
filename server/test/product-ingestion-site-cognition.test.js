'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {auditTopology,transition}=require('../services/product-ingestion-site-cognition-state');
const {clusterUrls,pageCard,buildSiteMap}=require('../services/product-ingestion-site-map');
const {generateSiteRule,siteId,compactEvidence,normalizeV2ProposalShape,executableTemplateSignals,sliceEvidenceErrors}=require('../services/product-ingestion-site-rule-ai');
const {validateDecision,decisionTool,parseFunctionArguments}=require('../services/product-ingestion-site-cognition-ai');
const {validateDiscoveryRule,generateDiscoveryRule,normalizeDiscoveryRule}=require('../services/product-ingestion-site-discovery-ai');
const {discoverProductsWithSiteRule,extractProductWithSiteRule}=require('../services/product-ingestion-site-rule-runtime');
const {refineFromValidation,validateDiscoveryAgainstMap,createSiteCognitionControl,augmentEvidenceForRule,attemptBudgetUsed,aiBudgetLimit,nextAiBudgetLimit,withBlindTestSeeds,evidenceUrls,MAX_EVIDENCE_PROBE_ROUNDS,evidenceProbeFingerprint,canAutoFreezeRule,renderedEvidenceUsable}=require('../services/product-ingestion-site-cognition');
const {fetchPageWithRetry,createRunner,fullCrawlRateLimitWait,MAX_FULL_CRAWL_RATE_LIMIT_WAITS}=require('../services/product-ingestion-runner');
const {buildExtractionContexts,mergeExtractionSlices,normalizeSliceOutput,sliceTasksForFeedback}=require('../services/product-ingestion-ai-context-builder');

const config=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','poliform-site-rule-config-v1.json'),'utf8'));
const productUrl='https://www.poliform.cn/%E4%BA%A7%E5%93%81/alfred-%E6%89%B6%E6%89%8B%E6%A4%85/';
function fixture(name='Alfred') { return `<!doctype html><html><head><meta property="og:description" content="${name} 产品说明"><meta property="og:image" content="https://s3.poliform.cn/${name}.jpg"><script type="application/ld+json">{"@type":"Product","name":"${name}","description":"${name} 产品说明"}</script></head><body><main><h1>${name}</h1><h3>技术细节</h3><p>2026年 由 Jean-Marie Massaud 设计</p><div class="projects-item__product"><img src="https://s3.poliform.cn/${name}.jpg"><img src="https://s3.poliform.cn/${name}-2.jpg"></div></main></body></html>`; }

test('frozen cognition topology has no non-terminal dead ends',()=>{
  assert.deepEqual(auditTopology().missing_states,[]);
  assert.deepEqual(auditTopology().no_exit_states,[]);
  assert.equal(transition('HUMAN_SAMPLE_REVIEW_REQUIRED','CONFIRMED').to,'RULE_FREEZING');
  assert.equal(transition('HUMAN_ANCHOR_REQUIRED','BUDGET_EXHAUSTED').to,'WAITING_FOR_AI_BUDGET_APPROVAL');
  assert.equal(transition('EXTRACTION_RULE_DRAFTING','BUDGET_EXHAUSTED').to,'WAITING_FOR_AI_BUDGET_APPROVAL');
  assert.equal(transition('WAITING_FOR_AI_BUDGET_APPROVAL','APPROVE_EXTRACTION').to,'EXTRACTION_RULE_DRAFTING');
  assert.equal(transition('WAITING_FOR_AI_BUDGET_APPROVAL','APPROVE_RETRY').to,'SITE_MAPPING');
  assert.equal(transition('HANDOFF_REQUIRED','RETRY').to,'SITE_MAPPING');
  assert.equal(transition('HANDOFF_REQUIRED','RETRY_EXTRACTION').to,'EXTRACTION_RULE_DRAFTING');
  assert.throws(()=>transition('SITE_MAPPING','CONFIRMED'),/不接受事件/);
});

test('bounded evidence loop has a finite stop event from every hypothesis state',()=>{
  assert.equal(MAX_EVIDENCE_PROBE_ROUNDS,3);
  assert.equal(transition('AI_HYPOTHESIZING','EVIDENCE_EXHAUSTED').to,'STOPPED_SAFE');
  assert.equal(transition('HYPOTHESIS_EVALUATING','EVIDENCE_EXHAUSTED').to,'STOPPED_SAFE');
});

test('sandbox failures select only the affected AI slices for a bounded revision',()=>{
  assert.deepEqual(sliceTasksForFeedback({rejected_pages:[{validation_errors:['PRODUCT_V2_CONFIGURATION_IDENTITY_MISSING:x','PRODUCT_V2_OPTION_GROUPS_MISSING']}]}),['configurations','option_groups']);
  assert.deepEqual(sliceTasksForFeedback({rejected_pages:[{validation_errors:['PRODUCT_V2_DISPLAY_IMAGES_MISSING']}]}),['assets']);
});

test('evidence probe fingerprints deduplicate semantically identical requests',()=>{
  const first=[
    {target_page_id:'P-002',evidence_type:'rendered_dom',purpose:'confirm product grid'},
    {target_page_id:'P-001',evidence_type:'links',purpose:'find product links'},
  ];
  const reordered=[first[1],first[0]];
  const changed=[{...first[0],purpose:'inspect configuration'}];
  assert.equal(evidenceProbeFingerprint(first),evidenceProbeFingerprint(reordered));
  assert.notEqual(evidenceProbeFingerprint(first),evidenceProbeFingerprint(changed));
});

test('AI cognition tool constrains page and subject ids to the current evidence manifest',()=>{
  const schema=decisionTool({pages:[{page_id:'P-001'},{page_id:'P-002'}],clusters:[{cluster_id:'UC-001'}]}).parameters;
  assert.deepEqual(schema.properties.probe_requests.items.properties.target_page_id.enum,['P-001','P-002','UC-001']);
  assert.deepEqual(schema.properties.hypotheses.items.properties.subject_id.enum,['P-001','P-002','UC-001']);
});

test('AI cognition arguments accept only lossless JSON wrappers',()=>{
  const value={schema_version:'site-cognition-ai-output-v1.0'};
  assert.deepEqual(parseFunctionArguments(value),value);
  assert.deepEqual(parseFunctionArguments(JSON.stringify(value)),value);
  assert.deepEqual(parseFunctionArguments(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``),value);
  assert.deepEqual(parseFunctionArguments(`result:\n${JSON.stringify(value)}`),value);
  assert.throws(()=>parseFunctionArguments('{"schema_version":'),/不是有效 JSON/);
});

test('v2 proposal normalization makes an evidenced product name mandatory',()=>{
  const extraction=normalizeV2ProposalShape({fields:{name:{required:false,sources:[{type:'css_text',selector:'h1'}]}}});
  assert.equal(extraction.fields.name.required,true);
  const absent=normalizeV2ProposalShape({fields:{name:{required:false,sources:[]}}});
  assert.equal(absent.fields.name.required,false);
});

test('final template gates use executable rule signals instead of incidental headings',()=>{
  const extraction={fields:{name:{sources:[{type:'css_text',selector:'.breadcrumbs .current'}]},description:{sources:[{type:'json_ld_product',path:'description'}]}},images:{sources:[{type:'dom_attribute',selector:'.gallery img',attribute:'src'}]},structured:{configurations:{mode:'none'},option_groups:[]}};
  assert.deepEqual(executableTemplateSignals(extraction,['PRODUCT_GALLERY','PRODUCT_SPECIFICATION','TECHNICAL_HEADING']),['PRODUCT_GALLERY','PRODUCT_NAME','PRODUCT_DESCRIPTION']);
});

test('an executable non-h1 name source is a stable product template signal',()=>{
  const extraction={fields:{name:{sources:[{type:'css_text',selector:'.breadcrumbs .current'}]},description:{sources:[]}},images:{sources:[{type:'dom_attribute',selector:'.gallery img',attribute:'src'}]},structured:{configurations:{mode:'none'},option_groups:[]}};
  assert.deepEqual(executableTemplateSignals(extraction,['TECHNICAL_HEADING']),['PRODUCT_NAME','PRODUCT_GALLERY']);
});

test('only a fully passing v2 technical sample can auto-freeze',()=>{
  const rule={config:{schema_version:'site-rule-config-v2',validation:{minimum_accepted_products:3}}};
  const accepted=()=>({accepted:true,validation_errors:[]});
  const result={passed:true,summary:{products_accepted:3,products_rejected:0,failures:0},site_validation:{products_failed:0,network_failures:0},accepted_products:[accepted(),accepted(),accepted()]};
  assert.equal(canAutoFreezeRule(rule,result),true);
  assert.equal(canAutoFreezeRule(rule,{...result,summary:{...result.summary,failures:1}}),false);
  assert.equal(canAutoFreezeRule(rule,{...result,accepted_products:[accepted(),accepted(),{accepted:true,validation_errors:['NAME_MISSING']}]}),false);
  assert.equal(canAutoFreezeRule({config:{schema_version:'site-rule-config-v1.1',validation:{minimum_accepted_products:3}}},result),false);
});

test('successful full crawl ends at candidate collection, not publication',()=>{
  assert.equal(transition('HUMAN_SAMPLE_REVIEW_REQUIRED','AUTO_VALIDATION_PASSED').to,'RULE_FREEZING');
  assert.equal(transition('FULL_CRAWLING','SUCCESS').to,'CANDIDATE_COLLECTION_COMPLETED');
  assert.ok(auditTopology().terminal_states.includes('CANDIDATE_COLLECTION_COMPLETED'));
});

test('rendered channel must produce locatable evidence before AI is called',()=>{
  assert.equal(renderedEvidenceUsable({pages:[{acquisition_channel:'rendered_html',visible_text:'Loading',links:[],json_ld:[]}]}),false);
  assert.equal(renderedEvidenceUsable({pages:[{acquisition_channel:'rendered_html',visible_text:'x'.repeat(220),links:[],json_ld:[]}]}),true);
  assert.equal(renderedEvidenceUsable({pages:[{acquisition_channel:'rendered_html',visible_text:'',links:[{url:'1'},{url:'2'},{url:'3'}],json_ld:[]}]}),true);
});

test('a retry gets a fresh bounded AI budget without erasing historical usage',()=>{
  assert.equal(attemptBudgetUsed(87608,{ai_budget_baseline_tokens:87608}),0);
  assert.equal(attemptBudgetUsed(99608,{ai_budget_baseline_tokens:87608}),12000);
});

test('AI budget approvals double through fixed tiers and stop at the hard limit',()=>{
  assert.equal(aiBudgetLimit({}),60000);
  assert.equal(nextAiBudgetLimit({}),120000);
  assert.equal(nextAiBudgetLimit({ai_budget_limit_tokens:120000}),240000);
  assert.equal(nextAiBudgetLimit({ai_budget_limit_tokens:240000}),480000);
  assert.equal(nextAiBudgetLimit({ai_budget_limit_tokens:480000}),null);
});

test('blind samples exclude every URL exposed in AI evidence manifests',()=>{
  const value=config(),seen=value.discovery.seed_urls[0],blind='https://www.poliform.cn/%E4%BA%A7%E5%93%81/unseen-chair/';
  const map={pages:[{url:seen}],clusters:[{url_examples:[seen,blind]}]};
  const exposed=evidenceUrls({pages:[{url:seen}],clusters:[{url_examples:[seen]}]});
  const result=withBlindTestSeeds(value,map,exposed);
  assert.ok(result.discovery.seed_urls.includes(blind));
  assert.equal(validateDiscoveryAgainstMap({site:{entry_url:'https://www.poliform.cn/'},pages:[],clusters:[{url_examples:[seen,blind]}]}, {seed_urls:[seen],product_detail_path_prefixes:['/产品/'],listing_path_prefixes:[],exclude_path_prefixes:[]}, exposed).unseen_product_urls.includes(blind),true);
});

test('blind samples understand task-scoped AI Context Builder manifests',()=>{
  const exposed=['https://example.com/products/a','https://example.com/products/b'];
  const manifest={contexts:[{task:'product_fields',evidence:{pages:exposed.map((url,index)=>({page_id:`P-${index+1}`,url}))}}]};
  assert.deepEqual(evidenceUrls(manifest),exposed);
  const config={discovery:{seed_urls:['https://example.com/products/a'],product_detail_path_prefixes:['/products/'],listing_path_prefixes:[],exclude_path_prefixes:[],product_detail_paths:[],listing_paths:[],exclude_paths:[],product_detail_path_patterns:[],listing_path_patterns:[],exclude_path_patterns:[]},sandbox:{},provenance:{evidence_ids:[]}};
  const siteMap={clusters:[{url_examples:[...exposed,'https://example.com/products/c','https://example.com/products/d']}],pages:exposed.map(url=>({url}))};
  const result=withBlindTestSeeds(config,siteMap,evidenceUrls(manifest));
  assert.deepEqual(result.discovery.seed_urls,['https://example.com/products/a','https://example.com/products/c','https://example.com/products/d']);
});

test('program evidence markers stay inside the site-rule schema limit',()=>{
  const {withBlindTestSeeds}=require('../services/product-ingestion-site-cognition'),value=config();value.provenance.evidence_ids=Array.from({length:100},(_,index)=>`E-${index}`);
  const updated=withBlindTestSeeds(value,{pages:[],clusters:[]});assert.equal(updated.provenance.evidence_ids.length,100);assert.match(updated.provenance.evidence_ids.at(-1),/^PROGRAM_BLIND_SET:/);
});

test('site cognition start atomically claims a job before creating its workflow',async()=>{
  let committed=false,released=false;const scheduled=[];
  const workflow={id:71,source_id:5,job_id:48,rule_id:null,state:'RULE_CHECKING',state_version:1,evidence_revision:0,attempt_counters:{},next_allowed_events:['RULE_FOUND','NO_RULE'],resume_payload:null};
  const conn={beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{},release:()=>{released=true;},query:async sql=>{
    if(sql.startsWith('SELECT id,source_id,status'))return [[{id:48,source_id:5,status:'discovery_approved'}]];
    if(sql.startsWith('SELECT * FROM product_ingestion_site_cognition_workflows WHERE job_id='))return [[]];
    if(sql.startsWith('UPDATE product_ingestion_jobs'))return [{affectedRows:1}];
    if(sql.startsWith('INSERT INTO product_ingestion_site_cognition_workflows'))return [{insertId:71}];
    throw new Error(`Unexpected transaction query: ${sql}`);
  }};
  const db={getConnection:async()=>conn,query:async sql=>{
    if(sql.startsWith('SELECT * FROM product_ingestion_site_cognition_workflows WHERE id='))return [[workflow]];
    if(sql.startsWith('SELECT * FROM product_ingestion_site_cognition_events'))return [[]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const started=await createSiteCognitionControl(db,{schedule:fn=>scheduled.push(fn),siteRules:{get:async()=>null}}).startForJob(48,'tester');
  assert.equal(started.id,71);assert.equal(committed,true);assert.equal(released,true);assert.equal(scheduled.length,1);
});

test('invalid human feedback is rejected before an audit row is written',async()=>{
  let inserts=0;const row={id:9,source_id:5,job_id:48,rule_id:null,state:'SITE_MAPPING',state_version:2,evidence_revision:0,attempt_counters:{},next_allowed_events:['SUCCESS'],resume_payload:null};
  const db={query:async sql=>{
    if(sql.startsWith('SELECT * FROM product_ingestion_site_cognition_workflows WHERE id='))return [[row]];
    if(sql.startsWith('SELECT * FROM product_ingestion_site_cognition_events'))return [[]];
    if(sql.startsWith('INSERT INTO product_ingestion_site_rule_feedback')){inserts+=1;return [{insertId:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const control=createSiteCognitionControl(db,{siteRules:{get:async()=>null}});
  await assert.rejects(()=>control.feedback(9,{decision:'confirm'},'tester'),/当前没有待确认/);
  assert.equal(inserts,0);
});

test('field evidence contains product pages rather than repeating home and listing DOM',()=>{
  const pages=[
    {page_id:'P-001',url:'https://example.com/',limited_main_dom:'home'},
    {page_id:'P-002',url:'https://example.com/catalog/',limited_main_dom:'listing'},
    {page_id:'P-003',url:'https://example.com/products/chair',limited_main_dom:'product'},
  ];
  const value=compactEvidence({site:{},coverage:{},clusters:[],pages,failures:[]},{phase:'extraction',discoveryRule:{product_detail_path_prefixes:['/products/']}});
  assert.deepEqual(value.pages.map(page=>page.page_id),['P-003']);
});

test('AI Context Builder sends only task-specific schema and evidence slices',()=>{
  const map={site:{brand:'Fixture',entry_url:'https://example.com/',allowed_hosts:['example.com'],allowed_asset_hosts:['example.com']},pages:[{page_id:'P-001',url:'https://example.com/products/a',h1:'模块沙发',visible_text:'型号 A1，尺寸 2100×900；面料颜色可选',field_contexts:[{field:'dimensions',selector:'.size',text:'2100×900'},{field:'color',selector:'.swatch',text:'暖灰'}],image_regions:[{role:'gallery',selector:'.gallery',image_count:4}],extraction_regions:[{region_id:'P-001-SR01',kind:'configurations',status:'routable',source:'current_page_dom',container_selector:'.specs',item_selector:'.specs > .spec',selector_match_count:3,raw_item_count:3,valid_item_count:3,excluded_item_count:0,classification_basis:['dimension_signal'],accepted_samples:[{text:'A1 2100×900',relative_evidence:[{selector:'.size',text:'2100×900'}]}],exclusions:[],exclusion_summary:[],content_hash:'a'},{region_id:'P-001-SR02',kind:'option_groups',status:'routable',source:'current_page_dom',container_selector:'.colors',item_selector:'.colors > .swatch',selector_match_count:2,raw_item_count:2,valid_item_count:2,excluded_item_count:0,classification_basis:['option_semantic_anchor'],accepted_samples:[{text:'暖灰',relative_evidence:[{selector:'.label',text:'暖灰'}]}],exclusions:[],exclusion_summary:[],content_hash:'b'}],dom_evidence_regions:[{region_id:'main',html:'<h1>模块沙发</h1><div class="size">2100×900</div>'},{region_id:'options',html:'<div class="swatch">暖灰</div>'}]}]};
  const contexts=buildExtractionContexts(map,{discoveryRule:{product_detail_path_prefixes:['/products/']}}),tasks=contexts.map(item=>item.task);
  assert.deepEqual(tasks,['product_fields','assets','configurations','option_groups']);
  assert.ok(contexts.every(item=>!('discovery' in item.schema.properties)));
  assert.ok(contexts.every(item=>!JSON.stringify(item.schema).includes('"$ref"')));
  assert.ok(contexts.find(item=>item.task==='configurations').input.includes('2100×900'));
  assert.deepEqual(contexts.find(item=>item.task==='configurations').route_manifest.region_ids,['P-001-SR01']);
  assert.ok(!contexts.find(item=>item.task==='assets').input.includes('统一字段注册表'));
  assert.ok(contexts.reduce((sum,item)=>sum+JSON.stringify(item.schema).length,0)<=JSON.stringify(require('../services/product-ingestion-site-rule-schema').SITE_RULE_EXTRACTION_PROPOSAL_SCHEMA_V2).length+2000);
});

test('structured slices are activated only by routable evidence on the submitted pages',()=>{
  const pages=[{page_id:'P-001',url:'https://example.com/products/a',visible_text:'页面写有很多型号、尺寸、颜色，但没有定位结构',extraction_regions:[]},{page_id:'P-002',url:'https://example.com/products/b',visible_text:'ordinary page',extraction_regions:[]},{page_id:'P-003',url:'https://example.com/products/c',extraction_regions:[{region_id:'late',kind:'configurations',status:'routable',item_selector:'.late > .item'}]}];
  const contexts=buildExtractionContexts({site:{},pages},{discoveryRule:{product_detail_path_prefixes:['/products/']}});
  assert.deepEqual(contexts.map(item=>item.task),['product_fields','assets']);
});

test('structured Slice output must consume the same routable selectors that justified activation',()=>{
  const context={task:'configurations',route_manifest:{relative_selectors:['.size','.code'],regions:[{item_selector:'.specs > .spec',valid_item_count:3}]}};
  const valid={configurations:{mode:'repeated',item_selector:'.specs > .spec',fields:{code:{required:false,sources:[{type:'css_text',selector:'.code'}]}},dimensions:{source:{required:false,sources:[{type:'css_text',selector:'.size'}]}}}};
  assert.deepEqual(sliceEvidenceErrors(context,valid),[]);
  const invalid=JSON.parse(JSON.stringify(valid));invalid.configurations.item_selector='.invented';invalid.configurations.dimensions.source.sources=[];
  assert.match(sliceEvidenceErrors(context,invalid).join(' '),/未引用可路由证据区域/);
  assert.match(sliceEvidenceErrors(context,invalid).join(' '),/dimensions.source.sources 为空/);
});

test('generic structured evidence finds valid configurations, deduplicates template copies and records exclusions',()=>{
  const html='<html><body><main><h1>Chair</h1><div class="recommend-title">产品规格</div><section class="spec-grid"><article class="spec-card"><b>A100</b><span class="size">800×900×950 mm</span></article><article class="spec-card"><b>A200</b><span class="size">900×900×950 mm</span></article><article class="spec-card"><b>A100</b><span class="size">800×900×950 mm</span></article></section></main></body></html>';
  const card=pageCard({url:'https://example.com/products/chair',status:200,contentType:'text/html',html},'P-001');
  const region=card.extraction_regions.find(item=>item.kind==='configurations');
  assert.ok(region);assert.equal(region.raw_item_count,3);assert.equal(region.valid_item_count,2);assert.equal(region.excluded_item_count,1);
  assert.deepEqual(region.exclusion_summary,[{reason:'duplicate_template_item',count:1}]);
  assert.ok(card.semantic_sections.some(item=>item.label==='产品规格'));
});

test('generic structured evidence works across table rows and option swatch lists without site rules',()=>{
  const table='<html><body><main><h1>Desk</h1><table class="variants"><tbody><tr><td>T10</td><td>1200×600 mm</td></tr><tr><td>T20</td><td>1600×800 mm</td></tr></tbody></table></main></body></html>';
  const swatches='<html><body><main><h1>Sofa</h1><section class="finishes"><h2>Available finishes</h2><ul class="swatches"><li class="swatch"><img src="a.jpg"><span>Oak 01</span></li><li class="swatch"><img src="b.jpg"><span>Walnut 02</span></li></ul></section></main></body></html>';
  const tableCard=pageCard({url:'https://one.example/product/desk',status:200,contentType:'text/html',html:table},'P-001');
  const optionCard=pageCard({url:'https://two.example/catalog/sofa',status:200,contentType:'text/html',html:swatches},'P-002');
  assert.ok(tableCard.extraction_regions.some(item=>item.kind==='configurations'&&item.valid_item_count===2));
  assert.ok(optionCard.extraction_regions.some(item=>item.kind==='option_groups'&&item.valid_item_count===2));
});

test('structured evidence routes metric-imperial and diameter dimensions to configuration slices',()=>{
  const html='<html><body><main><h1>Table</h1><section class="configurations"><article class="configuration"><div class="configuration-name">Rectangular</div><div class="configuration-code">T100X</div><div class="configuration-dimensions">300cm/118,11’’ x 120cm/47,24’’ H 74cm/29,13’’</div></article><article class="configuration"><div class="configuration-name">Round</div><div class="configuration-code">T200X</div><div class="configuration-dimensions">D 150cm/59,08’’ H 74cm/29,13’’</div></article></section></main></body></html>';
  const card=pageCard({url:'https://example.com/product/table',status:200,contentType:'text/html',html},'P-001');
  const region=card.extraction_regions.find(item=>item.kind==='configurations');
  assert.equal(region.valid_item_count,2);
  assert.ok(region.accepted_samples.every(item=>item.relative_evidence.some(evidence=>evidence.selector.includes('configuration-dimensions')&&evidence.signals.dimensions.length)));
});

test('AI Context Builder only normalizes unambiguous field-source aliases and wrappers',()=>{
  const value={fields:{name:{required:true,sources:[{type:'dom_text',selector:'h1'}]},category:{required:false,sources:[{type:'css_attr',selector:'[data-category]',attribute:'data-category'}]}},furniture_type:'unknown',furniture_type_rule:{source:{type:'dom_attribute',selector:'.type',attribute:'title'},keywords:{sofa:[],chair:[],table:[],bed:[],cabinet:[]}}};
  const normalized=normalizeSliceOutput('product_fields',value);
  assert.equal(normalized.fields.name.sources[0].type,'css_text');
  assert.deepEqual(normalized.fields.category.sources,[]);
  assert.deepEqual(normalized.furniture_type_rule.source,{required:false,sources:[{type:'css_attr',selector:'.type',attribute:'title'}]});
  assert.equal(value.fields.name.sources[0].type,'dom_text');
});

test('AI Context Builder never hides an invalid required field source',()=>{
  const value={fields:{name:{required:true,sources:[{type:'css_attr',selector:'[data-name]',attribute:'data-name'}]}},furniture_type:'unknown'};
  assert.equal(normalizeSliceOutput('product_fields',value).fields.name.sources.length,1);
});

test('classifier metadata drops unsupported attributes before program grounding',()=>{
  const value=normalizeSliceOutput('product_fields',{fields:{name:{required:true,sources:[{type:'css_text',selector:'h1'}]}},furniture_type:'table',furniture_type_rule:{source:{required:true,sources:[{type:'css_attr',selector:'[data-category]',attribute:'data-category'}]},keywords:{table:['table']}}});
  assert.deepEqual(value.furniture_type_rule.source.sources,[]);
  assert.equal(value.fields.name.sources[0].selector,'h1');
});

test('optional Product v2 fields drop unevidenced constant values',()=>{
  const value=normalizeSliceOutput('option_groups',{option_groups:[{mode:'repeated',item_selector:'.group',max_items:5,fields:{name:{required:true,sources:[{type:'css_text',selector:'h3'}]},type:{required:false,sources:[{type:'constant',value:'finish'}]}},options:{mode:'repeated',item_selector:'.option',max_items:10,fields:{name:{required:true,sources:[{type:'css_text',selector:'.name'}]}},swatch:null,applies_to_configuration_code:{required:false,sources:[]}}}]});
  assert.deepEqual(value.option_groups[0].fields.type.sources,[]);
  assert.equal(value.option_groups[0].fields.name.sources.length,1);
});

test('AI Context Builder maps configuration images to a valid Top5 display role',()=>{
  const value={images:{top5_roles:['product_gallery','configuration_image','scene']}};
  assert.deepEqual(normalizeSliceOutput('assets',value).images.top5_roles,['product_gallery','scene']);
});

test('AI Context Builder preserves the complete extraction contract after slice merge',()=>{
  const source=asV2Extraction(JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','fendi-casa-site-rule-config-v1.1.json'),'utf8')).extraction);
  const outputs={product_fields:extractionSliceFor('site-rule-v2-product-fields-slice',source),assets:extractionSliceFor('site-rule-v2-assets-slice',source)};
  const merged=mergeExtractionSlices(outputs);
  assert.equal(merged.product_type,'furniture');assert.deepEqual(merged.structured.option_groups,[]);assert.equal(merged.structured.configurations.mode,'none');
  assert.deepEqual(require('../services/product-ingestion-site-rule-ai').proposalErrors(merged),[]);
});

test('site rule id stays schema-safe for brands written only in Chinese',()=>{
  const value=siteId({brand:'班兰',entry_url:'https://banlan.com.cn/'});
  assert.match(value,/^[a-z0-9][a-z0-9_-]{1,79}$/);
  assert.match(value,/banlan-com-cn/);
});

test('site map preserves original, normalized and decoded multilingual URLs',()=>{
  const clusters=clusterUrls([productUrl,'https://www.poliform.cn/%E4%BA%A7%E5%93%81/attimo/']);
  assert.match(clusters[0].decoded_path_pattern,/产品/);
  const card=pageCard({url:productUrl,status:200,contentType:'text/html',html:fixture()},'P-001');
  assert.equal(card.original_url,productUrl);
  assert.match(card.decoded_path,/产品\/alfred-扶手椅/);
  assert.equal(card.h1,'Alfred');
  assert.ok(card.limited_main_dom.includes('projects-item__product'));
});

test('site map records a grounded product-name selector when a template has no h1',()=>{
  const html='<html><head><title>云杉沙发-Banlan | 班兰家具</title></head><body><div class="product-name">云杉沙发</div><div class="gallery"><img src="a.jpg"><img src="b.jpg"></div></body></html>';
  const card=pageCard({url:'https://banlan.com.cn/product/show/id/267',status:200,contentType:'text/html',html},'P-001');
  assert.deepEqual(card.field_contexts.find(item=>item.field==='name'),{field:'name',selector:'div.product-name',text:'云杉沙发'});
  assert.ok(card.dom_evidence_regions.some(region=>region.html.includes('product-name')));
});

test('site map follows bounded new link families from home to listing to product',async()=>{
  const home='https://example.com/',listing='https://example.com/collections/all',product='https://example.com/products/chair-one';
  const html=new Map([
    [home,`<html><body><main><a href="${listing}">All furniture</a><a href="https://example.com/collections/seating">Seating</a><a href="https://example.com/collections/tables">Tables</a></main></body></html>`],
    [listing,`<html><body><main><h1>Collection</h1><a href="${product}">Chair One</a><a href="https://example.com/products/chair-two">Chair Two</a><a href="https://example.com/products/table-one">Table One</a></main></body></html>`],
    [product,'<html><body><main><h1>Chair One</h1><h2>Materials</h2><p>Oak</p><img src="/one.jpg"><img src="/two.jpg"></main></body></html>'],
  ]);
  const scope={brand_name:'Example',base_url:home,seed_urls:[home],allowed_hosts:['example.com'],allowed_asset_hosts:['example.com'],allowed_path_prefixes:['/'],request_interval_ms:1000,max_pages:8,site_cognition_probe_pages:8};
  const map=await buildSiteMap(scope,{discoverSitemapUrls:async()=>({urls:['https://example.com/pages/store/a','https://example.com/pages/store/b'],summary:{files_scanned:1}}),fetchHtml:async url=>({url,status:200,contentType:'text/html',html:html.get(url)||'<html><body><main>Other</main></body></html>'})});
  assert.ok(map.pages.some(page=>page.url===listing));
  assert.ok(map.pages.some(page=>page.url===product));
  const productCluster=map.clusters.find(cluster=>cluster.decoded_path_pattern==='/products/{leaf}/');
  assert.ok(productCluster);
  assert.equal(productCluster.estimated_count,3);
  assert.ok(map.coverage.sampled_pages<=8);
});

test('product evidence augmentation receives scope, discovery rule and fetcher in separate positions',async()=>{
  const siteMap={site:{},pages:[],clusters:[{url_examples:['https://example.com/products/a']}]},scope={allowed_hosts:['example.com']},rule={product_detail_path_prefixes:['/products/'],exclude_path_prefixes:[]};
  const result=await augmentEvidenceForRule(siteMap,scope,rule,async url=>({url,status:200,contentType:'text/html',html:'<html><body><main><h1>A</h1></main></body></html>'}));
  assert.equal(result.coverage.product_evidence_pages,1);
  assert.equal(result.pages[0].url,'https://example.com/products/a');
});

test('AI cognition decision must cite real pages and a supported product hypothesis',()=>{
  const siteMap={pages:[{page_id:'P-001'}],clusters:[{cluster_id:'UC-001'}]};
  const decision={schema_version:'site-cognition-ai-output-v1.0',business_summary:'发现了一组具体产品页面。',hypotheses:[{hypothesis_id:'H-001',subject_id:'UC-001',proposed_role:'product_detail',claim:'同一模板对应不同产品。',supporting_evidence_refs:['P-001:h1'],counter_evidence_refs:[],alternative_roles:['collection_detail'],confidence:0.9,status:'supported',discriminators:['单一产品主体']}],next_decision:{action:'GENERATE_DISCOVERY_RULE',reason:'已有产品页与对照证据。',hypothesis_ids:['H-001'],readiness:{discovery_rule:true,extraction_rule:false}},probe_requests:[],unresolved_questions:[],warnings:[]};
  assert.deepEqual(validateDecision(decision,siteMap),[]);
  decision.hypotheses[0].supporting_evidence_refs=['P-999:h1'];
  assert.match(validateDecision(decision,siteMap).join(';'),/引用不存在/);
});

test('AI rule generator enforces function output and server validation',async()=>{
  const value=config();
  const fakeFetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({id:'resp-1',output:[{type:'function_call',name:'submit_site_rule',arguments:JSON.stringify(value)}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}})});
  const result=await generateSiteRule({schema_version:'site-structure-map-v1.0',site:{brand:'Poliform',entry_url:'https://www.poliform.cn/',allowed_hosts:['www.poliform.cn'],allowed_path_prefixes:['/产品/']},coverage:{},clusters:[],pages:[],failures:[]},{config:{apiKey:'test',model:'qwen-test',endpoint:'https://example.test/responses'},fetchImpl:fakeFetch});
  assert.equal(result.config_hash.length,64);
  assert.equal(result.calls.length,1);
  assert.equal(result.usage.total_tokens,120);
});

function extractionSliceFor(schemaId,extraction){
  if(schemaId==='site-rule-v2-product-fields-slice')return {fields:extraction.fields,furniture_type:extraction.structured.furniture_type,furniture_type_rule:extraction.structured.furniture_type_rule};
  if(schemaId==='site-rule-v2-assets-slice')return {images:extraction.images,attachments:extraction.attachments,relationships:extraction.relationships,ocr:extraction.structured.ocr,customization:extraction.structured.customization};
  if(schemaId==='site-rule-v2-configurations-slice')return {variants:extraction.variants,configurations:extraction.structured.configurations};
  if(schemaId==='site-rule-v2-option-groups-slice')return {option_groups:extraction.structured.option_groups};
  throw new Error(`unexpected schema ${schemaId}`);
}

function asV2Extraction(value){
  const extraction=normalizeV2ProposalShape(JSON.parse(JSON.stringify(value)));
  extraction.fields.english_name ||= {required:false,sources:[]};
  extraction.fields.release_date ||= {required:false,sources:[]};
  extraction.structured.configurations.fields.group ||= {required:false,sources:[]};
  extraction.structured.option_groups ||= [];
  return extraction;
}

test('field-stage AI receives no mutable discovery contract after the discovery gate',async()=>{
  const value=JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','fendi-casa-site-rule-config-v1.1.json'),'utf8')),extraction=asV2Extraction(value.extraction),frozen={
    seed_urls:value.discovery.seed_urls,product_detail_path_prefixes:value.discovery.product_detail_path_prefixes,
    listing_path_prefixes:value.discovery.listing_path_prefixes,exclude_path_prefixes:value.discovery.exclude_path_prefixes,
    link_sources:value.discovery.link_sources,required_signals:value.template.required_signals,
  };
  let calls=0;const fakeFetch=async(_url,options)=>{calls+=1;const request=JSON.parse(options.body),schema=request.tools[0].parameters;assert.equal('discovery' in (schema.properties||{}),false);const slice=extractionSliceFor(schema.$id,extraction);return {ok:true,status:200,text:async()=>JSON.stringify({id:`resp-${calls}`,output:[{type:'function_call',name:'submit_site_rule',arguments:JSON.stringify(slice)}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}})};};
  const generated=await generateSiteRule({schema_version:'site-structure-map-v1.0',site:{brand:'Fendi Casa',entry_url:'https://www.fendicasa.com/',allowed_hosts:['www.fendicasa.com'],allowed_asset_hosts:['www.fendicasa.com'],allowed_path_prefixes:['/']},coverage:{},clusters:[],pages:[{page_id:'P-001',content_hash:'hash-1',url:frozen.seed_urls[0],h1:'产品'}],failures:[]},{discoveryRule:frozen,config:{apiKey:'test',model:'qwen-test',endpoint:'https://example.test/responses'},fetchImpl:fakeFetch});
  assert.deepEqual(generated.config.discovery.product_detail_path_prefixes,frozen.product_detail_path_prefixes);
  assert.equal(calls,2);
  assert.ok(generated.calls.every(call=>Object.prototype.hasOwnProperty.call(call,'raw_output')));
  assert.ok(generated.calls.every(call=>Object.prototype.hasOwnProperty.call(call,'normalized_output')));
  assert.ok(generated.calls.every(call=>call.raw_output&&call.normalized_output));
});

test('program-owned rule assembly errors never trigger a second AI request',async()=>{
  const value=JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','fendi-casa-site-rule-config-v1.1.json'),'utf8')),extraction=asV2Extraction(value.extraction),frozen={
    seed_urls:value.discovery.seed_urls,product_detail_path_prefixes:value.discovery.product_detail_path_prefixes,
    listing_path_prefixes:value.discovery.listing_path_prefixes,exclude_path_prefixes:value.discovery.exclude_path_prefixes,
    link_sources:value.discovery.link_sources,required_signals:value.template.required_signals,
  };
  let calls=0;const fakeFetch=async(_url,options)=>{calls+=1;const request=JSON.parse(options.body),slice=extractionSliceFor(request.tools[0].parameters.$id,extraction);return {ok:true,status:200,text:async()=>JSON.stringify({id:`assembly-${calls}`,output:[{type:'function_call',name:'submit_site_rule',arguments:JSON.stringify(slice)}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}})};};
  const siteMap={schema_version:'site-structure-map-v1.0',site:{brand:'测试',entry_url:'https://www.poliform.cn/',allowed_hosts:[],allowed_asset_hosts:[],allowed_path_prefixes:['/']},coverage:{},clusters:[],pages:[],failures:[]};
  await assert.rejects(()=>generateSiteRule(siteMap,{discoveryRule:frozen,config:{apiKey:'test',model:'qwen-test',endpoint:'https://example.test/responses'},fetchImpl:fakeFetch}),error=>{
    assert.equal(error.code,'INGESTION_SITE_RULE_ASSEMBLY_INVALID');
    assert.ok(error.details.calls.every(call=>call.raw_output&&call.normalized_output));
    return true;
  });
  assert.equal(calls,2);
});

test('discovery gate requires positive, negative and unseen product candidates',()=>{
  const siteMap={site:{entry_url:'https://example.com/'},pages:[],clusters:[{url_examples:['https://example.com/products/','https://example.com/products/a','https://example.com/products/b','https://example.com/products/c','https://example.com/news/a']} ]};
  const rule={seed_urls:['https://example.com/products/a'],product_detail_path_prefixes:['/products/a','/products/b','/products/c'],listing_path_prefixes:['/products/'],exclude_path_prefixes:['/news/']};
  const result=validateDiscoveryAgainstMap(siteMap,rule);
  assert.equal(result.passed,true);assert.ok(result.unseen_product_urls.length>=2);assert.ok(result.cases.some(item=>item.kind==='negative'));
  const broad={...rule,product_detail_path_prefixes:['/'],listing_path_prefixes:[]};
  assert.equal(validateDiscoveryAgainstMap(siteMap,broad).passed,false);
});

test('precise URL role contract separates a locale homepage from sibling product files',()=>{
  const siteMap={site:{entry_url:'https://example.com/en-us/'},pages:[],clusters:[{url_examples:['https://example.com/en-us/','https://example.com/en-us/alpha-sofas.html','https://example.com/en-us/beta-chairs.html','https://example.com/en-us/gamma-tables.html']}]};
  const rule={seed_urls:['https://example.com/en-us/alpha-sofas.html'],product_detail_path_prefixes:['/en-us/'],product_detail_path_patterns:['^/en-us/[^/]+\\.html$'],listing_path_prefixes:[],exclude_path_prefixes:[],exclude_paths:['/en-us/']};
  const result=validateDiscoveryAgainstMap(siteMap,rule,['https://example.com/en-us/alpha-sofas.html']);
  assert.equal(result.passed,true,JSON.stringify(result.errors));assert.ok(result.cases.some(item=>item.kind==='negative'&&item.passed));
});

test('discovery normalization derives a bounded sibling-file role from two confirmed products and their cluster',()=>{
  const labeled=['https://example.com/en-us/alpha-sofas.html','https://example.com/en-us/beta-chairs.html','https://example.com/en-us/gamma-tables.html'];
  const siteMap={site:{entry_url:'https://example.com/en-us/',allowed_hosts:['example.com'],allowed_path_prefixes:['/']},pages:[],clusters:[{url_examples:labeled}],known_labels:labeled.map(url=>({url,role:'product_detail',source:'bounded_official_discovery'}))};
  const proposed={product_detail_path_prefixes:['/en-us/'],listing_path_prefixes:['/en-us/'],exclude_path_prefixes:[],seed_urls:[labeled[0]],link_sources:[{selector:'a[href]',attribute:'href'}],required_signals:['H1','PRODUCT_GALLERY'],evidence_refs:['UC-001:path_pattern']};
  const normalized=normalizeDiscoveryRule(proposed,siteMap);
  assert.deepEqual(normalized.product_detail_path_patterns,['^/en-us/[^/]+\\.html$']);
  assert.deepEqual(normalized.exclude_paths,['/en-us/']);
  assert.deepEqual(validateDiscoveryRule(normalized,siteMap),[]);
});

test('discovery AI output rejects listing pages used as product seeds',()=>{
  const siteMap={site:{allowed_hosts:['example.com'],allowed_path_prefixes:['/']},clusters:[{url_examples:['https://example.com/products/a','https://example.com/catalog/']} ]};
  const value={product_detail_path_prefixes:['/products/'],listing_path_prefixes:['/catalog/'],exclude_path_prefixes:[],seed_urls:['https://example.com/catalog/'],link_sources:[{selector:'a[href]',attribute:'href'}],required_signals:['H1','OG_IMAGE'],evidence_refs:['UC-001:path_pattern']};
  assert.match(validateDiscoveryRule(value,siteMap).join(';'),/种子不是当前规则认定的产品详情页/);
});

test('discovery AI converts site-map leaf templates into executable literal prefixes',async()=>{
  const siteMap={schema_version:'site-structure-map-v1.0',site:{entry_url:'https://banlan.com.cn/',allowed_hosts:['banlan.com.cn'],allowed_path_prefixes:['/']},coverage:{},clusters:[{cluster_id:'UC-005',decoded_path_pattern:'/product/show/id/{leaf}/',url_examples:['https://banlan.com.cn/product/show/id/267','https://banlan.com.cn/product/show/id/276','https://banlan.com.cn/product/show/id/312']}],pages:[],failures:[]};
  const value={product_detail_path_prefixes:['/product/show/id/{leaf}/'],listing_path_prefixes:['/product/index/cid/{leaf}/'],exclude_path_prefixes:['/product/'],seed_urls:['https://banlan.com.cn/product/show/id/267'],link_sources:[{selector:'a[href]',attribute:'href'}],required_signals:['H1','PRODUCT_DESCRIPTION'],evidence_refs:['UC-005:path_pattern']};
  let calls=0;const fakeFetch=async()=>{calls+=1;return {ok:true,status:200,text:async()=>JSON.stringify({id:'banlan-rule',output:[{type:'function_call',name:'submit_discovery_rule',arguments:JSON.stringify(value)}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}})};};
  const result=await generateDiscoveryRule(siteMap,{config:{apiKey:'test',model:'qwen-test',endpoint:'https://example.test/responses'},fetchImpl:fakeFetch});
  assert.equal(calls,1);
  assert.deepEqual(result.output.product_detail_path_prefixes,['/product/show/id/']);
  assert.deepEqual(result.output.listing_path_prefixes,['/product/index/cid/']);
  assert.deepEqual(result.output.exclude_path_prefixes,[]);
  assert.deepEqual(validateDiscoveryRule(result.output,siteMap),[]);
});

test('discovery AI replaces unsupported template signals with signals shared by product evidence',async()=>{
  const siteMap={schema_version:'site-structure-map-v1.0',site:{entry_url:'https://banlan.com.cn/',allowed_hosts:['banlan.com.cn'],allowed_path_prefixes:['/']},coverage:{},clusters:[{cluster_id:'UC-005',decoded_path_pattern:'/product/show/id/{leaf}/',url_examples:['https://banlan.com.cn/product/show/id/267']}],pages:[{page_id:'P-005',url:'https://banlan.com.cn/product/show/id/267',h1:'',headings:[],visible_text:'产品规格 材质信息',json_ld:[],image_regions:[{image_count:4}]}],failures:[]};
  const value={product_detail_path_prefixes:['/product/show/id/'],listing_path_prefixes:['/product/index/cid/'],exclude_path_prefixes:[],seed_urls:['https://banlan.com.cn/product/show/id/267'],link_sources:[{selector:'a[href]',attribute:'href'}],required_signals:['H1','PRODUCT_DESCRIPTION'],evidence_refs:['UC-005:path_pattern']};
  const fakeFetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({id:'signals',output:[{type:'function_call',name:'submit_discovery_rule',arguments:JSON.stringify(value)}],usage:{}})});
  const result=await generateDiscoveryRule(siteMap,{config:{apiKey:'test',model:'qwen-test',endpoint:'https://example.test/responses'},fetchImpl:fakeFetch});
  assert.deepEqual(result.output.required_signals,['PRODUCT_GALLERY','PRODUCT_SPECIFICATION']);
});

test('missing discovery function output is never treated as a valid empty rule',async()=>{
  let calls=0;const fakeFetch=async()=>{calls+=1;return {ok:true,status:200,text:async()=>JSON.stringify({id:`empty-${calls}`,output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}})};};
  const siteMap={schema_version:'site-structure-map-v1.0',site:{allowed_hosts:['example.com'],allowed_path_prefixes:['/']},coverage:{},clusters:[],pages:[],failures:[]};
  await assert.rejects(()=>generateDiscoveryRule(siteMap,{config:{apiKey:'test',model:'qwen-test',endpoint:'https://example.test/responses'},fetchImpl:fakeFetch}),/AI 发现规则两次均未通过校验/);
  assert.equal(calls,2);
});

test('production discovery trusts a frozen rule instead of the old URL score',async()=>{
  const value=config(),rule={id:9,source_id:1,status:'frozen',version_number:2,config:value,config_hash:require('../services/product-ingestion-site-rule-schema').configHash(value)};
  const scope={source_id:1,job_id:4,source_status:'active',job_status:'discovering',base_url:'https://www.poliform.cn/',allowed_hosts:['www.poliform.cn'],allowed_path_prefixes:['/产品/'],max_pages:3,max_products:10,request_interval_ms:1000,page_quota:{used:0,limit:3}};
  const result=await discoverProductsWithSiteRule(scope,rule,async url=>({url,status:200,contentType:'text/html',html:fixture()}),async()=>{}, {sitemapDiscoverer:async()=>({urls:[productUrl],summary:{files_scanned:1,urls_found:1}})});
  assert.deepEqual(result.urls,[productUrl]);
  assert.equal(result.summary.rule_execution.generic_score_bypassed,true);
});

test('production discovery separates sandbox samples from full-site listing traversal',async()=>{
  const value=config();
  value.scope.base_url='https://www.poliform.cn/';
  value.discovery.seed_urls=['https://www.poliform.cn/%E4%BA%A7%E5%93%81/sample/'];
  value.discovery.product_detail_path_prefixes=['/产品/'];
  value.discovery.listing_path_prefixes=['/catalog/'];
  const rule={id:12,source_id:1,status:'frozen',version_number:1,config:value,config_hash:require('../services/product-ingestion-site-rule-schema').configHash(value)};
  const home='https://www.poliform.cn/',listing='https://www.poliform.cn/catalog/chairs/',a='https://www.poliform.cn/%E4%BA%A7%E5%93%81/a/',b='https://www.poliform.cn/%E4%BA%A7%E5%93%81/b/';
  const pages=new Map([
    [home,`<a href="${listing}">chairs</a>`],
    [listing,`<a href="${a}">A</a><a href="${b}">B</a>`],
  ]);
  const scope={source_id:1,job_id:5,source_status:'active',job_status:'discovering',base_url:home,seed_urls:[home],allowed_hosts:['www.poliform.cn'],allowed_path_prefixes:['/'],max_pages:20,max_products:500,request_interval_ms:1000,page_quota:{used:0,limit:20}};
  const result=await discoverProductsWithSiteRule(scope,rule,async url=>({url,status:200,contentType:'text/html',html:pages.get(url)||''}),async()=>{}, {sitemapDiscoverer:async()=>({urls:[],summary:{files_scanned:1,urls_found:0,failures:[]}})});
  assert.deepEqual(result.urls.sort(),[a,b,value.discovery.seed_urls[0]].sort());
  assert.equal(result.summary.discovery_coverage.status,'complete');
  assert.equal(result.summary.discovery_coverage.listing_pages_scanned,1);
  assert.equal(result.summary.pages_scanned,2);
});

test('production discovery never presents frozen sample replay as a full-site result',async()=>{
  const value=config(),rule={id:13,source_id:1,status:'frozen',version_number:1,config:value,config_hash:require('../services/product-ingestion-site-rule-schema').configHash(value)};
  const home='https://www.poliform.cn/';
  const scope={source_id:1,job_id:6,source_status:'active',job_status:'discovering',base_url:home,seed_urls:[home],allowed_hosts:['www.poliform.cn'],allowed_path_prefixes:['/'],max_pages:20,max_products:500,request_interval_ms:1000,page_quota:{used:0,limit:20}};
  const result=await discoverProductsWithSiteRule(scope,rule,async url=>({url,status:200,contentType:'text/html',html:'<a href="/about/">about</a>'}),async()=>{}, {sitemapDiscoverer:async()=>({urls:[],summary:{files_scanned:1,urls_found:0,failures:[]}})});
  assert.equal(result.summary.discovery_coverage.status,'sample_only');
  assert.equal(result.summary.result,'sample_only');
  assert.match(result.summary.message,/规则样本/);
});

test('sitemap discovery never claims complete enumeration after the product limit truncates matches',async()=>{
  const value=config();value.discovery.product_detail_path_prefixes=['/产品/'];
  const urls=['a','b','c'].map(name=>`https://www.poliform.cn/%E4%BA%A7%E5%93%81/${name}/`);value.discovery.seed_urls=[urls[0]];const rule={id:14,source_id:1,status:'frozen',version_number:1,config:value,config_hash:require('../services/product-ingestion-site-rule-schema').configHash(value)},scope={source_id:1,job_id:7,source_status:'active',job_status:'discovering',base_url:'https://www.poliform.cn/',seed_urls:[],allowed_hosts:['www.poliform.cn'],allowed_path_prefixes:['/'],max_pages:20,max_products:2,request_interval_ms:1000,page_quota:{used:0,limit:20}};
  const result=await discoverProductsWithSiteRule(scope,rule,async url=>({url,status:200,contentType:'text/html',html:''}),async()=>{}, {sitemapDiscoverer:async()=>({urls,summary:{files_scanned:1,urls_found:3,capped_urls:false,capped_files:false}})});
  assert.equal(result.urls.length,2);
  assert.equal(result.summary.capped_products,true);
  assert.equal(result.summary.discovery_coverage.enumeration_complete,false);
  assert.equal(result.summary.discovery_coverage.status,'partial');
});

test('production extraction executes rule selectors and returns standard candidate payload',()=>{
  const value=config(),rule={id:9,source_id:1,status:'frozen',version_number:2,config:value,config_hash:require('../services/product-ingestion-site-rule-schema').configHash(value)};
  const result=extractProductWithSiteRule({url:productUrl,status:200,contentType:'text/html',html:fixture()},rule);
  assert.equal(result.payload.name,'Alfred');
  assert.equal(result.payload.brand,'Poliform');
  assert.equal(result.payload.product_type,'furniture');
  assert.ok(result.payload.product_details.configurations[0].image_urls.length>=1);
  assert.equal(result.extracted.extraction_method,'frozen_site_rule_v1');
});

test('validation-driven refinement removes disproved optional requirements, template signals and cross-product image sources',()=>{
  const value=config();value.template.required_signals=['JSON_LD_PRODUCT','H1','PRODUCT_GALLERY'];value.extraction.images.sources=[{type:'dom_attribute',selector:'.recommendations img',attribute:'src'}];
  const refined=refineFromValidation(value,{rejected_products:[{validation_errors:['TEMPLATE_SIGNALS_MISSING:PRODUCT_GALLERY','PRIMARY_IMAGE_REUSED_ACROSS_PRODUCTS','REQUIRED_FIELD_MISSING:description']}]});
  assert.deepEqual(refined.template.required_signals,['JSON_LD_PRODUCT','H1']);
  assert.deepEqual(refined.extraction.images.sources,[{type:'meta',property:'og:image'},{type:'json_ld_product',path:'image'}]);
  assert.ok(refined.validation.required_fields.includes('name'));
  assert.ok(!refined.validation.required_fields.includes('description'));
  assert.equal(refined.extraction.fields.description.required,false);
  assert.match(refined.provenance.generator,/validated-refinement/);
});

test('validation-driven image refinement preserves required v1.1 image roles',()=>{
  const value=JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','hc28-site-rule-config-v1.1.json'),'utf8'));
  const refined=refineFromValidation(value,{rejected_products:[{validation_errors:['PRIMARY_IMAGE_REUSED_ACROSS_PRODUCTS']}]});
  assert.deepEqual(refined.extraction.images.sources,[
    {type:'meta',property:'og:image',role:'main'},
    {type:'json_ld_product',path:'image',role:'main'},
  ]);
  assert.equal(require('../services/product-ingestion-site-rule-schema').validateSiteRule(refined).schema_valid,true);
});

test('production page fetch retries a transient reset once but stays bounded',async()=>{
  let calls=0;const scope={page_quota:{used:0,limit:2}};
  const page=await fetchPageWithRetry('https://example.com/product',scope,async()=>{calls+=1;if(calls===1){const error=new Error('reset');error.code='ECONNRESET';throw error;}return {url:'https://example.com/product',html:'ok'};});
  assert.equal(calls,2);assert.equal(page.html,'ok');
});

test('confirmed product fetch uses one controlled rendered retry after HTTP access restriction',async()=>{
  const scopes=[],scope={page_quota:{used:0,limit:3}};
  const page=await fetchPageWithRetry('https://example.com/product',scope,async(url,current)=>{scopes.push(current);if(!current.force_rendered_channel){const error=new Error('HTTP 403');error.code='PAGE_HTTP_STATUS';error.response={status:403};throw error;}return {url,html:'<h1>Rendered</h1>',acquisition_channel:'rendered_html'};});
  assert.equal(page.acquisition_channel,'rendered_html');
  assert.equal(scopes.length,2);
  assert.equal(scopes[1].force_rendered_channel,true);
  assert.equal(scopes[1].allow_same_site_subresources,true);
});

test('full crawl rate limiting waits a bounded number of times and honors Retry-After',()=>{
  const error=Object.assign(new Error('too many requests'),{response:{status:429,headers:{'retry-after':'120'}}});
  const first=fullCrawlRateLimitWait(error,{full_crawl_rate_limit_waits:0},Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(first.attempt,1);assert.equal(first.exhausted,false);assert.equal(first.resume_at,'2026-09-16T00:02:00.000Z');
  const exhausted=fullCrawlRateLimitWait(error,{full_crawl_rate_limit_waits:MAX_FULL_CRAWL_RATE_LIMIT_WAITS},Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(exhausted.exhausted,true);
  assert.equal(fullCrawlRateLimitWait(Object.assign(new Error('forbidden'),{response:{status:403}}),{},0),null);
});

test('restart recovery resumes discovery and extraction instead of leaving jobs failed',async()=>{
  const scheduled=[],updates=[];
  const db={query:async sql=>{
    if(sql.startsWith('SELECT id,status,current_stage FROM product_ingestion_jobs'))return [[
      {id:41,status:'discovering',current_stage:'site_cognition'},
      {id:42,status:'running',current_stage:'extraction'},
      {id:43,status:'queued',current_stage:'extraction'},
    ]];
    if(sql.startsWith('UPDATE product_ingestion_jobs')){updates.push(sql);return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const runner=createRunner(db,{schedule:fn=>scheduled.push(fn)});
  const result=await runner.recoverInterruptedJobs();
  assert.deepEqual(result,{recovered:3,resumed_discovery:1,resumed_extraction:2});
  assert.equal(scheduled.length,3);
  assert.match(updates[0],/status='discovery_approved'/);
  assert.match(updates[1],/status='queued'/);
  assert.equal(updates.every(sql=>!sql.includes("status='failed'")),true);
});

test('invalid human anchor returns to a new business anchor instead of staying in hypothesis evaluation',async()=>{
  const badUrl='https://www.fendicasa.com/',jobUpdates=[];
  const row={id:10,source_id:5,job_id:39,rule_id:null,state:'HYPOTHESIS_EVALUATING',state_version:8,evidence_revision:1,attempt_counters:{},next_allowed_events:['GENERATE_DISCOVERY_RULE','NEED_MORE_EVIDENCE','NEED_HUMAN_ANCHOR'],resume_payload:{page_url:badUrl},finished_at:null};
  const db={query:async(sql,args=[])=>{
    if(sql.startsWith('SELECT * FROM product_ingestion_site_cognition_workflows'))return [[{...row}]];
    if(sql.startsWith('SELECT * FROM product_ingestion_site_cognition_events'))return [[]];
    if(sql.startsWith('SELECT content FROM product_ingestion_site_cognition_evidence'))return [[{content:{pages:[{page_id:'P-001',url:badUrl,title:'Home',h1:'Fendi Casa'},{page_id:'P-002',url:'https://www.fendicasa.com/products/example',title:'Example',h1:'Example'}]}}]];
    if(sql.startsWith('UPDATE product_ingestion_site_cognition_workflows SET state=')){
      row.state=args[0];row.state_version+=1;row.next_allowed_events=JSON.parse(args[1]);row.resume_payload=JSON.parse(args[4]);return [{affectedRows:1}];
    }
    if(sql.startsWith('INSERT INTO product_ingestion_site_cognition_events'))return [{insertId:1}];
    if(sql.startsWith('UPDATE product_ingestion_site_cognition_workflows SET last_error_code=')){row.last_error_code=args[0];row.last_error=args[1];return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE product_ingestion_jobs SET')){jobUpdates.push({sql,args});return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const control=createSiteCognitionControl(db,{siteRules:{get:async()=>null}});
  const recovered=await control.returnToHumanAnchor(10,Object.assign(new Error('产品路径没有站内样本'),{code:'AI_RULE_INVALID'}),'test');
  assert.equal(recovered.state,'HUMAN_ANCHOR_REQUIRED');
  assert.equal(recovered.resume_payload.rejected_anchor_url,badUrl);
  assert.deepEqual(recovered.resume_payload.invalid_anchor_urls,[badUrl]);
  assert.match(recovered.business_summary,/重新选择/);
  assert.deepEqual(recovered.human_anchor_candidates.map(item=>item.url),['https://www.fendicasa.com/products/example']);
  assert.equal(jobUpdates.length,1);
  assert.match(jobUpdates[0].sql,/current_stage='human_anchor'/);
});
