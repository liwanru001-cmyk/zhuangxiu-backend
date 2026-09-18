'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPublicProductTaxonomy}=require('../services/public-product-taxonomy');

test('taxonomy governance keeps official category evidence and mapping counts separate',async()=>{
  let call=0;
  const db={query:async sql=>{
    call+=1;
    if(sql.includes('FROM product_ingestion_source_categories'))return [[{id:3,source_id:1,brand_name:'HC28',external_key:'cid:13',name:'沙发/组合沙发',source_url:'https://example.test/13',mapped_category_ids:'7',discovered_products:17,published_products:17}]];
    if(sql.includes('FROM product_ingestion_discovered_product_categories evidence JOIN product_ingestion_candidates'))return [[{source_category_id:3,id:9,source_url:'https://example.test/p/9',normalized_payload:JSON.stringify({name:'沙发',cover_url:'https://cdn.example.test/9.jpg',model:'S9'})}]];
    if(sql.includes('FROM public_product_categories'))return [[{id:7,parent_id:1,code:'furniture.sofa',name:'沙发',level:2,sort_order:10,status:'active',selectable:1}]];
    if(sql.includes('FROM product_ingestion_candidates candidate JOIN product_ingestion_sources'))return [[{id:9,brand_name:'HC28',source_url:'https://example.test/p/9',normalized_payload:JSON.stringify({name:'沙发'}),classification_suggestion:JSON.stringify({product_type:'furniture'}),direct_assignments:null,mapped_category_ids:null,source_category_names:null}]];
    throw new Error(`Unexpected query ${call}: ${sql}`);
  }};
  const result=await createPublicProductTaxonomy(db).listGovernance();
  assert.equal(result.pending_classification,1);
  assert.deepEqual(result.source_categories[0].mapped_category_ids,[7]);
  assert.equal(result.source_categories[0].discovered_products,17);
  assert.equal(result.source_categories[0].samples[0].cover_image_url,'https://cdn.example.test/9.jpg');
  assert.equal(result.source_categories[0].samples[0].model_code,'S9');
  assert.equal(result.categories[0].code,'furniture.sofa');
});

