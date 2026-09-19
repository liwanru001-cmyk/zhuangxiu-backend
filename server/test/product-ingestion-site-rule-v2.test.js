'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {validateSiteRule}=require('../services/product-ingestion-site-rule-schema');
const {configHash}=require('../services/product-ingestion-site-rule-schema');
const {extractPage,executeSiteRuleSandbox}=require('../services/product-ingestion-site-rule-sandbox');
const {extractProductWithSiteRule}=require('../services/product-ingestion-site-rule-runtime');
const {explicitSemanticValue,assetsFromSources}=require('../services/product-ingestion-site-rule-structured');

function emptyRule(){return {required:false,sources:[]};}
function rule(){
  const value=JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','hc28-site-rule-config-v1.1.json'),'utf8'));
  value.schema_version='site-rule-config-v2';value.site_id='generic-v2-fixture';value.brand='Fixture';
  value.scope={base_url:'https://catalog.example/',allowed_page_hosts:['catalog.example'],allowed_asset_hosts:['catalog.example','assets.example'],allowed_path_prefixes:['/products/']};
  value.discovery.seed_urls=['https://catalog.example/products/a'];value.discovery.product_detail_path_prefixes=['/products/'];value.discovery.listing_path_prefixes=[];value.discovery.exclude_path_prefixes=[];
  value.template.required_signals=['H1','PRODUCT_DESCRIPTION'];
  value.extraction.fields.english_name={required:false,sources:[{type:'css_text',selector:'.english-name'}]};
  value.extraction.fields.release_date={required:false,sources:[{type:'css_text',selector:'.release-date'}]};
  value.extraction.images.sources=[{type:'dom_attribute',role:'hero',selector:'.carousel-images img',attribute:'src'}];value.extraction.images.top5_roles=['hero','product_gallery','scene','detail'];
  value.extraction.structured.configurations.fields.group={required:false,sources:[{type:'css_text',selector:'.configuration-group'}]};
  value.extraction.structured.option_groups=[{mode:'repeated',item_selector:'.option-group',max_items:20,fields:{name:{required:true,sources:[{type:'css_text',selector:'.option-group-name'}]},type:{required:false,sources:[{type:'css_text',selector:'.option-group-type'}]}},options:{mode:'repeated',item_selector:'.option',max_items:100,fields:{name:{required:false,sources:[{type:'css_text',selector:'.option-name'}]},code:{required:true,sources:[{type:'css_text',selector:'.option-code'}]},material:{required:false,sources:[{type:'css_text',selector:'.option-material'}]},color:{required:false,sources:[{type:'css_text',selector:'.option-color'}]},supplier:{required:false,sources:[{type:'css_text',selector:'.option-supplier'}]},origin:{required:false,sources:[{type:'css_text',selector:'.option-origin'}]}},swatch:{type:'dom_attribute',role:'material_swatch',selector:'img',attribute:'src'},applies_to_configuration_code:emptyRule()}}];
  value.validation.minimum_accepted_products=1;value.provenance.prompt_version='site-rule-generator-v2';
  return value;
}

function fixture(name='通用模块沙发',code='GX01-A'){
  return `<!doctype html><html><body><main><h1 class="product-title">${name}</h1><div class="english-name">GENERIC MODULAR SOFA</div><div class="product-info">SOFA 编码：GX01</div><div class="product-content">模块化产品说明</div><div class="release-date">发布日期：2024.06</div><div class="carousel-images"><img src="https://assets.example/hero.jpg"><img src="https://assets.example/gallery.jpg"></div><h3>产品款型与尺寸</h3><div class="product-card product-card-bottom"><span class="configuration-group">直排</span><div class="product_img"><img src="https://assets.example/${code}-dimension.png"><div class="product_spec"><p>2120×1050×780MM</p></div></div><div class="product_name">${code}</div><div class="product_series"><p>两人位</p></div></div><section class="option-group"><h3 class="option-group-name">色彩选择</h3><span class="option-group-type">面料颜色</span><article class="option"><img src="https://assets.example/swatch-e116.jpg"><b class="option-name">暖灰</b><span class="option-code">E116</span><span class="option-material">面料</span><span class="option-color">暖灰色</span><span class="option-supplier">Supplier A</span><span class="option-origin">中国</span></article></section></main></body></html>`;
}

