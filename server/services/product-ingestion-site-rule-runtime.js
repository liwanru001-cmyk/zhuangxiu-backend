'use strict';

const { discoverSitemapUrls } = require('./product-ingestion-sitemap');
const { validateUrlAgainstSource } = require('./product-ingestion-control');
const { normalizeProductNode } = require('./product-ingestion-extractor');
const { normalizeDetails } = require('./product-details');
const { extractPage, extractDiscoveryLinks, roleFor, canonicalUrl } = require('./product-ingestion-site-rule-sandbox');
const { validateSiteRule, configHash } = require('./product-ingestion-site-rule-schema');
const { addField, assertProductDocumentV2 } = require('./product-schema-v2');

function parsed(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function error(message, code, status = 409) {
  const problem = new Error(message);
  problem.code = code;
  problem.status = status;
  return problem;
}

function assertFrozenRule(rule) {
  if (!rule || rule.status !== 'frozen') throw error('没有可执行的冻结站点规则', 'SITE_RULE_NOT_FROZEN');
  const config = parsed(rule.config, {});
  const validation = validateSiteRule(config);
  if (!validation.valid) throw error(`冻结规则已损坏：${[...validation.schema_errors, ...validation.semantic_errors].join('；')}`, 'SITE_RULE_CORRUPT');
  if (rule.config_hash && rule.config_hash !== configHash(config)) throw error('冻结规则内容与冻结指纹不一致', 'SITE_RULE_HASH_MISMATCH');
  return config;
}

function templateSignatureCompatible(observed, accepted = []) {
  if (!observed || !Array.isArray(accepted)) return false;
  // Image totals and optional content signals legitimately vary by product.
  // Treat navigation/layout anchors as the template identity; field, image and
  // required-signal validation still run independently before this check.
  const stableKeys=['h1','json_ld_product','has_main','heading_bucket'];
  return accepted.some(expected=>expected&&stableKeys.every(key=>expected[key]===observed[key]));
}

async function loadFrozenSiteRule(db, sourceId) {
  try {
    // Keep the JSON rule payload out of the ORDER BY working set. Large V2 rules
    // can otherwise exhaust MySQL's sort buffer even though only one row is needed.
    const [identityRows] = await db.query("SELECT id FROM product_ingestion_site_rules WHERE source_id=? AND status='frozen' ORDER BY version_number DESC,id DESC LIMIT 1", [Number(sourceId)]);
    if (!identityRows[0]) return null;
    const [rows] = await db.query("SELECT * FROM product_ingestion_site_rules WHERE id=? AND source_id=? AND status='frozen' LIMIT 1", [Number(identityRows[0].id), Number(sourceId)]);
    if (!rows[0]) return null;
    return { ...rows[0], id:Number(rows[0].id), source_id:Number(rows[0].source_id), config:parsed(rows[0].config, {}), validation_result:parsed(rows[0].validation_result, {}) };
  } catch (problem) {
    if (problem.code === 'ER_NO_SUCH_TABLE') return null;
    throw problem;
  }
}

async function loadFrozenSiteRules(db, sourceId, limit = 12) {
  try {
    const bounded=Math.min(Math.max(Number(limit)||12,1),50);
    const [identityRows]=await db.query(`SELECT id FROM product_ingestion_site_rules WHERE source_id=? AND status='frozen' ORDER BY version_number DESC,id DESC LIMIT ${bounded}`,[Number(sourceId)]);
    const rules=[];
    for(const identity of identityRows){
      const [rows]=await db.query("SELECT * FROM product_ingestion_site_rules WHERE id=? AND source_id=? AND status='frozen' LIMIT 1",[Number(identity.id),Number(sourceId)]);
      if(rows[0])rules.push({...rows[0],id:Number(rows[0].id),source_id:Number(rows[0].source_id),config:parsed(rows[0].config,{}),validation_result:parsed(rows[0].validation_result,{})});
    }
    return rules;
  } catch (problem) {
    if (problem.code === 'ER_NO_SUCH_TABLE') return [];
    throw problem;
  }
}

function allowedUrl(raw, scope) {
  try { return canonicalUrl(validateUrlAgainstSource(raw, scope)); } catch (_) { return ''; }
}

/**
 * Production discovery for a previously frozen rule. The old generic URL score is
 * deliberately absent: validated rule roles are authoritative inside their scope.
 */
async function discoverProductsWithSiteRule(scope, rule, fetcher, onProgress = async () => {}, options = {}) {
  const config = assertFrozenRule(rule);
  if(config.public_json_api){
    const {discoverApiProducts}=require('./product-ingestion-public-json-api');
    const found=await discoverApiProducts(config.public_json_api,{...scope,base_url:config.scope.base_url,api_quota:scope.api_quota||scope.page_quota},{onProgress,fetchJsonPage:options.fetchJsonPage});
    const urls=found.records.map(item=>item.url),coverageStatus=found.enumeration_complete?'complete':urls.length?'partial':'sample_only';
    return {urls,records:found.records.map(item=>({url:item.url,source_categories:[],detection:{origin:'public_json_api',score:100,evidence:['frozen_site_rule',`rule:${rule.id}`,'public_json_api']}})),evidence_snapshots:[],summary:{pages_scanned:found.pages_scanned,pages_attempted:found.pages_scanned,directory_urls:[config.public_json_api.endpoint_url],products_found:urls.length,result:!urls.length?'no_products_found':found.failures.length?'partial':'success',message:!urls.length?'公开 JSON 商品接口没有返回产品记录':found.enumeration_complete?`公开 JSON 商品接口完成发现，识别到 ${urls.length} 个产品`:`公开 JSON 商品接口已识别 ${urls.length} 个产品，但范围尚未完整`,failures:found.failures,sitemap:null,rule_execution:{mode:'frozen_site_rule_public_json_api',rule_id:rule.id,rule_version:Number(rule.version_number),config_hash:rule.config_hash||configHash(config),generic_score_bypassed:true},pipeline:{source_analysis:{status:'completed',method:'public_json_api'},url_discovery:{status:'completed',urls_found:urls.length},product_detection:{status:urls.length?'completed':'needs_attention',products_found:urls.length},extraction:{status:urls.length?'pending':'not_started'},field_mapping:{status:urls.length?'pending':'not_started'},candidate_ingestion:{status:urls.length?'pending':'not_started'}},discovery_coverage:{status:coverageStatus,enumeration_complete:found.enumeration_complete,sample_seed_urls:0,sitemap_product_urls:0,listing_pages_scanned:found.pages_scanned,listing_product_urls:urls.length,entry_product_urls:0,non_sample_product_urls:urls.length},capped_pages:!found.enumeration_complete&&found.pages_scanned>=Number(scope.max_pages||0),capped_products:urls.length>=Number(scope.max_products||500),excluded:{out_of_scope:0,unrelated:0}}};
  }
  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const products = new Set();
  const productCandidates = new Set();
  const failures = [];
  const detections = new Map();
  const origins = new Map();
  const enqueue = raw => {
    const url = allowedUrl(raw, scope);
    if (!url || queued.has(url)) return;
    queued.add(url);
    queue.push(url);
  };
  const accept = (raw, origin) => {
    const url = allowedUrl(raw, scope);
    if (!url || roleFor(url, config) !== 'product_detail') return;
    productCandidates.add(url);
    if (!origins.has(origin)) origins.set(origin, new Set());
    origins.get(origin).add(url);
    if (products.size >= scope.max_products) return;
    products.add(url);
    detections.set(url, { origin, score:100, evidence:['frozen_site_rule', `rule:${rule.id}`, `config:${rule.config_hash || configHash(config)}`] });
  };

  // Sample product URLs prove extraction, not inventory completeness. Production
  // discovery starts from the task's authorized entry points and the rule base URL.
  const discoveryEntries=unique([...(scope.discovery_entry_urls||[]),...(scope.seed_urls||[]),config.scope.base_url]);
  for (const entry of discoveryEntries) enqueue(entry);
  for (const seed of config.discovery.seed_urls) accept(seed,'frozen_rule_sample_seed');
  let sitemapSummary = null;
  const sitemapDiscoverer = options.sitemapDiscoverer || discoverSitemapUrls;
  if (typeof sitemapDiscoverer === 'function') {
    try {
      const sitemap = await sitemapDiscoverer(scope);
      sitemapSummary = sitemap.summary || null;
      for (const raw of sitemap.urls || []) {
        const role = roleFor(raw, config);
        if (role === 'product_detail') accept(raw, 'frozen_rule_sitemap');
        else if (role === 'listing') enqueue(raw);
      }
    } catch (problem) {
      failures.push({ stage:'sitemap', code:problem.code || 'SITEMAP_DISCOVERY_FAILED', message:String(problem.message || problem).slice(0, 300) });
    }
  }

  while (queue.length && visited.size < scope.max_pages && products.size < scope.max_products) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    try {
      const page = await fetcher(url, scope);
      const pageRole = roleFor(page.url || url, config);
      if (pageRole === 'product_detail') accept(page.url || url, 'frozen_rule_page');
      const links=extractDiscoveryLinks(page,config);
      const linkOrigin=pageRole==='listing'?'frozen_rule_listing_link':'frozen_rule_entry_link';
      for (const candidate of links.product_detail) accept(candidate,linkOrigin);
      // Listing traversal is the inventory-enumeration path. Product pages are
      // extracted later, after discovery is complete, so they are not needlessly
      // downloaded during this phase.
      for (const candidate of links.listing) enqueue(candidate);
    } catch (problem) {
      if (['JOB_NOT_EXECUTABLE','JOB_INTERRUPTED'].includes(problem?.code)) throw problem;
      failures.push({ stage:'fetch', url, code:problem.code || 'PAGE_FETCH_FAILED', message:String(problem.message || problem).slice(0, 300) });
    }
    await onProgress({ pages_scanned:visited.size, pages_attempted:visited.size, products_found:products.size, failures:failures.length, rule_id:rule.id });
  }

  const urls = [...products];
  const countOrigin=name=>origins.get(name)?.size||0;
  const sitemapProducts=countOrigin('frozen_rule_sitemap');
  const listingProducts=countOrigin('frozen_rule_listing_link');
  const entryProducts=countOrigin('frozen_rule_entry_link');
  const listingPages=[...visited].filter(url=>roleFor(url,config)==='listing').length;
  const cappedPages=Boolean(queue.length && visited.size >= scope.max_pages);
  const cappedProducts=productCandidates.size>products.size||Boolean(products.size>=scope.max_products&&queue.length);
  const enumerationComplete=!cappedProducts&&((sitemapProducts>0&&!sitemapSummary?.capped_urls&&!sitemapSummary?.capped_files) ||
    (listingPages>0&&!cappedPages&&!failures.some(item=>item.stage==='fetch')));
  const nonSampleProducts=unique([...origins.entries()].filter(([name])=>name!=='frozen_rule_sample_seed').flatMap(([,values])=>[...values])).length;
  const coverageStatus=enumerationComplete?'complete':nonSampleProducts?'partial':'sample_only';
  const result = !urls.length?'no_products_found':coverageStatus==='sample_only'?'sample_only':(failures.length||coverageStatus==='partial')?'partial':'success';
  return {
    urls,
    records:urls.map(url => ({ url, source_categories:[], detection:detections.get(url) })),
    evidence_snapshots:[],
    summary:{
      pages_scanned:visited.size,
      pages_attempted:visited.size,
      directory_urls:[...visited],
      products_found:urls.length,
      result,
      message:!urls.length?'冻结站点规则未识别到产品详情页，需要重新认识网站':coverageStatus==='sample_only'?`只复核了 ${urls.length} 个规则样本，尚未完成全站产品发现`:coverageStatus==='partial'?`已识别 ${urls.length} 个产品详情页，但全站发现证据尚不完整`:`冻结站点规则完成全站发现，识别到 ${urls.length} 个产品详情页`,
      failures,
      sitemap:sitemapSummary,
      rule_execution:{ mode:'frozen_site_rule', rule_id:rule.id, rule_version:Number(rule.version_number), config_hash:rule.config_hash || configHash(config), generic_score_bypassed:true },
      pipeline:{
        source_analysis:{status:'completed',method:'frozen_site_rule'},
        url_discovery:{status:'completed',urls_found:urls.length},
        product_detection:{status:urls.length ? 'completed' : 'needs_attention',products_found:urls.length},
        extraction:{status:urls.length ? 'pending' : 'not_started'},
        field_mapping:{status:urls.length ? 'pending' : 'not_started'},
        candidate_ingestion:{status:urls.length ? 'pending' : 'not_started'},
      },
      discovery_coverage:{status:coverageStatus,enumeration_complete:enumerationComplete,sample_seed_urls:countOrigin('frozen_rule_sample_seed'),sitemap_product_urls:sitemapProducts,listing_pages_scanned:listingPages,listing_product_urls:listingProducts,entry_product_urls:entryProducts,non_sample_product_urls:nonSampleProducts},
      capped_pages:cappedPages,
      capped_products:cappedProducts,
      excluded:{out_of_scope:0,unrelated:0},
    },
  };
}

