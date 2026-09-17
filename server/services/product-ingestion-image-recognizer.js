'use strict';

const cheerio=require('cheerio');

const POSITIVE_CONTAINER=/(?:product\s*(?:media|gallery|image)|(?:media|gallery|image)\s*product|gallery|carousel|slider|swiper|slideshow|media\s*list|thumbnail)/i;
const STRONG_PRODUCT_CONTAINER=/(?:product\s*(?:media|gallery|image)|(?:media|gallery|image)\s*product)/i;
const NEGATIVE_CONTEXT=/(?:recommend|related|similar|discover|newsletter|footer|header|navigation|\bnav\b|mega\s*menu|social|share|qrcode|cookie|popup|modal\s*newsletter)/i;
const NON_PRODUCT_ASSET_TOKEN=/(?:^|[\/_.-])(?:logo|icon|avatar|search|menu|close|cross|arrow|chevron|spinner|loading|language|wechat|weibo|facebook|instagram|pinterest|linkedin|qrcode|qr-code)(?:[\/_.-]|$)/i;
const PRODUCT_PATH=/(?:^|\/)(?:products?|goods?|items?|detail)(?:\/|$)/i;

function descriptor($,node){
  if(!node)return '';
  const value=$(node),parts=[node.tagName||node.name||'',value.attr('id')||'',value.attr('class')||'',value.attr('role')||'',value.attr('aria-label')||'',value.attr('data-media-id')||'',value.attr('data-testid')||''];
  return parts.join(' ').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
}
function absoluteUrl(value,sourceUrl){
  const raw=String(value||'').trim();if(!raw)return '';
  try{const url=new URL(raw,sourceUrl);if(!['http:','https:'].includes(url.protocol))return '';const page=new URL(sourceUrl);if(page.protocol==='https:'&&url.protocol==='http:'&&page.hostname===url.hostname)url.protocol='https:';url.hash='';return url.toString();}catch(_){return '';}
}
function canonicalImageKey(value){
  try{const url=new URL(value);for(const key of ['width','height','w','h','quality','format'])url.searchParams.delete(key);return url.toString();}catch(_){return value;}
}
function bestSrcset(value){
  const entries=String(value||'').split(',').map(item=>{const [url,size='']=item.trim().split(/\s+/,2);return {url,size:Number.parseFloat(size)||0};}).filter(item=>item.url);
  return entries.sort((left,right)=>right.size-left.size)[0]?.url||'';
}
function imageValue($,node){
  const value=$(node),srcset=value.attr('srcset')||value.attr('data-srcset');
  const pictureSrcset=value.closest('picture').find('source[srcset],source[data-srcset]').toArray().map(source=>bestSrcset($(source).attr('srcset')||$(source).attr('data-srcset'))).find(Boolean);
  const direct=bestSrcset(srcset)||value.attr('data-original')||value.attr('data-original-src')||value.attr('data-zoom-image')||value.attr('data-large')||value.attr('data-lazy-src')||value.attr('data-lazy')||value.attr('data-src')||pictureSrcset||value.attr('src');
  if(direct)return direct;
  const linked=value.closest('a[href]').attr('href')||'';
  return /\.(?:avif|webp|jpe?g|png)(?:[?#]|$)/i.test(linked)?linked:'';
}
function pagePath(value){try{return new URL(value).pathname.replace(/\/+$/,'')||'/';}catch(_){return '';}}
function linksToAnotherProduct($,node,sourceUrl){
  const link=$(node).closest('a[href]').attr('href');if(!link)return false;
  const target=absoluteUrl(link,sourceUrl);if(!target||!PRODUCT_PATH.test(pagePath(target)))return false;
  if(/\.(?:avif|webp|jpe?g|png|gif|svg)(?:[?#]|$)/i.test(target))return false;
  return pagePath(target)!==pagePath(sourceUrl);
}
function contextFor($,node){
  const parts=[];let current=$(node);
  for(let depth=0;depth<8&&current.length;depth+=1){parts.push(descriptor($,current[0]));current=current.parent();}
  return parts.join(' | ');
}
function containerScore($,node,sourceUrl){
  const value=$(node),own=descriptor($,node),context=contextFor($,node),count=value.find('img').length;
  if(count<2||count>80)return -Infinity;
  let score=0;
  if(STRONG_PRODUCT_CONTAINER.test(own))score+=75;
  else if(POSITIVE_CONTAINER.test(own))score+=45;
  if(/product\s*section|product\s*detail|product\s*main/.test(context))score+=18;
  if(value.closest('main').length)score+=8;
  if(NEGATIVE_CONTEXT.test(context))score-=120;
  const foreignLinks=value.find('a[href]').toArray().filter(item=>linksToAnotherProduct($,item,sourceUrl)).length;
  score-=Math.min(90,foreignLinks*25);
  score+=Math.min(12,count*2);
  if(count>24)score-=25;
  return score;
}
function productIdentity(value){
  return String(value||'').split(/\s*(?:[-–—|｜])\s*/)[0].replace(/\s+/g,' ').trim().toLowerCase();
}
function containerHasProductIdentity($,node,productName){
  const identity=productIdentity(productName);if(identity.length<2)return false;
  let current=$(node);
  for(let depth=0;depth<4&&current.length;depth+=1,current=current.parent()){
    const element=current[0];if(!element||['body','html'].includes(element.name||element.tagName))break;
    const content=current.clone().find('script,style').remove().end().text().replace(/\s+/g,' ').trim().toLowerCase();
    if(content.length<=5000&&content.includes(identity))return true;
  }
  return false;
}
function containsToken(value,tokens=[]){const normalized=String(value||'').toLowerCase();return tokens.some(token=>normalized.includes(String(token||'').toLowerCase()));}
function findGalleries($,sourceUrl,options={}){
  const rules=options.regionRules||{},primaryTokens=rules.primary_container_tokens||[],supportingTokens=rules.supporting_container_tokens||[],excludedTokens=rules.excluded_container_tokens||[];
  const candidates=new Map();
  $('img').each((_,image)=>{
    $(image).parents().slice(0,7).each((__,node)=>{
      const score=containerScore($,node,sourceUrl);if(!Number.isFinite(score))return;
      const context=contextFor($,node),profileRegion=containsToken(context,[...primaryTokens,...supportingTokens]);if(containsToken(context,excludedTokens)&&!profileRegion)return;
      const identityRegion=containerHasProductIdentity($,node,options.productName);
      if(score>=55||(score>=45&&(identityRegion||profileRegion)))candidates.set(node,{node,score,count:$(node).find('img').length,descriptor:descriptor($,node),identity_region:identityRegion,profile_region:profileRegion});
    });
  });
  const ranked=[...candidates.values()].sort((left,right)=>right.score-left.score||left.count-right.count);
  // Carousel libraries commonly nest several elements whose class names all
  // contain "slider" or "carousel". Collapse overlapping candidates so they
  // describe one visual region, while retaining genuinely separate galleries.
  return ranked.filter(candidate=>!ranked.some(other=>other!==candidate&&other.score>=candidate.score&&($.contains(other.node,candidate.node)||$.contains(candidate.node,other.node))&&(other.score>candidate.score||ranked.indexOf(other)<ranked.indexOf(candidate))));
}
function findGallery($,sourceUrl,options={}){return findGalleries($,sourceUrl,options)[0]||null;}
function productNameTokens(value){return String(value||'').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(item=>item.length>=3).slice(0,8);}
function isInterfaceAsset(candidate){
  let path='';try{path=decodeURIComponent(new URL(candidate.url).pathname).toLowerCase();}catch(_){}
  const alt=String(candidate.alt||'').trim().toLowerCase().replace(/\s+/g,'-');
  return NON_PRODUCT_ASSET_TOKEN.test(path)||Boolean(alt&&alt.length<=32&&NON_PRODUCT_ASSET_TOKEN.test(`/${alt}/`));
}
function candidateScore(candidate,{productName,preferred=[]}){
  let score=0;const reasons=[];
  if(candidate.sources.has('structured_data')){score+=90;reasons.push('structured_product_image');}
  if(candidate.sources.has('meta')){score+=65;reasons.push('product_meta_image');}
  if(candidate.inGallery){score+=85;reasons.push('inside_product_gallery');}
  if(STRONG_PRODUCT_CONTAINER.test(candidate.context)){score+=35;reasons.push('product_media_context');}
  else if(POSITIVE_CONTAINER.test(candidate.context)){score+=20;reasons.push('gallery_context');}
  if(candidate.primaryRegion){score+=50;reasons.push('shares_primary_product_region');}
  if(/\bmain\b/.test(candidate.context)){score+=6;reasons.push('main_content');}
  const evidence=`${candidate.alt} ${candidate.url}`.toLowerCase();
  if(productNameTokens(productName).some(token=>evidence.includes(token))){score+=12;reasons.push('matches_product_name');}
  if(preferred.some(token=>candidate.url.toLowerCase().includes(token))){score+=15;reasons.push('site_preferred_url');}
  if(candidate.foreignProductLink){score-=110;reasons.push('links_to_other_product');}
  if(NEGATIVE_CONTEXT.test(candidate.context)){score-=130;reasons.push('excluded_page_region');}
  if(isInterfaceAsset(candidate)){score-=100;reasons.push('interface_or_brand_asset');}
  return {score,reasons};
}
function collectCandidates($,sourceUrl,structuredImages=[]){
  const records=[];
  const add=(raw,source,node=null)=>{const url=absoluteUrl(raw,sourceUrl);if(!url)return;const region=node?$(node).closest('article,section,main'):null;records.push({url,key:canonicalImageKey(url),source,node,alt:node?String($(node).attr('alt')||''):'',context:node?contextFor($,node):'',foreignProductLink:node?linksToAnotherProduct($,node,sourceUrl):false,primaryRegion:Boolean(region?.find('h1').length)});};
  for(const value of structuredImages)add(value,'structured_data');
  $('meta[property="og:image"],meta[name="og:image"],meta[property="twitter:image"],meta[name="twitter:image"]').each((_,node)=>add($(node).attr('content'),'meta'));
  $('img').each((_,node)=>add(imageValue($,node),'dom',node));
  return records;
}
function imagePriority(candidate){
  if(candidate.primaryRegion)return 4;
  if(candidate.sources.has('structured_data'))return 3;
  if(candidate.sources.has('meta'))return 2;
  if(candidate.inGallery)return 1;
  return 0;
}
function recognizeProductImages(html,sourceUrl,options={}){
  const $=cheerio.load(String(html||'')),excluded=(options.siteProfile?.image_exclude_tokens||[]).map(value=>String(value).toLowerCase()),preferred=(options.siteProfile?.image_prefer_tokens||[]).map(value=>String(value).toLowerCase()),regionRules=options.siteProfile?.image_region_rules||{},commonImageKeys=new Set((options.commonImageKeys||options.siteProfile?.runtime_common_image_keys||[]).map(canonicalImageKey)),galleries=findGalleries($,sourceUrl,{productName:options.productName,regionRules}),gallery=galleries[0]||null;
  const grouped=new Map();
  for(const record of collectCandidates($,sourceUrl,options.structuredImages||[])){
    if(!grouped.has(record.key))grouped.set(record.key,{...record,sources:new Set(),nodes:[]});
    const candidate=grouped.get(record.key);candidate.sources.add(record.source);if(record.node)candidate.nodes.push(record.node);if(!candidate.alt&&record.alt)candidate.alt=record.alt;if(!candidate.context&&record.context)candidate.context=record.context;candidate.foreignProductLink=candidate.foreignProductLink||record.foreignProductLink;candidate.primaryRegion=candidate.primaryRegion||record.primaryRegion;
  }
  const decisions=[];
  for(const candidate of grouped.values()){
    const containingGalleries=galleries.filter(item=>candidate.nodes.some(node=>item.node===node||$.contains(item.node,node)));
    candidate.inGallery=Boolean(containingGalleries.length);candidate.inPageIdentityGallery=containingGalleries.some(item=>item.identity_region);candidate.inProfileGallery=containingGalleries.some(item=>item.profile_region);candidate.inIdentityGallery=candidate.inPageIdentityGallery||candidate.inProfileGallery;
    const scored=candidateScore(candidate,{productName:options.productName,preferred});let selected=scored.score>=55;
    const reasons=[...scored.reasons];
    const repeatedAcrossProducts=commonImageKeys.has(candidate.key);
    if(repeatedAcrossProducts&&!candidate.inPageIdentityGallery&&!candidate.sources.has('structured_data')&&!candidate.sources.has('meta')){selected=false;reasons.push('repeated_across_product_pages');}
    if(excluded.some(token=>candidate.url.toLowerCase().includes(token))){
      if(candidate.inIdentityGallery&&!repeatedAcrossProducts){reasons.push('site_url_hint_overridden_by_product_region');}
      else{selected=false;reasons.push('site_excluded_url');}
    }
    const profileProductRegion=containsToken(candidate.context,[...(regionRules.primary_container_tokens||[]),...(regionRules.supporting_container_tokens||[])]);
    if(containsToken(candidate.context,regionRules.excluded_container_tokens||[])&&!profileProductRegion){selected=false;reasons.push('site_excluded_container');}
    // A product page may keep its hero image beside the title and its remaining
    // images in a separate carousel. Treat both as product-owned regions instead
    // of forcing every DOM image into one chosen gallery container.
    if(gallery&&!candidate.inGallery&&!candidate.primaryRegion&&!candidate.sources.has('structured_data')&&!candidate.sources.has('meta')){selected=false;reasons.push('outside_product_regions');}
    decisions.push({url:candidate.url,selected,score:scored.score,priority:imagePriority(candidate),sources:[...candidate.sources],reasons:[...new Set(reasons)]});
  }
  decisions.sort((left,right)=>Number(right.selected)-Number(left.selected)||right.priority-left.priority||right.score-left.score);
  const selected=decisions.filter(item=>item.selected).slice(0,Math.min(5,Math.max(1,Number(options.max)||5)));
  const selectedKeys=new Set(selected.map(item=>canonicalImageKey(item.url)));
  for(const decision of decisions)if(decision.selected&&!selectedKeys.has(canonicalImageKey(decision.url))){decision.selected=false;decision.reasons.push('beyond_image_limit');}
  const confidence=selected.length?Math.min(.99,gallery?.score>=70?.94:gallery?.score>=55?.88:selected.some(item=>item.sources.includes('structured_data'))?.84:.68):0;
  const hasPrimaryOutsideGallery=decisions.some(item=>item.selected&&item.reasons.includes('shares_primary_product_region')&&!item.reasons.includes('inside_product_gallery'));
  const strategy=gallery?(galleries.length>1||hasPrimaryOutsideGallery?'merged_product_regions':gallery.identity_region?'identity_bounded_product_gallery':gallery.profile_region?'profile_bounded_product_gallery':'bounded_product_gallery'):'multi_evidence_fallback';
  return {urls:selected.map(item=>item.url),confidence,strategy,gallery:gallery?{descriptor:gallery.descriptor,score:gallery.score,image_count:gallery.count,identity_region:gallery.identity_region,profile_region:gallery.profile_region}:null,galleries:galleries.map(item=>({descriptor:item.descriptor,score:item.score,image_count:item.count,identity_region:item.identity_region,profile_region:item.profile_region})).slice(0,12),decisions:decisions.slice(0,120)};
}

module.exports={recognizeProductImages,canonicalImageKey,absoluteUrl,findGallery,findGalleries};
