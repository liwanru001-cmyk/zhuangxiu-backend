'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPublicProductTaxonomy}=require('../services/public-product-taxonomy');

test('taxonomy governance keeps official category evidence and mapping counts separate',async()=>{
  let call=0;
  const db={query:async sql=>{
    call+=1;
    if(sql.includes('FROM product_ingestion_source_categories'))return [[{id:3,source_id:1,brand_name:'HC28',external_key:'cid:13',name:'沙发/组合沙发',source_url:'https://example.test/13',mapped_category_ids:'7',discovered_products:17,published_products:17}]];
    if(sql.includes('SELECT COUNT(*) count FROM product_ingestion_candidates'))return [[{count:1}]];
    if(sql.includes('FROM public_product_categories'))return [[{id:7,parent_id:1,code:'furniture.sofa',name:'沙发',level:2,sort_order:10,status:'active'}]];
    throw new Error(`Unexpected query ${call}: ${sql}`);
  }};
  const result=await createPublicProductTaxonomy(db).listGovernance();
  assert.equal(result.pending_classification,1);
  assert.deepEqual(result.source_categories[0].mapped_category_ids,[7]);
  assert.equal(result.source_categories[0].discovered_products,17);
  assert.equal(result.categories[0].code,'furniture.sofa');
});

test('candidate manual classification requires at least one category',async()=>{
  await assert.rejects(()=>createPublicProductTaxonomy({}).setCandidateCategories(3,{category_ids:[]},'admin'),/至少需要一个标准分类/);
});

test('candidate category replacement rolls back instead of leaving an empty partial save',async()=>{
  let inserted=0,rolledBack=false,committed=false,released=false;
  const conn={beginTransaction:async()=>{},commit:async()=>{committed=true;},rollback:async()=>{rolledBack=true;},release:()=>{released=true;},query:async sql=>{
    if(sql.startsWith('SELECT id,published_product_id'))return [[{id:3,published_product_id:null}]];
    if(sql.startsWith('SELECT id FROM public_product_categories'))return [[{id:7},{id:8}]];
    if(sql.startsWith('DELETE FROM product_ingestion_candidate_categories'))return [{affectedRows:1}];
    if(sql.startsWith('INSERT INTO product_ingestion_candidate_categories')){inserted+=1;if(inserted===2)throw new Error('write failed');return [{affectedRows:1}];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  await assert.rejects(()=>createPublicProductTaxonomy({getConnection:async()=>conn}).setCandidateCategories(3,{category_ids:[7,8]},'admin'),/write failed/);
  assert.equal(rolledBack,true);assert.equal(committed,false);assert.equal(released,true);
});
