'use strict';

const http = require('http');
const https = require('https');
const { canRequest, policyError, isBlockedAddress, publicAddresses } = require('./product-ingestion-runtime-safety');
const { USER_AGENT_TOKEN, PARSER_NAME, PARSER_VERSION, evaluateRobots, sitemapDirectives, contentHash } = require('./product-ingestion-robots-policy');

const USER_AGENT = `${USER_AGENT_TOKEN}/1.0`;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const ROBOTS_TTL_MS = 60 * 60 * 1000;
const ROBOTS_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const robotsCache = new Map();

function requestOnce(url, { maxBytes, timeoutMs, accept, method = 'GET', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
    const req = client.request(url, {
      method, headers:{
        'User-Agent':USER_AGENT,
        Accept:accept || 'text/html,application/xhtml+xml,text/plain;q=0.8',
        'Accept-Language':'zh-CN,zh;q=0.9,en;q=0.5',
        'Accept-Encoding':'identity',
        ...headers,
      },
      lookup(hostname, options, callback) {
        publicAddresses(hostname).then(results => {
          if (options?.all) callback(null, results);
          else callback(null, results[0].address, results[0].family);
        }).catch(callback);
      },
    }, response => {
      const chunks=[]; let total=0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          const error=new Error(`网页超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 限制`); error.code='BODY_TOO_LARGE';
          finish(reject,error);
        } else chunks.push(chunk);
      });
      response.on('end',()=>finish(resolve,{status:Number(response.statusCode||0),headers:response.headers,body:Buffer.concat(chunks)}));
      response.on('error',error=>finish(reject,error));
    });
    req.setTimeout(timeoutMs,()=>{const error=new Error('网页请求超时');error.code='FETCH_TIMEOUT';req.destroy(error);});
    req.on('error',error=>finish(reject,error));
    req.end(body == null ? undefined : body);
  });
}

function contextFor(scope, options, redirectFrom) {
  const purpose=options.purpose || 'page';
  return {
    purpose, source_id:scope.source_id, job_id:scope.job_id,
    source_status:scope.source_status, job_status:scope.job_status,
    allowed_hosts:scope.allowed_hosts, allowed_asset_hosts:scope.allowed_asset_hosts,
    allowed_path_prefixes:scope.allowed_path_prefixes, robots_policy:options.robotsPolicy,
    robots_snapshot_id:options.robotsPolicy?.snapshotId || null, redirect_from:redirectFrom || null,
    actual_request:options.actualRequest !== false, request_interval_ms:scope.request_interval_ms,
    quota:options.quota || (['page','product'].includes(purpose)?scope.page_quota:purpose==='asset'?scope.asset_quota:null),
    db:scope.policy_db, authorize:scope.policy_authorizer, lookup:options.lookup,
    method:options.method || 'GET', read_only_post_approved:options.readOnlyPostApproved === true,
    candidate_publish_authorized:scope.candidate_publish_authorized === true,
  };
}

async function controlledRequest(raw, scope, options = {}, redirectCount = 0, redirectFrom = null) {
  const checked=await canRequest(raw,contextFor(scope,options,redirectFrom));
  if (!checked.allowed) throw policyError(checked);
  const url=new URL(checked.url);
  const requester=options.requester||requestOnce;
  const method=String(options.method||'GET').toUpperCase();
  const response=await requester(url,{maxBytes:options.maxBytes||MAX_HTML_BYTES,timeoutMs:options.timeoutMs||15000,accept:options.accept,method,body:options.body,headers:options.headers});
  if ([301,302,303,307,308].includes(response.status) && response.headers.location) {
    if (method !== 'GET') { const error=new Error('只读 POST 不允许跟随重定向');error.code='READ_ONLY_POST_REDIRECT_DENIED';throw error; }
    if (redirectCount >= 3) { const error=new Error('网页重定向次数过多');error.code='TOO_MANY_REDIRECTS';throw error; }
    const next=new URL(response.headers.location,url).toString();
    return controlledRequest(next,scope,options,redirectCount+1,url.toString());
  }
  return {...response,finalUrl:url.toString()};
}

