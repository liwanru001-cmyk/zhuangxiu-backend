'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedAddress } = require('../services/product-ingestion-fetch');
const { normalizeProductNode, extractProduct, classifyProduct } = require('../services/product-ingestion-extractor');
const { createRunner, frozenDiscoveryMustStop, preferredContentUrl, fetchPreferredHtml } = require('../services/product-ingestion-runner');
const { discoverProducts, hrefs, pageIsProduct, pageObstacle, fetchFailure } = require('../services/product-ingestion-discovery');

test('network guard blocks local, private, link-local and reserved addresses', () => {
  for (const address of ['127.0.0.1','10.0.0.8','172.16.2.3','192.168.1.9','169.254.1.1','100.64.0.1','::1','fc00::1','fe80::1','2001:db8::1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isBlockedAddress(address), false, address);
});

test('frozen discovery blocks sample replay but permits useful partial coverage',()=>{
  assert.equal(frozenDiscoveryMustStop({discovery_coverage:{status:'sample_only'}}),true);
  assert.equal(frozenDiscoveryMustStop({discovery_coverage:{status:'partial'}}),false);
  assert.equal(frozenDiscoveryMustStop({discovery_coverage:{status:'complete'}}),false);
});

test('single unnamed JSON-LD configuration reuses the evidenced product name', () => {
  const result = normalizeProductNode({ '@type':'Product', name:'休闲椅', sku:'CHAIR-01', brand:{name:'示例品牌'}, material:'实木', color:'胡桃木色' }, 'furniture', 'https://www.example.com/products/chair');
  assert.equal(result.payload.product_details.configurations[0].name, '休闲椅');
  assert.equal(result.payload.product_details.configurations[0].parts[0].material, '实木');
  assert.equal(result.generatedFields[0].rule, 'single_configuration_uses_official_product_name');
});

test('all five supported product types produce data accepted by the existing V1 validator', () => {
  for (const type of ['furniture','curtains','rugs','artwork','accessories']) {
    const result = normalizeProductNode({ '@type':'Product', name:`测试${type}`, sku:`SKU-${type}` }, type, `https://www.example.com/products/${type}`);
    assert.equal(result.payload.product_type, type);
    assert.equal(result.payload.product_details.schema_version, 1);
  }
});

test('product classification is inferred from each product page instead of source configuration', () => {
  const rug='<script type="application/ld+json">{"@type":"Product","name":"手工羊毛地毯","description":"适合客厅"}</script>';
  const chair='<script type="application/ld+json">{"@type":"Product","name":"Oak Lounge Chair","description":"Solid wood"}</script>';
  assert.equal(classifyProduct(rug,'generic_jsonld_v1','https://example.com/products/123').product_type,'rugs');
  assert.equal(classifyProduct(chair,'generic_jsonld_v1','https://example.com/products/456').product_type,'furniture');
  assert.equal(classifyProduct('<html><title>Unknown product</title></html>','generic_jsonld_v1','https://example.com/p/1').product_type,null);
});

test('mixed furniture-brand catalogs classify furniture, rugs and decor from product identity',()=>{
  const classify=(name,url)=>classifyProduct(`<script type="application/ld+json">{"@type":"Product","name":${JSON.stringify(name)}}</script>`,'universal_web_v1',url);
  assert.equal(classify('Later, chaise-longue','https://example.com/products/later-chaise-longue').product_type,'furniture');
  assert.equal(classify('B Buckle, carpet','https://example.com/products/b-buckle-carpet').product_type,'rugs');
  assert.equal(classify('Bells, suspension lamp','https://example.com/products/bells-suspension-lamp').product_type,'accessories');
  assert.equal(classify('Bajadera, blanket','https://example.com/products/bajadera-blanket').product_type,'accessories');
  assert.equal(classify('Dame, table lamp','https://example.com/products/dame-table-lamp').product_type,'accessories');
});

test('generic extractor accepts one product detail and refuses ambiguous product listings', () => {
  const one = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"边几","sku":"T-01"}</script>';
  assert.equal(extractProduct(one, 'furniture', 'https://www.example.com/products/table').payload.name, '边几');
  const many = '<script type="application/ld+json">[{"@type":"Product","name":"产品一"},{"@type":"Product","name":"产品二"}]</script>';
  assert.throws(() => extractProduct(many, 'furniture', 'https://www.example.com/products/list'), /多个独立产品/);
});

test('universal parser falls back to visible DOM and metadata when JSON-LD is absent', () => {
  const html='<html><head><meta property="og:title" content="Oak Lounge Chair"><meta property="og:image" content="https://cdn.example/chair.jpg"><meta name="description" content="Solid oak chair"></head><body><h1>Oak Lounge Chair</h1><p>Model: C-01</p></body></html>';
  const result=extractProduct(html,'furniture','https://example.com/products/oak-chair');
  assert.equal(result.payload.name,'Oak Lounge Chair');
  assert.equal(result.payload.cover_url,'https://cdn.example/chair.jpg');
  assert.equal(result.extracted.extraction_method,'generic_dom_fallback_v2');
});

test('generic DOM extraction maps public key-value facts without a site adapter', () => {
  const html='<html><head><meta property="og:title" content="Oak Chair"></head><body><h1>Oak Chair</h1><dl><dt>Material</dt><dd>Oak</dd><dt>Color</dt><dd>Walnut</dd><dt>Width</dt><dd>80 cm</dd><dt>Height</dt><dd>95 cm</dd></dl><p>RMB 3,200</p></body></html>';
  const result=extractProduct(html,'furniture','https://example.com/product/show/id/8');
  const configuration=result.payload.product_details.configurations[0];
  assert.equal(configuration.parts[0].material,'Oak');
  assert.equal(configuration.parts[0].color,'Walnut');
  assert.equal(configuration.dimensions.width,80);
  assert.equal(configuration.dimensions.height,95);
  assert.equal(configuration.price,3200);
});

test('product image recognizer supplements incomplete JSON-LD from the bounded product gallery',()=>{
  const gallery=Array.from({length:7},(_,index)=>`<li class="product__media-item slider__slide"><img src="https://cdn.example.com/marrakech-${index+1}.jpg" alt="Marrakech coffee table"></li>`).join('');
  const html=`<html><head><script type="application/ld+json">{"@type":"Product","name":"Marrakech coffee table","image":"https://cdn.example.com/marrakech-1.jpg"}</script></head><body><main><h1>Marrakech coffee table</h1><ul class="product__media-list slider">${gallery}</ul></main><footer><div class="newsletter"><img src="https://cdn.example.com/newsletter.jpg"></div></footer></body></html>`;
  const result=extractProduct(html,'furniture','https://www.example.com/products/marrakech-coffee-table');
  assert.deepEqual(result.payload.product_details.configurations[0].image_urls,Array.from({length:5},(_,index)=>`https://cdn.example.com/marrakech-${index+1}.jpg`));
  assert.equal(result.extracted.image_recognition.strategy,'identity_bounded_product_gallery');
  assert.equal(result.extracted.image_recognition.decisions.find(item=>item.url.endsWith('/newsletter.jpg')).selected,false);
});

test('product image recognizer excludes recommendation and specification regions outside the primary gallery',()=>{
  const html=`<html><head><meta property="og:title" content="MEMORY chair"></head><body><main><section class="product-section"><div class="carousel"><div class="carousel-images"><img src="/uploads/memory-front.jpg"><img src="/uploads/memory-side.jpg"></div></div><div class="product-info"><h1>MEMORY chair</h1></div></section><section class="product-grid product-grid-spec"><img src="https://cdn.example.com/spec-front.png"><img src="https://cdn.example.com/spec-side.png"></section><section class="product-grid recommendations"><a class="product-card" href="/hc28/detail/id/12"><img src="/uploads/other-product.jpg"></a></section></main></body></html>`;
  const result=extractProduct(html,'furniture','https://www.example.com/hc28/detail/id/153');
  assert.deepEqual(result.payload.product_details.configurations[0].image_urls,['https://www.example.com/uploads/memory-front.jpg','https://www.example.com/uploads/memory-side.jpg']);
  const audit=result.extracted.image_recognition.decisions;
  assert.equal(audit.find(item=>item.url.endsWith('/spec-front.png')).reasons.includes('outside_product_regions'),true);
  assert.equal(audit.find(item=>item.url.endsWith('/other-product.jpg')).reasons.includes('links_to_other_product'),true);
});

test('product image recognizer keeps the HC28 hero before images from a separate product carousel',()=>{
  const lowerGallery=Array.from({length:8},(_,index)=>`<div class="irregular-carousel-item"><img src="/uploads/20250721/harley-scene-${index+1}.jpg"></div>`).join('');
  const html=`<html><head><meta property="og:title" content="HARLEY 哈利"></head><body><main><section class="product-section"><div class="carousel"><div class="carousel-images carousel-images-padding"><img src="/uploads/20250714/harley-main.jpg" alt="HARLEY 哈利"></div></div><div class="product-info"><h1>HARLEY 哈利</h1><p>L164</p></div></section><section class="irregular-carousel">${lowerGallery}<button>查看更多</button></section><section class="product-grid product-grid-spec"><img src="/RJFile/Model/harley-front.png"><img src="/RJFile/Model/harley-side.png"></section></main></body></html>`;
  const result=extractProduct(html,'furniture','https://www.hc28maison.com/hc28/detail/id/317',{image_exclude_tokens:['/RJFile/Model/']});
  assert.deepEqual(result.payload.product_details.configurations[0].image_urls,[
    'https://www.hc28maison.com/uploads/20250714/harley-main.jpg',
    ...Array.from({length:4},(_,index)=>`https://www.hc28maison.com/uploads/20250721/harley-scene-${index+1}.jpg`),
  ]);
  assert.equal(result.extracted.image_recognition.strategy,'merged_product_regions');
  assert.equal(result.extracted.image_recognition.decisions.find(item=>item.url.endsWith('/harley-main.jpg')).selected,true);
  assert.equal(result.extracted.image_recognition.decisions.find(item=>item.url.endsWith('/harley-front.png')).selected,false);
});

test('product image recognizer binds a Banlan gallery to the current product and rejects a repeated service carousel',()=>{
  const current=Array.from({length:5},(_,index)=>`<div class="swiper-slide"><img src="/Upload/photos/current-${index+1}.jpg"></div>`).join('');
  const shared=Array.from({length:3},(_,index)=>`<div class="swiper-slide"><img src="/Upload/goods/shared-${index+1}.png"></div>`).join('');
  const html=`<html><head><title>锦盒抽屉柜-Banlan | 班兰家具</title></head><body><header><img src="/public/static/images/logo.png"></header><div class="pro_info_1"><div class="pro_info_1_mid"><div class="swiper-container swiper-container-banner2s"><div class="swiper-wrapper">${current}</div></div><div class="product-copy">锦盒抽屉柜</div></div></div><div class="pro_info_4"><div><div><div class="service"><div class="swiper-container swiper-container-bannerp"><div class="swiper-wrapper">${shared}</div></div></div></div></div><div>锦盒抽屉柜</div></div></body></html>`;
  const siteProfile={name_sources:['title'],image_prefer_tokens:['/Upload/goods/'],image_exclude_tokens:['/public/static/images/','/Upload/photos/'],runtime_common_image_keys:Array.from({length:3},(_,index)=>`https://banlan.com.cn/Upload/goods/shared-${index+1}.png`)};
  const result=extractProduct(html,'furniture','https://banlan.com.cn/product/show/id/359',siteProfile);
  assert.deepEqual(result.payload.product_details.configurations[0].image_urls,Array.from({length:5},(_,index)=>`https://banlan.com.cn/Upload/photos/current-${index+1}.jpg`));
  assert.equal(result.extracted.image_recognition.strategy,'identity_bounded_product_gallery');
  assert.equal(result.extracted.image_recognition.decisions.find(item=>item.url.endsWith('/current-1.jpg')).reasons.includes('site_url_hint_overridden_by_product_region'),true);
  assert.equal(result.extracted.image_recognition.decisions.find(item=>item.url.endsWith('/shared-1.png')).reasons.includes('repeated_across_product_pages'),true);
  assert.equal(result.extracted.image_recognition.decisions.find(item=>item.url.endsWith('/logo.png')).selected,false);
});

test('product image recognizer keeps a simple main product image when no gallery widget exists',()=>{
  const html='<html><head><meta property="og:title" content="Oak chair"></head><body><main><section><h1>Oak chair</h1><img src="/images/oak-chair.jpg" alt="Oak chair front"></section><section class="recommendations"><a href="/products/other-chair"><img src="/images/other-chair.jpg"></a></section></main></body></html>';
  const result=extractProduct(html,'furniture','https://example.com/products/oak-chair');
  assert.deepEqual(result.payload.product_details.configurations[0].image_urls,['https://example.com/images/oak-chair.jpg']);
});

test('multiple variants need source facts that distinguish every configuration', () => {
  assert.throws(() => normalizeProductNode({ '@type':'ProductGroup', name:'模块沙发', hasVariant:[{'@type':'Product',sku:'A'},{'@type':'Product',sku:'B'}] }, 'furniture', 'https://www.example.com/products/sofa'), /缺少可区分名称/);
});

test('worker makes no request after a queued job is cancelled before claim', async () => {
  const queries = [];
  const db = { query: async (sql) => {
    queries.push(sql);
    if (sql.startsWith('SELECT job.*')) return [[{
      id:12, source_id:4, status:'queued', scope_snapshot:{
        adapter_key:'generic_jsonld_v1', product_type:'furniture', seed_urls:['https://www.example.com/products/chair'],
        allowed_hosts:['www.example.com'], allowed_path_prefixes:['/products/'], max_pages:1, max_products:1, request_interval_ms:1000,
      }, source_status:'active',
    }]];
    if (sql.includes("SET status='running'")) return [{ affectedRows:0 }];
    throw new Error(`Worker continued after cancellation: ${sql}`);
  } };
  await createRunner(db).run(12);
  assert.equal(queries.length, 2);
});

test('extraction resume re-enters full crawl workflow before processing frozen-rule pages', async () => {
  const transitions=[];
  const job={
    id:32,source_id:4,status:'queued',source_status:'active',frozen_site_rule_id:9,
    scope_snapshot:{
      adapter_key:'universal_web_v1',product_type:'furniture',seed_urls:[],allowed_hosts:['example.com'],
      allowed_path_prefixes:['/'],max_pages:1,max_products:1,request_interval_ms:1000,site_rule_ids:[9],
    },
  };
  const db={query:async sql=>{
    if(sql.startsWith('SELECT job.*'))return [[job]];
    if(sql.includes("SET status='running'"))return [{affectedRows:1}];
    if(sql.startsWith('SELECT source_url,extracted_payload'))return [[]];
    if(sql.startsWith('SELECT COUNT(*) candidates'))return [[{candidates:0,accepted:0,rejected:0}]];
    if(sql.startsWith('SELECT source_url,normalized_payload'))return [[]];
    if(sql.includes('SET status=?'))return [{affectedRows:1}];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const runner=createRunner(db,{
    globalSlots:{acquire:async()=>({release:async()=>{}})},
    loadFrozenSiteRules:async()=>[{id:9,version_number:1,config:{}}],
    onFullCrawlStarted:async id=>transitions.push(['started',id]),
    onFullCrawlFinished:async(id,outcome)=>transitions.push(['finished',id,outcome]),
  });
  await runner.run(32);
  assert.deepEqual(transitions,[['started',32],['finished',32,'success']]);
});

test('extraction resume restores page progress from the durable checkpoint',()=>{
  const source=require('fs').readFileSync(require.resolve('../services/product-ingestion-runner'),'utf8');
  assert.match(source,/let pages=checkpoint,/);
  assert.doesNotMatch(source,/let pages=checkpoint\?Number\(job\.pages_fetched/);
  assert.match(source,/Frozen-rule retries upsert the same URL/);
});

test('automatic collection continues from discovery to candidate ingestion without scope confirmation', async () => {
  let state='discovery_approved',scope={adapter_key:'universal_web_v1',job_mode:'brand_scan',source_id:4,brand_name:'Example',base_url:'https://example.com/',seed_urls:['https://example.com/'],allowed_hosts:['example.com'],allowed_path_prefixes:['/'],max_pages:5,max_products:5,request_interval_ms:1000,manual_review_required:true};
  let complete;const completed=new Promise(resolve=>{complete=resolve;});
  const db={query:async(sql,params=[])=>{
    if(sql.startsWith('SELECT job.*'))return [[{id:77,source_id:4,status:state,scope_snapshot:scope,source_status:'active',allowed_asset_hosts:'[]'}]];
    if(sql.includes("SET status='discovering'")){state='discovering';return [{affectedRows:1}];}
    if(sql.startsWith('DELETE FROM product_ingestion_discovered_product_categories'))return [{affectedRows:0}];
    if(sql.includes("SET status='queued'")){state='queued';scope=JSON.parse(params[0]);return [{affectedRows:1}];}
    if(sql.includes("SET status='running'")){state='running';return [{affectedRows:1}];}
    if(sql.includes("SET current_stage='extraction'"))return [{affectedRows:1}];
    if(sql.startsWith('INSERT INTO product_ingestion_candidates'))return [{insertId:91}];
    if(sql.startsWith('SELECT id FROM product_ingestion_candidates'))return [[{id:91}]];
    if(sql.startsWith('DELETE FROM product_ingestion_candidate_categories'))return [{affectedRows:0}];
    if(sql.startsWith('INSERT INTO product_ingestion_candidate_categories'))return [{affectedRows:1}];
    if(sql.includes('SET pages_fetched=?'))return [{affectedRows:1}];
    if(sql.includes("SET status='completed'")){state='completed';complete();return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const html='<script type="application/ld+json">{"@type":"Product","name":"Oak Chair","sku":"C-1"}</script>';
  const runner=createRunner(db,{fetchHtml:async url=>({url,status:200,contentType:'text/html',html}),discoverProducts:async()=>({urls:['https://example.com/products/chair'],records:[{url:'https://example.com/products/chair',source_categories:[],detection:{score:100,evidence:['schema_org_product'],origin:'sitemap'}}],summary:{message:'found',pipeline:{extraction:{status:'pending'}}}})});
  await runner.runDiscovery(77);
  await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('automatic pipeline timeout')),500))]);
  assert.equal(state,'completed');
  assert.deepEqual(scope.seed_urls,['https://example.com/products/chair']);
});

test('custom DNS lookup supports Node all-address connection selection', () => {
  const source = require('fs').readFileSync(require.resolve('../services/product-ingestion-fetch'), 'utf8');
  assert.match(source, /if \(options\?\.all\) callback\(null, results\)/);
  assert.match(source, /callback\(null, results\[0\]\.address, results\[0\]\.family\)/);
  assert.match(source, /'Accept-Language':\s*'zh-CN,zh;q=0\.9,en;q=0\.5'/);
});

test('universal runner requests the original product URL without brand-specific rewriting', async () => {
  const calls=[];
  const sourceUrl='https://example.com/products/chair?lang=zh';
  assert.equal(preferredContentUrl(sourceUrl,'legacy_adapter'),sourceUrl);
  const result=await fetchPreferredHtml(sourceUrl,{adapter_key:'universal_web_v1'},async url=>{calls.push(url);return {url};});
  assert.deepEqual(calls,[sourceUrl]);
  assert.equal(result.url,sourceUrl);
});

test('universal discovery follows in-scope pages and recognizes product details', async () => {
  const links = hrefs('<a href="/collections/seating">座椅</a><a href="https://outside.example/x">站外</a>', 'https://www.example.com/');
  assert.equal(links[0].toString(), 'https://www.example.com/collections/seating');
  const pages = {
    'https://www.example.com/': '<a href="/collections/seating">座椅</a><a href="/about">关于</a>',
    'https://www.example.com/collections/seating': '<a href="/products/oak-chair">View product</a><a href="https://evil.example/products/fake">站外</a>',
  };
  const scope = { adapter_key:'universal_web_v1', seed_urls:['https://www.example.com/'],
    allowed_hosts:['www.example.com'], allowed_path_prefixes:['/'], max_pages:10, max_products:50, request_interval_ms:0 };
  const result = await discoverProducts(scope, async url => ({ url, html:pages[url] || '' }));
  assert.deepEqual(result.urls, ['https://www.example.com/products/oak-chair']);
  assert.equal(result.summary.pages_scanned, 2);
  assert.equal(result.summary.products_found, 1);
  assert.deepEqual(result.records[0].source_categories, []);
  assert.ok(result.summary.excluded.out_of_scope >= 1);
});

test('universal discovery keeps successes and reports individual page failures', async () => {
  const pages={
    'https://example.com/':'<a href="/collections/chairs">Chairs</a><a href="/collections/tables">Tables</a>',
    'https://example.com/collections/chairs':'<a href="/products/chair-one">View product</a>',
  };
  const scope={adapter_key:'universal_web_v1',seed_urls:['https://example.com/'],allowed_hosts:['example.com'],allowed_path_prefixes:['/'],max_pages:10,max_products:50,request_interval_ms:0};
  const result=await discoverProducts(scope,async url=>{
    if(url.endsWith('/collections/tables')){const error=new Error('forbidden');error.response={status:403};throw error;}
    return {url,html:pages[url]||''};
  });
  assert.deepEqual(result.urls,['https://example.com/products/chair-one']);
  assert.equal(result.summary.result,'partial');
  assert.equal(result.summary.failures[0].stage,'fetch');
  assert.match(result.summary.failures[0].message,/HTTP 403/);
});

test('universal discovery identifies page obstacles and gives a clear all-failed error', async () => {
  assert.equal(pageIsProduct('<script type="application/ld+json">{"@type":"Product","name":"Chair"}</script>','https://example.com/x'),true);
  assert.equal(pageObstacle('<nav><a href="/product">产品</a></nav><div class="login"><label>验证码</label></div>','https://example.com/'), '');
  assert.match(pageObstacle('<title>Verify you are human</title><h1>Security check</h1><div class="challenge-platform"></div>','https://example.com/'),/验证|挑战/);
  assert.match(fetchFailure({response:{status:429}}),/HTTP 429/);
  const scope={adapter_key:'universal_web_v1',seed_urls:['https://example.com/'],allowed_hosts:['example.com'],allowed_path_prefixes:['/'],max_pages:2,max_products:2,request_interval_ms:0};
  await assert.rejects(()=>discoverProducts(scope,async()=>{const error=new Error('denied');error.response={status:403};throw error;}),/官网入口无法分析.*HTTP 403/);
});

test('multi-evidence discovery recognizes nested product id routes without a brand rule', async () => {
  const pages={'https://banlan.example/':'<nav><a href="/product/show/id/267">云杉沙发</a></nav><div class="login"><label>验证码</label></div>'};
  const scope={adapter_key:'universal_web_v1',seed_urls:['https://banlan.example/'],allowed_hosts:['banlan.example'],allowed_path_prefixes:['/'],max_pages:10,max_products:50,request_interval_ms:0};
  const result=await discoverProducts(scope,async url=>({url,status:200,html:pages[url]||''}));
  assert.deepEqual(result.urls,['https://banlan.example/product/show/id/267']);
  assert.equal(result.summary.analysis.analyzer_version,'source_analyzer_v1');
  assert.equal(result.summary.detection.method,'multi_evidence_v1');
  assert.equal(result.summary.pipeline.extraction.status,'pending');
});