test('v2 generic extraction keeps exact field states, configurations, options and asset bindings',()=>{
  const config=rule(),validation=validateSiteRule(config);assert.deepEqual(validation,{valid:true,schema_valid:true,schema_errors:[],semantic_errors:[]});
  const result=extractPage({url:config.discovery.seed_urls[0],html:fixture(),status:200,contentType:'text/html'},config),document=result.structured.product_document;
  assert.equal(result.accepted,true,JSON.stringify(result.validation_errors));assert.equal(document.schema_version,2);assert.equal(document.data.product.names.primary,'通用模块沙发');assert.equal(document.data.product.names.en,'GENERIC MODULAR SOFA');assert.equal(document.field_status['/product/release_date/value'].status,'provided');
  assert.equal(document.data.configurations.length,1);assert.equal(document.data.configurations[0].code,'GX01-A');assert.equal(document.data.configurations[0].dimensions[0].values.width,2120);
  assert.equal(document.data.option_groups.length,1);assert.equal(document.data.option_groups[0].options[0].code,'E116');assert.equal(document.data.option_groups[0].options[0].material,'面料');
  const dimension=document.data.assets.find(item=>item.role==='dimension_diagram'),swatch=document.data.assets.find(item=>item.role==='material_swatch');
  assert.ok(dimension.bindings.some(item=>item.target_type==='configuration'));assert.ok(swatch.bindings.some(item=>item.target_type==='option'));
  assert.equal(document.data.assets.filter(item=>item.role==='hero').length,1);assert.equal(document.data.assets.find(item=>item.url.endsWith('/gallery.jpg')).role,'product_gallery');
  assert.doesNotMatch(JSON.stringify(document),/标准款|其他家具|整体/);
});

test('v2 sandbox rejects missing extraction when the page contains configuration evidence',async()=>{
  const config=rule();config.extraction.structured.configurations.item_selector='.selector-that-does-not-exist';
  const result=await executeSiteRuleSandbox(config,{fetchHtml:async url=>({url,html:fixture(),status:200,contentType:'text/html'})});
  assert.equal(result.passed,false);assert.ok(result.rejected_products[0].validation_errors.some(item=>item.includes('CONFIGURATIONS_MISSING')));
  assert.equal(result.site_validation.products_seen,1);assert.equal(result.site_validation.products_failed,1);assert.equal(result.site_validation.exceptions.length,1);
});

test('v2 structured rules stay optional when a product page has no configuration or option evidence',()=>{
  const config=rule();
  const html='<main><h1 class="product-title">Independent chair</h1><div class="product-content">A compact lounge chair with a soft silhouette.</div><div class="carousel-images"><img src="https://assets.example/chair.jpg"></div></main>';
  const result=extractPage({url:config.discovery.seed_urls[0],html,status:200,contentType:'text/html'},config);
  assert.equal(result.accepted,true,JSON.stringify(result.validation_errors));
  assert.deepEqual(result.structured.product_document.data.configurations,[]);
  assert.deepEqual(result.structured.product_document.data.option_groups,[]);
});

test('product-level size options do not fabricate missing per-configuration dimensions',()=>{
  const config=rule();config.extraction.structured.configurations.dimensions.source={required:false,sources:[]};
  const html=fixture().replace('</main>','<section><h3>尺寸选择</h3><div>1.5m*2.0m</div></section></main>');
  const result=extractPage({url:config.discovery.seed_urls[0],html,status:200,contentType:'text/html'},config),document=result.structured.product_document;
  assert.equal(document.data.configurations[0].dimensions.length,0);
  assert.equal(document.field_status[`/configurations/${document.data.configurations[0].id}/dimensions`].status,'source_absent');
  assert.ok(!result.validation_errors.some(item=>item.includes('/dimensions')));
});

