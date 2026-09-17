'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const { evaluateRobots }=require('../services/product-ingestion-robots-policy');
const { canRequest }=require('../services/product-ingestion-runtime-safety');
const { controlledRequest,storeRobotsSnapshot,robotsStatusError,robotsResponseDisposition }=require('../services/product-ingestion-fetch');
const { parseSitemapXml,discoverSitemapUrls,DEFAULT_LIMITS }=require('../services/product-ingestion-sitemap');

test('RFC-style robots matching fixes the Fendi /*? regression',async()=>{
  const robots=fs.readFileSync(require.resolve('./fixtures/fendicasa-robots-2026-09.txt'),'utf8');
  const plain=await evaluateRobots(robots,'https://www.fendicasa.com/products/xxx');
  const query=await evaluateRobots(robots,'https://www.fendicasa.com/products/xxx?variant=123');
  assert.equal(plain.allowed,true);
  assert.equal(query.allowed,false);
  assert.equal(query.matched_rule,'Disallow: /*?');
});

test('robots parser handles groups, wildcards, anchors, longest match, allow ties and URL encoding',async()=>{
  const longest='User-agent: *\nDisallow: /products/\nAllow: /products/public/\nDisallow: /*.pdf$';
  assert.equal((await evaluateRobots(longest,'https://example.com/products/public/chair')).allowed,true);
  assert.equal((await evaluateRobots(longest,'https://example.com/products/private/chair')).allowed,false);
  assert.equal((await evaluateRobots(longest,'https://example.com/files/spec.pdf')).allowed,false);
  assert.equal((await evaluateRobots('User-agent: *\nDisallow: /same\nAllow: /same','https://example.com/same')).allowed,true);
  assert.equal((await evaluateRobots('User-agent: OtherBot\nDisallow: /\nUser-agent: *\nAllow: /','https://example.com/x')).allowed,true);
  assert.equal((await evaluateRobots('User-agent: *\nDisallow: /caf%C3%A9','https://example.com/caf%c3%a9')).allowed,false);
});

const publicLookup=async()=>[{address:'8.8.8.8',family:4}];
const allowRobots={snapshotId:3,evaluate:async()=>({allowed:true,matched_rule:null})};

test('canRequest returns structured decisions for page, source, robots and asset boundaries',async()=>{
  const base={source_status:'active',job_status:'running',allowed_hosts:['example.com'],allowed_asset_hosts:['cdn.example.com'],allowed_path_prefixes:['/products/'],robots_policy:allowRobots,lookup:publicLookup};
  assert.equal((await canRequest('https://example.com/products/chair',{...base,purpose:'product'})).reason_code,'POLICY_ALLOWED');
  assert.equal((await canRequest('https://example.com/about',{...base,purpose:'page'})).reason_code,'PATH_NOT_ALLOWED');
  assert.equal((await canRequest('https://cdn.example.com/a.jpg',{...base,job_status:'completed',purpose:'asset'})).allowed,true);
  assert.equal((await canRequest('https://cdn.example.com/a.jpg',{...base,job_status:'running',purpose:'asset'})).reason_code,'JOB_NOT_EXECUTABLE');
  assert.equal((await canRequest('https://cdn.example.com/a.jpg',{...base,job_status:'running',purpose:'asset',candidate_publish_authorized:true})).allowed,true);
  assert.equal((await canRequest('https://example.com/a.jpg',{...base,job_status:'completed',purpose:'asset'})).reason_code,'ASSET_HOST_NOT_ALLOWED');
  assert.equal((await canRequest('https://example.com/products/chair',{...base,source_status:'paused',purpose:'product'})).reason_code,'SOURCE_NOT_ACTIVE');
  assert.equal((await canRequest('https://example.com/products/chair',{...base,robots_policy:{evaluate:async()=>({allowed:false,matched_rule:'Disallow: /products/'})},purpose:'product'})).reason_code,'ROBOTS_DISALLOW');
  assert.equal((await canRequest('https://example.com/products/chair',{...base,purpose:'product',authorize:async()=>({source_status:'paused',job_status:'running'})})).reason_code,'SOURCE_NOT_ACTIVE');
});