test('governance treats a non-selectable parent assignment as unfinished',async()=>{
  const db={query:async sql=>{
    if(sql.includes('FROM product_ingestion_source_categories'))return [[]];
    if(sql.includes('FROM public_product_categories'))return [[{id:1,parent_id:null,code:'furniture',name:'家具',level:1,sort_order:10,status:'active',selectable:0},{id:7,parent_id:1,code:'furniture.sofa',name:'沙发',level:2,sort_order:10,status:'active',selectable:1}]];
    if(sql.includes('FROM product_ingestion_candidates candidate JOIN product_ingestion_sources'))return [[{id:10,brand_name:'HC28',source_url:'https://example.test/p/10',normalized_payload:JSON.stringify({name:'待分类家具'}),classification_suggestion:JSON.stringify({product_type:'furniture'}),direct_assignments:'1:system',mapped_category_ids:null,source_category_names:null}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await createPublicProductTaxonomy(db).listGovernance();
  assert.equal(result.pending_classification,1);
  assert.equal(result.issues[0].issue_type,'parent_only');
});

test('candidate manual classification requires at least one category',async()=>{
  await assert.rejects(()=>createPublicProductTaxonomy({}).setCandidateCategories(3,{category_ids:[]},'admin'),/至少需要一个标准分类/);
});

test('candidate category replacement rolls back instead of leaving an empty partial save',async()=>{
  let inserted=0,rolledBack=false,committed=false,released=false;
  const conn={beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{rolledBack=true;},release:()=>{released=true;},query:async sql=>{
    if(sql.startsWith('SELECT id,published_product_id'))return [[{id:3,published_product_id:null}]];
    if(sql.includes('SELECT category.id FROM public_product_categories'))return [[{id:7},{id:8}]];
    if(sql.startsWith('DELETE FROM product_ingestion_candidate_categories'))return [{affectedRows:1}];
    if(sql.startsWith('INSERT INTO product_ingestion_candidate_categories')){inserted+=1;if(inserted===2)throw new Error('write failed');return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE product_ingestion_candidates SET manual_revision'))return [{affectedRows:1}];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  await assert.rejects(()=>createPublicProductTaxonomy({getConnection:async()=>conn}).setCandidateCategories(3,{category_ids:[7,8]},'admin'),/write failed/);
  assert.equal(rolledBack,true);assert.equal(committed,false);assert.equal(released,true);
});

test('mapping impact reports affected products and protected overrides before save',async()=>{
  const db={query:async(sql)=>{
    if(sql.includes('SELECT category.id FROM public_product_categories'))return [[{id:7}]];
    if(sql.startsWith('SELECT id,name FROM product_ingestion_source_categories'))return [[{id:3,name:'Sofas'}]];
    if(sql.includes('affected_candidates'))return [[{affected_candidates:18,affected_products:7,skipped_overrides:2}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await createPublicProductTaxonomy(db).mappingImpact(3,{category_ids:[7]});
  assert.deepEqual(result,{source_category_id:3,source_category_name:'Sofas',category_ids:[7],affected_candidates:18,affected_products:7,skipped_overrides:2});
});

test('mapping save requires an explicit impact confirmation',async()=>{
  await assert.rejects(()=>createPublicProductTaxonomy({}).saveSourceMapping(3,{category_ids:[7]},'admin'),/确认分类映射的影响范围/);
});

test('candidate category batch preview protects manual choices and reports unavailable rows',async()=>{
  const db={query:async sql=>{
    if(sql.includes('SELECT category.id FROM public_product_categories'))return [[{id:7}]];
    if(sql.includes('FROM product_ingestion_candidates candidate JOIN product_ingestion_sources'))return [[
      {id:11,brand_name:'Flexform',normalized_payload:JSON.stringify({name:'Carlotta'}),validation_status:'valid',published_product_id:null,has_manual:0},
      {id:12,brand_name:'Flexform',normalized_payload:JSON.stringify({name:'Marquis'}),validation_status:'valid',published_product_id:null,has_manual:1},
      {id:13,brand_name:'Other',normalized_payload:JSON.stringify({name:'Broken'}),validation_status:'invalid',published_product_id:null,has_manual:0},
    ]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const result=await createPublicProductTaxonomy(db).candidateCategoryImpact({candidate_ids:[11,12,13,99],category_ids:[7]});
  assert.equal(result.requested_count,4);
  assert.equal(result.affected_candidates,1);
  assert.equal(result.skipped_manual,1);
  assert.equal(result.skipped_unavailable,2);
  assert.deepEqual(result.brands,[{brand_name:'Flexform',count:1}]);
  assert.equal(result.sample[0].product_name,'Carlotta');
});

test('candidate category batch apply requires impact confirmation',async()=>{
  await assert.rejects(()=>createPublicProductTaxonomy({}).applyCandidateCategories({candidate_ids:[11],category_ids:[7]},'admin'),/确认批量分类的影响范围/);
});

test('candidate category batch apply writes manual assignments and an audit batch',async()=>{
  const calls=[];
  const conn={
    beginTransaction:async()=>calls.push('begin'),commit:async()=>calls.push('commit'),rollback:async()=>calls.push('rollback'),release:()=>calls.push('release'),
    query:async(sql)=>{
      calls.push(sql);
      if(sql.includes('SELECT category.id FROM public_product_categories'))return [[{id:7}]];
      if(sql.includes('FROM product_ingestion_candidates candidate JOIN product_ingestion_sources'))return [[{id:11,brand_name:'Flexform',normalized_payload:JSON.stringify({name:'Carlotta'}),validation_status:'valid',published_product_id:null,has_manual:0}]];
      if(sql.startsWith('SELECT candidate_id,category_id'))return [[{candidate_id:11,category_id:1}]];
      return [{affectedRows:1}];
    },
  };
  const db={getConnection:async()=>conn};
  const result=await createPublicProductTaxonomy(db).applyCandidateCategories({candidate_ids:[11],category_ids:[7],confirmed:true},'preview-admin');
  assert.equal(result.affected_candidates,1);
  assert.match(result.batch_key,/^[0-9a-f-]{36}$/);
  assert.ok(calls.some(sql=>typeof sql==='string'&&sql.includes("assignment_type) VALUES (?,?,?,NOW(),'manual')")));
  assert.ok(calls.some(sql=>typeof sql==='string'&&sql.includes('product_ingestion_candidate_category_changes')));
  assert.ok(calls.includes('commit'));
  assert.ok(calls.includes('release'));
});
