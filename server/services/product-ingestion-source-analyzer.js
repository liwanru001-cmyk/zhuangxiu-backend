'use strict';

function text(value) {
  return String(value || '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
}
function titleOf(html) {
  return text(String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '').slice(0, 300);
}
function headingOf(html) {
  return text(String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1] || '').slice(0, 300);
}
function count(source, pattern) { return [...String(source || '').matchAll(pattern)].length; }

function platformSignals(html) {
  const source=String(html || '');
  const platforms=[];
  if(/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(source))platforms.push('shopify');
  if(/wp-content\/|woocommerce/i.test(source))platforms.push('wordpress_woocommerce');
  if(/__NEXT_DATA__|\/_next\//i.test(source))platforms.push('nextjs');
  if(/__NUXT__|\/_nuxt\//i.test(source))platforms.push('nuxt');
  return platforms;
}

function structuredProductCount(html) {
  const source=String(html || '');
  return count(source, /["']@type["']\s*:\s*["']Product(?:Group)?["']/gi);
}

function accessObstacle(html, url = '', status = 200) {
  const source=String(html || ''), visible=text(source), title=titleOf(source), heading=headingOf(source);
  const linkCount=count(source, /<a\b[^>]*\bhref\s*=/gi);
  const productSignals=structuredProductCount(source)+count(source, /\b(?:product|products|catalog|shop|\u4ea7\u54c1|\u5546\u54c1)\b/gi);
  const challengeMarker=/(?:cf-chl-|challenge-platform|hcaptcha|g-recaptcha|captcha-container|\/captcha(?:\/|\?|$))/i.test(source);
  const challengeHeading=/(?:captcha|verify you are human|security check|access denied|\u4eba\u673a\u9a8c\u8bc1|\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u9a8c\u8bc1)/i.test(`${title} ${heading}`);
  let challengeScore=0; const challengeEvidence=[];
  if([401,403,429].includes(Number(status))){challengeScore+=4;challengeEvidence.push(`http_${status}`);}
  if(challengeHeading){challengeScore+=4;challengeEvidence.push('challenge_title_or_heading');}
  if(challengeMarker){challengeScore+=3;challengeEvidence.push('challenge_component');}
  if(visible.length<500){challengeScore+=1;challengeEvidence.push('sparse_visible_content');}
  if(linkCount>=8){challengeScore-=2;challengeEvidence.push('normal_navigation_present');}
  if(productSignals>=3){challengeScore-=2;challengeEvidence.push('product_content_present');}
  if(challengeScore>=4 && (challengeHeading || challengeMarker || [401,403,429].includes(Number(status)))) {
    return {blocked:true,code:'HUMAN_VERIFICATION_REQUIRED',message:'\u9875\u9762\u9700\u8981\u5b8c\u6210\u9a8c\u8bc1\u6216\u8bbf\u95ee\u6311\u6218',score:challengeScore,evidence:challengeEvidence};
  }
  const password=/<input\b[^>]*type=["']password["'][^>]*>/i.test(source);
  const loginHeading=/(?:^|\s)(?:sign\s*in|log\s*in|login|\u767b\u5f55|\u767b\u5165)(?:\s|$)/i.test(`${title} ${heading}`);
  if(password && loginHeading && linkCount<8 && productSignals<3) {
    return {blocked:true,code:'LOGIN_REQUIRED',message:'\u9875\u9762\u8981\u6c42\u767b\u5f55\u540e\u624d\u80fd\u8bbf\u95ee\u5546\u54c1\u5185\u5bb9',score:5,evidence:['password_form','login_title_or_heading']};
  }
  return {blocked:false,code:null,message:'',score:Math.max(0,challengeScore),evidence:challengeEvidence};
}

const staticExtensions=/\.(?:jpe?g|png|gif|webp|svg|ico|pdf|zip|rar|mp4|mp3|css|js|woff2?|ttf)$/i;
const nonProductSegments=/(?:^|\/)(?:login|account|cart|checkout|search|contact|about|news|blog|press|careers?|privacy|terms)(?:\/|$)/i;
function assessProductUrl(rawUrl, anchorText = '') {
  const url=rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  const path=url.pathname.toLowerCase().replace(/\/+$/,'');
  const label=text(anchorText).toLowerCase();
  let score=0; const evidence=[];
  if(staticExtensions.test(path)||nonProductSegments.test(path))return {score:-100,is_product:false,evidence:['excluded_path']};
  if(/\/(?:products?|goods?|items?)\/(?:all|new|index|list|category|categories|collections?)$/.test(path))return {score:10,is_product:false,evidence:['product_directory_path']};
  if(/\/(?:products?|goods?|items?)\/[^/]{2,}$/.test(path)){score+=65;evidence.push('product_path_with_slug');}
  else if(/\/(?:products?|goods?|items?)\/(?:show|detail|view)\/(?:id\/)?[^/]+$/.test(path)){score+=70;evidence.push('product_action_id_path');}
  else if(/\/(?:detail|goods-detail|item-detail)\/[^/]+$/.test(path)){score+=60;evidence.push('detail_path');}
  else if(/\/(?:products?|goods?|items?)(?:\/|$)/.test(path)){score+=22;evidence.push('product_path');}
  if(/\/(?:show|detail|view)\/id\/\d+$/.test(path)){score+=35;evidence.push('show_id_pattern');}
  if(/[?&](?:product_?id|item_?id|goods_?id|sku|id)=[^&]+/i.test(url.search)){score+=45;evidence.push('product_id_query');}
  if(/(?:\u67e5\u770b\u8be6\u60c5|\u4ea7\u54c1\u8be6\u60c5|\u67e5\u770b\u4ea7\u54c1|\u7acb\u5373\u8d2d\u4e70|view product|product details|more details|view details|shop now)/i.test(label)){score+=35;evidence.push('detail_anchor_text');}
  if(/\/(?:collections?|categories?|catalog|shop)(?:\/|$)/.test(path)){score-=35;evidence.push('directory_path');}
  return {score,is_product:score>=55,evidence};
}

function assessProductPage(html, rawUrl) {
  const source=String(html || ''), url=new URL(rawUrl);
  let score=0; const evidence=[];
  const structured=structuredProductCount(source);
  if(structured){score+=100;evidence.push('schema_org_product');}
  if(/<meta\b[^>]*(?:property|name)=["'](?:og:type|product:type)["'][^>]*content=["']product["']/i.test(source)){score+=80;evidence.push('product_meta');}
  const urlAssessment=assessProductUrl(url);
  if(urlAssessment.score>0){score+=Math.min(60,urlAssessment.score);evidence.push(...urlAssessment.evidence);}
  if(headingOf(source)){score+=12;evidence.push('primary_heading');}
  if(/(?:\bsku\b|\bmodel\b|\u578b\u53f7|\u89c4\u683c|\u6750\u8d28|\u5c3a\u5bf8|add to (?:cart|bag)|\u4ea7\u54c1\u6b3e\u578b|\u4ef7\u683c\u8be6\u60c5)/i.test(text(source))){score+=20;evidence.push('product_fields');}
  if(count(source,/<img\b/gi)>=2){score+=5;evidence.push('product_images');}
  return {score,is_product:score>=60,evidence:[...new Set(evidence)],structured_products:structured};
}

function directoryPriority(rawUrl, anchorText = '') {
  const url=rawUrl instanceof URL ? rawUrl : new URL(rawUrl), path=url.pathname.toLowerCase(), label=text(anchorText).toLowerCase();
  let score=10; const evidence=[];
  if(staticExtensions.test(path)||nonProductSegments.test(path))return {score:-100,evidence:['excluded_path']};
  if(/\/(?:products?|collections?|categories?|catalog|shop)(?:\/|$)/.test(path)){score+=55;evidence.push('catalog_path');}
  if(/(?:\u4ea7\u54c1|\u5546\u54c1|\u6c99\u53d1|\u5e8a|\u6905|\u684c|\u67dc|\u5730\u6bef|products?|catalog|collection|sofa|chair|table|bed|rug)/i.test(label)){score+=30;evidence.push('catalog_anchor_text');}
  if(url.pathname==='/'||url.pathname==='')score+=20;
  return {score,evidence};
}

function analyzePage(html, url, status = 200) {
  const source=String(html || ''), visible=text(source), obstacle=accessObstacle(source,url,status);
  const publicApiSignals=[/\/(?:api|graphql)\//i.test(source)?'api_path':null,/products\.json(?:\?|["'])/i.test(source)?'products_json':null,
    /application\/json/i.test(source)?'embedded_json':null].filter(Boolean);
  const assetHosts=[];
  for(const match of source.matchAll(/<(?:img|source)\b[^>]*(?:src|srcset)\s*=\s*(["'])(.*?)\1/gi)){
    for(const candidate of match[2].split(',').map(item=>item.trim().split(/\s+/)[0]).filter(Boolean)){
      try{const host=new URL(candidate,url).hostname.toLowerCase();if(host)assetHosts.push(host);}catch(_){}
    }
  }
  return {url,status,title:titleOf(source),heading:headingOf(source),platforms:platformSignals(source),
    structured_products:structuredProductCount(source),link_count:count(source,/<a\b[^>]*\bhref\s*=/gi),
    visible_text_length:visible.length,public_api_signals:publicApiSignals,asset_host_candidates:[...new Set(assetHosts)].slice(0,30),dynamic_signals:[/\b(?:__NEXT_DATA__|__NUXT__)\b/.test(source)?'hydration_state':null,
      visible.length<300&&/<script\b/i.test(source)?'script_shell':null].filter(Boolean),obstacle};
}

function summarizeAnalysis(pageProfiles, extra = {}) {
  const profiles=Array.isArray(pageProfiles)?pageProfiles:[];
  const platforms=[...new Set(profiles.flatMap(item=>item.platforms||[]))];
  const obstacles={}; for(const item of profiles){if(item.obstacle?.blocked)obstacles[item.obstacle.code]=(obstacles[item.obstacle.code]||0)+1;}
  return {analyzer_version:'source_analyzer_v1',pages_profiled:profiles.length,platforms,
    structured_product_pages:profiles.filter(item=>item.structured_products>0).length,
    dynamic_shell_pages:profiles.filter(item=>(item.dynamic_signals||[]).length).length,
    obstacles,public_api_signals:[...new Set(profiles.flatMap(item=>item.public_api_signals||[]))],
    asset_host_candidates:[...new Set(profiles.flatMap(item=>item.asset_host_candidates||[]))].slice(0,50),
    channels:{robots:true,sitemap:Boolean(extra.sitemap),html_links:true,json_ld:true,
      public_api:profiles.some(item=>(item.public_api_signals||[]).length),dynamic_rendering:false}};
}

module.exports={text,titleOf,headingOf,platformSignals,structuredProductCount,accessObstacle,assessProductUrl,assessProductPage,directoryPriority,analyzePage,summarizeAnalysis};
