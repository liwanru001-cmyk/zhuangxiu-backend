'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createFieldReview,buildFields,applyFieldMapping}=require('../services/product-ingestion-field-review');
const {emptyDocument,addField}=require('../services/product-schema-v2');

function details(name='标准款'){
  return {schema_version:1,furniture_type:'table',model:'',source_url:'',configurations:[{id:'standard',name,code:'',shape:'box',dimensions:{width:null,depth:null,height:null},dimension_unit:'cm',dimension_note:'',parts:[{part:'整体',material:'',color:'',code:'',swatch_url:''}],image_urls:[],image_url:'',drawing_url:'',drawing_name:'',unit:'件',price_state:'unknown',price:null,includes:''}],customization:{enabled:false,fields:[],limits:'',pricing_note:''}};
}

function candidate(id,name,published=false,configurationName='标准款'){
  return {id,job_id:41,source_id:7,source_url:`https://example.com/products/${id}`,published_product_id:published?900+id:null,normalized_payload:JSON.stringify({name,brand:'Fendi Casa',product_type:'furniture',product_details:details(configurationName)}),extracted_payload:JSON.stringify({name}),generated_fields:'[]'};
}

test('field review exposes the evidence path used by a batch mapping',()=>{
  const field=buildFields(candidate(1,'Sigillo FF, table')).find(item=>item.path==='product_details.configurations[0].name');
  const option=field.options.find(item=>item.value==='Sigillo FF, table');
  assert.equal(option.source,'官网商品名称');
  assert.equal(option.source_path,'name');
});

test('mapping copies each product own official value and never repeats the anchor value',()=>{
  const first={product_details:details()},second={product_details:details()};
  const rule={field_path:'product_details.configurations[0].name',source_path:'name',when_current_equals:'标准款'};
  assert.equal(applyFieldMapping(first,{name:'Sigillo FF, table'},rule),true);
  assert.equal(applyFieldMapping(second,{name:'Adrian chair'},rule),true);
  assert.equal(first.product_details.configurations[0].name,'Sigillo FF, table');
  assert.equal(second.product_details.configurations[0].name,'Adrian chair');
});

test('batch mapping previews, updates only matching unpublished task candidates, and saves a future source rule',async()=>{
  const anchor=candidate(1,'Sigillo FF, table'),rows=[anchor,candidate(2,'Adrian chair'),{...candidate(3,'Already corrected'),normalized_payload:JSON.stringify({name:'Already corrected',brand:'Fendi Casa',product_type:'furniture',product_details:details('Already corrected')})},candidate(4,'Published product',true)];
  const updates=[];let storedRule=null;
  const db={query:async(sql,params=[])=>{
    if(sql==='SELECT * FROM product_ingestion_candidates WHERE id=?')return [[anchor]];
    if(sql.includes('FROM product_ingestion_candidates WHERE source_id=? AND job_id=?'))return [rows];
    if(sql.startsWith('UPDATE product_ingestion_candidates SET normalized_payload=')){updates.push(params);return [{affectedRows:1}];}
    if(sql.startsWith('INSERT INTO product_ingestion_field_review_rules')){storedRule=JSON.parse(params[3]);return [{affectedRows:1}];}
    if(sql.includes('FROM product_ingestion_field_review_rules'))return [[{field_path:storedRule.field_path,rule_type:'map_from_extracted',match_value:JSON.stringify(storedRule)}]];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const review=createFieldReview(db),request={field_path:'product_details.configurations[0].name',source_path:'name',scope:'job'};
  const preview=await review.previewFieldMapping(1,request);
  assert.equal(preview.affected_count,2);
  assert.deepEqual(preview.examples.map(item=>item.new_value),['Sigillo FF, table','Adrian chair']);
  const result=await review.applyFieldMapping(1,{...request,confirmed:true,save_rule:true},'reviewer');
  assert.equal(result.affected_count,2);
  assert.equal(result.rule_saved,true);
  assert.equal(updates.length,2);
  assert.deepEqual(updates.map(item=>JSON.parse(item[0]).product_details.configurations[0].name),['Sigillo FF, table','Adrian chair']);
  assert.equal(storedRule.when_current_equals,'标准款');
  const future={name:'Future product',brand:'Fendi Casa',product_type:'furniture',product_details:details()};
  await review.applyRules(7,future,{name:'Future product'});
  assert.equal(future.product_details.configurations[0].name,'Future product');
});

test('an already corrected product can still start a batch mapping for the dominant old value',async()=>{
  const anchor=candidate(1,'Sigillo FF, table',false,'Sigillo FF, table'),rows=[anchor,candidate(2,'Adrian chair'),candidate(3,'Five sofa')];
  const db={query:async(sql)=>{
    if(sql==='SELECT * FROM product_ingestion_candidates WHERE id=?')return [[anchor]];
    if(sql.includes('FROM product_ingestion_candidates WHERE source_id=? AND job_id=?'))return [rows];
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const preview=await createFieldReview(db).previewFieldMapping(1,{field_path:'product_details.configurations[0].name',source_path:'name',scope:'job'});
  assert.equal(preview.affected_count,2);
  assert.deepEqual(preview.examples.map(item=>item.new_value),['Adrian chair','Five sofa']);
});

test('v2 candidate review uses contract paths and preserves schema after an asset-role correction',async()=>{
  const document=emptyDocument('https://www.example.com/p');document.data.product.names.primary='产品';addField(document,'/product/names/primary','产品','provided',{type:'dom_text',selector:'h1'});document.data.assets.push({id:'asset-one',url:'https://www.example.com/a.jpg',media_type:'image',role:'hero',sort_order:0,bindings:[{target_type:'product',target_id:'product'}]});addField(document,'/assets/asset-one/role','hero','provided',{type:'image'});const payload={product_schema_version:2,product_document:document},candidate={id:31,source_id:2,normalized_payload:payload,extracted_payload:{product_document:document},generated_fields:[]};let saved;
  const db={query:async(sql,params)=>{if(sql==='SELECT * FROM product_ingestion_candidates WHERE id=?')return [[candidate]];if(sql.startsWith('SELECT normalized_payload'))return [[{normalized_payload:payload}]];if(sql.startsWith('UPDATE product_ingestion_candidates SET')){saved=JSON.parse(params[0]);return [{affectedRows:1}];}throw new Error(`Unexpected query: ${sql}`);}};
  const review=createFieldReview(db),listed=await review.listFields(31),role=listed.fields.find(item=>item.path==='/assets/asset-one/role');assert.ok(role.options.some(item=>item.value==='detail'));await review.saveSelections(31,{selections:[{path:role.path,value:'detail'}]},'reviewer');assert.equal(saved.product_document.data.assets[0].role,'detail');assert.equal(saved.product_document.field_status[role.path].status,'provided');
});
