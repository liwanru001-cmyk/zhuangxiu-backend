const {test}=require('node:test');const assert=require('node:assert/strict');const {normalizeDetails,catalogFields}=require('../services/product-details');const fixture=require('./fixtures/accessory-product.json');
test('accessory shape and set contract validates without inventing project quantities',()=>{
 const d=normalizeDetails(fixture,'accessories');assert.equal(d.configurations[0].dimensions.diameter,20);assert.equal(d.configurations[0].dimensions.width,undefined);assert.equal(d.configurations[0].accessory_specs.piece_count,2);
 for(const [k,x] of [['piece_count',0],['piece_count',1.5],['piece_count',1001],['composition','']]){const v=structuredClone(fixture);v.configurations[0].accessory_specs[k]=x;assert.throws(()=>normalizeDetails(v,'accessories'));}
 const v=structuredClone(fixture);v.configurations[0].shape='box';v.configurations[0].dimensions={width:10,depth:null,height:20};assert.deepEqual(normalizeDetails(v,'accessories').configurations[0].dimensions,{width:10,depth:null,height:20});
 v.configurations[0].unit='把';assert.throws(()=>normalizeDetails(v,'accessories'));assert.throws(()=>normalizeDetails(fixture,'artwork'));
 assert.ok(catalogFields({product_group:'soft_furnishings',product_type:'accessories',product_details:fixture}).product_details);
});
