'use strict';

const DOM_ACTIONS = new Set(['PARSE_SCOPED_DOM','PARSE_CSS_BACKGROUND_IMAGE','CLASSIFY_PAGE_ROLE','EXTRACT_SCOPED_LIGHTBOX_CANDIDATES','PARSE_REPEATED_PRODUCT_BLOCKS','INSPECT_SAME_ORIGIN_SCRIPT_REFERENCES']);
const NETWORK_ACTIONS = new Set(['GET_SAME_ORIGIN_PAGE','GET_SITE_ROOT','POST_SAME_ORIGIN_PUBLIC_API','GET_EXACT_URL_ONCE','GET_SAME_HANDLE_PUBLIC_JSON_ONCE','CHECK_CURRENT_OFFICIAL_SITEMAP']);
const PREVIOUS_OUTPUT_ACTIONS = new Set(['EXCLUDE_RELATED_PRODUCTS','DEDUPLICATE_NAME_MODEL_IMAGE','PROPOSE_PUBLIC_API_PROFILE','MAP_API_FIELDS_TO_FROZEN_SCHEMA']);
const OUTPUT_CAPABILITIES=Object.freeze({
  discovery:new Set(['PARSE_SCOPED_DOM','PARSE_REPEATED_PRODUCT_BLOCKS']),
  fields:new Set(['PARSE_SCOPED_DOM','MAP_API_FIELDS_TO_FROZEN_SCHEMA','PRESERVE_MISSING_FIELDS']),
  images:new Set(['PARSE_SCOPED_DOM','PARSE_CSS_BACKGROUND_IMAGE','EXTRACT_SCOPED_LIGHTBOX_CANDIDATES','EXCLUDE_RELATED_PRODUCTS']),
  diagnostic:new Set(['CLASSIFY_PAGE_ROLE','INSPECT_SAME_ORIGIN_SCRIPT_REFERENCES','PROPOSE_PUBLIC_API_PROFILE','MARK_STALE_BASELINE','TLS_VERIFY_REQUIRED','RECORD_CERTIFICATE_ERROR','QUEUE_HUMAN_TRUST_CHAIN_REVIEW']),
});

function failureLayer(value) {
  const type=String(value||'').toUpperCase();
  if(/NO_PRODUCTS|DISCOVER|SITEMAP|URL/.test(type))return 'discovery';
  if(/IMAGE|LIGHTBOX|BACKGROUND/.test(type))return 'images';
  if(/FIELD|EXTRACT|CLASSIFICATION|PAGE_ROLE/.test(type))return 'fields';
  return 'diagnostic';
}
function hasHtmlEvidence(pack, evidenceRefs = null) {
  const refs=evidenceRefs?new Set(evidenceRefs):null;
  return (pack?.evidence||[]).some(item=>(!refs||refs.has(item.evidence_id))&&item.kind==='html_snapshot'&&typeof item.observed?.content==='string'&&item.observed.content.trim());
}
function assessPlanReadiness(pack,plan) {
  let htmlFromPreviousAction=false,previousOutput=false;
  const missing=[],outputs=[];
  for(const action of plan?.actions||[]){
    if(NETWORK_ACTIONS.has(action.type)){htmlFromPreviousAction=htmlFromPreviousAction||action.type!=='POST_SAME_ORIGIN_PUBLIC_API';previousOutput=true;continue;}
    if(DOM_ACTIONS.has(action.type)&&!htmlFromPreviousAction&&!hasHtmlEvidence(pack,action.evidence_refs))missing.push({action_id:action.action_id,artifact_type:'html_snapshot',reason:'该动作必须引用已保存的网页内容，或紧跟读取网页动作'});
    if(PREVIOUS_OUTPUT_ACTIONS.has(action.type)&&!previousOutput)missing.push({action_id:action.action_id,artifact_type:'previous_action_output',reason:'该动作需要前序动作结果'});
    previousOutput=true;
  }
  const layer=failureLayer(pack?.failure?.type);
  if(!(plan?.actions||[]).some(action=>OUTPUT_CAPABILITIES[layer]?.has(action.type)))missing.push({action_id:null,artifact_type:'output_contract',reason:`方案没有能产出 ${layer} 层统一结果的动作`});
  for(const action of plan?.actions||[])outputs.push({action_id:action.action_id,result_type:OUTPUT_CAPABILITIES[layer]?.has(action.type)?layer:'diagnostic'});
  return {schema_version:'recovery-readiness-v1.0',ready:missing.length===0,execution_mode:(plan?.counts?.network||0)>0?'bounded_network':'existing_data',failure_layer:layer,missing_artifacts:missing,expected_outputs:outputs};
}
function evidenceRequest(pack,plan,readiness,maxPages=3) {
  const allowed=new Set(pack.authorized_scope?.allowed_hosts||[]),urls=[];
  for(const action of plan?.actions||[])if(action.network&&action.target_url){try{const url=new URL(action.target_url);if(allowed.has(url.hostname.toLowerCase()))urls.push(url.toString());}catch(_){}}
  if(!urls.length)urls.push(pack.source.url);
  return {schema_version:'recovery-evidence-request-v1.0',purpose:readiness.failure_layer==='discovery'?'补充网页证据以重新寻找产品详情链接':'补充完成本次恢复所需的官网证据',allowed_hosts:[...allowed],urls:[...new Set(urls)].slice(0,maxPages),max_pages:Math.min(maxPages,Math.max(1,urls.length||1)),network_requests:Math.min(maxPages,Math.max(1,urls.length||1)),read_only:true};
}
function normalizeOutput(output={},layer='diagnostic') {
  if(output?.schema_version==='recovery-action-output-v1.0')return output;
  const productUrls=Array.isArray(output.product_urls)?output.product_urls:[];
  const fields=output.fields||Object.fromEntries(['name','model','description','materials','dimensions'].filter(key=>output[key]!=null).map(key=>[key,output[key]]));
  const images=Array.isArray(output.images)?output.images:(Array.isArray(output.background_images)?output.background_images:[]);
  return {...output,schema_version:'recovery-action-output-v1.0',result_type:productUrls.length?'discovery':images.length?'images':Object.keys(fields).length?'fields':layer,product_urls:productUrls,fields,images,diagnostics:output.diagnostics||output};
}

module.exports={DOM_ACTIONS,NETWORK_ACTIONS,PREVIOUS_OUTPUT_ACTIONS,OUTPUT_CAPABILITIES,failureLayer,hasHtmlEvidence,assessPlanReadiness,evidenceRequest,normalizeOutput};
