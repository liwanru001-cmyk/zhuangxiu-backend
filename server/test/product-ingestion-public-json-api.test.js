'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {apiRuleErrors,recordToCanonicalHtml,discoverApiProducts,parseVirtualProductUrl}=require('../services/product-ingestion-public-json-api');
const {publicApiDiscovery,validateDiscoveryAgainstMap}=require('../services/product-ingestion-site-cognition');

function rule(){return {schema_version:'public-json-api-rule-v1',endpoint_url:'https://api.example.com/catalog/items?page=1&pageSize=2',method:'GET',items_path:'data.items',total_path:'data.total',identity_path:'id',pagination:{mode:'page_number',page_param:'page',page_size_param:'pageSize',start_page:1,page_size:2,max_pages:10},fields:{name:'title',description:'summary',model:'model',category:'category'},images:{paths:['images'],max_images:10},configurations:{items_path:'variants',name_path:'name',code_path:'code',dimensions_path:'size'},option_groups:{items_path:'groups',name_path:'name',options_path:'options',option_name_path:'name',option_code_path:'code'},evidence_refs:['API-001']};}
function records(){return [{id:'A 100%',title:'Alpha chair',summary:'A chair',model:'A-1',category:'chair',images:['https://cdn.example.com/a.jpg'],variants:[{name:'wide',code:'A-W',size:'800×900×700mm'}],groups:[{name:'finish',options:[{name:'oak',code:'OAK'}]}]},{id:'B',title:'Beta table',summary:'A table',model:'B-1',category:'table',images:['https://cdn.example.com/b.jpg'],variants:[],groups:[]},{id:'C',title:'Gamma sofa',summary:'A sofa',model:'C-1',category:'sofa',images:['https://cdn.example.com/c.jpg'],variants:[],groups:[]}];}
function siteMap(){return {site:{entry_url:'https://www.example.com/',brand:'Fixture'},pages:[{public_json_api_evidence:[{evidence_id:'API-001',url:rule().endpoint_url,status:200,content_type:'application/json',cors:'*',arrays:[{path:'data.items',count:3,sample_records:records()}]}]}]};}

test('public JSON rule is grounded in observed same-site records',()=>{
  assert.deepEqual(apiRuleErrors(rule(),siteMap()),[]);
  const invalid={...rule(),endpoint_url:'https://unrelated.test/catalog?page=1&pageSize=2'};
  assert.ok(apiRuleErrors(invalid,siteMap()).some(value=>value.includes('同一注册域')));
});

test('API records become generic canonical product HTML without site handlers',()=>{
  const html=recordToCanonicalHtml(records()[0],rule(),'https://api.example.com/catalog#record=A');
  assert.match(html,/Alpha chair/);assert.match(html,/api-configuration/);assert.match(html,/800×900×700mm/);assert.match(html,/api-option-group/);assert.match(html,/cdn\.example\.com\/a\.jpg/);
});

test('bounded page-number discovery returns virtual product identities and completeness',async()=>{
  const pages={1:records().slice(0,2),2:records().slice(2)};
  const result=await discoverApiProducts(rule(),{base_url:'https://www.example.com/',max_pages:10,max_products:10},{fetchJsonPage:async(_rule,page)=>({items:pages[page]||[],total:3,page})});
  assert.equal(result.records.length,3);assert.equal(result.pages_scanned,2);assert.equal(result.enumeration_complete,true);
  assert.equal(parseVirtualProductUrl(result.records[0].url).identity,'A 100%');
});

test('validated public API evidence creates a deterministic discovery rule without another AI call',()=>{
  const apiRule=rule(),endpoint=new URL(apiRule.endpoint_url),pages=records().map((record,index)=>({
    page_id:`API-${index+1}`,
    url:`${endpoint.origin}${endpoint.pathname}?page=1&pageSize=2#record=${record.id}&page=1&index=${index}`,
    content_hash:`hash-${index+1}`,
    acquisition_channel:'public_json_api',
  }));
  const map={site:{entry_url:'https://www.example.com/'},public_json_api_rule:apiRule,pages,clusters:[{url_examples:pages.map(page=>page.url)}]};
  const generated=publicApiDiscovery(map);
  assert.equal(generated.model,'program');
  assert.equal(generated.usage.total_tokens,0);
  assert.equal(generated.output.seed_urls.length,2);
  assert.equal(validateDiscoveryAgainstMap(map,generated.output,generated.input_manifest.pages.map(page=>page.url)).passed,true);
});
