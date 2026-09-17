'use strict';

const crypto = require('crypto');
const cheerio = require('cheerio');
const { discoverSitemapUrls } = require('./product-ingestion-sitemap');
const { validateUrlAgainstSource } = require('./product-ingestion-control');
const { mineStructuredEvidence } = require('./product-ingestion-structured-evidence');
const { classifyIngestionOutcome } = require('./product-ingestion-outcome-classifier');
const { urlRole } = require('./product-ingestion-url-role-contract');

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function clean(value, max = 500) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function decodedPath(raw) { try { return decodeURIComponent(new URL(raw).pathname); } catch (_) { return ''; } }
function decodedPrefix(raw) { try { return decodeURIComponent(String(raw || '')); } catch (_) { return String(raw || ''); } }
function canonical(raw) { try { const url=new URL(raw);url.hash='';return url.toString(); } catch (_) { return ''; } }
function inScope(raw, scope) { try { return canonical(validateUrlAgainstSource(raw, scope)); } catch (_) { return ''; } }

function pathFamily(raw) {
  const parts = decodedPath(raw).split('/').filter(Boolean);
  if (!parts.length) return '/';
  const stable = parts.slice(0, -1);
  return `/${[...stable, parts.length > 1 ? '{leaf}' : parts[0]].join('/')}/`;
}

