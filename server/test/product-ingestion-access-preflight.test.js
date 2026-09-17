'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {preflightAccess,retryAfterAt,boundedBackoffAt}=require('../services/product-ingestion-access-preflight');
const {transition,auditTopology}=require('../services/product-ingestion-site-cognition-state');

const scope={base_url:'https://example.com/',seed_urls:['https://example.com/']};

test('access preflight classifies static, rendered, restricted and rate-limited sites without brand rules',async()=>{
  const ready=await preflightAccess(scope,{fetchHtml:async()=>({url:scope.base_url,status:200,html:'<html><body><h1>Furniture</h1><a href="/products">Products</a></body></html>'})});
  assert.equal(ready.outcome.category,'SUCCESS');
  const rendered=await preflightAccess(scope,{fetchHtml:async()=>({url:scope.base_url,status:200,html:'<html><body><div id="app"></div><script src="/app.js"></script></body></html>'})});
  assert.equal(rendered.outcome.category,'JS_RENDER_REQUIRED');
  const denied=await preflightAccess(scope,{fetchHtml:async()=>{const error=new Error('forbidden');error.code='PAGE_HTTP_STATUS';error.response={status:403,headers:{}};throw error;}});
  assert.equal(denied.outcome.category,'ACCESS_RESTRICTED');
  const limited=await preflightAccess(scope,{now:0,fetchHtml:async()=>{const error=new Error('limited');error.code='PAGE_HTTP_STATUS';error.response={status:429,headers:{'retry-after':'120'}};throw error;}});
  assert.equal(limited.outcome.category,'RATE_LIMITED');
  assert.equal(limited.retry_after_at,'1970-01-01T00:02:00.000Z');
});

test('retry-after supports seconds and HTTP dates and fallback remains bounded',()=>{
  const now=Date.parse('2026-09-16T00:00:00Z');
  assert.equal(retryAfterAt({'retry-after':'60'},now),'2026-09-16T00:01:00.000Z');
  assert.equal(retryAfterAt({'Retry-After':'Wed, 16 Sep 2026 00:05:00 GMT'},now),'2026-09-16T00:05:00.000Z');
  assert.equal(boundedBackoffAt(1,{},now),'2026-09-16T00:01:00.000Z');
  assert.equal(boundedBackoffAt(9,{},now),'2026-09-16T00:15:00.000Z');
});

test('access states have explicit wait, alternate-channel and safe-stop exits',()=>{
  assert.equal(transition('RULE_CHECKING','NO_RULE').to,'ACCESS_PREFLIGHT');
  assert.equal(transition('ACCESS_PREFLIGHT','RATE_LIMITED').to,'RATE_LIMIT_WAITING');
  assert.equal(transition('RATE_LIMIT_WAITING','WAIT_EXPIRED').to,'ACCESS_PREFLIGHT');
  assert.equal(transition('ACCESS_PREFLIGHT','ACCESS_RESTRICTED').to,'BOUNDED_EVIDENCE_REQUIRED');
  assert.equal(transition('ACCESS_PREFLIGHT','JS_REQUIRED').to,'JS_CHANNEL_REQUIRED');
  assert.equal(auditTopology().valid,true);
});
