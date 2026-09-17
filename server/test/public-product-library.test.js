'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPublicProductLibrary}=require('../services/public-product-library');
const {normalizeProductNode}=require('../services/product-ingestion-extractor');
const {emptyDocument,addField,assertProductDocumentV2}=require('../services/product-schema-v2');

function validPayload(){return normalizeProductNode({'@type':'Product',name:'测试边几',sku:'T-01',width:{value:500,unitText:'mm'},depth:{value:500,unitText:'mm'},height:{value:450,unitText:'mm'}},'furniture','https://www.example.com/products/table').payload;}

test('formal publishing requires both structural validity and human approval',async()=>{
  let rolledBack=false;
  const conn={beginTransaction:async()=>{},rollback:async()=>{rolledBack=true;},release(){},query:async sql=>{
    if(sql.includes('FROM product_ingestion_candidates'))return [[{id:8,validation_status:'valid',review_status:'pending'}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  await assert.rejects(()=>createPublicProductLibrary({getConnection:async()=>conn}).publishCandidate(8,'admin'),/人工审核通过/);
  assert.equal(rolledBack,false);
});

test('publishing creates a product, immutable version and separate configuration rows',async()=>{
  const payload=validPayload();const queries=[];let committed=false;
  const conn={beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{},release(){},query:async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes('FROM product_ingestion_candidates'))return [[{id:9,job_id:5,source_id:2,source_url:'https://www.example.com/products/table',source_url_hash:'hash',validation_status:'valid',review_status:'approved',normalized_payload:payload,source_brand:'示例品牌'}]];
    if(sql.includes('FROM product_ingestion_candidate_categories'))return [[{category_id:7,source_category_id:3,assignment_type:'source'}]];
    if(sql.startsWith('SELECT product_id FROM public_product_category_overrides'))return [[]];
    if(sql.startsWith('SELECT * FROM public_product_library_products'))return [[]];
    if(sql.startsWith('INSERT INTO public_product_library_products'))return [{insertId:31}];
    if(sql.startsWith('SELECT COALESCE(MAX(version_no)'))return [[{max_version:0}]];
    if(sql.startsWith('INSERT INTO public_product_library_versions'))return [{insertId:41}];
    if(sql.startsWith('INSERT INTO public_product_library_configurations'))return [{insertId:51}];
    if(sql.startsWith('INSERT IGNORE INTO public_product_category_relations'))return [{affectedRows:1}];
    if(sql.startsWith('UPDATE public_product_library_products')||sql.startsWith('UPDATE product_ingestion_candidates'))return [{affectedRows:1}];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  let archiveRuntime;
  const result=await createPublicProductLibrary({getConnection:async()=>conn},{archiveProductAssets:async (value,_source,runtime)=>{archiveRuntime=runtime;return {payload:value,assets:[]};}}).publishCandidate(9,'reviewer');
  assert.deepEqual(result,{product_id:31,version_id:41,version_no:1,configuration_count:1,asset_count:0,already_published:false});
  assert.equal(queries.filter(item=>item.sql.startsWith('INSERT INTO public_product_library_configurations')).length,1);
  assert.equal(committed,true);
  assert.equal(archiveRuntime.candidatePublishAuthorized,true);
});

test('publishing accepts a gated v2 product without inventing a configuration',async()=>{
  const document=emptyDocument('https://www.example.com/products/v2');document.data.product.names.primary='V2 产品';document.data.product.names.zh='V2 产品';addField(document,'/product/names/primary','V2 产品','provided',{type:'dom_text',selector:'h1',raw_value:'V2 产品'});document.data.assets.push({id:'asset-hero',url:'https://www.example.com/hero.jpg',media_type:'image',role:'hero',sort_order:0,bindings:[{target_type:'product',target_id:'product'}]});addField(document,'/assets/asset-hero/role','hero','provided',{type:'image',raw_value:'https://www.example.com/hero.jpg'});assertProductDocumentV2(document);
  const payload={name:'V2 产品',brand:'示例品牌',product_type:'furniture',product_schema_version:2,product_document:document};const queries=[];
  const conn={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},query:async(sql,params)=>{queries.push({sql,params});if(sql.includes('FROM product_ingestion_candidates'))return [[{id:19,job_id:8,source_id:2,source_url:'https://www.example.com/products/v2',source_url_hash:'hash',validation_status:'valid',review_status:'approved',normalized_payload:payload,source_brand:'示例品牌'}]];if(sql.includes('FROM product_ingestion_candidate_categories'))return [[{category_id:7,source_category_id:null,assignment_type:'manual'}]];if(sql.startsWith('SELECT product_id FROM public_product_category_overrides'))return [[]];if(sql.startsWith('SELECT * FROM public_product_library_products'))return [[]];if(sql.startsWith('INSERT INTO public_product_library_products'))return [{insertId:61}];if(sql.startsWith('SELECT COALESCE(MAX(version_no)'))return [[{max_version:0}]];if(sql.startsWith('INSERT INTO public_product_library_versions'))return [{insertId:71}];if(sql.startsWith('INSERT IGNORE INTO public_product_category_relations')||sql.startsWith('UPDATE public_product_library_products')||sql.startsWith('UPDATE product_ingestion_candidates'))return [{affectedRows:1}];throw new Error(`Unexpected query: ${sql}`);}};
  const result=await createPublicProductLibrary({getConnection:async()=>conn},{archiveProductAssets:async value=>({payload:value,assets:[]})}).publishCandidate(19,'reviewer');assert.equal(result.configuration_count,0);assert.equal(queries.some(item=>item.sql.startsWith('INSERT INTO public_product_library_configurations')),false);const version=queries.find(item=>item.sql.startsWith('INSERT INTO public_product_library_versions'));assert.ok(version.params.includes(2));
});

test('publishing the same candidate is idempotent',async()=>{
  let commits=0;
  const conn={beginTransaction:async()=>{},commit:async()=>{commits+=1;},rollback:async()=>{},release(){},query:async sql=>{
    if(sql.includes('FROM product_ingestion_candidates'))return [[{id:10,published_product_id:4,published_version_id:7}]];
    if(sql.startsWith('SELECT id,version_no,asset_status'))return [[{id:7,version_no:1,asset_status:'complete',asset_count:3}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await createPublicProductLibrary({getConnection:async()=>conn}).publishCandidate(10,'admin');
  assert.deepEqual(result,{product_id:4,version_id:7,version_no:1,asset_count:3,already_published:true});
  assert.equal(commits,0);
});

test('publishing refuses an approved but unclassified candidate before archiving assets',async()=>{
  const payload=validPayload();let archiveCalled=false;
  const conn={release(){},query:async sql=>{
    if(sql.includes('FROM product_ingestion_candidates'))return [[{id:12,job_id:6,source_id:2,source_url:'https://www.example.com/products/table',source_url_hash:'hash',validation_status:'valid',review_status:'approved',normalized_payload:payload,source_brand:'示例品牌'}]];
    if(sql.includes('FROM product_ingestion_candidate_categories'))return [[]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  await assert.rejects(()=>createPublicProductLibrary({getConnection:async()=>conn},{archiveProductAssets:async()=>{archiveCalled=true;}}).publishCandidate(12,'admin'),/尚未完成标准分类/);
  assert.equal(archiveCalled,false);
});

test('public library filters by stable category code and searches configuration facts',async()=>{
  let captured;
  const db={query:async(sql,params)=>{captured={sql,params};return [[{id:3,source_id:1,current_version_id:8,version_id:8,version_no:1,configuration_count:2,asset_count:4,category_codes:'furniture.sofa',category_names:'沙发'}]];}};
  const rows=await createPublicProductLibrary(db).listProducts({category_code:'furniture.sofa',q:'HW01',limit:20},true);
  assert.match(captured.sql,/public_product_category_relations/);
  assert.match(captured.sql,/searchable_configuration\.code LIKE/);
  assert.deepEqual(captured.params.slice(0,2),['furniture.sofa','furniture.sofa']);
  assert.deepEqual(rows[0].category_codes,['furniture.sofa']);
  assert.deepEqual(rows[0].category_names,['沙发']);
});

test('public library facets return brand and two-level category counts',async()=>{
  let call=0;
  const db={query:async()=>++call===1?[[{value:'HC28',count:180}]]:[[{
    id:1,parent_id:null,code:'furniture',name:'家具',level:1,sort_order:10,count:175,
  },{id:7,parent_id:1,code:'furniture.sofa',name:'沙发',level:2,sort_order:10,count:17}]]};
  const result=await createPublicProductLibrary(db).facets();
  assert.deepEqual(result.brands,[{value:'HC28',count:180}]);
  assert.deepEqual(result.categories.map(item=>({code:item.code,count:item.count})),[
    {code:'furniture',count:175},{code:'furniture.sofa',count:17},
  ]);
});

test('admin library can filter lifecycle status without changing public active filter',async()=>{
  let captured;
  const db={query:async(sql,params)=>{captured={sql,params};return [[]];}};
  await createPublicProductLibrary(db).listProducts({status:'archived',include_payload:'false',limit:24});
  assert.match(captured.sql,/product\.status=\?/);
  assert.equal(captured.params[0],'archived');
  assert.doesNotMatch(captured.sql,/version\.product_payload/);
});

test('library inspector can read one immutable version with archived assets and provenance',async()=>{
  let call=0;const payload={name:'V2 产品',product_schema_version:2,product_document:{schema_version:2,data:{product:{},configurations:[],option_groups:[],assets:[]},field_status:{},evidence:{},issues:[]}};
  const db={query:async(sql,params)=>{call+=1;
    if(call===1){assert.match(sql,/version\.product_id=product\.id/);assert.deepEqual(params,[5,5,12]);return [[{id:5,source_id:2,current_version_id:13,version_id:12,version_no:1,product_payload:JSON.stringify(payload),configuration_count:0,asset_count:1,category_codes:'furniture.sofa',category_names:'沙发',candidate_id:7,job_id:9,current_frozen_site_rule_id:3,current_frozen_site_rule_version:2,content_fingerprint:'abc'}]];}
    if(call===2)return [[]];
    if(call===3)return [[{id:13,version_no:2,candidate_id:8,product_schema_version:2,asset_count:1},{id:12,version_no:1,candidate_id:7,product_schema_version:2,asset_count:1}]];
    if(call===4)return [[{relation_id:20,asset_id:30,asset_role:'hero',payload_path:'$.cover_url',storage_uri:'/api/storage/a.jpg',byte_size:1200}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await createPublicProductLibrary(db).getProduct(5,false,12);
  assert.equal(result.version_id,12);assert.equal(result.current_version_id,13);assert.equal(result.product_payload.product_schema_version,2);
  assert.deepEqual(result.provenance,{source_id:2,source_brand_name:undefined,source_base_url:undefined,candidate_id:7,job_id:9,current_frozen_site_rule_id:3,current_frozen_site_rule_version:2,content_fingerprint:'abc'});
  assert.equal(result.archived_assets[0].asset_id,30);assert.equal(result.versions[0].product_schema_version,2);
});

test('library lifecycle actions are reversible soft state changes',async()=>{
  const calls=[];
  const db={query:async(sql,params)=>{calls.push({sql,params});return [{affectedRows:2}];}};
  const library=createPublicProductLibrary(db);
  const archived=await library.changeProductStatus([3,4],'archived','preview-admin');
  const deleted=await library.changeProductStatus([3,4],'deleted','preview-admin');
  const restored=await library.changeProductStatus([3,4],'active','preview-admin');
  assert.deepEqual([archived.status,deleted.status,restored.status],['archived','deleted','active']);
  assert.match(calls[0].sql,/archived_at=NOW\(\)/);
  assert.match(calls[1].sql,/deleted_at=NOW\(\)/);
  assert.match(calls[2].sql,/deleted_at=NULL/);
  assert.equal(calls.every(call=>/^UPDATE public_product_library_products/.test(call.sql)),true,'归档和删除均不物理删除产品或版本');
});
