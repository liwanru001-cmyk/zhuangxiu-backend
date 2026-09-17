'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {emptyDocument,addField,assertProductDocumentV2,toProductDocumentV2,validateCorrectionIssues,ASSET_ROLES,FIELD_STATUSES}=require('../services/product-schema-v2');

test('Product Schema v2 keeps data, status and evidence separate',()=>{
  const document=emptyDocument('https://example.com/products/sofa');
  document.data.product.names.primary='云杉沙发';
  addField(document,'/product/names/primary','云杉沙发','provided',{type:'css_text',selector:'.title',raw_value:'云杉沙发'});
  assert.equal(assertProductDocumentV2(document),document);
  assert.equal(document.field_status['/product/names/primary'].status,'provided');
  assert.equal(document.evidence['/product/names/primary'][0].selector,'.title');
  assert.ok(FIELD_STATUSES.includes('inferred'));
});

test('canonical rule sources terminate in the stable Product Schema v2 evidence vocabulary',()=>{
  const expected={json_ld_product:'json_ld',css_text:'dom_text',css_attr:'dom_attribute',meta:'meta',body_regex:'regex',url_path:'url_path',constant:'system'};
  for(const [sourceType,evidenceType] of Object.entries(expected)){
    const document=emptyDocument('https://example.com/products/evidence');
    addField(document,`/contract/${sourceType}`,'value','provided',{source:{type:sourceType},raw_value:'value'});
    assert.equal(document.evidence[`/contract/${sourceType}`][0].source_type,evidenceType,sourceType);
  }
});

test('Product Schema v2 represents configurations, option groups and bound assets without business defaults',()=>{
  const document=emptyDocument('https://example.com/products/modular');
  document.data.product.names.primary='Modular';
  addField(document,'/product/names/primary','Modular','provided',{type:'json_ld_product',path:'name',raw_value:'Modular'});
  document.data.configurations.push({id:'cfg-two-seat',group:'两人位',name:'两人位 2120',code:'YS101-001',dimensions:[{id:'dim-overall',kind:'overall',label:null,values:{width:2120,depth:1050,height:null},unit:'mm',note:null,asset_ids:['asset-size']}],asset_ids:['asset-size'],option_group_ids:['fabric'],price_state:'unknown',price:null,currency:'CNY',unit:null,includes:null});
  document.data.option_groups.push({id:'fabric',type:'material_color',name:'面料',applies_to_configuration_ids:['cfg-two-seat'],options:[{id:'fabric-e116',name:'E116',code:'E116',material:'面料',color:null,supplier:'GABRIEL',origin:'中国',asset_ids:['asset-swatch']} ]});
  document.data.assets.push({id:'asset-size',url:'https://example.com/size.png',media_type:'image',role:'dimension_diagram',sort_order:0,bindings:[{target_type:'configuration',target_id:'cfg-two-seat'}]},{id:'asset-swatch',url:'https://example.com/e116.png',media_type:'image',role:'material_swatch',sort_order:1,bindings:[{target_type:'option',target_id:'fabric-e116'}]});
  assert.doesNotThrow(()=>assertProductDocumentV2(document));
  assert.ok(ASSET_ROLES.includes('certificate'));
  assert.equal(document.data.configurations[0].unit,null);
});

test('legacy product payload remains readable through the v2 compatibility boundary',()=>{
  const document=toProductDocumentV2({name:'Legacy chair',description:'Old data',product_type:'furniture',product_details:{schema_version:1,source_url:'https://example.com/chair',model:'C1',configurations:[{id:'c1',name:'Dining chair',code:'C1-A',dimensions:{width:520,depth:600,height:820},dimension_unit:'mm',image_urls:['https://example.com/chair.jpg'],drawing_url:'https://example.com/chair-size.pdf',unit:'把',price_state:'unknown',price:null,includes:''}]}});
  assert.equal(document.schema_version,2);
  assert.equal(document.data.configurations[0].code,'C1-A');
  assert.equal(document.data.assets[0].role,'configuration_image');
  assert.equal(document.data.assets[1].role,'drawing');
});

test('structured correction issues identify an exact target and action',()=>{
  const issues=validateCorrectionIssues([{id:'issue-1',target_type:'asset',target_id:'asset-size',path:'/assets/asset-size/role',issue_type:'misclassified',current_value:'hero',expected_value:'dimension_diagram',action:'reclassify',evidence_paths:['/assets/asset-size/role'],note:'尺寸图不能作为主图'}]);
  assert.equal(issues[0].target_id,'asset-size');
  assert.equal(issues[0].action,'reclassify');
});

test('invalid v2 documents cannot silently add unknown business fields',()=>{
  const document=emptyDocument();document.data.product.brand_specific_value='x';
  assert.throws(()=>assertProductDocumentV2(document),/Product Schema v2 校验失败/);
});