function parseVariantItems(page, config) {
  const rule = config.extraction.variants;
  if (rule.mode === 'none' || !rule.item_selector) return [];
  const cheerio = require('cheerio');
  const $ = cheerio.load(page.html);
  const items = [];
  try {
    $(rule.item_selector).slice(0, 100).each((index, node) => {
      const value = $(node);
      const text = value.text().replace(/\s+/g, ' ').trim();
      const attributes = node.attribs || {};
      const item = { index, label:text || null, source_attributes:{} };
      for (const field of rule.identity_fields) {
        const variants = [attributes[`data-${field}`], attributes[field], value.find(`[data-${field}]`).first().attr(`data-${field}`)].filter(Boolean);
        item[field] = String(variants[0] || (field === 'name' ? text : '')).trim() || null;
      }
      for (const [key, raw] of Object.entries(attributes)) if (/^(?:data-|id$|class$)/.test(key)) item.source_attributes[key] = String(raw).slice(0, 500);
      if (item.label || rule.identity_fields.some(field => item[field])) items.push(item);
    });
  } catch (_) {}
  return items;
}

function extractProductWithSiteRule(page, rule, options = {}) {
  const config = assertFrozenRule(rule);
  const row = extractPage(page, config, {ocrEvidence:options.ocrEvidence||{}});
  if (!row.accepted) {
    const stale = row.validation_errors.some(value => value.startsWith('TEMPLATE_SIGNALS_MISSING'));
    throw error(`冻结规则未通过页面校验：${row.validation_errors.join('；')}`, stale ? 'SITE_RULE_TEMPLATE_STALE' : 'SITE_RULE_EXTRACTION_REJECTED');
  }
  const binding=parsed(rule.validation_result,{})?.template_binding;
  const observedFingerprint=row.template?.fingerprint?.hash;
  const exactTemplate=Array.isArray(binding?.accepted_fingerprints)&&binding.accepted_fingerprints.includes(observedFingerprint);
  const compatibleTemplate=templateSignatureCompatible(row.template?.fingerprint?.signature,binding?.accepted_signatures);
  if(config.validation.require_template_match&&Array.isArray(binding?.accepted_fingerprints)&&binding.accepted_fingerprints.length&&!exactTemplate&&!compatibleTemplate){
    throw error('页面结构指纹不属于冻结规则验证过的模板，已停止并请求重新认识网站', 'SITE_RULE_TEMPLATE_STALE');
  }
  const fields = row.fields;
  if(config.schema_version==='site-rule-config-v2'){
    const rich=row.structured,document=rich.product_document,product=document.data.product,coverAsset=document.data.assets.find(item=>item.role==='hero')||document.data.assets.find(item=>['product_gallery','scene','detail','configuration_image'].includes(item.role));
    if(options.productType){
      product.product_type=options.productType;
      addField(document,'/product/product_type',options.productType,'inferred',{
        type:'system',
        section:`classification:${options.productTypeMethod||'runtime'}`,
        raw_value:options.productType,
        confidence:options.productTypeConfidence,
      });
      assertProductDocumentV2(document);
    }
    return {
      payload:{name:product.names.primary||product.names.zh||product.names.en||'',cover_url:coverAsset?.url||'',brand:options.brandName||config.brand,spec:'',price_text:'',description:product.description||'',product_group:'soft_furnishings',product_type:options.productType||'furniture',product_schema_version:2,product_document:document},
      generatedFields:[
        {path:'site_rule',rule:'frozen_site_rule_v2',value:`rule:${rule.id}@${rule.version_number}`,confidence:1,evidence:config.provenance.evidence_ids},
        {path:'product_document',rule:'product_schema_v2_mapping',value:`${document.data.configurations.length} 个配置 · ${document.data.option_groups.length} 个选项组 · ${document.data.assets.length} 个素材`,confidence:1,evidence:Object.keys(document.evidence)},
      ],
      extracted:{extraction_method:'frozen_site_rule_v2',rule_id:rule.id,rule_version:Number(rule.version_number),config_hash:rule.config_hash,...fields,images:rich.assets,top5:rich.top5,attachments:rich.attachments,configurations:rich.configurations,option_groups:rich.option_groups,product_document:document,coverage:rich.coverage,template:row.template,evidence:row.evidence},
    };
  }
  if(config.schema_version==='site-rule-config-v1.1'){
    const rich=row.structured;
    const configurations=rich.configurations.map(item=>({
      id:item.id,name:item.name,code:item.code,shape:item.shape,dimensions:item.dimensions,dimension_unit:item.dimension_unit,
      dimension_note:item.dimension_note,parts:item.parts.map(part=>({part:part.part,material:part.material,color:part.color,code:part.code,swatch_url:part.swatch_url})),
      material_options:item.material_options||[],image_urls:item.image_urls,image_url:item.image_url,drawing_url:item.drawing_url,drawing_name:item.drawing_name,
      unit:item.unit,price_state:item.price_state,currency:'CNY',price:item.price,includes:item.includes,
    }));
    const details=normalizeDetails({schema_version:1,furniture_type:rich.furniture_type,model:fields.model||'',source_url:page.url,source_merchant_id:null,configurations,customization:rich.customization},'furniture');
    const cover=rich.top5[0]?.url||rich.assets.find(item=>['main','angle','scene','detail'].includes(item.role))?.url||configurations[0]?.image_url||'';
    return {
      payload:{name:fields.name,cover_url:cover,brand:options.brandName||config.brand,spec:'',price_text:'',description:fields.description||'',product_group:'soft_furnishings',product_type:options.productType||'furniture',product_details:details},
      generatedFields:[
        {path:'site_rule',rule:'frozen_site_rule_v1.1',value:`rule:${rule.id}@${rule.version_number}`,confidence:1,evidence:config.provenance.evidence_ids},
        {path:'product_details.configurations',rule:'declarative_structured_mapping_v1',value:`${configurations.length} 个配置`,confidence:1,evidence:[JSON.stringify(rich.coverage)]},
      ],
      extracted:{extraction_method:'frozen_site_rule_v1.1',rule_id:rule.id,rule_version:Number(rule.version_number),config_hash:rule.config_hash,...fields,images:rich.assets,top5:rich.top5,attachments:rich.attachments,configurations:rich.configurations,coverage:rich.coverage,template:row.template,evidence:row.evidence},
    };
  }
  const imageRecognition = {
    strategy:'frozen_site_rule_v1', confidence:1, urls:row.images.map(item => item.url),
    decisions:row.images.map(item => ({ url:item.url, selected:true, score:100, reasons:[`site_rule_top_${item.top5_rank}`] })),
  };
  const node = {
    '@type':'Product', name:fields.name, description:fields.description || '', model:fields.model || '',
    sku:fields.model || '', category:fields.category || '', material:fields.material || '', image:imageRecognition.urls,
    additionalProperty:fields.dimensions ? [{name:'尺寸',value:fields.dimensions}] : [],
  };
  const normalized = normalizeProductNode(node, options.productType || config.extraction.product_type, page.url, imageRecognition);
  normalized.payload.brand = options.brandName || config.brand;
  normalized.generatedFields.push({
    path:'site_rule', rule:'frozen_site_rule_v1', value:`rule:${rule.id}@${rule.version_number}`,
    confidence:1, evidence:config.provenance.evidence_ids,
  });
  for (const [name, value] of Object.entries(fields)) if (value && !['name','description','model','category','material','dimensions'].includes(name)) {
    normalized.generatedFields.push({ path:`source_fields.${name}`, rule:'frozen_site_rule_v1', value, evidence:[JSON.stringify(row.field_evidence[name] || {})] });
  }
  const variants = parseVariantItems(page, config);
  return {
    ...normalized,
    extracted:{
      extraction_method:'frozen_site_rule_v1', rule_id:rule.id, rule_version:Number(rule.version_number), config_hash:rule.config_hash,
      ...fields, image_recognition:imageRecognition, images:row.images, variants,
      attachments:row.attachments, relationships:row.relationships, template:row.template, evidence:row.evidence,
    },
  };
}

