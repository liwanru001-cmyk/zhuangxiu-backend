'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {acquireBoundedOfficialEvidence}=require('../services/product-ingestion-bounded-official-evidence');

const scope={brand_name:'New Brand',base_url:'https://example.com/',allowed_hosts:['example.com'],allowed_asset_hosts:['example.com'],allowed_path_prefixes:['/'],request_interval_ms:2000};
function discovery(urls){return async()=>({output:{product_urls:urls.map((url,index)=>({url,name:`Product ${index+1}`,reason:'official result'})),material_urls:[],warnings:[],site_summary:'official products'},request_hash:'hash',model:'test',prompt_version:'test',usage:{total_tokens:1},calls:[]});}

test('bounded official evidence accepts only exact-host URLs and proves them through the controlled fetcher',async()=>{
  const fetched=[];
  const result=await acquireBoundedOfficialEvidence(scope,{
    discoverOfficialPages:discovery(['https://example.com/products/a','https://other.example/products/x','https://example.com/products/b']),
    fetchHtml:async url=>{fetched.push(url);return {url,status:200,contentType:'text/html',html:`<html><body><main><h1>${url.endsWith('/a')?'A':'B'}</h1><p>Product description with enough visible information for an official product page.</p><img src="/1.jpg"><img src="/2.jpg"></main></body></html>`};},
  });
  assert.equal(result.status,'ready');
  assert.deepEqual(fetched,['https://example.com/products/a','https://example.com/products/b']);
  assert.equal(result.site_map.pages.length,2);
  assert.equal(result.site_map.known_labels.length,2);
  assert.ok(result.site_map.known_labels.every(item=>item.role==='product_detail'));
  assert.ok(result.site_map.known_labels.every(item=>item.evidence_level==='page_verified'));
  assert.equal(result.site_map.acquisition.channel,'bounded_official_discovery_then_controlled_fetch');
});

test('confirmed official URLs blocked on HTTP request are escalated to the controlled JS channel',async()=>{
  const result=await acquireBoundedOfficialEvidence(scope,{
    discoverOfficialPages:discovery(['https://example.com/products/a']),
    fetchHtml:async()=>{const error=new Error('forbidden');error.code='PAGE_HTTP_STATUS';error.response={status:403,headers:{}};throw error;},
  });
  assert.equal(result.status,'js_required');
  assert.equal(result.outcome.category,'JS_RENDER_REQUIRED');
  assert.deepEqual(result.official_urls,['https://example.com/products/a']);
  assert.equal(result.site_map,undefined);
});