test('v2 emits no default configuration when no routable configuration slice exists',()=>{
  const config=rule(),configuration=config.extraction.structured.configurations;
  configuration.mode='none';configuration.item_selector=null;configuration.max_items=0;config.extraction.structured.option_groups=[];
  const html='<main><h1 class="product-title">Independent chair</h1><div class="product-content">Materials and configuration information are available in a separate official document.</div><div class="carousel-images"><img src="https://assets.example/chair.jpg"></div></main>';
  const result=extractPage({url:config.discovery.seed_urls[0],html,status:200,contentType:'text/html'},config);
  assert.equal(validateSiteRule(config).valid,true);assert.equal(result.accepted,true,JSON.stringify(result.validation_errors));assert.deepEqual(result.structured.product_document.data.configurations,[]);assert.deepEqual(result.structured.product_document.data.option_groups,[]);
});

test('explicit independent dimension options create generic configurations and shared bindings',()=>{
  const config=rule(),configuration=config.extraction.structured.configurations;
  configuration.mode='none';configuration.item_selector=null;configuration.max_items=0;config.extraction.structured.option_groups=[];
  config.extraction.images.sources=[
    {type:'dom_attribute',role:'hero',selector:'.hero',attribute:'src'},
    {type:'dom_attribute',role:'dimension_diagram',selector:'.dimensions',attribute:'src'},
  ];
  config.extraction.structured.ocr={enabled:true,max_images:1,roles:['dimension_diagram'],outputs:['dimensions']};
  const diagram='https://assets.example/dimensions.jpg',html=`<main><h1 class="product-title">Table</h1><div class="product-content">Product description</div><img class="hero" src="https://assets.example/hero.jpg"><img class="dimensions" src="${diagram}"></main>`;
  const ocrEvidence={[diagram]:{dimensions:'Ø120 H39 cm; 120×150 H39 cm',confidence:.98,configuration_interpretation:'multiple_explicit_options',configuration_proof:'explicit_size_list',configuration_options:[{label:null,dimensions:'Ø120 H39 cm',evidence_text:'Ø120 H39 cm',confidence:.98},{label:null,dimensions:'120×150 H39 cm',evidence_text:'120×150 H39 cm',confidence:.97}],prompt_version:'test',response_id:'ocr-test'}};
  const result=extractPage({url:config.discovery.seed_urls[0],html,status:200,contentType:'text/html'},config,{ocrEvidence}),document=result.structured.product_document;
  assert.equal(result.accepted,true,JSON.stringify(result.validation_errors));
  assert.deepEqual(document.data.configurations.map(item=>item.name),['规格 A','规格 B']);
  assert.equal(document.field_status[`/configurations/${document.data.configurations[0].id}/name`].status,'inferred');
  const asset=document.data.assets.find(item=>item.role==='dimension_diagram');
  assert.equal(asset.bindings.filter(item=>item.target_type==='configuration').length,2);
});

test('ambiguous dimension views stay product-bound and enter human confirmation without fabricated configurations',()=>{
  const config=rule(),configuration=config.extraction.structured.configurations;
  configuration.mode='none';configuration.item_selector=null;configuration.max_items=0;config.extraction.structured.option_groups=[];
  config.extraction.images.sources=[
    {type:'dom_attribute',role:'hero',selector:'.hero',attribute:'src'},
    {type:'dom_attribute',role:'dimension_diagram',selector:'.dimensions',attribute:'src'},
  ];
  config.extraction.structured.ocr={enabled:true,max_images:1,roles:['dimension_diagram'],outputs:['dimensions']};
  const diagram='https://assets.example/ambiguous.jpg',html=`<main><h1 class="product-title">Chair</h1><div class="product-content">Product description</div><img class="hero" src="https://assets.example/hero.jpg"><img class="dimensions" src="${diagram}"></main>`;
  const ocrEvidence={[diagram]:{dimensions:'W80 D90 H75 cm',confidence:.85,configuration_interpretation:'ambiguous_views_or_options',configuration_proof:'none',configuration_options:[],prompt_version:'test',response_id:'ocr-test'}};
  const result=extractPage({url:config.discovery.seed_urls[0],html,status:200,contentType:'text/html'},config,{ocrEvidence}),document=result.structured.product_document;
  assert.equal(result.accepted,true,JSON.stringify(result.validation_errors));
  assert.deepEqual(document.data.configurations,[]);
  const asset=document.data.assets.find(item=>item.role==='dimension_diagram');
  assert.ok(asset.bindings.some(item=>item.target_type==='product'));
  assert.ok(document.issues.some(item=>item.target_id===asset.id&&item.issue_type==='ambiguous'&&item.action==='bind'));
});