function clusterUrls(urls) {
  const groups = new Map();
  for (const raw of urls) {
    const url = canonical(raw); if (!url) continue;
    const key = `${new URL(url).hostname}|${pathFamily(url)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(url);
  }
  return [...groups.entries()].map(([key, values], index) => ({
    cluster_id:`UC-${String(index + 1).padStart(3, '0')}`,
    decoded_path_pattern:key.split('|').slice(1).join('|'),
    estimated_count:values.length,
    representative_urls:values.slice(0, 3),
    url_examples:values.slice(0, 8),
  })).sort((left, right) => right.estimated_count - left.estimated_count || left.decoded_path_pattern.localeCompare(right.decoded_path_pattern));
}

function stableSelector(node, $) {
  const value = $(node), id=value.attr('id');
  if (id && /^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(id)) return `#${id}`;
  const classes = String(value.attr('class') || '').split(/\s+/).filter(item => /^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(item)).slice(0, 3);
  return `${node.tagName || node.name || '*'}${classes.map(item => `.${item}`).join('')}`.slice(0, 200);
}

function contentRoot($){
  const h1=$('h1').first();
  if(h1.length){
    const containingMain=h1.closest('main');if(containingMain.length&&clean(containingMain.text(),1000).length>100)return containingMain;
    const containingArticle=h1.closest('article');if(containingArticle.length)return containingArticle;
    const candidates=h1.parents().filter((_,node)=>!['header','nav','footer','body','html'].includes(node.name)&&$(node).find('img').length>=2&&$(node).find('h2,h3,h4').length>=1&&clean($(node).text(),2000).length>=300);
    if(candidates.length)return candidates.first();
  }
  return $('main').first().length?$('main').first():$('article').first().length?$('article').first():$('body').first();
}

function imageRegionScore(region,productName){
  const text=`${region.selector} ${region.sample_attributes.map(item=>`${item.alt} ${item.src} ${item.data_src}`).join(' ')}`.toLowerCase(),name=String(productName||'').toLowerCase();
  let score=Math.min(region.image_count,8);
  if(/gallery|product|hero|media|slider|carousel/.test(text))score+=12;
  if(name&&text.includes(name))score+=15;
  if(/footer|header|nav|menu|logo|recommend|related|wechat|qrcode/.test(text))score-=20;
  return score;
}

const SECTION_PATTERNS=Object.freeze({
  configuration:/configuration|variant|model|type|product\s*standard|款型|款式|规格|型号|组合/i,
  dimensions:/dimension|measurement|size|尺寸|宽|深|高/i,
  options:/material|fabric|leather|finish|colour|color|swatch|材质|面料|皮革|饰面|色彩|颜色|色卡/i,
  designer:/designer|designed\s+by|设计师|设计者/i,
  release:/release|published|launch|发布日期|发布日|上市时间/i,
  gallery:/gallery|product\s*image|carousel|slider|产品图片|产品展示/i,
  certificate:/certificate|certification|award|专利|证书|认证|获奖/i,
  attachment:/download|drawing|technical|图纸|下载|附件/i,
});
function sectionKind(label){for(const [kind,pattern] of Object.entries(SECTION_PATTERNS))if(pattern.test(label))return kind;return 'other';}

function pageCard(page, id) {
  const $ = cheerio.load(String(page.html || ''));
  const main = contentRoot($),documentTitle=clean($('title').text(),300),titleStem=clean(documentTitle.split(/\s*(?:\||[-–—])\s*/)[0],160);
  const headings = $('h1,h2,h3').map((_, node) => clean($(node).text(), 220)).get().filter(Boolean).slice(0, 20);
  const links = $('a[href]').map((_, node) => {
    try { return { url:new URL($(node).attr('href'), page.url).toString(), text:clean($(node).text(), 120) }; } catch (_) { return null; }
  }).get().filter(Boolean).slice(0, 120);
  const jsonLd = $('script[type="application/ld+json"]').map((_, node) => clean($(node).html(), 4000)).get().filter(Boolean).slice(0, 5);
  const imageRegions = [],semanticSections=[];
  const fieldContexts=[];const addFieldContext=(field,node,text)=>{let selector=stableSelector(node,$),value=clean(text,900);if(/^[a-z]+$/i.test(selector)){const ancestor=$(node).parents().toArray().find(parent=>!/^[a-z]+$/i.test(stableSelector(parent,$)));if(ancestor)selector=`${stableSelector(ancestor,$)} ${node.name}`;}if(value&&!fieldContexts.some(item=>item.field===field&&item.selector===selector&&item.text===value))fieldContexts.push({field,selector,text:value});};
  if(!$('h1').first().text().trim()&&titleStem.length>=2){
    const exact=$('body *').toArray().filter(node=>clean($(node).text(),200)===titleStem).sort((left,right)=>$(left).find('*').length-$(right).find('*').length);
    const named=exact.find(node=>!/^[a-z]+$/i.test(stableSelector(node,$)))||exact[0];
    if(named)addFieldContext('name',named,titleStem);
  }
  main.find('h2,h3,h4,h5,dt,th').each((_,node)=>{const label=clean($(node).text(),120),container=$(node).closest('section,article,dl,table,div').first(),target=container[0]||node,text=clean(container.length?container.text():$(node).parent().text(),4000);if(text.length>label.length+5){const kind=sectionKind(label);if(!semanticSections.some(item=>item.kind===kind&&item.selector===stableSelector(target,$)))semanticSections.push({kind,label,selector:stableSelector(target,$),text:text.slice(0,2400),image_count:$(target).find('img').length});}if(text.length<=label.length+5||text.length>2400)return;if(SECTION_PATTERNS.options.test(label))addFieldContext('material_options',target,text);if(SECTION_PATTERNS.dimensions.test(label))addFieldContext('dimensions',target,text);if(SECTION_PATTERNS.configuration.test(label))addFieldContext('configurations',target,text);if(SECTION_PATTERNS.designer.test(label))addFieldContext('designer',target,text);if(SECTION_PATTERNS.release.test(label))addFieldContext('release_date',target,text);});
  const structuredEvidence=mineStructuredEvidence($,main[0],id);
  for(const section of structuredEvidence.anchors){
    if(!semanticSections.some(item=>item.kind===section.kind&&item.selector===section.selector))semanticSections.push(section);
    if(section.text.length<=2400){if(section.kind==='configuration')addFieldContext('configurations',main.find(section.selector).first()[0]||main[0],section.text);if(section.kind==='options')addFieldContext('material_options',main.find(section.selector).first()[0]||main[0],section.text);}
  }
  const primaryHeading=$('h1').first();if(primaryHeading.length){const parent=primaryHeading.parent();parent.children('p,div,span').slice(0,5).each((_,node)=>{const value=clean($(node).text(),500);if(value.length>=2&&value.length<=160&&/^[\p{L}\s&'’.:-]+$/u.test(value)&&/[A-Za-z]{2}/.test(value))addFieldContext('english_name',node,value);});}
  main.find('p,li,span').each((_,node)=>{if(fieldContexts.length>=30)return;const text=clean($(node).text(),900);if(!text||text.length>800)return;if(/(?:designer|designed\s+by|设计师|由.{1,100}设计)/i.test(text))addFieldContext('designer',node,text);if(/(?:发布日期|发布日|release\s*date|published)\s*[:：]?\s*(?:19|20)\d{2}(?:[.\-/年]\d{1,2})?/i.test(text))addFieldContext('release_date',node,text);if(/(?:19|20)\d{2}\s*年(?:\s*由.{1,100}设计)?/i.test(text))addFieldContext('design_year',node,text);if(text.length>=80&&!$(node).find('*').length)addFieldContext('description',node,text);});
  const attachmentLinks=main.find('a[href],[data-file-url]').map((_,node)=>{try{const attribute=$(node).attr('data-file-url')?'data-file-url':'href',url=new URL($(node).attr(attribute),page.url).toString();return /\.(?:pdf|dwg|dxf|zip|3dm|fbx|max|skp)(?:$|[?#])/i.test(url)?{url,text:clean($(node).text(),160),selector:stableSelector(node,$),attribute}:null;}catch{return null;}}).get().filter(Boolean).slice(0,30);
  main.find('article,section,div').addBack('article,section,div').each((_, node) => {
    if (imageRegions.length >= 100) return;
    const images = $(node).find('img');
    if (images.length < 2 || images.length > 60) return;
    const selector = stableSelector(node, $);
    if (imageRegions.some(item => item.selector === selector)) return;
    imageRegions.push({ selector, image_count:images.length, sample_attributes:images.slice(0, 5).map((__, image) => ({
      src:clean($(image).attr('src'), 1000), data_src:clean($(image).attr('data-src') || $(image).attr('data-original'), 1000), alt:clean($(image).attr('alt'), 200),
    })).get() });
  });
  const sanitized=node=>{const clone=$(node).clone();clone.find('script:not([type="application/ld+json"]),style,noscript,svg').remove();return clone.prop('outerHTML')||'';};
  const evidenceNodes=[],seenEvidence=new Set(),addEvidence=node=>{if(!node)return;const html=sanitized(node),key=hash(html);if(!html||seenEvidence.has(key))return;seenEvidence.add(key);evidenceNodes.push(html);};
  const h1=$('h1').first();addEvidence(h1.closest('section,article').first()[0]||h1.parent()[0]);
  for(const context of fieldContexts.filter(item=>item.field==='name')){try{addEvidence($('body').find(context.selector).first()[0]);}catch{}}
  main.find('h2,h3,h4,h5').each((_,node)=>{if(sectionKind(clean($(node).text(),160))!=='other')addEvidence($(node).closest('section,article,div').first()[0]||node);});
  main.find('[data-file-url],iframe[src]').each((_,node)=>addEvidence($(node).closest('section,article,div').first()[0]||node));
  for(const context of fieldContexts){try{addEvidence(main.find(context.selector).first()[0]);}catch{}}
  for(const region of imageRegions.slice(0,3)){try{addEvidence(main.find(region.selector).first()[0]);}catch{}}
  const mainFallback=sanitized(main[0]);const mainDom=(evidenceNodes.length?evidenceNodes.join('\n'):mainFallback).slice(0,18000);
  return {
    page_id:id, url:page.url, original_url:page.requestedUrl || page.url, normalized_url:canonical(page.url), decoded_path:decodedPath(page.url),
    http_status:Number(page.status || 0), content_type:page.contentType || '', acquisition_channel:page.acquisition_channel||'static_html', title:documentTitle, h1:clean($('h1').first().text(), 300),
    breadcrumbs:$('[class*="breadcrumb"],nav[aria-label*="breadcrumb" i]').first().find('a,span').map((_, node) => clean($(node).text(), 100)).get().filter(Boolean).slice(0, 12),
    headings, visible_text:clean(main.text(), 6000), links, json_ld:jsonLd,
    field_contexts:fieldContexts.slice(0,30),semantic_sections:semanticSections.slice(0,30),attachment_links:attachmentLinks,
    extraction_regions:structuredEvidence.regions,
    image_regions:imageRegions.sort((left,right)=>imageRegionScore(right,titleStem)-imageRegionScore(left,titleStem)||left.image_count-right.image_count).slice(0,20),
    dom_evidence_regions:evidenceNodes.slice(0,8).map((html,index)=>({region_id:`${id}-R${String(index+1).padStart(2,'0')}`,html:html.slice(0,4500),truncated:html.length>4500})),
    limited_main_dom:mainDom, dom_truncated:(evidenceNodes.length?evidenceNodes.join('\n').length:mainFallback.length) > 18000,
    public_json_api_evidence:(page.public_json_api_evidence||[]).slice(0,8),
    content_hash:hash(page.html || ''), html_bytes:Buffer.byteLength(String(page.html || '')),
  };
}

function selectRepresentatives(scope, clusters, maxPages) {
  const result = [];
  const add = raw => { const url=inScope(raw, scope);if (url && !result.includes(url) && result.length < maxPages) result.push(url); };
  for (const raw of scope.seed_urls || [scope.base_url]) add(raw);
  for (const cluster of clusters) for (const raw of cluster.representative_urls.slice(0, 1)) add(raw);
  return result;
}

async function buildSiteMap(scope, dependencies = {}) {
  const sitemapDiscoverer = dependencies.discoverSitemapUrls || discoverSitemapUrls;
  const fetcher = dependencies.fetchHtml;
  if (typeof fetcher !== 'function') throw new Error('网站结构地图缺少受控页面读取器');
  let sitemap = { urls:[], summary:{files_scanned:0,urls_found:0,failures:[]} };
  try { sitemap = await sitemapDiscoverer(scope, {maxUrls:5000}); } catch (problem) { sitemap.summary={files_scanned:0,urls_found:0,failures:[{code:problem.code || 'SITEMAP_FAILED',message:problem.message}]}; }
  const allUrls = [...new Set([...(scope.seed_urls || []), ...(sitemap.urls || [])].map(raw => inScope(raw, scope)).filter(Boolean))];
  const initialClusters = clusterUrls(allUrls);
  const probeLimit = Math.min(12, Math.max(3, Number(scope.site_cognition_probe_pages || 8)), Number(scope.max_pages || 8));
  const initialLimit=Math.min(probeLimit,Math.max(3,Math.ceil(probeLimit*0.55)));
  const initialQueue=selectRepresentatives(scope,initialClusters,initialLimit),frontier=[],queued=new Set(initialQueue),visited=new Set(),allUrlSet=new Set(allUrls);
  const knownFamilies=new Set(initialClusters.map(cluster=>cluster.decoded_path_pattern));
  const pages = [], cards=[],failures = [];
  while((frontier.length||initialQueue.length)&&pages.length+failures.length<probeLimit){
    const url=frontier.shift()||initialQueue.shift();if(!url||visited.has(url))continue;visited.add(url);
    try {
      const page=await fetcher(url,scope),card=pageCard(page,`P-${String(cards.length+1).padStart(3,'0')}`);pages.push(page);cards.push(card);
      const byFamily=new Map();
      for(const link of card.links||[]){
        const candidate=inScope(link.url,scope);if(!candidate||visited.has(candidate)||queued.has(candidate))continue;
        const family=pathFamily(candidate);if(knownFamilies.has(family))continue;
        if(!byFamily.has(family))byFamily.set(family,[]);byFamily.get(family).push({url:candidate,text:link.text});
      }
      const ranked=[...byFamily.entries()].sort((left,right)=>right[1].length-left[1].length||left[0].localeCompare(right[0])).slice(0,3);
      for(const [family,links] of ranked){
        const candidates=[...new Set(links.map(item=>item.url))].slice(0,8),candidate=candidates[0];if(!candidate)continue;
        knownFamilies.add(family);
        for(const linkedUrl of candidates)if(!allUrlSet.has(linkedUrl)){allUrlSet.add(linkedUrl);allUrls.push(linkedUrl);}
        queued.add(candidate);frontier.push(candidate);
      }
    } catch (problem) { failures.push({url,code:problem.code || 'PAGE_FETCH_FAILED',message:String(problem.message || problem).slice(0, 500),outcome:classifyIngestionOutcome(problem,{stage:'site_mapping'})}); }
  }
  const clusters=clusterUrls(allUrls);
  return {
    schema_version:'site-structure-map-v1.0',
    site:{brand:scope.brand_name,entry_url:scope.base_url,allowed_hosts:scope.allowed_hosts,allowed_asset_hosts:scope.allowed_asset_hosts || scope.allowed_hosts,allowed_path_prefixes:scope.allowed_path_prefixes,request_interval_ms:scope.request_interval_ms},
    coverage:{sitemap_urls:(sitemap.urls || []).length,sitemap_files:Number(sitemap.summary?.files_scanned || 0),sampled_pages:cards.length,failed_pages:failures.length,template_clusters:clusters.length},
    clusters:clusters.slice(0, 80).map(cluster => ({...cluster, representative_pages:cards.filter(card => cluster.representative_urls.includes(card.url)).map(card => card.page_id)})),
    pages:cards,
    failures,
    sitemap_summary:sitemap.summary,
    evidence_levels:['L0','L1','L2','L3'],
  };
}

async function augmentProductEvidence(siteMap,scope,discovery,dependencies={}){
  const fetcher=dependencies.fetchHtml;if(typeof fetcher!=='function')throw new Error('产品结构取证缺少受控页面读取器');
  const rules={matching_priority:['exclude','product_detail','listing'],...discovery},existing=new Set((siteMap.pages||[]).map(x=>x.url));
  const candidates=(siteMap.clusters||[]).flatMap(x=>x.url_examples||[]).filter(url=>urlRole(url,rules)==='product_detail'&&!existing.has(url));
  const added=[],failures=[];for(const url of candidates){if(added.length>=4)break;try{const page=await fetcher(url,scope);added.push(pageCard(page,`P-${String((siteMap.pages||[]).length+added.length+1).padStart(3,'0')}`));}catch(error){failures.push({url,code:error.code||'PRODUCT_EVIDENCE_FETCH_FAILED',message:String(error.message||error).slice(0,500),outcome:classifyIngestionOutcome(error,{stage:'product_evidence'})});}}
  const knownProduct=(siteMap.pages||[]).filter(page=>urlRole(page.url,rules)==='product_detail');
  return {...siteMap,pages:[...added,...knownProduct,...(siteMap.pages||[]).filter(page=>!knownProduct.includes(page))],failures:[...(siteMap.failures||[]),...failures],coverage:{...siteMap.coverage,product_evidence_pages:added.length}};
}

module.exports = { hash, decodedPath, pathFamily, clusterUrls, pageCard, contentRoot, buildSiteMap, selectRepresentatives, augmentProductEvidence };