function extractProductWithSiteRuleSet(page, rules, options = {}) {
  const failures=[];
  for(const rule of rules||[]){
    try{return {rule,result:extractProductWithSiteRule(page,rule,options)};}
    catch(problem){
      if(problem?.code!=='SITE_RULE_TEMPLATE_STALE')throw problem;
      failures.push({rule_id:Number(rule.id),message:String(problem.message||problem).slice(0,500)});
    }
  }
  const problem=error('页面结构不属于任何已验证的冻结模板，已保留现有规则并请求补充新模板','SITE_RULE_TEMPLATE_STALE');
  problem.template_failures=failures;
  throw problem;
}

async function invalidateRule(db, ruleId, reason, actor = 'system:template-monitor') {
  const [result] = await db.query("UPDATE product_ingestion_site_rules SET status='invalidated',validation_result=JSON_SET(COALESCE(validation_result,JSON_OBJECT()),'$.invalidation_reason',?,'$.invalidated_by',?,'$.invalidated_at',?),updated_at=NOW() WHERE id=? AND status='frozen'", [String(reason).slice(0, 500), String(actor).slice(0, 80), new Date().toISOString(), Number(ruleId)]);
  return Number(result.affectedRows || 0);
}

module.exports = {
  assertFrozenRule,
  loadFrozenSiteRule,
  loadFrozenSiteRules,
  discoverProductsWithSiteRule,
  templateSignatureCompatible,
  extractProductWithSiteRule,
  extractProductWithSiteRuleSet,
  invalidateRule,
};
