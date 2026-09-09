const {test}=require('node:test'); const assert=require('node:assert/strict');const {normalizeDetails,catalogFields}=require('../services/product-details');const fixture=require('./fixtures/artwork-product.json');
test('artwork separates image, framed and set dimensions and rejects invalid configurations',()=>{
 const d=normalizeDetails(fixture,'artwork');assert.equal(d.configurations[0].dimensions.width,40);assert.equal(d.configurations[0].artwork_specs.outer_width,44);assert.equal(d.configurations[0].artwork_specs.piece_count,2);assert.equal(d.configurations[0].dimensions.depth,undefined);
 for(const [key,value] of [['piece_count',0],['piece_count',1.5],['composition',''],['outer_width',0],['frame','invalid']]){const v=structuredClone(fixture);v.configurations[0].artwork_specs[key]=value;assert.throws(()=>normalizeDetails(v,'artwork'));}
 assert.throws(()=>normalizeDetails(fixture,'rugs'));
 const v=structuredClone(fixture);v.configurations[0].price_state='quote';assert.equal(normalizeDetails(v,'artwork').configurations[0].price,null);
 assert.ok(catalogFields({product_group:'soft_furnishings',product_type:'artwork',product_details:fixture}).product_details);
});