async function storeRobotsSnapshot(scope, record) {
  if (!scope.policy_db || !scope.source_id) return null;
  try {
    const [stored]=await scope.policy_db.query(`INSERT INTO product_ingestion_robots_snapshots
      (source_id,host,fetched_url,final_url,status_code,content_hash,content,etag,last_modified,parser_name,parser_version,fetched_at,last_checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())
      ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),final_url=VALUES(final_url),status_code=VALUES(status_code),etag=VALUES(etag),last_modified=VALUES(last_modified),last_checked_at=NOW()`,
    [scope.source_id,record.host,record.fetchedUrl,record.finalUrl,record.status,record.hash,record.content,record.etag||null,record.lastModified||null,PARSER_NAME,PARSER_VERSION]);
    return Number(stored.insertId || 0) || null;
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}

function robotsStatusError(status, headers = {}) {
  let code='ROBOTS_FETCH_FAILED',message=`robots.txt 返回 HTTP ${status}`;
  if ([401,403].includes(status)) { code='ROBOTS_ACCESS_DENIED'; message=`robots.txt 返回 HTTP ${status}，需要人工复核`; }
  else if (status === 429) { code='ROBOTS_RATE_LIMITED'; message='robots.txt 返回 HTTP 429，已停止访问'; }
  else if (status >= 500) { code='ROBOTS_SERVER_ERROR'; message=`robots.txt 返回 HTTP ${status}，官网暂时不可用`; }
  const error=new Error(message);error.code=code;error.status=409;error.response={status,headers};return error;
}

function robotsResponseDisposition(status){
  const value=Number(status||0);
  if(value>=200&&value<300)return 'loaded';
  if(value>=400&&value<500&&value!==429)return 'unavailable';
  return 'error';
}

async function getRobotsPolicy(raw, scope) {
  const target=new URL(raw),host=target.hostname.toLowerCase(),cacheKey=`${scope.source_id||'none'}:${host}`;
  const cached=robotsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.policy;
  const fetchedUrl=`${target.protocol}//${target.host}/robots.txt`;
  const response=await controlledRequest(fetchedUrl,scope,{purpose:'robots_bootstrap',maxBytes:MAX_ROBOTS_BYTES,timeoutMs:10000});
  const disposition=robotsResponseDisposition(response.status),unavailable=disposition==='unavailable';
  const content=unavailable?'':response.body.toString('utf8');
  const record={host,fetchedUrl,finalUrl:response.finalUrl,status:response.status,content,hash:contentHash(content),etag:response.headers.etag,lastModified:response.headers['last-modified']};
  const snapshotId=await storeRobotsSnapshot(scope,record);
  if(disposition==='error')throw robotsStatusError(response.status,response.headers);
  // RFC 9309 section 2.3.1.4 treats non-429 4xx responses as an unavailable
  // robots resource, not as a published Disallow rule. Continue only through
  // the ordinary page policy gate; a 403/429/5xx on the page itself still stops.
  const policy={host,status:unavailable?'robots_unavailable_4xx':'loaded',statusCode:response.status,content,contentHash:record.hash,snapshotId,
    fallback:unavailable?'rfc9309_unavailable_4xx':null,
    sitemaps:sitemapDirectives(content,response.finalUrl),evaluate:url=>evaluateRobots(content,url,USER_AGENT_TOKEN)};
  robotsCache.set(cacheKey,{policy,expiresAt:Date.now()+ROBOTS_TTL_MS,staleUntil:Date.now()+ROBOTS_STALE_TTL_MS});
  return policy;
}

async function assertRobotsAllows(raw, scope) {
  const policy=await getRobotsPolicy(raw,scope),result=await policy.evaluate(raw);
  if (!result.allowed) throw policyError({...result,reason_text:'robots.txt 不允许抓取该路径'});
  return {policy,result};
}

async function fetchHtml(raw, scope) {
  const robotsPolicy=await getRobotsPolicy(raw,scope);
  const response=await controlledRequest(raw,scope,{purpose:'page',robotsPolicy});
  if (response.status < 200 || response.status >= 300) { const error=new Error(`页面返回 HTTP ${response.status}`);error.code='PAGE_HTTP_STATUS';error.response=response;throw error; }
  const contentType=String(response.headers['content-type']||'').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    const error=new Error(`目标不是 HTML 页面：${contentType||'未知类型'}`);error.code='NOT_HTML';error.response=response;throw error;
  }
  return {url:response.finalUrl,status:response.status,contentType,html:response.body.toString('utf8')};
}

module.exports={fetchHtml,controlledRequest,assertRobotsAllows,getRobotsPolicy,storeRobotsSnapshot,robotsStatusError,robotsResponseDisposition,isBlockedAddress,publicAddresses,MAX_HTML_BYTES,MAX_ROBOTS_BYTES};
