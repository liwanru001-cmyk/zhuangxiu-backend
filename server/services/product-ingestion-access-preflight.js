'use strict';

const { analyzePage } = require('./product-ingestion-source-analyzer');
const { classifyIngestionOutcome } = require('./product-ingestion-outcome-classifier');

const DEFAULT_BACKOFF_MS=60_000;
const MAX_BACKOFF_MS=15*60_000;

function retryAfterAt(headers = {}, now = Date.now()) {
  const raw=headers?.['retry-after'] ?? headers?.['Retry-After'];
  if(raw==null||String(raw).trim()==='')return null;
  const seconds=Number(String(raw).trim());
  if(Number.isFinite(seconds)&&seconds>=0)return new Date(now+seconds*1000).toISOString();
  const timestamp=Date.parse(String(raw));
  return Number.isFinite(timestamp)&&timestamp>now?new Date(timestamp).toISOString():null;
}

function boundedBackoffAt(attempt = 1, headers = {}, now = Date.now()) {
  const explicit=retryAfterAt(headers,now);if(explicit)return explicit;
  const delay=Math.min(MAX_BACKOFF_MS,DEFAULT_BACKOFF_MS*Math.max(1,5**Math.max(0,Number(attempt||1)-1)));
  return new Date(now+delay).toISOString();
}

async function preflightAccess(scope, options = {}) {
  const fetcher=options.fetchHtml;if(typeof fetcher!=='function')throw new Error('访问预检缺少受控页面读取器');
  const now=typeof options.now==='function'?options.now():Number(options.now??Date.now());
  const url=scope.base_url || scope.seed_urls?.[0];
  try{
    const page=await fetcher(url,scope),profile=analyzePage(page.html,page.url,page.status||200);
    if(profile.obstacle?.blocked){
      const outcome=classifyIngestionOutcome({...profile.obstacle,http_status:page.status},{stage:'access_preflight'});
      return {status:'blocked',url:page.url,outcome,profile};
    }
    if((profile.dynamic_signals||[]).includes('script_shell')){
      return {status:'channel_required',url:page.url,outcome:classifyIngestionOutcome({code:'JS_RENDER_REQUIRED',dynamic_signals:profile.dynamic_signals},{stage:'access_preflight'}),profile};
    }
    return {status:'ready',url:page.url,outcome:classifyIngestionOutcome({success:true},{stage:'access_preflight'}),profile};
  }catch(error){
    return {status:'failed',url,outcome:classifyIngestionOutcome(error,{stage:'access_preflight'}),error:{code:error.code||'ACCESS_PREFLIGHT_FAILED',message:String(error.message||error).slice(0,500),headers:error.response?.headers||{}},retry_after_at:retryAfterAt(error.response?.headers,now)};
  }
}

module.exports={preflightAccess,retryAfterAt,boundedBackoffAt,DEFAULT_BACKOFF_MS,MAX_BACKOFF_MS};
