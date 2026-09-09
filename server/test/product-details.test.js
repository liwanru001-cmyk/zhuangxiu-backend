const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogFields, normalizeDetails, validateSourceMerchant } = require('../services/product-details');
const fixture = () => ({schema_version:1,furniture_type:'chair',model:'C01',source_url:'',source_merchant_id:null,configurations:[{id:'chair-cream',name:'米白布艺 / 胡桃木架',code:'C01-A',shape:'box',dimensions:{width:520,depth:null,height:'820'},dimension_unit:'mm',dimension_note:'座高450',parts:[{part:'坐面',material:'布艺',color:'米白',code:'A01',swatch_url:'https://example.com/sw.jpg'},{part:'椅架',material:'实木',color:'胡桃木',code:'',swatch_url:''}],image_url:'',drawing_url:'',unit:'把',price_state:'quote',price:null,includes:''}],customization:{enabled:true,fields:['material','color'],limits:'尺寸固定',pricing_note:'需询价'}});
test('both sources use one schema; unknown dimension and pending price stay null', () => {
  const data=fixture(); const personal=catalogFields({product_group:'soft_furnishings',product_type:'furniture',product_details:data});
  assert.deepEqual(JSON.parse(personal.product_details), normalizeDetails(data));
  assert.equal(normalizeDetails(data).configurations[0].dimensions.depth,null);
  assert.equal(normalizeDetails(data).configurations[0].price,null);
  assert.equal(normalizeDetails(data).configurations[0].parts.length,2);
});
test('reject impossible input, duplicate identities, unsafe URLs, invalid price and dimension precision', () => {
  for (const mutate of [d=>d.configurations.push({...d.configurations[0]}),d=>d.configurations[0].dimensions.width=0,d=>d.configurations[0].dimensions.width=1.1234,d=>d.configurations[0].price_state='known',d=>d.configurations[0].image_url='javascript:alert(1)',d=>d.configurations[0].price_state='free',d=>d.configurations[0].parts=[],d=>d.configurations[0].dimensions.width=true,d=>d.configurations[0].parts[0].swatch_url='https://user:pass@example.com/a',d=>d.schema_version=2]) { const data=fixture(); mutate(data); assert.throws(()=>normalizeDetails(data)); }
  const data=fixture();data.configurations[0].price_state='known';data.configurations[0].price='0.00';assert.equal(normalizeDetails(data).configurations[0].price,0);
  data.configurations[0].price='1.234';assert.throws(()=>normalizeDetails(data));
});
test('legacy omission preserves metadata; explicit category changes clear furniture fields', () => {
  assert.deepEqual(catalogFields({name:'legacy'}),{});
  assert.equal(catalogFields({product_group:'woodwork'}).product_details,null);
  assert.equal(catalogFields({product_group:'soft_furnishings',product_type:'lighting'}).product_details,null);
  assert.throws(()=>catalogFields({product_group:'woodwork',product_details:fixture()}));
});
test('unknown source merchant cannot be attached, association itself grants no ownership', async () => {
  await assert.rejects(validateSourceMerchant({query:async()=>[[]]}, {...fixture(),source_merchant_id:9}));
  await validateSourceMerchant({query:async(sql,params)=>{assert.deepEqual(params,[9]);return [[{user_id:9}]];}}, {...fixture(),source_merchant_id:9});
});
