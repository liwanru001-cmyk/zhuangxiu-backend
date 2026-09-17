'use strict';

const cheerio = require('cheerio');
const { controlledRequest, getRobotsPolicy } = require('./product-ingestion-fetch');
const { assessProductUrl } = require('./product-ingestion-source-analyzer');

function previousOutput(context) {
  return context.previous_results.at(-1)?.output || {};
}
function sourceText(context, evidencePack, evidenceRefs = null) {
  const prior = previousOutput(context);
  if (typeof prior.html === 'string') return prior.html;
  if (typeof prior.body === 'string') return prior.body;
  if (typeof prior.diagnostics?.html === 'string') return prior.diagnostics.html;
  if (typeof prior.diagnostics?.body === 'string') return prior.diagnostics.body;
  const refs=evidenceRefs?new Set(evidenceRefs):null;
  return (evidencePack.evidence||[]).filter(item=>!refs||refs.has(item.evidence_id)).map(item => {
    if(typeof item.observed==='string')return item.observed;
    if(typeof item.observed?.content==='string')return item.observed.content;
    if(typeof item.observed?.html==='string')return item.observed.html;
    return '';
  }).join('\n');
}
function pageFacts(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const absolute=value=>{try{return new URL(value,baseUrl).toString();}catch(_){return null;}};
  const images = $('main img, article img, .product img').toArray().map(node => absolute($(node).attr('data-src') || $(node).attr('src'))).filter(Boolean);
  const productUrls=$('main a[href], article a[href], .product a[href], a[href]').toArray().map(node=>{
    const href=absolute($(node).attr('href'));if(!href)return null;
    const label=$(node).text().replace(/\s+/g,' ').trim();
    try{return assessProductUrl(new URL(href),label).is_product?href:null;}catch(_){return null;}
  }).filter(Boolean);
  return { product_urls:[...new Set(productUrls)], fields:{name:$('main h1, article h1, h1').first().text().replace(/\s+/g, ' ').trim(),description:$('meta[name="description"]').attr('content') || ''}, images:[...new Set(images)] };
}
function createRecoveryActionHandlers({ evidencePack, requestScope, request = controlledRequest } = {}) {
  const get = async action => {
    const robotsPolicy = requestScope?.robots_policy || await getRobotsPolicy(action.target_url, requestScope);
    const response = await request(action.target_url, requestScope, { purpose: action.purpose || 'product', robotsPolicy, maxBytes: action.max_response_bytes });
    return { http_status: response.status, final_url: response.finalUrl, content_type: response.headers?.['content-type'] || '', html: response.body.toString('utf8') };
  };
  return {
    GET_SAME_ORIGIN_PAGE: get,
    GET_SITE_ROOT: get,
    GET_EXACT_URL_ONCE: get,
    GET_SAME_HANDLE_PUBLIC_JSON_ONCE: get,
    CHECK_CURRENT_OFFICIAL_SITEMAP: get,
    async POST_SAME_ORIGIN_PUBLIC_API(action) {
      const body = JSON.stringify(action.parameters || {});
      const robotsPolicy = requestScope?.robots_policy || await getRobotsPolicy(action.target_url, requestScope);
      const response = await request(action.target_url, requestScope, { purpose: 'product', robotsPolicy, method: 'POST', readOnlyPostApproved: true, body, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } });
      const text = response.body.toString('utf8');
      let data; try { data = JSON.parse(text); } catch (_) { data = text; }
      return { http_status: response.status, final_url: response.finalUrl, data };
    },
    async PARSE_SCOPED_DOM(action, context) { return pageFacts(sourceText(context, evidencePack,action.evidence_refs), previousOutput(context).diagnostics?.final_url || evidencePack.source?.url); },
    async PARSE_CSS_BACKGROUND_IMAGE(action, context) {
      const urls = [...sourceText(context, evidencePack,action.evidence_refs).matchAll(/background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/gi)].map(match => match[1]);
      return { background_images: [...new Set(urls)] };
    },
    async EXCLUDE_RELATED_PRODUCTS(_action, context) {
      const prior = previousOutput(context), list = prior.images || prior.diagnostics?.background_images || [];
      return { ...prior, images: list.filter(url => !/(?:related|recommend|qr|logo)/i.test(String(url))) };
    },
    async CLASSIFY_PAGE_ROLE(action, context) {
      const facts = pageFacts(sourceText(context, evidencePack,action.evidence_refs),evidencePack.source?.url);
      return { page_role: facts.fields.name ? 'product_detail' : 'unknown', evidence: facts.fields.name };
    },
    async EXTRACT_SCOPED_LIGHTBOX_CANDIDATES(action, context) {
      const $ = cheerio.load(sourceText(context, evidencePack,action.evidence_refs));
      return { images: [...new Set($('main a[href], article a[href], .product a[href]').toArray().map(node => $(node).attr('href')).filter(value => /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(value || '')))] };
    },
    async PRESERVE_MISSING_FIELDS() { return { missing_fields_preserved: true }; },
    async PARSE_REPEATED_PRODUCT_BLOCKS(action, context) {
      const $ = cheerio.load(sourceText(context, evidencePack,action.evidence_refs));
      const base=evidencePack.source?.url;
      const products = $('[data-product], .product-item, .product').toArray().map(node => {const raw=$(node).find('a[href]').first().attr('href');let source_url='';try{source_url=raw?new URL(raw,base).toString():'';}catch(_){}return { name: $(node).find('h1,h2,h3,.name').first().text().replace(/\s+/g, ' ').trim(), image: $(node).find('img').first().attr('src') || '',source_url };}).filter(item => item.name || item.image||item.source_url);
      return { products,product_urls:[...new Set(products.map(item=>item.source_url).filter(Boolean))] };
    },
    async DEDUPLICATE_NAME_MODEL_IMAGE(_action, context) {
      const products = previousOutput(context).products || [];
      return { products: [...new Map(products.map(item => [`${item.name}|${item.model || ''}|${item.image || ''}`, item])).values()] };
    },
    async INSPECT_SAME_ORIGIN_SCRIPT_REFERENCES(action, context) {
      const $ = cheerio.load(sourceText(context, evidencePack,action.evidence_refs));
      return { script_references: $('script[src]').toArray().map(node => $(node).attr('src')).filter(Boolean) };
    },
    async PROPOSE_PUBLIC_API_PROFILE(_action, context) { return { api_clues: previousOutput(context).script_references || [] }; },
    async MAP_API_FIELDS_TO_FROZEN_SCHEMA(_action, context) { return { frozen_schema_payload: previousOutput(context).data || previousOutput(context) }; },
    async MARK_STALE_BASELINE() { return { stale_baseline: true }; },
    async TLS_VERIFY_REQUIRED() { return { tls_verification_required: true, bypass_allowed: false }; },
    async STOP_BEFORE_CONTENT_EXTRACTION() { return { stopped_before_content_extraction: true }; },
    async RECORD_CERTIFICATE_ERROR() { return { certificate_error_recorded: true }; },
    async QUEUE_HUMAN_TRUST_CHAIN_REVIEW() { return { human_review_queued: true, reason: 'trust_chain' }; },
  };
}

module.exports = { createRecoveryActionHandlers, pageFacts, sourceText };
