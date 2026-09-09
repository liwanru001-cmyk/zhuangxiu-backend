const test=require('node:test');const assert=require('node:assert/strict');const {normalizeDetails,catalogFields}=require('../services/product-details');const fixture=require('./fixtures/rug-product.json');
const rug=()=>structuredClone(fixture);
test('rug shapes retain only their own named dimensions without guessing area',()=>{
 for(const [shape,keys] of [['rectangle',['length','width']],['square',['side']],['circle',['diameter']],['oval',['length','width']],['irregular',['length','width']]]) {
 const data=rug();data.configurations[0].shape=shape;data.configurations[0].dimensions={length:300,width:200,side:null,diameter:180,height:40};const out=normalizeDetails(data,'rugs').configurations[0];assert.deepEqual(Object.keys(out.dimensions),keys);assert.equal(out.rug_specs.pile_height_mm,10);assert.equal(out.rug_specs.thickness_mm,14);assert.ok(!Object.hasOwn(out,'area')); }
 assert.deepEqual(JSON.parse(catalogFields({product_group:'soft_furnishings',product_type:'rugs',product_details:rug()}).product_details),normalizeDetails(rug(),'rugs'));
});
test('reject mismatched products, vague area price, invalid pile height and irrelevant units',()=>{
 assert.throws(()=>normalizeDetails(rug()));assert.throws(()=>normalizeDetails(rug(),'curtains'));
 for(const change of [c=>c.rug_specs.pricing_basis='',c=>c.rug_specs.pile_height_mm=0,c=>c.rug_specs.thickness_mm=-1,c=>c.dimensions.width=0,c=>c.unit='米',c=>c.shape='box']) {const data=rug();change(data.configurations[0]);assert.throws(()=>normalizeDetails(data,'rugs'));}
 const data=rug();data.configurations[0].unit='张';data.configurations[0].rug_specs.pricing_basis='';assert.equal(normalizeDetails(data,'rugs').configurations[0].price,200);
 data.configurations[0].price_state='quote';assert.equal(normalizeDetails(data,'rugs').configurations[0].price,null);
});