test('canRequest enforces logical request quotas but does not double-charge redirects',async()=>{
  const quota={used:0,limit:1},base={purpose:'page',source_status:'active',job_status:'running',allowed_hosts:['example.com'],allowed_path_prefixes:['/'],robots_policy:allowRobots,lookup:publicLookup,actual_request:true,request_interval_ms:0,quota};
  assert.equal((await canRequest('https://example.com/a',base)).allowed,true);
  assert.equal((await canRequest('https://example.com/b',{...base,redirect_from:'https://example.com/a'})).allowed,true);
  assert.equal((await canRequest('https://example.com/c',base)).reason_code,'REQUEST_QUOTA_EXCEEDED');
});

test('every redirect is checked again without losing the original request purpose',async()=>{
  let requests=0;
  const scope={source_status:'active',job_status:'running',allowed_hosts:['example.com'],allowed_path_prefixes:['/'],request_interval_ms:0};
  const requester=async()=>{requests+=1;return {status:302,headers:{location:'https://outside.example/product'},body:Buffer.alloc(0)};};
  await assert.rejects(()=>controlledRequest('https://example.com/start',scope,{purpose:'page',robotsPolicy:allowRobots,lookup:publicLookup,requester}),error=>error.code==='DOMAIN_NOT_ALLOWED');
  assert.equal(requests,1);
});

test('redirect to a private IP is blocked before the second request',async()=>{
  let requests=0;
  const scope={source_status:'active',job_status:'running',allowed_hosts:['example.com','127.0.0.1'],allowed_path_prefixes:['/'],request_interval_ms:0};
  const requester=async()=>{requests+=1;return {status:302,headers:{location:'http://127.0.0.1/internal'},body:Buffer.alloc(0)};};
  const lookup=async hostname=>[{address:hostname==='127.0.0.1'?'127.0.0.1':'8.8.8.8',family:4}];
  await assert.rejects(()=>controlledRequest('https://example.com/start',scope,{purpose:'page',robotsPolicy:allowRobots,lookup,requester}),error=>error.code==='SSRF_BLOCKED');
  assert.equal(requests,1);
});

test('actual request decisions are auditable while candidate filtering stays unsaved',async()=>{
  const queries=[];
  const db={query:async(sql,params)=>{queries.push({sql,params});return [{insertId:1}];}};
  const context={purpose:'product',source_id:2,job_id:8,source_status:'active',job_status:'running',allowed_hosts:['example.com'],allowed_path_prefixes:['/'],robots_policy:allowRobots,lookup:publicLookup,actual_request:true,request_interval_ms:0,db};
  assert.equal((await canRequest('https://example.com/products/a',context)).allowed,true);
  await canRequest('https://example.com/products/b',{...context,actual_request:false});
  assert.equal(queries.length,1);
  assert.match(queries[0].sql,/product_ingestion_request_decisions/);
});

test('robots snapshots are content-hash deduplicated and retain parser evidence',async()=>{
  let captured;
  const db={query:async(sql,params)=>{captured={sql,params};return [{insertId:7}];}};
  const id=await storeRobotsSnapshot({source_id:2,policy_db:db},{host:'example.com',fetchedUrl:'https://example.com/robots.txt',finalUrl:'https://example.com/robots.txt',status:200,hash:'a'.repeat(64),content:'User-agent: *\nDisallow:',etag:'x',lastModified:'today'});
  assert.equal(id,7);
  assert.match(captured.sql,/ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID/);
  assert.equal(captured.params.at(-2),'google-robotstxt-parser');
  assert.equal(captured.params.at(-1),'1.2.0');
  assert.equal(robotsStatusError(403).code,'ROBOTS_ACCESS_DENIED');
  assert.equal(robotsStatusError(429).code,'ROBOTS_RATE_LIMITED');
  assert.equal(robotsStatusError(503).code,'ROBOTS_SERVER_ERROR');
});

