'use strict';

const crypto=require('crypto');
const cheerio=require('cheerio');
const {fetchHtml}=require('./product-ingestion-fetch');
const {recognizeProductImages}=require('./product-ingestion-image-recognizer');
const {validateSiteRule,configHash,semanticPath,decodePath}=require('./product-ingestion-site-rule-schema');
const {resolveFieldRule,embeddedJsonValues}=require('./product-ingestion-field-source-contract');
const {urlRole}=require('./product-ingestion-url-role-contract');

function fail(message,status=400,code='SITE_RULE_INVALID'){const error=new Error(message);error.status=status;error.code=code;throw error;}
function parsed(value,fallback=null){if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function unique(values){return [...new Set(values.filter(Boolean))];}
function canonicalUrl(raw,base){if(typeof raw!=='string'||!raw.trim())return '';try{const url=new URL(raw.trim(),base);if(!['http:','https:'].includes(url.protocol))return '';url.hash='';return url.toString();}catch{return '';}}
function roleFor(raw,config){
  return urlRole(raw,config.discovery);
}
function findJsonLdProducts($){
  const found=[];
  function walk(value){if(!value||typeof value!=='object')return;const types=Array.isArray(value['@type'])?value['@type']:[value['@type']];if(types.some(type=>String(type).toLowerCase()==='product'))found.push(value);for(const child of Array.isArray(value)?value:Object.values(value))walk(child);}
  $('script[type="application/ld+json"]').each((_,node)=>{try{walk(JSON.parse($(node).html()||'null'));}catch{}});
  return found;
}
function bestSrcset(value){return String(value||'').split(',').map(part=>{const [url,size='']=part.trim().split(/\s+/,2);return {url,size:Number.parseFloat(size)||0};}).filter(item=>item.url).sort((a,b)=>b.size-a.size)[0]?.url||'';}
function selectedValues($,source,baseUrl){
  try{const values=source.type==='embedded_json'?embeddedJsonValues(source,{$}):$(source.selector).map((_,node)=>$(node).attr(source.attribute)).get();return values.map(value=>canonicalUrl(value,baseUrl)).filter(Boolean);}catch{return [];}
}
function configuredImages($,product,baseUrl,config,fallback){
  const values=[];
  for(const source of config.extraction.images.sources){
    if(source.type==='json_ld_product')values.push(...(Array.isArray(product.image)?product.image:[product.image]).map(value=>typeof value==='object'?value?.url||value?.contentUrl:value));
    else if(source.type==='meta')values.push($(`meta[property="${source.property}"],meta[name="${source.property}"]`).first().attr('content'));
    else if(source.type==='dom_attribute'){
      try{$(source.selector).each((_,node)=>{const raw=$(node).attr(source.attribute);values.push(/srcset$/i.test(source.attribute)?bestSrcset(raw):raw);});}catch{}
    }else if(source.type==='css_background'){
      try{$(source.selector).each((_,node)=>{const style=$(node).attr('style')||'';for(const match of style.matchAll(/background(?:-image)?\s*:[^;]*url\((['"]?)(.*?)\1\)/gi))values.push(match[2]);});}catch{}
    }else if(source.type==='embedded_json')values.push(...embeddedJsonValues(source,{$}));
  }
  // A validated site rule is authoritative. Generic image recognition is used
  // only as an emergency source when every configured source is empty; mixing it
  // into successful configured extraction reintroduces cross-product pollution.
  if(!values.some(value=>typeof value==='string'&&value.trim()))values.push(...fallback.urls);
  const allowed=new Set(config.scope.allowed_asset_hosts),excluded=config.extraction.images.exclude_tokens.map(value=>value.toLowerCase());
  return unique(values.map(value=>canonicalUrl(value,baseUrl))).filter(url=>{
    try{return allowed.has(new URL(url).hostname.toLowerCase())&&!excluded.some(token=>url.toLowerCase().includes(token));}catch{return false;}
  }).slice(0,config.extraction.images.max_images);
}
function authoritativeImages($,product,baseUrl){
  const values=[];
  values.push(...(Array.isArray(product.image)?product.image:[product.image]).map(value=>typeof value==='object'?value?.url||value?.contentUrl:value));
  values.push($('meta[property="og:image"],meta[name="og:image"]').first().attr('content'));
  return unique(values.map(value=>canonicalUrl(value,baseUrl)));
}
function linksFromSources($,sources,baseUrl){return unique(sources.flatMap(source=>selectedValues($,source,baseUrl)));}
function attachmentOwnedByProduct(url,fields,sourceUrl){
  const haystack=decodePath(`${url} ${new URL(url).pathname}`).toLowerCase(),tokens=unique([fields.name,fields.model,...decodePath(new URL(sourceUrl).pathname).split(/[\/\s_-]+/)]).flatMap(value=>String(value||'').toLowerCase().split(/[\s_-]+/)).filter(value=>value.length>=3&&!['product','products','产品'].includes(value));
  return tokens.some(token=>haystack.includes(token));
}
function templateSignals($,product,name,description,imageResult){
  const headings=$('h2,h3,h4,h5').map((_,node)=>$(node).text()).get().join(' ');
  const body=$('body').text();
  return unique([
    name?'PRODUCT_NAME':'',
    product?.name?'JSON_LD_PRODUCT':'', $('h1').first().text().trim()?'H1':'',
    $('meta[property="og:image"]').attr('content')?'OG_IMAGE':'', description?'PRODUCT_DESCRIPTION':'',
    /技术细节|technical details/i.test(headings)?'TECHNICAL_HEADING':'',
    imageResult.urls.length>=2?'PRODUCT_GALLERY':'', /尺寸|材质|技术参数|dimension|material|specification/i.test(body)?'PRODUCT_SPECIFICATION':'',
  ]);
}
function configurationRuleActivated(rule){
  if(!rule||rule.mode==='none')return false;
  if(rule.mode==='repeated')return true;
  return [...Object.values(rule.fields||{}),rule.dimensions?.source].some(field=>Array.isArray(field?.sources)&&field.sources.length>0)||(rule.images||[]).length>0;
}
function structuralFingerprint($,signals){
  const structure={signals:[...signals].sort(),h1:$('h1').length,json_ld_product:$('script[type="application/ld+json"]').length>0,has_main:$('main').length>0,image_bucket:Math.min(5,Math.ceil($('img').length/5)),heading_bucket:Math.min(5,Math.ceil($('h2,h3,h4').length/5))};
  return {algorithm:'site-template-fingerprint-v1',signature:structure,hash:crypto.createHash('sha256').update(JSON.stringify(structure)).digest('hex')};
}
function pageLinks($,baseUrl,config){
  return discoveryLinksFromDocument($,baseUrl,config).product_detail;
}
function discoveryLinksFromDocument($,baseUrl,config){
  const hosts=new Set(config.scope.allowed_page_hosts),result={product_detail:[],listing:[]};
  for(const url of linksFromSources($,config.discovery.link_sources,baseUrl)){
    try{
      if(!hosts.has(new URL(url).hostname.toLowerCase()))continue;
      const role=roleFor(url,config);
      if(role==='product_detail'||role==='listing')result[role].push(url);
    }catch{}
  }
  result.product_detail=unique(result.product_detail);result.listing=unique(result.listing);
  return result;
}
function extractDiscoveryLinks(page,config){
  return discoveryLinksFromDocument(cheerio.load(page.html||''),page.url,config);
}
function extractPage(page,config,options={}){
  const $=cheerio.load(page.html),product=findJsonLdProducts($)[0]||{},bodyText=$('body').text().replace(/\s+/g,' ').trim();
  const fields={};const fieldEvidence={};
  for(const [name,rule] of Object.entries(config.extraction.fields)){
    const resolved=resolveFieldRule(rule,{$,product,bodyText,baseUrl:page.url},{mode:'base'});
    fields[name]=resolved.value;fieldEvidence[name]=resolved.evidence;
  }
  const structuredImages=Array.isArray(product.image)?product.image:product.image?[product.image]:[];
  let imageResult={strategy:'site_rule_sources',confidence:1,urls:[]};
  let configured=configuredImages($,product,page.url,config,imageResult);
  if(!configured.length){imageResult=recognizeProductImages(page.html,page.url,{productName:fields.name||'',structuredImages,max:config.extraction.images.max_images,siteProfile:{image_prefer_tokens:config.extraction.images.prefer_tokens,image_exclude_tokens:config.extraction.images.exclude_tokens}});configured=configuredImages($,product,page.url,config,imageResult);}
  const images=configured.map((url,index)=>({url,top5_rank:index+1}));
  const authoritative=authoritativeImages($,product,page.url);
  const attachmentLinks=linksFromSources($,config.extraction.attachments.link_sources,page.url).filter(url=>config.extraction.attachments.allowed_extensions.some(extension=>new URL(url).pathname.toLowerCase().endsWith(`.${extension}`))&&attachmentOwnedByProduct(url,fields,page.url));
  const componentLinks=linksFromSources($,config.extraction.relationships.component_link_sources,page.url);
  const signals=templateSignals($,product,fields.name,fields.description,{urls:images.map(item=>item.url)}),missingSignals=config.template.required_signals.filter(signal=>!signals.includes(signal));
  const errors=[];
  if(roleFor(page.url,config)!=='product_detail')errors.push('PAGE_ROLE_MISMATCH');
  for(const name of config.validation.required_fields)if(!fields[name])errors.push(`REQUIRED_FIELD_MISSING:${name}`);
  const comparable=value=>String(value||'').replace(/\s+/g,'').toLocaleLowerCase();
  if(fields.description&&fields.category&&comparable(fields.description)===comparable(fields.category))errors.push('DESCRIPTION_EQUALS_CATEGORY');
  if(config.schema_version!=='site-rule-config-v2'&&images.length<config.validation.minimum_images)errors.push('MINIMUM_IMAGES_NOT_MET');
  if(config.validation.require_template_match&&missingSignals.length)errors.push(`TEMPLATE_SIGNALS_MISSING:${missingSignals.join(',')}`);
  const result={
    source_url:page.url,page_role:roleFor(page.url,config),fields,field_evidence:fieldEvidence,images,
    template:{observed_signals:signals,missing_signals:missingSignals,fingerprint:structuralFingerprint($,signals)},
    discovered_product_urls:pageLinks($,page.url,config),attachments:attachmentLinks,
    relationships:{mode:config.extraction.relationships.mode,component_urls:componentLinks},variants:{mode:config.extraction.variants.mode,items:[]},
    evidence:{content_hash:crypto.createHash('sha256').update(page.html).digest('hex'),http_status:page.status,content_type:page.contentType,html_bytes:Buffer.byteLength(page.html),image_strategy:config.extraction.images.sources.length?'site_rule_sources_with_generic_fallback':imageResult.strategy,authoritative_image_urls:authoritative},
    validation_errors:errors,accepted:errors.length===0,
  };
  if(config.schema_version==='site-rule-config-v1.1'){
    const {extractStructuredPage}=require('./product-ingestion-site-rule-structured');
    result.structured=extractStructuredPage(page,config,result,options);
    result.variants={mode:config.extraction.variants.mode,items:result.structured.configurations};
    if(!result.structured.configurations.length)result.validation_errors.push('CONFIGURATIONS_NOT_FOUND');
    const configurationRule=config.extraction.structured.configurations;
    for(const [index,item] of result.structured.configurations.entries()){
      for(const [name,rule] of Object.entries(configurationRule.fields||{}))if(rule.required&&item.evidence?.[name]?.status!=='provided')result.validation_errors.push(`CONFIGURATION_FIELD_MISSING:${index}:${name}`);
      if(configurationRule.dimensions.source.required&&item.dimension_status!=='provided')result.validation_errors.push(`CONFIGURATION_DIMENSIONS_MISSING:${index}`);
    }
    result.accepted=result.validation_errors.length===0;
  }
  if(config.schema_version==='site-rule-config-v2'){
    const {extractStructuredPage,businessPresence}=require('./product-ingestion-site-rule-structured');
    result.structured=extractStructuredPage(page,config,result,options);result.variants={mode:config.extraction.variants.mode,items:result.structured.configurations};
    const document=result.structured.product_document,status=document.field_status,displayRoles=new Set(['hero','product_gallery','scene','detail','configuration_image']);
    result.images=document.data.assets.filter(asset=>asset.media_type==='image'&&displayRoles.has(asset.role)).map((asset,index)=>({url:asset.url,role:asset.role,top5_rank:index+1}));
    if(status['/product/names/primary']?.status!=='provided')result.validation_errors.push('PRODUCT_V2_NAME_NOT_PROVIDED');
    for(const [path,value] of Object.entries(status)){
      if(value.status==='extraction_failed')result.validation_errors.push(`PRODUCT_V2_EXTRACTION_FAILED:${path}`);
      if(value.status==='ambiguous')result.validation_errors.push(`PRODUCT_V2_AMBIGUOUS:${path}`);
      if(value.status==='defaulted')result.validation_errors.push(`PRODUCT_V2_UNSUPPORTED_DEFAULT:${path}`);
    }
    if(configurationRuleActivated(config.extraction.structured.configurations)&&businessPresence(bodyText,'configurations')){
      if(!document.data.configurations.length)result.validation_errors.push('PRODUCT_V2_CONFIGURATIONS_MISSING');
      for(const item of document.data.configurations)if(!item.name&&!item.code)result.validation_errors.push(`PRODUCT_V2_CONFIGURATION_IDENTITY_MISSING:${item.id}`);
    }
    if((config.extraction.structured.option_groups||[]).some(group=>group.mode!=='none')&&businessPresence(bodyText,'option_groups')&&!document.data.option_groups.some(group=>group.options.length))result.validation_errors.push('PRODUCT_V2_OPTION_GROUPS_MISSING');
    if(!result.images.length)result.validation_errors.push('PRODUCT_V2_DISPLAY_IMAGES_MISSING');
    for(const asset of document.data.assets){
      if(asset.role==='dimension_diagram'&&!asset.bindings.some(item=>['configuration','product'].includes(item.target_type)))result.validation_errors.push(`PRODUCT_V2_DIMENSION_ASSET_UNBOUND:${asset.id}`);
      if(asset.role==='material_swatch'&&!asset.bindings.some(item=>item.target_type==='option'))result.validation_errors.push(`PRODUCT_V2_SWATCH_ASSET_UNBOUND:${asset.id}`);
    }
    result.business_validation={schema_version:2,field_status_counts:Object.values(status).reduce((counts,value)=>{counts[value.status]=(counts[value.status]||0)+1;return counts;},{}),configuration_count:document.data.configurations.length,option_group_count:document.data.option_groups.length,asset_role_counts:document.data.assets.reduce((counts,value)=>{counts[value.role]=(counts[value.role]||0)+1;return counts;},{}),passed:result.validation_errors.length===0};
    result.accepted=result.validation_errors.length===0;
  }
  return result;
}

async function executeSiteRuleSandbox(config,options={}){
  const validation=validateSiteRule(config);if(!validation.valid)fail(`站点规则未通过校验：${[...validation.schema_errors,...validation.semantic_errors].join('；')}`,409,'SITE_RULE_VALIDATION_FAILED');
  const fetchPage=options.fetchHtml||fetchHtml,scope={
    source_id:options.source_id||null,job_id:null,source_status:'active',job_status:'running',
    allowed_hosts:config.scope.allowed_page_hosts,allowed_asset_hosts:config.scope.allowed_asset_hosts,
    allowed_path_prefixes:config.scope.allowed_path_prefixes,request_interval_ms:config.sandbox.request_interval_ms,
    base_url:config.scope.base_url,max_pages:config.sandbox.max_pages,max_products:config.sandbox.max_products,
    page_quota:{used:0,limit:config.sandbox.max_pages},api_quota:{used:0,limit:config.sandbox.max_pages},policy_db:options.audit_db||null,
  };
  if(config.public_json_api){
    const {discoverApiProducts,recordToCanonicalHtml}=require('./product-ingestion-public-json-api');
    const found=await discoverApiProducts(config.public_json_api,scope,{fetchJsonPage:options.fetchJsonPage,onProgress:progress=>options.onProgress?.({stage:'fetching_api',...progress})});
    const products=found.records.slice(0,config.sandbox.max_products).map(item=>extractPage({url:item.url,status:200,contentType:'text/html; charset=utf-8',html:recordToCanonicalHtml(item.record,config.public_json_api,item.url),acquisition_channel:'public_json_api'},config,{ocrEvidence:options.ocrEvidence||{}}));
    const failures=found.failures.map(item=>({url:config.public_json_api.endpoint_url,error_code:item.error_code,message:item.message}));
    return sandboxResult(config,products,failures,found.pages_scanned,{public_json_api:{pages_scanned:found.pages_scanned,total:found.total,enumeration_complete:found.enumeration_complete}});
  }
  const queue=config.discovery.seed_urls.map(url=>canonicalUrl(url)).filter(Boolean),visited=new Set(),products=[],failures=[];
  const fetchAuthorizedProduct=async url=>{
    try{return await fetchPage(url,scope);}
    catch(problem){
      const {classifyIngestionOutcome}=require('./product-ingestion-outcome-classifier'),outcome=classifyIngestionOutcome(problem,{stage:'site_rule_sandbox'});
      if(!['ACCESS_RESTRICTED','HUMAN_CHALLENGE','JS_RENDER_REQUIRED'].includes(outcome.category))throw problem;
      return fetchPage(url,{...scope,force_rendered_channel:true,allow_same_site_subresources:true});
    }
  };
  while(queue.length&&visited.size<config.sandbox.max_pages&&products.length<config.sandbox.max_products){
    const url=queue.shift();if(!url||visited.has(url))continue;visited.add(url);options.onProgress?.({stage:'fetching',url,pages_attempted:visited.size});
    try{
      const page=await fetchAuthorizedProduct(url);const row=extractPage(page,config,{ocrEvidence:options.ocrEvidence||{}});products.push(row);
      if(config.discovery.follow_same_role_links)for(const candidate of row.discovered_product_urls){if(!visited.has(candidate)&&queue.length<config.discovery.max_candidates)queue.push(candidate);}
    }catch(error){failures.push({url,error_code:String(error.code||'SANDBOX_PAGE_FAILED'),message:String(error.message||error).slice(0,1000)});}
  }
  return sandboxResult(config,products,failures,visited.size);
}

function sandboxResult(config,products,failures,pagesAttempted,extra={}){
  const primaryOwners=new Map(),identity=row=>String(row.fields.model||decodePath(new URL(row.source_url).pathname).split('/').filter(Boolean).at(-1)||row.fields.name||row.source_url).toLowerCase();
  for(const row of products){const primary=row.images[0]?.url;if(!primary)continue;if(!primaryOwners.has(primary))primaryOwners.set(primary,new Set());primaryOwners.get(primary).add(identity(row));}
  for(const row of products){const primary=row.images[0]?.url;if(primary&&primaryOwners.get(primary)?.size>1){row.validation_errors.push('PRIMARY_IMAGE_REUSED_ACROSS_PRODUCTS');row.accepted=false;}}
  const accepted=products.filter(row=>row.accepted),rejected=products.filter(row=>!row.accepted),passed=accepted.length>=config.validation.minimum_accepted_products&&!rejected.length&&!failures.length;
  const siteMetrics=siteValidationMetrics(products,failures);
  return {schema_version:'site-rule-sandbox-result-v1.0',rule_schema_version:config.schema_version,config_hash:configHash(config),started_with_seeds:config.discovery.seed_urls,
    limits:{...config.sandbox},summary:{pages_attempted:pagesAttempted,products_extracted:products.length,products_accepted:accepted.length,products_rejected:products.length-accepted.length,failures:failures.length},
    site_validation:siteMetrics,outcome:passed?'PASS':failures.length?'EXECUTION_FAILED':accepted.length?'PARTIAL_IMPROVEMENT':'NO_IMPROVEMENT',passed,accepted_products:accepted,rejected_products:rejected,failures,production_effects:{candidate_writes:0,published_products:0,source_rule_activated:false},...extra};
}

function siteValidationMetrics(products,failures=[]){
  const rows=products.filter(item=>item?.structured?.product_document),counts={products_seen:products.length,products_passed:products.filter(item=>item.accepted).length,products_failed:products.filter(item=>!item.accepted).length,network_failures:failures.length,with_configurations:0,with_option_groups:0,with_dimensions:0,with_display_images:0,field_status:{}};
  for(const row of rows){const document=row.structured.product_document;if(document.data.configurations.length)counts.with_configurations+=1;if(document.data.option_groups.some(group=>group.options.length))counts.with_option_groups+=1;if(document.data.configurations.some(item=>item.dimensions.length))counts.with_dimensions+=1;if(document.data.assets.some(item=>['hero','product_gallery','scene','detail','configuration_image'].includes(item.role)))counts.with_display_images+=1;for(const value of Object.values(document.field_status)){counts.field_status[value.status]=(counts.field_status[value.status]||0)+1;}}
  return {...counts,exceptions:[...products.filter(item=>!item.accepted).map(item=>({url:item.source_url,reasons:item.validation_errors})),...failures.map(item=>({url:item.url,reasons:[item.error_code||item.message]}))]};
}

function mapRule(row){return {...row,id:Number(row.id),source_id:Number(row.source_id),version_number:Number(row.version_number),config:parsed(row.config,{}),validation_result:parsed(row.validation_result,null),last_sandbox_result:parsed(row.last_sandbox_result,null)};}
function templateBinding(rule){
  const products=rule.last_sandbox_result?.accepted_products||[];
  const fingerprints=[...new Set(products.map(item=>item?.template?.fingerprint?.hash).filter(Boolean))];
  const signatures=[];
  const seen=new Set();
  for(const item of products){const value=item?.template?.fingerprint?.signature;if(!value)continue;const key=JSON.stringify(value);if(seen.has(key))continue;seen.add(key);signatures.push(value);}
  return {
    schema_version:'site-template-binding-v1',algorithm:'site-template-fingerprint-v1',
    accepted_fingerprints:fingerprints,accepted_signatures:signatures,
    sample_urls:products.map(item=>item.source_url).filter(Boolean),bound_at:new Date().toISOString(),
  };
}
function mapRun(row){return {...row,id:Number(row.id),rule_id:Number(row.rule_id),source_id:Number(row.source_id),result:parsed(row.result,null)};}

function createSiteRuleControl(db,dependencies={}){
  async function getRule(id){const [rows]=await db.query('SELECT * FROM product_ingestion_site_rules WHERE id=?',[Number(id)]);return rows[0]?mapRule(rows[0]):null;}
  async function assertSourceScope(sourceId,config){
    const [rows]=await db.query('SELECT * FROM product_ingestion_sources WHERE id=?',[Number(sourceId)]);const source=rows[0];if(!source)fail('抓取来源不存在',404,'SOURCE_NOT_FOUND');
    const sourceHosts=new Set(parsed(source.allowed_hosts,[]).map(value=>String(value).toLowerCase())),sourceAssets=new Set(parsed(source.allowed_asset_hosts,[]).map(value=>String(value).toLowerCase()));
    let baseHost='';try{baseHost=new URL(source.base_url).hostname.toLowerCase();sourceHosts.add(baseHost);sourceAssets.add(baseHost);}catch{}
    if(config.scope.base_url!==source.base_url)fail('规则官网地址与来源记录不一致',409,'SITE_RULE_SCOPE_MISMATCH');
    if(String(config.brand||'').trim().toLowerCase()!==String(source.brand_name||'').trim().toLowerCase())fail('规则品牌与来源记录不一致',409,'SITE_RULE_SCOPE_MISMATCH');
    if(config.scope.allowed_page_hosts.some(value=>!sourceHosts.has(value)))fail('规则页面域名超出来源授权范围',409,'SITE_RULE_SCOPE_MISMATCH');
    if(config.scope.allowed_asset_hosts.some(value=>!sourceAssets.has(value)))fail('规则素材域名超出来源授权范围',409,'SITE_RULE_SCOPE_MISMATCH');
    return source;
  }
  async function prepareSandbox(id,actor,allowedStatuses=['draft','sandbox_passed']){
    const rule=await getRule(id);if(!rule)fail('站点规则不存在',404,'SITE_RULE_NOT_FOUND');if(!allowedStatuses.includes(rule.status))fail('当前规则状态不能执行沙箱抽样',409,'SITE_RULE_STATE_INVALID');
    const source=await assertSourceScope(rule.source_id,rule.config);if(source.status!=='active')fail('抓取来源未启用，不能执行沙箱',409,'SOURCE_NOT_ACTIVE');
    const [running]=await db.query("SELECT id FROM product_ingestion_rule_sandbox_runs WHERE rule_id=? AND status='running' LIMIT 1",[rule.id]);
    if(running.length)fail('该规则已有沙箱正在运行，请查看当前进度',409,'SITE_RULE_SANDBOX_ALREADY_RUNNING');
    const [stored]=await db.query(`INSERT INTO product_ingestion_rule_sandbox_runs (rule_id,source_id,status,config_hash,max_pages,max_products,request_interval_ms,created_by,started_at) VALUES (?,?,'running',?,?,?,?,?,NOW())`,[rule.id,rule.source_id,rule.config_hash,rule.config.sandbox.max_pages,rule.config.sandbox.max_products,rule.config.sandbox.request_interval_ms,String(actor).slice(0,80)]);
    return {rule,runId:Number(stored.insertId)};
  }
  async function completeSandbox(rule,runId,options={}){
    try{
      const result=await executeSiteRuleSandbox(rule.config,{source_id:rule.source_id,audit_db:db,fetchHtml:dependencies.fetchHtml,onProgress:dependencies.onProgress});
      const status=result.passed?'completed':'no_improvement';
      await db.query('UPDATE product_ingestion_rule_sandbox_runs SET status=?,result=?,finished_at=NOW() WHERE id=?',[status,JSON.stringify(result),runId]);
      const nextStatus=options.preserveFrozen?(result.passed?'frozen':'invalidated'):(result.passed?'sandbox_passed':'draft');
      await db.query('UPDATE product_ingestion_site_rules SET status=?,last_sandbox_result=?,last_sandbox_run_id=?,updated_at=NOW() WHERE id=? AND config_hash=?',[nextStatus,JSON.stringify(result),runId,rule.id,rule.config_hash]);
      return {run_id:runId,rule_id:rule.id,status,result};
    }catch(error){await db.query(`UPDATE product_ingestion_rule_sandbox_runs SET status='failed',failure_code=?,last_error=?,finished_at=NOW() WHERE id=?`,[String(error.code||'SANDBOX_FAILED').slice(0,80),String(error.message||error).slice(0,1000),runId]);throw error;}
  }
  return {
    validate(config){const validation=validateSiteRule(config);return {...validation,config_hash:validation.valid?configHash(config):null};},
    async create(sourceId,config,actor){
      const validation=validateSiteRule(config);if(!validation.valid)fail(`规则校验失败：${[...validation.schema_errors,...validation.semantic_errors].join('；')}`,409,'SITE_RULE_VALIDATION_FAILED');
      await assertSourceScope(sourceId,config);
      const [[version]]=await db.query('SELECT COALESCE(MAX(version_number),0)+1 next_version FROM product_ingestion_site_rules WHERE source_id=?',[Number(sourceId)]);
      const hash=configHash(config);
      const [stored]=await db.query(`INSERT INTO product_ingestion_site_rules (source_id,schema_version,version_number,status,config,config_hash,validation_result,created_by) VALUES (?,?,?,'draft',?,?,?,?)`,[Number(sourceId),config.schema_version,Number(version.next_version),JSON.stringify(config),hash,JSON.stringify(validation),String(actor).slice(0,80)]);
      return getRule(stored.insertId);
    },
    get:getRule,
    async list(query={}){const params=[];let where='';if(query.source_id){where='WHERE source_id=?';params.push(Number(query.source_id));}const [rows]=await db.query(`SELECT * FROM product_ingestion_site_rules ${where} ORDER BY id DESC LIMIT 200`,params);return rows.map(mapRule);},
    async listRuns(ruleId){const [rows]=await db.query('SELECT * FROM product_ingestion_rule_sandbox_runs WHERE rule_id=? ORDER BY id DESC LIMIT 50',[Number(ruleId)]);return rows.map(mapRun);},
    async runSandbox(id,actor){
      const prepared=await prepareSandbox(id,actor);return completeSandbox(prepared.rule,prepared.runId);
    },
    async revalidateFrozen(id,actor){
      const prepared=await prepareSandbox(id,actor,['frozen']);
      return completeSandbox(prepared.rule,prepared.runId,{preserveFrozen:true});
    },
    async startSandbox(id,actor){
      const prepared=await prepareSandbox(id,actor);
      setImmediate(()=>completeSandbox(prepared.rule,prepared.runId).catch(error=>console.error('Site-rule sandbox failed:',{ruleId:prepared.rule.id,runId:prepared.runId,code:error.code||error.name,message:error.message})));
      return {run_id:prepared.runId,rule_id:prepared.rule.id,status:'running',next_action:'poll_sandbox_run'};
    },
    async freeze(id,body,actor){
      if(body.confirmation!=='冻结此站点规则')fail('请输入“冻结此站点规则”完成确认');
      const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
      try{
        if(typeof conn.beginTransaction==='function'){await conn.beginTransaction();transaction=true;}
        const [identityRows]=await conn.query('SELECT source_id FROM product_ingestion_site_rules WHERE id=?',[Number(id)]);
        if(!identityRows[0])fail('站点规则不存在',404,'SITE_RULE_NOT_FOUND');
        // Serialize all freezes for one source before locking the selected rule. This
        // prevents two concurrent confirmations from invalidating each other.
        await conn.query('SELECT id FROM product_ingestion_sources WHERE id=? FOR UPDATE',[Number(identityRows[0].source_id)]);
        const [rows]=await conn.query('SELECT * FROM product_ingestion_site_rules WHERE id=? FOR UPDATE',[Number(id)]);
        const rule=rows[0]?mapRule(rows[0]):null;
        if(!rule)fail('站点规则不存在',404,'SITE_RULE_NOT_FOUND');
        if(rule.status!=='sandbox_passed'||!rule.last_sandbox_result?.passed)fail('规则必须先通过最新沙箱抽样',409,'SITE_RULE_NOT_SANDBOXED');
        const frozenValidation={...(rule.validation_result||{}),template_binding:templateBinding(rule)};
        if(!frozenValidation.template_binding.accepted_fingerprints.length)fail('最新沙箱没有可绑定的产品模板指纹',409,'SITE_RULE_TEMPLATE_BINDING_MISSING');
        const [updated]=await conn.query(`UPDATE product_ingestion_site_rules SET status='frozen',validation_result=?,frozen_by=?,frozen_at=NOW(),updated_at=NOW() WHERE id=? AND status='sandbox_passed' AND config_hash=?`,[JSON.stringify(frozenValidation),String(actor).slice(0,80),rule.id,rule.config_hash]);
        if(!updated.affectedRows)fail('规则状态已变化，请刷新',409,'SITE_RULE_STATE_CHANGED');
        // A template-drift recovery adds another validated template to the same
        // site rule set. Normal/manual replacement keeps the historical
        // single-rule behaviour for backwards compatibility.
        if(body.preserve_existing_templates!==true){
          await conn.query(`UPDATE product_ingestion_site_rules SET status='invalidated',updated_at=NOW() WHERE source_id=? AND status='frozen' AND id<>?`,[rule.source_id,rule.id]);
        }
        if(transaction)await conn.commit();transaction=false;
        return getRule(rule.id);
      }catch(error){if(transaction)await conn.rollback();throw error;}
      finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
    },
    async recoverInterruptedRuns(){const [result]=await db.query(`UPDATE product_ingestion_rule_sandbox_runs SET status='interrupted',failure_code='PROCESS_INTERRUPTED',last_error='服务重启导致沙箱执行中断，可重新运行',finished_at=NOW() WHERE status='running'`);return {recovered:Number(result.affectedRows||0)};},
  };
}

module.exports={createSiteRuleControl,executeSiteRuleSandbox,extractPage,extractDiscoveryLinks,roleFor,canonicalUrl,templateBinding,siteValidationMetrics};
