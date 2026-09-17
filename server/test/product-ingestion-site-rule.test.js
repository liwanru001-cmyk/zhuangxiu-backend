'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {validateSiteRule,configHash,SANDBOX_HARD_LIMITS}=require('../services/product-ingestion-site-rule-schema');
const {executeSiteRuleSandbox,createSiteRuleControl,templateBinding}=require('../services/product-ingestion-site-rule-sandbox');
const {extractProductWithSiteRule,extractProductWithSiteRuleSet,templateSignatureCompatible,loadFrozenSiteRule,loadFrozenSiteRules}=require('../services/product-ingestion-site-rule-runtime');
const {pathAllowedByPrefixes}=require('../services/product-ingestion-runtime-safety');
const {parseDimensions}=require('../services/product-ingestion-site-rule-structured');
const {analyzeImages}=require('../services/product-ingestion-site-rule-ocr');
const {normalizeExtractionProposal}=require('../services/product-ingestion-site-rule-ai');

const configPath=path.join(__dirname,'..','..','docs','research-artifacts','poliform-site-rule-config-v1.json');
function config(){return JSON.parse(fs.readFileSync(configPath,'utf8'));}
function clone(value){return JSON.parse(JSON.stringify(value));}

test('frozen rule loading sorts only identity before reading a large rule payload',async()=>{
  const value=config(),calls=[];
  const db={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT id FROM product_ingestion_site_rules'))return [[{id:25}]];
    if(sql.startsWith('SELECT * FROM product_ingestion_site_rules WHERE id='))return [[{id:25,source_id:9,status:'frozen',config:value,validation_result:{valid:true}}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const rule=await loadFrozenSiteRule(db,9);
  assert.equal(rule.id,25);
  assert.equal(calls.length,2);
  assert.doesNotMatch(calls[0].sql,/SELECT \*/);
  assert.match(calls[1].sql,/WHERE id=\?/);
});

test('frozen template rule sets load newest first without sorting JSON payloads',async()=>{
  const value=config(),calls=[];
  const db={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT id FROM product_ingestion_site_rules'))return [[{id:26},{id:25}]];
    if(sql.startsWith('SELECT * FROM product_ingestion_site_rules WHERE id='))return [[{id:params[0],source_id:9,status:'frozen',config:value,validation_result:{valid:true}}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const rules=await loadFrozenSiteRules(db,9);
  assert.deepEqual(rules.map(rule=>rule.id),[26,25]);
  assert.doesNotMatch(calls[0].sql,/SELECT \*/);
});

test('site-rule-config-v1 accepts the frozen Poliform rule and has bounded no-write sandbox',()=>{
  const value=config(),result=validateSiteRule(value);
  assert.equal(result.valid,true,JSON.stringify(result));
  assert.equal(value.sandbox.max_pages<=SANDBOX_HARD_LIMITS.max_pages,true);
  assert.equal(value.sandbox.max_products<=SANDBOX_HARD_LIMITS.max_products,true);
  assert.equal(value.sandbox.write_candidates,false);
  assert.equal(value.sandbox.publish_products,false);
  assert.equal(configHash(value).length,64);
});

test('schema and semantic gates reject unsafe or unexecutable AI output',()=>{
  const excessive=clone(config());excessive.sandbox.max_pages=6;
  assert.equal(validateSiteRule(excessive).valid,false);
  const wrongPriority=clone(config());wrongPriority.discovery.matching_priority=['listing','product_detail','exclude'];
  assert.match(validateSiteRule(wrongPriority).semantic_errors.join(' '),/matching_priority/);
  const shadowed=clone(config());shadowed.discovery.exclude_path_prefixes=['/'];
  assert.match(validateSiteRule(shadowed).semantic_errors.join(' '),/被排除路径.*覆盖/);
  const unsafeRegex=clone(config());unsafeRegex.extraction.fields.designer.sources[0].pattern='(a+)+$';
  assert.match(validateSiteRule(unsafeRegex).semantic_errors.join(' '),/body_regex/);
  const outside=clone(config());outside.discovery.seed_urls=['https://dealer.example/products/chair'];
  assert.match(validateSiteRule(outside).semantic_errors.join(' '),/超出页面域名范围/);
  const writable=clone(config());writable.sandbox.write_candidates=true;
  assert.equal(validateSiteRule(writable).schema_valid,false);
});

test('precise URL roles supersede overlapping fallback prefixes in the full site rule',()=>{
  const value=clone(config());
  value.discovery.product_detail_path_prefixes=['/en-us/'];
  value.discovery.listing_path_prefixes=['/en-us/'];
  value.discovery.exclude_path_prefixes=['/en-us/'];
  value.discovery.product_detail_path_patterns=['^/en-us/[^/]+\\.html$'];
  value.discovery.exclude_paths=['/en-us/'];
  const result=validateSiteRule(value);
  assert.doesNotMatch(result.semantic_errors.join(' '),/产品详情路径.*(?:列表|排除|覆盖)/);
});

test('path authorization supports Chinese encoded paths without encoded-slash bypass',()=>{
  assert.equal(pathAllowedByPrefixes('/%E4%BA%A7%E5%93%81/alfred-%E6%89%B6%E6%89%8B%E6%A4%85/',['/产品/']),true);
  assert.equal(pathAllowedByPrefixes('/news/alfred',['/产品/']),false);
  assert.equal(pathAllowedByPrefixes('/%E4%BA%A7%E5%93%81%2F..%2Fadmin',['/产品/']),false);
  assert.equal(pathAllowedByPrefixes('/%E4%BA%A7%E5%93%81/%E0%A4%A',['/产品/']),false);
});

function fixture(name,designer,next=''){
  return `<!doctype html><html><head><meta property="og:description" content="${name} 产品描述"><meta property="og:image" content="https://s3.poliform.cn/${name.toLowerCase()}-main.jpg"><script type="application/ld+json">{"@type":"Product","name":"${name}","description":"${name} 产品描述"}</script></head><body><main><h1>${name}</h1><h3>技术细节</h3><p>2026年 由 ${designer} 设计</p><div class="product-gallery"><img src="https://s3.poliform.cn/${name.toLowerCase()}-main.jpg"><img src="https://s3.poliform.cn/${name.toLowerCase()}-side.jpg"></div>${next}</main></body></html>`;
}

test('controlled sandbox follows the rule, strips fragments, extracts three products and writes nothing',async()=>{
  const value=config();
  const urls=[
    value.discovery.seed_urls[0],
    'https://www.poliform.cn/%E4%BA%A7%E5%93%81/attimo-%E6%89%B6%E6%89%8B%E6%A4%85/',
    'https://www.poliform.cn/%E4%BA%A7%E5%93%81/aqualuna-%E6%89%B6%E6%89%8B%E6%A4%85/',
  ];
  const pages=new Map([
    [urls[0],fixture('Alfred','Jean-Marie Massaud',`<a href="${urls[0]}#details">same</a><a href="${urls[1]}">Attimo</a><a href="https://dealer.example/product">outside</a>`)],
    [urls[1],fixture('Attimo','Jean-Marie Massaud',`<a href="${urls[2]}">Aqualuna</a>`)],
    [urls[2],fixture('Aqualuna','Yabu Pushelberg')],
  ]);
  const requested=[];
  const result=await executeSiteRuleSandbox(value,{fetchHtml:async(url,scope)=>{requested.push({url,scope});return {url,status:200,contentType:'text/html; charset=UTF-8',html:pages.get(url)};}});
  assert.equal(result.passed,true);
  assert.deepEqual(result.summary,{pages_attempted:3,products_extracted:3,products_accepted:3,products_rejected:0,failures:0});
  assert.deepEqual(result.accepted_products.map(row=>row.fields.name),['Alfred','Attimo','Aqualuna']);
  assert.deepEqual(result.accepted_products.map(row=>row.fields.designer),['Jean-Marie Massaud','Jean-Marie Massaud','Yabu Pushelberg']);
  assert.equal(requested.filter(item=>item.url.includes('#')).length,0);
  assert.equal(requested.every(item=>item.scope.page_quota.limit===3),true);
  assert.deepEqual(result.production_effects,{candidate_writes:0,published_products:0,source_rule_activated:false});
});

test('sandbox distinguishes no improvement from execution failure',async()=>{
  const noProduct=await executeSiteRuleSandbox(config(),{fetchHtml:async url=>({url,status:200,contentType:'text/html',html:'<html><body><h1>About</h1></body></html>'})});
  assert.equal(noProduct.outcome,'NO_IMPROVEMENT');
  const failed=await executeSiteRuleSandbox(config(),{fetchHtml:async()=>{const error=new Error('timeout');error.code='FETCH_TIMEOUT';throw error;}});
  assert.equal(failed.outcome,'EXECUTION_FAILED');
  assert.equal(failed.failures[0].error_code,'FETCH_TIMEOUT');
});

test('sandbox rejects a supposed primary image reused by different products',async()=>{
  const value=config(),urls=[value.discovery.seed_urls[0],'https://www.poliform.cn/%E4%BA%A7%E5%93%81/attimo/','https://www.poliform.cn/%E4%BA%A7%E5%93%81/aqualuna/'];
  value.discovery.seed_urls=urls;value.sandbox.max_pages=3;value.sandbox.max_products=3;
  const htmlByUrl=new Map(urls.map((url,index)=>[url,fixture(`Item${index+1}`,'Designer').replace(/https:\/\/s3\.poliform\.cn\/item\d-main\.jpg/g,'https://s3.poliform.cn/shared-banner.jpg')]));
  const result=await executeSiteRuleSandbox(value,{fetchHtml:async url=>({url,status:200,contentType:'text/html',html:htmlByUrl.get(url)})});
  assert.equal(result.passed,false);assert.equal(result.outcome,'NO_IMPROVEMENT');
  assert.ok(result.rejected_products.every(row=>row.validation_errors.includes('PRIMARY_IMAGE_REUSED_ACROSS_PRODUCTS')));
});

test('service restart marks running sandbox attempts interrupted',async()=>{
  let sql='';const db={query:async statement=>{sql=statement;return [{affectedRows:2}];}};
  const result=await createSiteRuleControl(db).recoverInterruptedRuns();
  assert.equal(result.recovered,2);assert.match(sql,/PROCESS_INTERRUPTED/);assert.match(sql,/status='running'/);
});

test('freeze requires an unchanged latest passing sandbox and explicit phrase',async()=>{
  const value=config(),hash=configHash(value),sample={source_url:value.discovery.seed_urls[0],template:{fingerprint:{hash:'abc',signature:{signals:['H1']}}}},row={id:7,source_id:3,version_number:1,status:'sandbox_passed',config:value,config_hash:hash,validation_result:{valid:true},last_sandbox_result:{passed:true,accepted_products:[sample]}};
  let committed=false,released=false;const conn={beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{},release:()=>{released=true;},query:async(sql)=>{
    if(sql.startsWith('SELECT source_id'))return [[{source_id:3}]];
    if(sql.startsWith('SELECT id FROM product_ingestion_sources'))return [[{id:3}]];
    if(sql.includes('FOR UPDATE'))return [[row]];
    if(sql.startsWith('UPDATE product_ingestion_site_rules'))return [{affectedRows:1}];
    throw new Error(`Unexpected query: ${sql}`);
  }};const db={getConnection:async()=>conn,query:async sql=>{if(sql.startsWith('SELECT * FROM product_ingestion_site_rules'))return [[{...row,status:'frozen'}]];throw new Error(`Unexpected query: ${sql}`);}};
  const control=createSiteRuleControl(db);
  await assert.rejects(()=>control.freeze(7,{},'tester'),/冻结此站点规则/);
  const result=await control.freeze(7,{confirmation:'冻结此站点规则'},'tester');
  assert.equal(result.id,7);assert.equal(committed,true);assert.equal(released,true);
});

test('failed freeze rolls back without invalidating the previously frozen rule',async()=>{
  const value=config(),sample={source_url:value.discovery.seed_urls[0],template:{fingerprint:{hash:'abc',signature:{signals:['H1']}}}},row={id:8,source_id:3,status:'sandbox_passed',config:value,config_hash:configHash(value),validation_result:{valid:true},last_sandbox_result:{passed:true,accepted_products:[sample]}};
  let rolledBack=false,invalidated=false;const conn={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{rolledBack=true;},release:()=>{},query:async sql=>{
    if(sql.startsWith('SELECT source_id'))return [[{source_id:3}]];
    if(sql.startsWith('SELECT id FROM product_ingestion_sources'))return [[{id:3}]];
    if(sql.includes('FOR UPDATE'))return [[row]];
    if(sql.includes("SET status='frozen'"))return [{affectedRows:0}];
    if(sql.includes("SET status='invalidated'")){invalidated=true;return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  await assert.rejects(()=>createSiteRuleControl({getConnection:async()=>conn}).freeze(8,{confirmation:'冻结此站点规则'},'tester'),problem=>problem.code==='SITE_RULE_STATE_CHANGED');
  assert.equal(rolledBack,true);assert.equal(invalidated,false);
});

test('template-drift freeze preserves earlier frozen templates in the same rule set',async()=>{
  const value=config(),sample={source_url:value.discovery.seed_urls[0],template:{fingerprint:{hash:'abc',signature:{h1:1,json_ld_product:true,has_main:true,heading_bucket:1}}}},row={id:18,source_id:3,status:'sandbox_passed',config:value,config_hash:configHash(value),validation_result:{valid:true},last_sandbox_result:{passed:true,accepted_products:[sample]}};
  let invalidated=false;const conn={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},query:async sql=>{
    if(sql.startsWith('SELECT source_id'))return [[{source_id:3}]];
    if(sql.startsWith('SELECT id FROM product_ingestion_sources'))return [[{id:3}]];
    if(sql.includes('FOR UPDATE'))return [[row]];
    if(sql.includes("SET status='frozen'"))return [{affectedRows:1}];
    if(sql.includes("SET status='invalidated'")){invalidated=true;return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const db={getConnection:async()=>conn,query:async sql=>sql.startsWith('SELECT * FROM product_ingestion_site_rules')?[[{...row,status:'frozen'}]]:Promise.reject(new Error(`Unexpected query: ${sql}`))};
  await createSiteRuleControl(db).freeze(18,{confirmation:'冻结此站点规则',preserve_existing_templates:true},'tester');
  assert.equal(invalidated,false);
});

test('freezing derives an auditable template binding and runtime rejects unseen structure',()=>{
  const value=config(),url=value.discovery.seed_urls[0],page={url,status:200,contentType:'text/html',html:fixture('Alfred','Designer')};
  const extracted=require('../services/product-ingestion-site-rule-sandbox').extractPage(page,value);
  const rule={id:8,source_id:3,version_number:1,status:'frozen',config:value,config_hash:configHash(value),last_sandbox_result:{accepted_products:[extracted]}};
  rule.validation_result={template_binding:templateBinding(rule)};
  assert.equal(extractProductWithSiteRule(page,rule,{brandName:'Poliform'}).payload.name,'Alfred');
  const changed={...page,html:page.html.replace('<main>','<main><h2>New section</h2><h2>Another</h2><h2>More</h2><h2>Extra</h2><h2>Changed</h2><h2>Layout</h2>')};
  assert.throws(()=>extractProductWithSiteRule(changed,rule),problem=>problem.code==='SITE_RULE_TEMPLATE_STALE');
});

test('template matching permits product-specific image counts but not navigation layout drift',()=>{
  const accepted=[{h1:1,json_ld_product:true,has_main:true,heading_bucket:2,image_bucket:4,signals:['H1','JSON_LD_PRODUCT','PRODUCT_GALLERY']}];
  assert.equal(templateSignatureCompatible({h1:1,json_ld_product:true,has_main:true,heading_bucket:2,image_bucket:2,signals:['H1','JSON_LD_PRODUCT','PRODUCT_GALLERY']},accepted),true);
  assert.equal(templateSignatureCompatible({h1:1,json_ld_product:true,has_main:true,heading_bucket:4,image_bucket:2,signals:['H1','JSON_LD_PRODUCT','PRODUCT_GALLERY']},accepted),false);
  assert.equal(templateSignatureCompatible({h1:0,json_ld_product:false,has_main:true,heading_bucket:2,image_bucket:2,signals:[]},accepted),false);
});

test('runtime selects the matching member of a multi-template frozen rule set',()=>{
  const value=config(),url=value.discovery.seed_urls[0],page={url,status:200,contentType:'text/html',html:fixture('Alfred','Designer')};
  const extracted=require('../services/product-ingestion-site-rule-sandbox').extractPage(page,value);
  const matching={id:11,source_id:3,version_number:2,status:'frozen',config:value,config_hash:configHash(value),validation_result:{template_binding:templateBinding({last_sandbox_result:{accepted_products:[extracted]}})}};
  const other=clone(matching);other.id=12;other.version_number=3;other.validation_result={template_binding:{accepted_fingerprints:['different'],accepted_signatures:[{h1:0,json_ld_product:false,has_main:false,heading_bucket:0}]}};
  const selected=extractProductWithSiteRuleSet(page,[other,matching],{brandName:'Test'});
  assert.equal(selected.rule.id,11);
  assert.equal(selected.result.payload.name,'Alfred');
  assert.throws(()=>extractProductWithSiteRuleSet(page,[other]),problem=>problem.code==='SITE_RULE_TEMPLATE_STALE'&&problem.template_failures.length===1);
});

test('admin routes expose validation, sandbox history, execution and freeze endpoints',()=>{
  const source=fs.readFileSync(require.resolve('../routes/admin-product-ingestion.routes'),'utf8');
  assert.match(source,/site-rules\/validate/);
  assert.match(source,/site-rules\/:id\/sandbox-runs/);
  assert.match(source,/site-rules\/:id\/freeze/);
});

function richConfig(){return JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','hc28-site-rule-config-v1.1.json'),'utf8'));}
function richFixture(){return `<!doctype html><html><head></head><body><main><h1 class="product-title">GENERIC</h1><div class="product-info">MODULAR SOFA 编码：GX01</div><div class="product-content">通用测试产品说明</div><div class="carousel-images"><img src="/uploads/main.jpg"><img src="/uploads/scene.jpg"></div><h3>技术参数</h3><div class="product-card product-card-bottom"><div class="product_img"><img src="https://hc28study.oss-cn-beijing.aliyuncs.com/a-dimension.png"><div class="product_spec"><p>980×980×700MM</p></div></div><div class="product_name">GX01-A</div><div class="product_series"><span>￥</span>12010.00<p>单扶手沙发</p></div></div><div class="product-card product-card-bottom"><div class="product_img"><img src="https://hc28study.oss-cn-beijing.aliyuncs.com/b-dimension.png"><div class="product_spec"><p>1200×900×700MM</p></div></div><div class="product_name">GX01-B</div><div class="product_series"><p>双扶手沙发</p></div></div></main></body></html>`;}

test('ungrounded furniture type keywords reuse the evidenced product name source',()=>{
  const extraction=richConfig().extraction;
  extraction.structured.furniture_type_rule.source={required:false,sources:[]};
  extraction.structured.furniture_type_rule.keywords.sofa=['sofa','沙发'];
  const normalized=normalizeExtractionProposal(extraction);
  assert.deepEqual(normalized.structured.furniture_type_rule.source.sources,extraction.fields.name.sources);
  assert.equal(normalized.structured.furniture_type_rule.source.required,false);
  assert.deepEqual(extraction.structured.furniture_type_rule.source.sources,[]);
});

test('extraction assembly prepends a product-name selector grounded across sampled pages',()=>{
  const extraction=richConfig().extraction,selector='div.product-name';
  const siteMap={pages:[1,2,3].map(id=>({url:`https://example.com/product/${id}`,field_contexts:[{field:'name',selector,text:`Product ${id}`}]}))};
  const normalized=normalizeExtractionProposal(extraction,siteMap,{product_detail_path_prefixes:['/product/']});
  assert.deepEqual(normalized.fields.name.sources[0],{type:'css_text',selector});
});

test('v1.1 generic executor maps repeated configurations, dimensions, image relations and Top5',()=>{
  const value=richConfig(),validation=validateSiteRule(value);assert.equal(validation.valid,true,JSON.stringify(validation));
  const page={url:value.discovery.seed_urls[0],status:200,contentType:'text/html',html:richFixture()};
  const extracted=require('../services/product-ingestion-site-rule-sandbox').extractPage(page,value);
  assert.equal(extracted.structured.configurations.length,2);
  assert.deepEqual(extracted.structured.configurations[0].dimensions,{width:980,depth:980,height:700});
  assert.equal(extracted.structured.configurations[0].asset_relations[0].role,'dimension_diagram');
  assert.equal(extracted.structured.top5.length,2);
  assert.equal(extracted.structured.furniture_type,'sofa');
  const rule={id:91,source_id:9,version_number:1,status:'frozen',config:value,config_hash:configHash(value),validation_result:{}};
  const result=extractProductWithSiteRule(page,rule,{brandName:'Test Brand'});
  assert.equal(result.payload.product_details.configurations.length,2);
  assert.equal(result.payload.product_details.configurations[0].code,'GX01-A');
  assert.equal(result.payload.product_details.configurations[0].image_urls.some(url=>url.includes('a-dimension.png')),true);
  assert.equal(result.extracted.coverage.dimensions.provided,2);
});

test('v1.1 OCR is bounded evidence fallback and never guesses when no OCR result exists',()=>{
  const value=richConfig();value.extraction.structured.configurations.dimensions.source.sources=[{type:'css_text',selector:'.missing-dimension'}];
  value.extraction.structured.ocr={enabled:true,max_images:1,roles:['dimension_diagram'],outputs:['dimensions']};
  const image='https://hc28study.oss-cn-beijing.aliyuncs.com/a-dimension.png';
  const page={url:value.discovery.seed_urls[0],status:200,contentType:'text/html',html:richFixture()};
  const without=require('../services/product-ingestion-site-rule-sandbox').extractPage(page,value);
  assert.equal(without.structured.configurations[0].dimension_status,'evidence_insufficient');
  assert.equal(without.structured.configurations[0].ocr.missing_reason,'ocr_not_executed');
  const withEvidence=require('../services/product-ingestion-site-rule-sandbox').extractPage(page,value,{ocrEvidence:{[image]:{dimensions:'W 980 D 980 H 700 mm',confidence:.99}}});
  assert.deepEqual(withEvidence.structured.configurations[0].dimensions,{width:980,depth:980,height:700});
  assert.equal(withEvidence.structured.configurations[0].ocr.results[0].confidence,.99);
});

test('dimension parser supports explicit labels, multiplication order and round products',()=>{
  assert.deepEqual(parseDimensions('W 90 D 80 H 75 cm','auto','mm').dimensions,{width:90,depth:80,height:75});
  assert.deepEqual(parseDimensions('Ø800 × H720 mm','diameter_height','mm').dimensions,{diameter:800,height:720});
  assert.deepEqual(parseDimensions('300cm/118,11’’ x 120cm/47,24’’ H 74cm/29,13’’','auto','mm').dimensions,{width:300,depth:120,height:74});
  assert.deepEqual(parseDimensions('D 150cm/59,08’’ H 74cm/29,13’’','auto','mm').dimensions,{diameter:150,height:74});
});

test('bounded OCR sends only selected image evidence and accepts strict structured output',async()=>{
  let request=null;const image='https://assets.example.test/dimension.png';
  const fetchImpl=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,status:200,text:async()=>JSON.stringify({id:'ocr-1',usage:{input_tokens:12,output_tokens:8,total_tokens:20},output:[{type:'function_call',name:'submit_image_evidence',arguments:JSON.stringify({items:[{url:image,dimensions:'W 980 D 900 H 720 mm',material:null,color:null,code:null,confidence:.98,configuration_interpretation:'single_explicit_option',configuration_proof:'explicit_size_list',configuration_options:[{label:null,dimensions:'W 980 D 900 H 720 mm',evidence_text:'W 980 D 900 H 720 mm',confidence:.98}]}]})}]})};};
  const result=await analyzeImages([image],['dimensions'],{config:{apiKey:'test',model:'vision-test',endpoint:'https://example.test/responses'},fetchImpl});
  assert.equal(request.input[0].content.filter(item=>item.type==='input_image').length,1);
  assert.equal(request.tools[0].strict,true);
  assert.equal(result.evidence[image].dimensions,'W 980 D 900 H 720 mm');
  assert.equal(result.evidence[image].configuration_interpretation,'single_explicit_option');
  assert.equal(result.usage.total_tokens,20);
});
