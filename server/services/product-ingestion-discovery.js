'use strict';

const { fetchHtml } = require('./product-ingestion-fetch');
const { validateUrlAgainstSource } = require('./product-ingestion-control');
const { accessObstacle, assessProductUrl, assessProductPage, directoryPriority, analyzePage, summarizeAnalysis } = require('./product-ingestion-source-analyzer');
const { classifyIngestionOutcome } = require('./product-ingestion-outcome-classifier');

function hrefs(html, pageUrl) { return pageLinks(html,pageUrl).map(item=>item.url); }
function pageLinks(html, pageUrl) {
  const result=[];
  for(const match of String(html||'').matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)){
    try{const url=new URL(match[2].replace(/&amp;/g,'&'),pageUrl);if(!['http:','https:'].includes(url.protocol))continue;url.hash='';result.push({url,text:String(match[3]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,200)});}catch(_){}
  }
  return result;
}
function canonical(raw){const url=new URL(raw);url.hash='';url.searchParams.delete('lg');return url.toString();}
function isLikelyDetail(url,anchorText=''){return assessProductUrl(url,anchorText).is_product;}
function isCrawlablePage(url){return directoryPriority(url).score>=0;}
function pageIsProduct(html,url){return assessProductPage(html,url).is_product;}
function pageObstacle(html,url='',status=200){return accessObstacle(html,url,status).message;}
function fetchFailure(error){
  const status=Number(error?.response?.status||0)||null,code=String(error?.code||'');
  if([401,403].includes(status))return `\u9875\u9762\u8fd4\u56de HTTP ${status}\uff0c\u53ef\u80fd\u9700\u8981\u767b\u5f55\u3001\u6388\u6743\u6216\u7f51\u7ad9\u62d2\u7edd\u8bbf\u95ee`;
  if(status===429)return '\u9875\u9762\u8fd4\u56de HTTP 429\uff0c\u8bf7\u6c42\u53d7\u5230\u9891\u7387\u9650\u5236';
  if(status>=500)return `\u9875\u9762\u8fd4\u56de HTTP ${status}\uff0c\u5b98\u7f51\u670d\u52a1\u5668\u6682\u65f6\u4e0d\u53ef\u7528`;
  if(code==='ENOTFOUND')return '\u65e0\u6cd5\u89e3\u6790\u5b98\u7f51\u57df\u540d\uff08DNS \u67e5\u8be2\u5931\u8d25\uff09';
  if(['ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(code))return `\u8fde\u63a5\u5b98\u7f51\u5931\u8d25\uff08${code}\uff09`;
  return String(error?.message||'\u9875\u9762\u8bbf\u95ee\u5931\u8d25').slice(0,300);
}
const universalAdapter={isDetail:isLikelyDetail,isDirectory:isCrawlablePage,contentUrl:raw=>raw,category:()=>null};
const adapters={universal_web_v1:universalAdapter};
function adapterFor(key){const adapter=adapters[key];if(!adapter){const error=new Error('\u4efb\u52a1\u4e0d\u662f\u5f53\u524d\u7684\u901a\u7528\u7f51\u7ad9\u89e3\u6790\u7248\u672c\uff0c\u8bf7\u91cd\u65b0\u6388\u6743\u540e\u518d\u8bd5');error.status=409;throw error;}return adapter;}

async function discoverProducts(scope,fetcher=fetchHtml,onProgress=async()=>{},options={}){
  const adapter=adapterFor(scope.adapter_key);
  const checkpoint=options.checkpoint&&options.checkpoint.version===1?options.checkpoint:null;
  const queue=checkpoint?.queue||scope.seed_urls.map(url=>({url:canonical(url),priority:1000,origin:'seed'}));
  const queued=new Set(checkpoint?.queued||queue.map(item=>item.url)),visited=checkpoint?.visited||[],products=new Set(checkpoint?.products||[]),failures=checkpoint?.failures||[],pageProfiles=checkpoint?.page_profiles||[];
  const excluded=checkpoint?.excluded||{out_of_scope:0,unrelated:0};
  const categoryEvidence=new Map((checkpoint?.category_evidence||[]).map(([url,values])=>[url,new Map(values)])),productEvidence=new Map(checkpoint?.product_evidence||[]);
  const evidenceSnapshots=checkpoint?.evidence_snapshots||[];
  let pageLimitReached=Boolean(checkpoint?.page_limit_reached),attempted=Number(checkpoint?.attempted||0),possibleDynamicShells=Number(checkpoint?.possible_dynamic_shells||0),sitemapSummary=checkpoint?.sitemap_summary||null,sitemapInitialized=Boolean(checkpoint?.sitemap_initialized);
  const enqueue=(raw,priority,origin)=>{const normalized=canonical(raw);if(queued.has(normalized))return false;queued.add(normalized);queue.push({url:normalized,priority,origin});return true;};
  const next=()=>{queue.sort((a,b)=>b.priority-a.priority);return queue.shift();};
  const addProduct=(raw,assessment,origin)=>{const normalized=canonical(raw);products.add(normalized);productEvidence.set(normalized,{score:assessment?.score||0,evidence:assessment?.evidence||[],origin});};
  const durableCheckpoint=()=>({version:1,mode:'generic',queue,queued:[...queued],visited,products:[...products],failures,page_profiles:pageProfiles,excluded,category_evidence:[...categoryEvidence].map(([url,values])=>[url,[...values]]),product_evidence:[...productEvidence],evidence_snapshots:evidenceSnapshots,page_limit_reached:pageLimitReached,attempted,possible_dynamic_shells:possibleDynamicShells,sitemap_summary:sitemapSummary,sitemap_initialized:sitemapInitialized});
  const progress=()=>onProgress({pages_scanned:visited.length,pages_attempted:attempted,products_found:products.size,failures:failures.length,checkpoint:durableCheckpoint()});

  if(!sitemapInitialized&&typeof options.sitemapDiscoverer==='function'){
    try{
      const sitemap=await options.sitemapDiscoverer(scope);sitemapSummary=sitemap.summary;
      for(const raw of sitemap.urls||[]){
        if(products.size>=scope.max_products)break;
        const url=new URL(raw),normalized=canonical(url),product=assessProductUrl(url),directory=directoryPriority(url);
        if(product.is_product)addProduct(normalized,product,'sitemap');
        else if(adapter.isDirectory(url)&&attempted+queue.length<scope.max_pages)enqueue(normalized,directory.score,'sitemap');
      }
    }catch(error){sitemapSummary={files_scanned:0,urls_found:0,failures:[{code:error.code||'SITEMAP_DISCOVERY_FAILED',message:String(error.message||'Sitemap \u53d1\u73b0\u5931\u8d25').slice(0,300)}]};}
    sitemapInitialized=true;await progress();
  }

  while(queue.length&&attempted<scope.max_pages&&products.size<scope.max_products){
    const queuedPage=next(),pageUrl=queuedPage.url;attempted+=1;let page;
    try{page=await fetcher(adapter.contentUrl(pageUrl),scope);}
    catch(error){if(['JOB_NOT_EXECUTABLE','JOB_INTERRUPTED'].includes(error?.code))throw error;failures.push({stage:'fetch',code:error?.code||'PAGE_FETCH_FAILED',url:pageUrl,status:error?.response?.status||null,message:fetchFailure(error),outcome:classifyIngestionOutcome(error,{stage:'url_discovery'})});await progress();continue;}
    visited.push(canonical(pageUrl));
    if(evidenceSnapshots.length<5){
      const html=String(page.html||'');
      evidenceSnapshots.push({url:page.url,status:Number(page.status||200),content_type:page.contentType||'text/html',content:html.slice(0,131072),truncated:html.length>131072});
    }
    const profile=analyzePage(page.html,page.url,page.status||200);pageProfiles.push(profile);
    if(profile.obstacle.blocked){failures.push({stage:'access',code:profile.obstacle.code,url:page.url,status:page.status||null,message:profile.obstacle.message,evidence:profile.obstacle.evidence,outcome:classifyIngestionOutcome({...profile.obstacle,http_status:page.status},{stage:'url_discovery'})});await progress();continue;}
    const pageAssessment=assessProductPage(page.html,page.url);
    if(pageAssessment.is_product){addProduct(page.url,pageAssessment,'page_content');await progress();continue;}
    const links=pageLinks(page.html,page.url);
    if(!links.length&&/<script\b/i.test(String(page.html||'')))possibleDynamicShells+=1;
    const sourceCategory=adapter.category(pageUrl,page.html);
    for(const record of links){
      let allowed;try{allowed=new URL(validateUrlAgainstSource(record.url.toString(),scope));}catch(_){excluded.out_of_scope+=1;continue;}
      const normalized=canonical(allowed),product=assessProductUrl(allowed,record.text),directory=directoryPriority(allowed,record.text);
      if(product.is_product){addProduct(normalized,product,'html_link');if(sourceCategory){if(!categoryEvidence.has(normalized))categoryEvidence.set(normalized,new Map());categoryEvidence.get(normalized).set(sourceCategory.external_key,sourceCategory);}if(products.size>=scope.max_products)break;}
      else if(adapter.isDirectory(allowed)&&!queued.has(normalized)){if(attempted+queue.length<scope.max_pages)enqueue(normalized,directory.score,'html_link');else pageLimitReached=true;}
      else excluded.unrelated+=1;
    }
    await progress();
  }
  if(!visited.length&&failures.length){const error=new Error(`\u5b98\u7f51\u5165\u53e3\u65e0\u6cd5\u5206\u6790\uff1a${failures[0].message}`);error.code=failures[0].code;throw error;}
  const noProductMessage=possibleDynamicShells?`\u5df2\u5206\u6790 ${visited.length} \u4e2a\u9875\u9762\uff0c\u672a\u53d1\u73b0\u53ef\u786e\u8ba4\u7684\u4ea7\u54c1\u8be6\u60c5\u9875\uff1b${possibleDynamicShells} \u4e2a\u9875\u9762\u53ef\u80fd\u9700\u8981\u52a8\u6001\u6e32\u67d3`:`\u5df2\u5206\u6790 ${visited.length} \u4e2a\u9875\u9762\uff0c\u4f46\u672a\u53d1\u73b0\u8fbe\u5230\u8bc1\u636e\u9608\u503c\u7684\u4ea7\u54c1\u8be6\u60c5\u9875`;
  return {urls:[...products],records:[...products].map(url=>({url,source_categories:[...(categoryEvidence.get(url)?.values()||[])],detection:productEvidence.get(url)||null})),evidence_snapshots:evidenceSnapshots,summary:{
    pages_scanned:visited.length,pages_attempted:attempted,directory_urls:visited,products_found:products.size,
    result:products.size?(failures.length?'partial':'success'):'no_products_found',message:products.size?(failures.length?`\u5df2\u8bc6\u522b ${products.size} \u4e2a\u4ea7\u54c1\u8be6\u60c5\u9875\uff0c\u53e6\u6709 ${failures.length} \u4e2a\u9875\u9762\u5206\u6790\u5931\u8d25`:`\u5df2\u8bc6\u522b ${products.size} \u4e2a\u4ea7\u54c1\u8be6\u60c5\u9875`):noProductMessage,
    failures,sitemap:sitemapSummary,analysis:summarizeAnalysis(pageProfiles,{sitemap:sitemapSummary}),
    detection:{method:'multi_evidence_v1',products:[...productEvidence.entries()].slice(0,500).map(([url,value])=>({url,...value}))},
    pipeline:{source_analysis:{status:'completed',pages_profiled:pageProfiles.length},url_discovery:{status:'completed',urls_found:products.size},
      product_detection:{status:products.size?'completed':'needs_attention',products_found:products.size},
      extraction:{status:products.size?'pending':'not_started'},field_mapping:{status:products.size?'pending':'not_started'},candidate_ingestion:{status:products.size?'pending':'not_started'}},
    capped_pages:pageLimitReached||Boolean(queue.length&&attempted>=scope.max_pages),capped_products:products.size>=scope.max_products,excluded}};
}

module.exports={discoverProducts,hrefs,canonical,adapterFor,pageLinks,pageIsProduct,isLikelyDetail,fetchFailure,pageObstacle};
