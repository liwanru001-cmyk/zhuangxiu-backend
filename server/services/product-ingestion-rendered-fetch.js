'use strict';

const fs=require('fs');
const {getDomain}=require('tldts');
const {fetchHtml,getRobotsPolicy}=require('./product-ingestion-fetch');
const {canRequest,publicAddresses,pathAllowedByPrefixes,auditDecision}=require('./product-ingestion-runtime-safety');
const {analyzePage}=require('./product-ingestion-source-analyzer');

const MAX_RENDERED_BYTES=5*1024*1024;
const DEFAULT_EXECUTABLES=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];

function executablePath(env=process.env){const configured=String(env.INGESTION_CHROME_PATH||'').trim();if(configured&&fs.existsSync(configured))return configured;return DEFAULT_EXECUTABLES.find(item=>fs.existsSync(item))||null;}
function lists(value){if(Array.isArray(value))return value.map(item=>String(item).toLowerCase());try{return JSON.parse(value||'[]').map(item=>String(item).toLowerCase());}catch{return [];}}
function sameRegistrableDomain(left,right){const a=getDomain(String(left||''),{allowPrivateDomains:false}),b=getDomain(String(right||''),{allowPrivateDomains:false});return Boolean(a&&b&&a===b);}
function allowedSubresource(raw,scope){try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return false;const hosts=new Set([...lists(scope.allowed_hosts),...lists(scope.allowed_asset_hosts)]);if(hosts.has(url.hostname.toLowerCase()))return true;if(scope.allow_same_site_subresources!==true)return false;const baseHost=new URL(scope.base_url||scope.seed_urls?.[0]).hostname;return sameRegistrableDomain(url.hostname,baseHost);}catch{return false;}}
function allowedDocument(raw,scope){try{const url=new URL(raw);return lists(scope.allowed_hosts).includes(url.hostname.toLowerCase())&&pathAllowedByPrefixes(url.pathname,Array.isArray(scope.allowed_path_prefixes)?scope.allowed_path_prefixes:JSON.parse(scope.allowed_path_prefixes||'[]'));}catch{return false;}}

function safePublicApiUrl(raw){try{const url=new URL(raw),sensitive=/token|auth|session|signature|secret|password|cookie|key/i;if(url.username||url.password||url.port||url.protocol!=='https:'||[...url.searchParams.keys()].some(key=>sensitive.test(key)))return null;url.hash='';return url.toString();}catch{return null;}}
function compactJson(value,depth=0){if(depth>5)return '[truncated]';if(value==null||typeof value==='boolean'||typeof value==='number')return value;if(typeof value==='string')return value.slice(0,500);if(Array.isArray(value))return value.slice(0,5).map(item=>compactJson(item,depth+1));if(typeof value==='object'){const result={},keys=Object.keys(value),semantic=/id|name|title|brief|description|model|sku|(?:^|_)bn$|category|image|pic|gallery|spec|variant|option|color|colour|material|finish|dimension|size/i,ranked=[...keys.filter(key=>semantic.test(key)),...keys.filter(key=>!semantic.test(key))];for(const key of [...new Set(ranked)].slice(0,50))result[key]=compactJson(value[key],depth+1);return result;}return String(value).slice(0,200);}
function jsonArrayCandidates(value,path='',depth=0,result=[]){if(depth>6||value==null)return result;if(Array.isArray(value)){if(value.length&&value.every(item=>item&&typeof item==='object'&&!Array.isArray(item)))result.push({path,count:value.length,sample_records:value.slice(0,5).map(item=>compactJson(item))});return result;}if(typeof value==='object')for(const [key,child] of Object.entries(value))jsonArrayCandidates(child,path?`${path}.${key}`:key,depth+1,result);return result;}

