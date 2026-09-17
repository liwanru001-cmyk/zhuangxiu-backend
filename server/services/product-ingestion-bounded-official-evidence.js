'use strict';

const {discoverOfficialPages}=require('./product-ingestion-public-web-evidence');
const {pageCard,clusterUrls}=require('./product-ingestion-site-map');
const {classifyIngestionOutcome}=require('./product-ingestion-outcome-classifier');

function exactHost(raw,baseUrl){try{return new URL(raw).hostname.toLowerCase()===new URL(baseUrl).hostname.toLowerCase();}catch{return false;}}

async function acquireBoundedOfficialEvidence(scope,options={}){
  const discover=options.discoverOfficialPages||discoverOfficialPages,fetcher=options.fetchHtml;
  if(typeof fetcher!=='function')throw new Error('限定官网取证缺少受控页面读取器');
  const discovered=await discover({brandName:scope.brand_name,baseUrl:scope.base_url,maxProducts:8},options.aiOptions||{});
  const officialUrls=[...new Set((discovered.output?.product_urls||[]).map(item=>item.url).filter(url=>exactHost(url,scope.base_url)))].slice(0,5);
  const pages=[],failures=[];
  for(const url of officialUrls.slice(0,3)){
    try{pages.push(await fetcher(url,scope));}
    catch(error){failures.push({url,code:error.code||'BOUNDED_OFFICIAL_PAGE_FAILED',message:String(error.message||error).slice(0,500),outcome:classifyIngestionOutcome(error,{stage:'bounded_official_evidence'})});}
  }
  if(!pages.length){
    const alternate=officialUrls.length>0&&failures.length>0&&failures.every(item=>['ACCESS_RESTRICTED','HUMAN_CHALLENGE','JS_RENDER_REQUIRED'].includes(item.outcome?.category));
    if(alternate)return {status:'js_required',discovered,official_urls:officialUrls,failures,outcome:{schema_version:'ingestion-outcome-v1',category:'JS_RENDER_REQUIRED',stage:'bounded_official_evidence',retryability:'alternate_channel',next_action:'USE_RENDERED_CHANNEL',terminal:false,error_code:'BOUNDED_OFFICIAL_HTTP_RESTRICTED',http_status:failures.find(item=>item.outcome?.http_status)?.outcome?.http_status||null}};
    return {status:'no_legal_channel',discovered,official_urls:officialUrls,failures,outcome:{schema_version:'ingestion-outcome-v1',category:'NO_LEGAL_ACQUISITION_CHANNEL',stage:'bounded_official_evidence',retryability:'none',next_action:'STOP_NO_LEGAL_CHANNEL',terminal:true,error_code:null,http_status:null}};
  }
  const cards=pages.map((page,index)=>pageCard(page,`P-B${String(index+1).padStart(2,'0')}`)),clusters=clusterUrls([...officialUrls,...pages.map(page=>page.url)]);
  const siteMap={
    schema_version:'site-structure-map-v1.0',
    site:{brand:scope.brand_name,entry_url:scope.base_url,allowed_hosts:scope.allowed_hosts,allowed_asset_hosts:scope.allowed_asset_hosts||scope.allowed_hosts,allowed_path_prefixes:scope.allowed_path_prefixes,request_interval_ms:scope.request_interval_ms},
    coverage:{sitemap_urls:0,sitemap_files:0,sampled_pages:cards.length,failed_pages:failures.length,template_clusters:clusters.length,bounded_official_discovery_urls:officialUrls.length},
    clusters:clusters.slice(0,20).map(cluster=>({...cluster,representative_pages:cards.filter(card=>cluster.representative_urls.includes(card.url)).map(card=>card.page_id)})),
    pages:cards,failures,sitemap_summary:{files_scanned:0,urls_found:0,failures:[]},
    // The strict official-page discovery contract establishes URL role, while
    // controlled fetch establishes page-content evidence. Keep those two
    // confidence levels distinct: unfetched URLs may shape discovery, but can
    // never be used as extraction evidence until the sandbox reads them.
    known_labels:officialUrls.map(url=>{const card=cards.find(item=>item.url===url);return {page_id:card?.page_id||null,url,role:'product_detail',source:'bounded_official_discovery',evidence_level:card?'page_verified':'url_role_only'};}),
    evidence_levels:['L0','L1','L2','L3','L4'],
    acquisition:{channel:'bounded_official_discovery_then_controlled_fetch',official_urls:officialUrls,tool_request_hash:discovered.request_hash||null},
  };
  return {status:'ready',discovered,official_urls:officialUrls,failures,site_map:siteMap,outcome:classifyIngestionOutcome({success:true},{stage:'bounded_official_evidence'})};
}

module.exports={acquireBoundedOfficialEvidence,exactHost};
