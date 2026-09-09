const test = require('node:test');
const assert = require('node:assert/strict');
const {catalogFields, normalizeDetails} = require('../services/product-details');
const curtain = () => ({schema_version:1,product_kind:'curtains',curtain_type:'combined',model:'C1',configurations:[{id:'linen-1',name:'米白布帘＋白纱',code:'',shape:'curtain',dimensions:{width:null,height:null},dimension_unit:'cm',parts:[{part:'帘布',material:'亚麻混纺',color:'米白',code:'A01',swatch_url:'',fabric_width_cm:280,repeat_height_cm:null,blackout_note:'以供应商样布为准'},{part:'窗纱',material:'涤纶',color:'白',fabric_width_cm:null,repeat_height_cm:null}],unit:'米',price_state:'known',price:120,curtain_specs:{sizing:'custom',dimension_basis:'panel',heading:'挂钩',opening:'左右对开',operation:'compatible',fullness_ratio:2,hardware_note:'电机与轨道另购',pricing_basis:'按帘布用米计价，窗纱另报价'}}],customization:{enabled:true,fields:['width','height','heading'],limits:'复尺后确认成品尺寸',pricing_note:'加工安装另计'}});
module.exports = {curtain};
test('curtain contract separates fabric width, finished dimensions, pricing basis and project quantities',()=>{
 const input=curtain();const out=normalizeDetails(input,'curtains');assert.equal(out.configurations[0].dimensions.width,null);assert.equal(out.configurations[0].parts[0].fabric_width_cm,280);assert.equal(out.configurations[0].curtain_specs.fullness_ratio,2);assert.equal(out.configurations[0].curtain_specs.operation,'compatible');assert.ok(!('quantity' in out.configurations[0]));
 assert.deepEqual(JSON.parse(catalogFields({product_group:'soft_furnishings',product_type:'curtains',product_details:input}).product_details),out);
});
test('curtain rejects category mismatch, vague known price, invalid sizes and fullness, furniture units',()=>{
 assert.throws(()=>normalizeDetails(curtain()));
 for(const change of [c=>c.unit='把',c=>c.curtain_specs.pricing_basis='',c=>c.curtain_specs.fullness_ratio=0,c=>c.parts[0].fabric_width_cm=0,c=>c.parts[0].repeat_height_cm=-1,c=>c.dimensions.height=0,c=>c.curtain_specs.sizing='production']) { const input=curtain();change(input.configurations[0]);assert.throws(()=>normalizeDetails(input,'curtains')); }
 const input=curtain();input.configurations[0].price_state='quote';input.configurations[0].price=99;input.configurations[0].curtain_specs.pricing_basis='';assert.equal(normalizeDetails(input,'curtains').configurations[0].price,null);
});