test('robots response policy follows RFC 9309 without weakening rate limits or server failures',()=>{
  assert.equal(robotsResponseDisposition(200),'loaded');
  assert.equal(robotsResponseDisposition(401),'unavailable');
  assert.equal(robotsResponseDisposition(403),'unavailable');
  assert.equal(robotsResponseDisposition(404),'unavailable');
  assert.equal(robotsResponseDisposition(429),'error');
  assert.equal(robotsResponseDisposition(503),'error');
});

test('Sitemap parser supports indexes and urlsets and rejects DTD or entities',()=>{
  assert.deepEqual(parseSitemapXml('<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>','https://example.com/sitemap.xml'),{type:'index',urls:['https://example.com/a.xml']});
  assert.deepEqual(parseSitemapXml('<urlset><url><loc>https://example.com/products/a</loc></url></urlset>','https://example.com/sitemap.xml'),{type:'urlset',urls:['https://example.com/products/a']});
  assert.deepEqual(parseSitemapXml('<sitemapindex><sitemap><loc>https://example.com/products.xml?from=1&amp;to=9</loc></sitemap></sitemapindex>','https://example.com/sitemap.xml'),{type:'index',urls:['https://example.com/products.xml?from=1&to=9']});
  assert.throws(()=>parseSitemapXml('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset/>','https://example.com/sitemap.xml'),error=>error.code==='SITEMAP_UNSAFE_XML');
  assert.equal(DEFAULT_LIMITS.maxDepth,3);
  assert.equal(DEFAULT_LIMITS.maxFiles,20);
});

test('Sitemap candidates pass through canRequest and offsite candidates are denied',async()=>{
  const calls=[],gated=[];
  const policy={sitemaps:['https://example.com/root.xml'],evaluate:async()=>({allowed:true})};
  const xml={
    'https://example.com/root.xml':'<sitemapindex><sitemap><loc>https://example.com/products.xml</loc></sitemap></sitemapindex>',
    'https://example.com/products.xml':'<urlset><url><loc>https://example.com/products/a</loc></url><url><loc>https://outside.example/products/b</loc></url></urlset>',
    'https://example.com/sitemap.xml':'<urlset></urlset>',
  };
  const request=async(url,_scope,options)=>{calls.push({url,purpose:options.purpose});return {status:200,headers:{},body:Buffer.from(xml[url]),finalUrl:url};};
  const gate=async url=>{gated.push(url);return {allowed:new URL(url).hostname==='example.com',reason_code:'DOMAIN_NOT_ALLOWED'};};
  const scope={base_url:'https://example.com/',seed_urls:['https://example.com/'],source_status:'active',job_status:'discovering',allowed_hosts:['example.com'],allowed_path_prefixes:['/'],request_interval_ms:0};
  const result=await discoverSitemapUrls(scope,{}, {getRobotsPolicy:async()=>policy,controlledRequest:request,canRequest:gate});
  assert.deepEqual(result.urls,['https://example.com/products/a']);
  assert.equal(result.summary.denied.DOMAIN_NOT_ALLOWED,1);
  assert.equal(gated.length,2);
  assert.ok(calls.every(item=>item.purpose==='sitemap'));
});

test('compressed Sitemap is reported unsupported instead of being silently parsed',async()=>{
  const scope={base_url:'https://example.com/',seed_urls:['https://example.com/']};
  const result=await discoverSitemapUrls(scope,{}, {getRobotsPolicy:async()=>({sitemaps:['https://example.com/products.xml.gz']}),controlledRequest:async()=>{throw new Error('must not request gzip');}});
  assert.equal(result.summary.failures[0].code,'SITEMAP_GZIP_UNSUPPORTED');
});