async function renderHtml(raw,scope,options={}){
  const path=options.executablePath||executablePath(options.env);if(!path){const error=new Error('当前服务器没有配置受控 Chromium 渲染器');error.code='JS_RENDERER_UNAVAILABLE';throw error;}
  let chromium=options.chromium;if(!chromium){try{chromium=require('playwright-core').chromium;}catch{const error=new Error('当前服务器没有可用的 Chromium 渲染运行时');error.code='JS_RENDERER_UNAVAILABLE';throw error;}}
  const browser=await chromium.launch({headless:true,executablePath:path,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  let context;
  try{
    context=await browser.newContext({javaScriptEnabled:true,serviceWorkers:'block',acceptDownloads:false,locale:'zh-CN'});
    const page=await context.newPage(),checkedHosts=new Set(),apiEvidence=[],captureTasks=[];let apiCaptureScheduled=0;
    if(scope.capture_public_json_api===true)page.on('response',response=>{
      const request=response.request(),resource=request.resourceType(),url=safePublicApiUrl(response.url());
      if(!url||request.method()!=='GET'||!['xhr','fetch'].includes(resource)||apiEvidence.length>=8||apiCaptureScheduled>=30)return;
      apiCaptureScheduled+=1;
      captureTasks.push((async()=>{try{
        const headers=await response.allHeaders(),type=String(headers['content-type']||'').toLowerCase(),origin=new URL(scope.base_url||scope.seed_urls?.[0]).origin,cors=String(headers['access-control-allow-origin']||'');
        if(response.status()<200||response.status()>=300||!type.includes('json')||!(cors==='*'||cors===origin)||!sameRegistrableDomain(new URL(url).hostname,new URL(origin).hostname))return;
        const body=await response.body();if(body.length>1024*1024)return;const parsed=JSON.parse(body.toString('utf8')),arrays=jsonArrayCandidates(parsed).sort((a,b)=>b.count-a.count);
        if(!arrays.length)return;apiEvidence.push({evidence_id:`API-${String(apiEvidence.length+1).padStart(3,'0')}`,url,status:response.status(),content_type:type,cors,arrays:arrays.slice(0,5),response_sample:compactJson(parsed)});
      }catch{}})());
    });
    await page.route('**/*',async route=>{
      const request=route.request(),url=request.url(),method=request.method().toUpperCase(),document=request.isNavigationRequest()&&request.resourceType()==='document';
      try{
        if(method!=='GET'||(document?!allowedDocument(url,scope):!allowedSubresource(url,scope)))return route.abort('blockedbyclient');
        const target=new URL(url);if(!checkedHosts.has(target.hostname)){await publicAddresses(target.hostname);checkedHosts.add(target.hostname);}
        if(document){
          const robotsPolicy=await getRobotsPolicy(url,scope),decision=await canRequest(url,{purpose:'page',source_id:scope.source_id,job_id:scope.job_id,source_status:scope.source_status,job_status:scope.job_status,allowed_hosts:scope.allowed_hosts,allowed_asset_hosts:scope.allowed_asset_hosts,allowed_path_prefixes:scope.allowed_path_prefixes,robots_policy:robotsPolicy,robots_snapshot_id:robotsPolicy.snapshotId,actual_request:true,request_interval_ms:scope.request_interval_ms,quota:scope.page_quota,db:scope.policy_db,authorize:scope.policy_authorizer,method:'GET'});
          if(!decision.allowed)return route.abort('blockedbyclient');
        }else await auditDecision({actual_request:true,db:scope.policy_db,source_id:scope.source_id,job_id:scope.job_id,purpose:'render_subresource'},url,{decision:'ALLOW',reason_code:'RENDER_SUBRESOURCE_ALLOWED',reason_text:'受控渲染子资源域名已授权'});
        return route.continue();
      }catch{return route.abort('blockedbyclient');}
    });
    const response=await page.goto(String(raw),{waitUntil:'domcontentloaded',timeout:Number(options.timeoutMs||30_000)});
    await page.waitForLoadState('networkidle',{timeout:Math.min(5000,Number(options.timeoutMs||30_000))}).catch(()=>{});
    if(captureTasks.length)await Promise.allSettled(captureTasks);
    const status=Number(response?.status()||0),headers=await response?.allHeaders?.()||{};
    if(status<200||status>=300){const error=new Error(`渲染页面返回 HTTP ${status}`);error.code='PAGE_HTTP_STATUS';error.response={status,headers};throw error;}
    const html=await page.content();if(Buffer.byteLength(html)>MAX_RENDERED_BYTES){const error=new Error('渲染网页超过 5MB 限制');error.code='BODY_TOO_LARGE';throw error;}
    return {url:page.url(),status,contentType:String(headers['content-type']||'text/html').toLowerCase(),html,acquisition_channel:'rendered_html',public_json_api_evidence:apiEvidence};
  }finally{await context?.close().catch(()=>{});await browser.close().catch(()=>{});}
}

function createHybridFetcher(options={}){
  const direct=options.fetchHtml||fetchHtml,render=options.renderHtml||renderHtml;
  return async function hybridFetch(raw,scope){
    if(scope.force_rendered_channel===true)return render(raw,scope,options.renderOptions||{});
    const page=await direct(raw,scope),profile=analyzePage(page.html,page.url,page.status||200);
    if(!(profile.dynamic_signals||[]).includes('script_shell'))return page;
    return render(raw,scope,options.renderOptions||{});
  };
}

module.exports={renderHtml,createHybridFetcher,executablePath,allowedSubresource,allowedDocument,sameRegistrableDomain,safePublicApiUrl,compactJson,jsonArrayCandidates,MAX_RENDERED_BYTES};