test('v2 permits a bounded 200 configurations for public catalogs without changing Product Schema v2',()=>{
  const config=rule();config.extraction.structured.configurations.max_items=200;
  assert.equal(validateSiteRule(config).valid,true);
  config.extraction.structured.configurations.max_items=201;
  assert.equal(validateSiteRule(config).schema_valid,false);
});

test('frozen v2 runtime persists Product Schema v2 as the canonical payload',()=>{
  const config=rule(),page={url:config.discovery.seed_urls[0],html:fixture(),status:200,contentType:'text/html'};
  const result=extractProductWithSiteRule(page,{id:9,version_number:2,status:'frozen',config,config_hash:configHash(config),validation_result:{template_binding:{accepted_signatures:[]}}},{brandName:'Fixture',productType:'furniture',productTypeConfidence:.91,productTypeMethod:'semantic_classifier'});
  assert.equal(result.payload.product_schema_version,2);assert.equal(result.payload.product_document.schema_version,2);assert.equal('product_details' in result.payload,false);
  assert.equal(result.payload.product_document.data.product.product_type,'furniture');assert.equal(result.payload.product_document.field_status['/product/product_type'].status,'inferred');assert.equal(result.payload.product_document.evidence['/product/product_type'][0].section,'classification:semantic_classifier');
});

test('generic semantic fallback reads explicit designer evidence but ignores prose using the word design',()=>{
  assert.equal(explicitSemanticValue('1991 年 由 Poliform 研发部门设计','designer').value,'Poliform 研发部门');
  assert.equal(explicitSemanticValue('产品由研发部门不断调整细节，以适应最新设计需求','designer'),null);
});

test('empty structured image values never resolve to the current product page URL',()=>{
  const cheerio=require('cheerio'),$=cheerio.load('<main><h1>Quincy</h1></main>');
  const assets=assetsFromSources(
    [{type:'json_ld_product',path:'image',role:'hero'},{type:'meta',property:'og:image',role:'hero'}],
    {$,root:$.root(),product:{},baseUrl:'https://www.flexform.it/zh-hans/chanpin/quincy'},
    new Set(['www.flexform.it']),
  );
  assert.deepEqual(assets,[]);
});

test('embedded JSON enriches product copy, images and official attachments',()=>{
  const config=rule();
  config.extraction.fields.technical_specifications={required:false,sources:[{type:'embedded_json_text',selector:'#__NEXT_DATA__',json_path:'product.technical[*]',strip_html:true,join_with:'\n'}]};
  config.extraction.images.sources=[{type:'embedded_json',role:'hero',selector:'#__NEXT_DATA__',json_path:'product.images[*].url'}];
  config.extraction.attachments.link_sources=[{type:'embedded_json',selector:'#__NEXT_DATA__',attribute:'text',json_path:'product.documents[*].url',kind:'technical'}];
  config.extraction.attachments.allowed_extensions=['pdf'];
  const data={product:{technical:['<p>Structure: metal</p>','Removable fabric cover'],images:[{url:'https://assets.example/one.jpg'},{url:'https://assets.example/two.jpg'}],documents:[{url:'https://assets.example/spec.pdf'}]}};
  const html=fixture().replace('</head>','').replace('<html><body>',`<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></head><body>`);
  const result=extractPage({url:config.discovery.seed_urls[0],html,status:200,contentType:'text/html'},config),document=result.structured.product_document;
  assert.equal(validateSiteRule(config).valid,true);
  assert.equal(document.data.product.technical_specifications,'Structure: metal Removable fabric cover');
  assert.ok(document.data.assets.some(item=>item.url==='https://assets.example/one.jpg'));
  assert.ok(document.data.assets.some(item=>item.url==='https://assets.example/two.jpg'));
  assert.ok(document.data.assets.some(item=>item.media_type==='pdf'&&item.role==='technical_document'));
});

