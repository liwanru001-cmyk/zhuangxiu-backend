'use strict';

const { XMLParser } = require('fast-xml-parser');
const { controlledRequest, getRobotsPolicy } = require('./product-ingestion-fetch');
const { canRequest } = require('./product-ingestion-runtime-safety');

const DEFAULT_LIMITS=Object.freeze({maxDepth:3,maxFiles:20,maxXmlBytes:2*1024*1024,maxUrls:5000});

function canonical(raw, base) {
  const url=new URL(String(raw||'').trim(),base);
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port) throw new Error('网址格式不受支持');
  url.hash='';
  url.pathname=url.pathname.replace(/%[0-9a-f]{2}/gi,value=>value.toUpperCase());
  url.search=url.search.replace(/%[0-9a-f]{2}/gi,value=>value.toUpperCase());
  return url.toString();
}

function values(value) { return Array.isArray(value)?value:value==null?[]:[value]; }
function locValue(value) {
  const raw=typeof value==='object'?value?.['#text']||value?.text||'':value;
  // Entity expansion stays disabled in the XML parser. Decode only the five
  // predefined XML entities after parsing so query separators such as &amp;
  // cannot accidentally become part of a Sitemap URL.
  return String(raw||'').replace(/&(amp|lt|gt|quot|apos);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[name]);
}

function parseSitemapXml(buffer, sourceUrl) {
  const xml=Buffer.isBuffer(buffer)?buffer.toString('utf8'):String(buffer||'');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) { const error=new Error('Sitemap 包含 DTD 或外部实体声明，已拒绝解析');error.code='SITEMAP_UNSAFE_XML';throw error; }
  let parsed;
  try { parsed=new XMLParser({ignoreAttributes:false,processEntities:false,trimValues:true}).parse(xml); }
  catch (_) { const error=new Error('Sitemap XML 格式不正确');error.code='SITEMAP_INVALID_XML';throw error; }
  if (parsed?.sitemapindex) return {type:'index',urls:values(parsed.sitemapindex.sitemap).map(item=>locValue(item?.loc)).filter(Boolean).map(item=>canonical(item,sourceUrl))};
  if (parsed?.urlset) return {type:'urlset',urls:values(parsed.urlset.url).map(item=>locValue(item?.loc)).filter(Boolean).map(item=>canonical(item,sourceUrl))};
  const error=new Error('Sitemap 不是 sitemapindex 或 urlset');error.code='SITEMAP_UNSUPPORTED_XML';throw error;
}

function policyContext(scope, robotsPolicy) {
  return {purpose:'product',source_id:scope.source_id,job_id:scope.job_id,source_status:scope.source_status,
    job_status:scope.job_status,
    allowed_hosts:scope.allowed_hosts,allowed_path_prefixes:scope.allowed_path_prefixes,robots_policy:robotsPolicy,
    actual_request:false,request_interval_ms:scope.request_interval_ms};
}

async function discoverSitemapUrls(scope, limits = {}, dependencies = {}) {
  const getPolicy=dependencies.getRobotsPolicy||getRobotsPolicy,request=dependencies.controlledRequest||controlledRequest,gate=dependencies.canRequest||canRequest;
  const applied={...DEFAULT_LIMITS,...limits},robotsPolicy=await getPolicy(scope.base_url||scope.seed_urls[0],scope);
  const sitemapQuota={used:0,limit:applied.maxFiles};
  const fallback=canonical('/sitemap.xml',scope.base_url||scope.seed_urls[0]);
  const roots=[...new Set([...robotsPolicy.sitemaps,fallback])];
  const queue=roots.map(url=>({url,depth:0})),queued=new Set(roots),visited=[],products=[],productSet=new Set(),failures=[],denied={};
  while (queue.length && visited.length < applied.maxFiles && products.length < applied.maxUrls) {
    const item=queue.shift();
    if (/\.xml\.gz(?:$|\?)/i.test(item.url)) { failures.push({url:item.url,code:'SITEMAP_GZIP_UNSUPPORTED',message:'本轮不支持 .xml.gz Sitemap'});continue; }
    try {
      const response=await request(item.url,scope,{purpose:'sitemap',robotsPolicy,quota:sitemapQuota,maxBytes:applied.maxXmlBytes,timeoutMs:15000,accept:'application/xml,text/xml;q=0.9,text/plain;q=0.5'});
      visited.push(item.url);
      if (response.status < 200 || response.status >= 300) { failures.push({url:item.url,code:'SITEMAP_HTTP_STATUS',message:`Sitemap 返回 HTTP ${response.status}`});continue; }
      const parsed=parseSitemapXml(response.body,response.finalUrl);
      if (parsed.type === 'index') {
        if (item.depth >= applied.maxDepth) { failures.push({url:item.url,code:'SITEMAP_LIMIT_EXCEEDED',message:'Sitemap 递归深度已达上限'});continue; }
        for (const child of parsed.urls) {
          if (queued.has(child)) continue;
          if (queued.size >= applied.maxFiles) break;
          queued.add(child);queue.push({url:child,depth:item.depth+1});
        }
      } else {
        for (const candidate of parsed.urls) {
          if (productSet.has(candidate)||products.length>=applied.maxUrls) continue;
          const decision=await gate(candidate,policyContext(scope,robotsPolicy));
          if (!decision.allowed) { denied[decision.reason_code]=(denied[decision.reason_code]||0)+1;continue; }
          productSet.add(candidate);products.push(candidate);
        }
      }
    } catch (error) { failures.push({url:item.url,code:error.code||'SITEMAP_FETCH_FAILED',message:String(error.message||'Sitemap 处理失败').slice(0,300)}); }
  }
  return {urls:products,summary:{roots,files_scanned:visited.length,urls_found:products.length,denied,failures,
    capped_files:Boolean(queue.length&&visited.length>=applied.maxFiles),capped_urls:products.length>=applied.maxUrls,limits:applied}};
}

module.exports={discoverSitemapUrls,parseSitemapXml,canonical,DEFAULT_LIMITS};
