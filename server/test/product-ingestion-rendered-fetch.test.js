'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createHybridFetcher,allowedDocument,allowedSubresource,safePublicApiUrl,sameRegistrableDomain,jsonArrayCandidates}=require('../services/product-ingestion-rendered-fetch');

const scope={allowed_hosts:['example.com'],allowed_asset_hosts:['cdn.example.com'],allowed_path_prefixes:['/products'],base_url:'https://example.com/products'};

test('rendered request scope permits only approved page paths and asset hosts',()=>{
  assert.equal(allowedDocument('https://example.com/products/a',scope),true);
  assert.equal(allowedDocument('https://example.com/admin',scope),false);
  assert.equal(allowedDocument('https://other.example/products/a',scope),false);
  assert.equal(allowedSubresource('https://cdn.example.com/a.js',scope),true);
  assert.equal(allowedSubresource('https://tracker.example/a.js',scope),false);
  assert.equal(allowedSubresource('data:text/plain,x',scope),false);
});

test('same-site rendered evidence may observe public JSON but never credentials or unrelated hosts',()=>{
  assert.equal(allowedSubresource('https://api.example.com/catalog?page=1',{...scope,allow_same_site_subresources:true}),true);
  assert.equal(allowedSubresource('https://api.unrelated.test/catalog?page=1',{...scope,allow_same_site_subresources:true}),false);
  assert.equal(sameRegistrableDomain('api.example.com','www.example.com'),true);
  assert.equal(safePublicApiUrl('https://api.example.com/catalog?page=1&pageSize=20'),'https://api.example.com/catalog?page=1&pageSize=20');
  assert.equal(safePublicApiUrl('https://api.example.com/catalog?access_token=secret'),null);
  assert.deepEqual(jsonArrayCandidates({data:{items:[{id:1},{id:2},{id:3}]}})[0].path,'data.items');
});

test('hybrid fetch keeps static HTML on the direct channel',async()=>{
  let rendered=0;const fetch=createHybridFetcher({
    fetchHtml:async()=>({url:'https://example.com/products/a',status:200,contentType:'text/html',html:'<html><body><h1>A chair</h1><p>Visible product content</p></body></html>'}),
    renderHtml:async()=>{rendered+=1;throw new Error('should not render');},
  });
  const page=await fetch('https://example.com/products/a',scope);assert.equal(page.url,'https://example.com/products/a');assert.equal(rendered,0);
});

test('hybrid fetch renders a script shell but never treats an HTTP access error as JS',async()=>{
  let rendered=0;const fetch=createHybridFetcher({
    fetchHtml:async()=>({url:'https://example.com/products/a',status:200,contentType:'text/html',html:'<html><body><div id="app"></div><script src="/app.js"></script></body></html>'}),
    renderHtml:async()=>{rendered+=1;return {url:'https://example.com/products/a',status:200,contentType:'text/html',html:'<h1>A</h1>',acquisition_channel:'rendered_html'};},
  });
  assert.equal((await fetch('https://example.com/products/a',scope)).acquisition_channel,'rendered_html');assert.equal(rendered,1);
  const blocked=createHybridFetcher({fetchHtml:async()=>{const error=new Error('forbidden');error.response={status:403};throw error;},renderHtml:async()=>{throw new Error('must not bypass');}});
  await assert.rejects(()=>blocked('https://example.com/products/a',scope),/forbidden/);
});

test('an explicit JS-channel state bypasses the failing direct client without weakening ordinary fetches',async()=>{
  let direct=0,rendered=0;const fetch=createHybridFetcher({fetchHtml:async()=>{direct+=1;throw new Error('direct blocked');},renderHtml:async()=>{rendered+=1;return {url:'https://example.com/products/a',status:200,contentType:'text/html',html:'<h1>A</h1>',acquisition_channel:'rendered_html'};}});
  const page=await fetch('https://example.com/products/a',{...scope,force_rendered_channel:true});
  assert.equal(page.acquisition_channel,'rendered_html');assert.equal(direct,0);assert.equal(rendered,1);
});