test('indexed field sources pair parallel labels with configuration and option images',()=>{
  const config=rule(),configuration=config.extraction.structured.configurations;
  configuration.item_selector='.variant-image';configuration.fields.name={required:true,sources:[{type:'indexed_css_text',selector:'.variant-label'}]};configuration.fields.code=emptyRule();configuration.dimensions.source=emptyRule();configuration.images=[{type:'dom_attribute',role:'configuration_image',selector:'img',attribute:'src'}];
  config.extraction.structured.option_groups=[{mode:'single',item_selector:null,max_items:1,fields:{name:{required:true,sources:[{type:'css_text',selector:'.color-title'}]},type:{required:false,sources:[{type:'css_text',selector:'.color-title'}]}},options:{mode:'repeated',item_selector:'.color-image',max_items:10,fields:{name:{required:true,sources:[{type:'indexed_css_text',selector:'.color-label'}]},code:emptyRule(),material:emptyRule(),color:{required:false,sources:[{type:'indexed_css_text',selector:'.color-label'}]},supplier:emptyRule(),origin:emptyRule()},swatch:{type:'dom_attribute',role:'material_swatch',selector:'img',attribute:'src'},applies_to_configuration_code:emptyRule()}}];
  const extra='<div class="variant-label">Two seat</div><div class="variant-label">Three seat</div><div class="variant-image"><img src="https://assets.example/two-seat.jpg"></div><div class="variant-image"><img src="https://assets.example/three-seat.jpg"></div><h3 class="color-title">Color options</h3><span class="color-label">Warm grey</span><span class="color-label">Blue</span><div class="color-image"><img src="https://assets.example/grey.jpg"></div><div class="color-image"><img src="https://assets.example/blue.jpg"></div>';
  const result=extractPage({url:config.discovery.seed_urls[0],html:fixture().replace('</main>',`${extra}</main>`),status:200,contentType:'text/html'},config),document=result.structured.product_document;
  assert.equal(result.accepted,true,JSON.stringify(result.validation_errors));
  assert.deepEqual(document.data.configurations.map(item=>item.name),['Two seat','Three seat']);
  assert.deepEqual(document.data.option_groups[0].options.map(item=>item.name),['Warm grey','Blue']);
  assert.ok(document.data.configurations.every(item=>item.asset_ids.length===1));
  assert.ok(document.data.option_groups[0].options.every(item=>item.asset_ids.length===1));
});

test('v2 site rules may classify evidence-backed accessory categories as other',()=>{
  const config=rule();
  config.extraction.structured.furniture_type_rule.source={required:true,sources:[{type:'css_text',selector:'.product-category'}]};
  config.extraction.structured.furniture_type_rule.keywords.other=['配件'];
  const html=fixture().replace('<div class="product-info">','<div class="product-category">配件</div><div class="product-info">');
  const result=extractPage({url:config.discovery.seed_urls[0],html,status:200,contentType:'text/html'},config);
  assert.equal(validateSiteRule(config).valid,true);
  assert.equal(result.accepted,true,JSON.stringify(result.validation_errors));
  assert.equal(result.structured.product_document.data.product.product_type,'other');
});

function scopedRule(host,pathName='/products/item'){
  const value=rule(),url=`https://${host}${pathName}`;value.site_id=`golden-${host.replace(/[^a-z0-9]+/g,'-')}`.slice(0,70);value.brand='Golden fixture';value.scope={base_url:`https://${host}/`,allowed_page_hosts:[host],allowed_asset_hosts:[host],allowed_path_prefixes:['/']};value.discovery.seed_urls=[url];value.discovery.product_detail_path_prefixes=['/'];return value;
}
function singleProductRule(host){
  const value=scopedRule(host);value.extraction.fields.name={required:true,sources:[{type:'css_text',selector:'h1'}]};value.extraction.fields.description={required:true,sources:[{type:'css_text',selector:'.description'}]};value.extraction.fields.english_name=emptyRule();value.extraction.fields.release_date=emptyRule();value.extraction.images.sources=[{type:'dom_attribute',role:'hero',selector:'.product-gallery img',attribute:'src'}];
  const configurations=value.extraction.structured.configurations;configurations.mode='single';configurations.item_selector=null;configurations.fields={group:emptyRule(),name:emptyRule(),code:emptyRule(),includes:emptyRule(),price:emptyRule()};configurations.dimensions.source=emptyRule();configurations.images=[];value.extraction.structured.option_groups=[];value.extraction.structured.furniture_type_rule.source={required:false,sources:[{type:'css_text',selector:'h1'}]};return value;
}

