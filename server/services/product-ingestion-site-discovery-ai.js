'use strict';

const crypto=require('crypto');
const Ajv=require('ajv');
const {configuration,callResponses,compactEvidence}=require('./product-ingestion-site-rule-ai');
const {semanticPath,decodePath}=require('./product-ingestion-site-rule-schema');
const {urlRole,safePathPattern,siblingFilePattern,pathOf}=require('./product-ingestion-url-role-contract');

const PROMPT_VERSION='site-discovery-rule-v1.0';
const SCHEMA={type:'object',additionalProperties:false,required:['product_detail_path_prefixes','listing_path_prefixes','exclude_path_prefixes','seed_urls','link_sources','required_signals','evidence_refs'],properties:{product_detail_path_prefixes:{type:'array',minItems:1,maxItems:30,items:{type:'string',pattern:'^/'}},listing_path_prefixes:{type:'array',maxItems:30,items:{type:'string',pattern:'^/'}},exclude_path_prefixes:{type:'array',maxItems:50,items:{type:'string',pattern:'^/'}},product_detail_paths:{type:'array',maxItems:50,items:{type:'string',pattern:'^/'}},listing_paths:{type:'array',maxItems:50,items:{type:'string',pattern:'^/'}},exclude_paths:{type:'array',maxItems:50,items:{type:'string',pattern:'^/'}},product_detail_path_patterns:{type:'array',maxItems:30,items:{type:'string',minLength:3,maxLength:240}},listing_path_patterns:{type:'array',maxItems:30,items:{type:'string',minLength:3,maxLength:240}},exclude_path_patterns:{type:'array',maxItems:30,items:{type:'string',minLength:3,maxLength:240}},seed_urls:{type:'array',minItems:1,maxItems:10,items:{type:'string',pattern:'^https://'}},link_sources:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['selector','attribute'],properties:{selector:{type:'string',minLength:1,maxLength:200},attribute:{enum:['href','data-href','data-url']}}}},required_signals:{type:'array',minItems:2,maxItems:8,items:{enum:['PRODUCT_NAME','JSON_LD_PRODUCT','H1','OG_IMAGE','PRODUCT_DESCRIPTION','TECHNICAL_HEADING','PRODUCT_GALLERY','PRODUCT_SPECIFICATION']}},evidence_refs:{type:'array',minItems:1,maxItems:30,items:{type:'string',minLength:1,maxLength:120}}}};
const validateSchema=new Ajv({allErrors:true,strict:true}).compile(SCHEMA);
function fail(message,details=[],audit={}){const error=new Error(message);error.code='INGESTION_AI_DISCOVERY_RULE_INVALID';error.status=409;error.details={...audit,validation_errors:details};throw error;}
function tool(){return {type:'function',name:'submit_discovery_rule',description:'提交产品页发现规则，不含字段提取规则',strict:true,parameters:SCHEMA};}
function compactDiscoveryEvidence(siteMap){return {
  schema_version:siteMap.schema_version,site:siteMap.site,coverage:siteMap.coverage,
  clusters:(siteMap.clusters||[]).slice(0,20).map(item=>({cluster_id:item.cluster_id,decoded_path_pattern:item.decoded_path_pattern,estimated_count:item.estimated_count,url_examples:(item.url_examples||item.representative_urls||[]).slice(0,3)})),
  pages:(siteMap.pages||[]).slice(0,12).map(page=>({page_id:page.page_id,url:page.url,decoded_path:page.decoded_path,title:page.title,h1:page.h1,content_hash:page.content_hash})),
  known_labels:siteMap.known_labels||[],failures:(siteMap.failures||[]).slice(0,10),
};}
function validate(value,siteMap){
  const errors=validateSchema(value)?[]:(validateSchema.errors||[]).map(x=>`${x.instancePath||'/'} ${x.message}`),hosts=new Set(siteMap.site.allowed_hosts||[]),allowedPaths=siteMap.site.allowed_path_prefixes||['/'];
  const entryPath=semanticPath(siteMap.site.entry_url||''),locale=/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i.exec(entryPath)?.[1]?.toLowerCase();
  if(locale)for(const prefix of value?.product_detail_path_prefixes||[])if(!decodePath(prefix).toLowerCase().startsWith(`/${locale}/`))errors.push(`产品路径 ${prefix} 与用户入口语言 /${locale}/ 不一致，会造成跨语言重复产品`);
  for(const role of ['product_detail','listing','exclude'])for(const pattern of value?.[`${role}_path_patterns`]||[])if(!safePathPattern(pattern))errors.push(`${role} 路径模式必须安全且以 ^/$ 完整锚定：${pattern}`);
  for(const url of value?.seed_urls||[]){try{const parsed=new URL(url),path=semanticPath(url);if(!hosts.has(parsed.hostname.toLowerCase()))errors.push(`种子超出允许域名：${url}`);if(!allowedPaths.some(prefix=>prefix==='/'||path.startsWith(decodePath(prefix))))errors.push(`种子超出允许路径：${url}`);if(urlRole(url,{matching_priority:['exclude','product_detail','listing'],...value})!=='product_detail')errors.push(`种子不是当前规则认定的产品详情页：${url}`);}catch{errors.push(`种子 URL 无效：${url}`);}}
  const examples=(siteMap.clusters||[]).flatMap(x=>x.url_examples||[]);for(const prefix of value?.product_detail_path_prefixes||[])if(!examples.some(url=>semanticPath(url).startsWith(decodePath(prefix))))errors.push(`产品路径没有站内样本：${prefix}`);
  const preciseProductRole=Boolean((value?.product_detail_paths||[]).length||(value?.product_detail_path_patterns||[]).length);
  if(!preciseProductRole&&(value?.product_detail_path_prefixes||[]).some(x=>(value?.listing_path_prefixes||[]).includes(x)||(value?.exclude_path_prefixes||[]).includes(x)))errors.push('产品路径不能与列表或排除路径相同');
  for(const detail of value?.product_detail_path_prefixes||[])for(const excluded of value?.exclude_path_prefixes||[])if(decodePath(detail).startsWith(decodePath(excluded)))errors.push(`产品路径 ${detail} 被排除路径 ${excluded} 覆盖`);
  return errors;
}
function normalizePathPrefix(value){
  const decoded=decodePath(String(value||'').trim());
  // Site-map clusters intentionally describe variable path segments with
  // placeholders such as /product/show/id/{leaf}/. Discovery rules, however,
  // are executable literal prefixes. Keep the proven static portion only.
  const placeholder=decoded.search(/\{[^/{}]+\}/);
  if(placeholder<0)return decoded;
  const prefix=decoded.slice(0,placeholder);
  return prefix.endsWith('/')?prefix:`${prefix}/`;
}
function observedSignals(page){
  const text=`${(page.headings||[]).join(' ')} ${page.visible_text||''}`;
  return new Set([
    (page.field_contexts||[]).some(item=>item.field==='name'&&item.selector)?'PRODUCT_NAME':'',
    page.h1?'H1':'',
    (page.json_ld||[]).some(item=>/"@type"\s*:\s*"Product"/i.test(String(item)))?'JSON_LD_PRODUCT':'',
    (page.image_regions||[]).some(item=>Number(item.image_count||0)>=2)?'PRODUCT_GALLERY':'',
    /技术|参数|尺寸|规格|材质|technical|specification|dimension|material/i.test(text)?'PRODUCT_SPECIFICATION':'',
    /技术|technical|specification/i.test((page.headings||[]).join(' '))?'TECHNICAL_HEADING':'',
  ].filter(Boolean));
}
function normalizeDiscoveryRule(value,siteMap=null){
  if(!value||typeof value!=='object')return value;
  const normalized={...value};
  for(const key of ['product_detail_path_prefixes','listing_path_prefixes','exclude_path_prefixes']){
    if(!Array.isArray(value[key]))continue;
    normalized[key]=[...new Set(value[key].map(normalizePathPrefix).filter(Boolean))];
  }
  for(const key of ['product_detail_paths','listing_paths','exclude_paths'])normalized[key]=[...new Set((value[key]||[]).map(pathOf).filter(Boolean))];
  for(const key of ['product_detail_path_patterns','listing_path_patterns','exclude_path_patterns'])normalized[key]=[...new Set((value[key]||[]).filter(safePathPattern))];
  const entryPath=pathOf(siteMap?.site?.entry_url||''),broadEntry=(normalized.product_detail_path_prefixes||[]).some(prefix=>entryPath.startsWith(decodePath(prefix)));
  if(broadEntry&&!normalized.product_detail_paths.length&&!normalized.product_detail_path_patterns.length){
    const labeledProducts=(siteMap?.known_labels||[]).filter(item=>item.role==='product_detail').map(item=>item.url);
    let pattern=siblingFilePattern([...normalized.seed_urls,...labeledProducts]);
    if(!pattern){
      // Two independently confirmed product pages plus a third URL from their
      // structural cluster are enough to derive a bounded sibling-file role.
      // The cluster URL is not promoted to a product seed; it only proves the
      // URL family, so discovery still has to validate it through the frozen rule.
      for(const cluster of siteMap?.clusters||[]){
        const examples=cluster.url_examples||cluster.representative_urls||[],candidate=siblingFilePattern([...normalized.seed_urls,...examples]);
        if(!candidate)continue;
        let confirmed=0;try{const matcher=new RegExp(candidate,'u');confirmed=normalized.seed_urls.filter(url=>matcher.test(pathOf(url))).length;}catch{}
        if(confirmed>=2){pattern=candidate;break;}
      }
    }
    if(pattern)normalized.product_detail_path_patterns=[pattern];
  }
  if(broadEntry&&!normalized.seed_urls?.some(url=>pathOf(url)===entryPath)&&entryPath&&!normalized.exclude_paths.includes(entryPath))normalized.exclude_paths.push(entryPath);
  normalized.exclude_path_prefixes=(normalized.exclude_path_prefixes||[]).filter(excluded=>!(normalized.product_detail_path_prefixes||[]).some(detail=>decodePath(detail).startsWith(decodePath(excluded))));
  const productPages=(siteMap?.pages||[]).filter(page=>urlRole(page.url,{matching_priority:['exclude','product_detail','listing'],...normalized})==='product_detail');
  if(productPages.length){
    const supported=[...productPages.map(observedSignals).reduce((common,current)=>new Set([...common].filter(signal=>current.has(signal))))];
    if(supported.length>=2){
      const requested=(value.required_signals||[]).filter(signal=>supported.includes(signal));
      normalized.required_signals=[...new Set([...requested,...supported])].slice(0,8);
    }
  }
  return normalized;
}
function parse(body){const call=(body.output||[]).find(x=>x.type==='function_call'&&x.name==='submit_discovery_rule');if(!call)fail('AI 没有返回发现规则');try{return JSON.parse(call.arguments);}catch{fail('AI 发现规则不是有效 JSON');}}
async function generateDiscoveryRule(siteMap,options={}){
  const cfg=options.config||configuration(options.env),calls=[];let errors=[],lastOutput=null,usage={input_tokens:0,output_tokens:0,total_tokens:0};
  const evidence=compactDiscoveryEvidence(siteMap);
  for(let attempt=0;attempt<2;attempt+=1){const input=['你是家具官网产品页发现规则生成器。只调用 submit_discovery_rule；不得生成字段或图片规则。','根据已获支持的页面角色假设与结构地图，区分产品详情、列表和排除路径。URL 使用解码路径分析，种子保留原始 HTTPS URL。当首页、列表和产品共享同一前缀时，使用 *_paths 表达精确例外，或使用以 ^ 开头、$ 结尾的 *_path_patterns 表达文件名/路径模板；不得用过宽前缀把首页当成产品。结构证据中的 {leaf} 是变量占位符，不得复制到前缀中。如果入口带明确语言路径，只保留该语言。每个 seed_url 都必须是具体产品页。','required_signals 必须是同一产品模板普遍具备的组合，不得把某一页偶然信号设成全站硬门禁。发现阶段只需要路径、页面角色和链接位置。',options.cognition?`已验证假设：${JSON.stringify(options.cognition)}`:'',options.feedback?`上一版发现规则的真实程序校验错误：${JSON.stringify(options.feedback)}。只修正这些错误。`:'',errors.length?`上一轮真实错误：${JSON.stringify(errors)}`:'',`结构证据：${JSON.stringify(evidence)}`].filter(Boolean).join('\n');const response=await callResponses({model:cfg.model,input,tools:[tool()],tool_choice:'required',reasoning:{effort:'none'},max_output_tokens:2500,store:false},{...options,config:cfg});const current=response.body.usage||{};for(const key of Object.keys(usage))usage[key]+=Number(current[key]||0);let output;try{output=normalizeDiscoveryRule(parse(response.body),siteMap);lastOutput=output;errors=validate(output,siteMap);}catch(error){const details=error.details?.validation_errors;errors=Array.isArray(details)&&details.length?details:[error.message];}calls.push({attempt:attempt+1,status:errors.length?'invalid':'valid',errors,usage:current,elapsed_ms:response.elapsed_ms,response_id:response.body.id||null});if(!errors.length&&output)return {output,model:cfg.model,prompt_version:PROMPT_VERSION,request_hash:crypto.createHash('sha256').update(input).digest('hex'),input_manifest:evidence,usage,calls};if(!errors.length)errors=['discovery rule missing after validation'];}
  fail(`AI 发现规则两次均未通过校验：${errors.join('；')}`,errors,{output:lastOutput,model:cfg.model,prompt_version:PROMPT_VERSION,input_manifest:evidence,usage,calls});
}
module.exports={PROMPT_VERSION,SCHEMA,validateDiscoveryRule:validate,generateDiscoveryRule,compactDiscoveryEvidence,normalizeDiscoveryRule};