test('site-level Golden Set covers Banlan, HC28, Poliform and Fendi page structures without runtime brand branches',()=>{
  const hc=rule(),banlan=scopedRule('banlan.example','/product/show/id/267'),poliform=singleProductRule('poliform.example'),fendi=singleProductRule('fendi.example');
  banlan.extraction.fields.name={required:true,sources:[{type:'css_text',selector:'.product-name'}]};banlan.extraction.fields.description={required:true,sources:[{type:'css_text',selector:'.intro'}]};banlan.extraction.fields.english_name={required:false,sources:[{type:'css_text',selector:'.product-en'}]};banlan.extraction.images.sources=[{type:'dom_attribute',role:'hero',selector:'.hero img',attribute:'src'}];const bc=banlan.extraction.structured.configurations;bc.item_selector='.variant';bc.fields={group:emptyRule(),name:{required:true,sources:[{type:'css_text',selector:'.variant-name'}]},code:{required:true,sources:[{type:'css_text',selector:'.variant-code'}]},includes:emptyRule(),price:emptyRule()};bc.dimensions.source={required:true,sources:[{type:'css_text',selector:'.variant-size'}]};bc.images=[];banlan.extraction.structured.option_groups=[];banlan.extraction.structured.furniture_type_rule.source={required:false,sources:[{type:'css_text',selector:'.product-name'}]};
  fendi.extraction.attachments.link_sources=[{selector:'.downloads a',attribute:'href',kind:'catalog'}];
  const samples=[
    {site:'HC28',config:hc,html:fixture(),expectedConfigurations:1},
    {site:'Banlan',config:banlan,html:'<main><h1 class="product-name">云杉沙发</h1><div class="product-en">YUN SHAN SOFA</div><p class="intro">模块化沙发产品说明</p><div class="hero"><img src="https://banlan.example/hero.jpg"></div><h2>产品款型</h2><div class="variant"><b class="variant-name">两人位</b><span class="variant-code">YS-001</span><span class="variant-size">2120×1050×780MM</span></div></main>',expectedConfigurations:1},
    {site:'Poliform',config:poliform,html:'<main><h1>扶手椅</h1><p class="description">产品说明文字</p><div class="product-gallery"><img src="https://poliform.example/chair.jpg"></div></main>',expectedConfigurations:0},
    {site:'Fendi',config:fendi,html:'<main><h1>设计桌</h1><p class="description">产品说明文字</p><div class="product-gallery"><img src="https://fendi.example/table.jpg"></div><div class="downloads"><a href="https://fendi.example/catalog.pdf">Catalog</a></div></main>',expectedConfigurations:0,expectedRole:'catalog'},
  ];
  for(const sample of samples){const validation=validateSiteRule(sample.config);assert.equal(validation.valid,true,`${sample.site}: ${JSON.stringify(validation)}`);const result=extractPage({url:sample.config.discovery.seed_urls[0],html:sample.html,status:200,contentType:'text/html'},sample.config);assert.equal(result.accepted,true,`${sample.site}: ${JSON.stringify(result.validation_errors)}`);assert.equal(result.structured.product_document.data.configurations.length,sample.expectedConfigurations,sample.site);if(sample.expectedRole)assert.ok(result.structured.product_document.data.assets.some(item=>item.role===sample.expectedRole),sample.site);assert.doesNotMatch(JSON.stringify(result.structured.product_document),/标准款|其他家具|整体/);}
});
