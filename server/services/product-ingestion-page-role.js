'use strict';

const crypto=require('crypto');
const cheerio=require('cheerio');

function jsonLdNodes(value){
  if(Array.isArray(value))return value.flatMap(jsonLdNodes);
  if(!value||typeof value!=='object')return [];
  return [value,...jsonLdNodes(value['@graph'])];
}
function types(value){return (Array.isArray(value)?value:[value]).map(item=>String(item||'').toLowerCase());}
function cleanToken(value){return String(value||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'').slice(0,48);}
function assessSingleProductEvidence(page={}){
  const html=String(page.html||''),$=cheerio.load(html),signals=[],reasons=[];
  let nodes=[];
  $('script[type="application/ld+json"]').each((_,node)=>{try{nodes.push(...jsonLdNodes(JSON.parse($(node).html()||'null')));}catch{}});
  const products=nodes.filter(node=>types(node['@type']).includes('product'));
  const creative=nodes.some(node=>types(node['@type']).some(type=>['article','newsarticle','creativework','imagegallery'].includes(type)));
  const product=products[0]||{};
  const h1=$('h1').filter((_,node)=>Boolean($(node).text().trim()));
  const ogType=String($('meta[property="og:type"]').attr('content')||'').toLowerCase();
  const productMeta=$('meta[property^="product:"],meta[name^="product:"]').length;
  const itemProduct=$('[itemtype*="schema.org/Product" i],[itemtype*="schema.org/product" i]').length;
  const bodyText=$('body').text().replace(/\s+/g,' ').trim();
  const visibleIdentifier=bodyText.match(/(?:sku|model|item\s*(?:no|number)|product\s*code|型号|货号|产品编号)\s*[:：#]?\s*[a-z0-9][a-z0-9._/-]{1,}/i)?.[0];
  const identifiers=[product.sku,product.mpn,product.productID,product.model,visibleIdentifier,$('[itemprop="sku"],[itemprop="mpn"],[itemprop="productID"],[data-sku],[data-model]').first().attr('content')||$('[itemprop="sku"],[itemprop="mpn"],[itemprop="productID"],[data-sku],[data-model]').first().text()].filter(value=>String(value||'').trim());
  const productRoot=$('[class*="product-detail" i],[class*="product_detail" i],[class*="product-info" i],[class*="product__info" i],[id*="product-detail" i],[id*="product_detail" i]').length;
  const specificationStructure=$('dl dt,table th,[class*="specification" i],[class*="dimensions" i]').length;
  const optionCount=$('select[name*="variant" i],select[name*="model" i],select[name*="size" i],select[name*="color" i],[data-variant],[data-sku],[class*="swatch" i],[class*="configuration" i]').length;
  const commerce=$('[itemprop="offers"],meta[property="product:price:amount"],button[name="add"],button[class*="cart" i]').length;
  const mainImages=$('main img,[role="main"] img,[class*="product" i] img').length;
  let score=0;
  if(products.length===1){score+=4;signals.push('JSON_LD_SINGLE_PRODUCT');}
  if(products.length>1){score-=4;reasons.push('MULTIPLE_PRODUCTS');}
  if(String(product.name||'').trim()){score+=2;signals.push('PRODUCT_IDENTITY_NAME');}
  if(identifiers.length){score+=2;signals.push('PRODUCT_IDENTIFIER');}
  if(ogType.includes('product')||productMeta){score+=3;signals.push('PRODUCT_METADATA');}
  if(itemProduct){score+=2;signals.push('PRODUCT_MICRODATA');}
  if(h1.length===1){score+=1;signals.push('SINGLE_H1');}
  if(productRoot){score+=2;signals.push('PRODUCT_DETAIL_CONTAINER');}
  if(productRoot&&h1.length===1){score+=1;signals.push('PRODUCT_IDENTITY_HEADING');}
  if(specificationStructure>=2){score+=1;signals.push('PRODUCT_SPECIFICATIONS');}
  if(optionCount){score+=2;signals.push('PRODUCT_OPTIONS');}
  if(commerce){score+=2;signals.push('PRODUCT_OFFER');}
  if(mainImages>=2){score+=1;signals.push('BOUNDED_IMAGE_SET');}
  if(creative){score-=2;reasons.push('EDITORIAL_SCHEMA');}
  const identity=signals.some(value=>['PRODUCT_IDENTITY_NAME','PRODUCT_IDENTIFIER','PRODUCT_METADATA','PRODUCT_MICRODATA','PRODUCT_IDENTITY_HEADING'].includes(value));
  const role=products.length>1||score<=2||!identity?'suspected_non_product':score>=5?'product_detail':'uncertain';
  if(!identity)reasons.push('PRODUCT_IDENTITY_MISSING');
  if(!signals.includes('PRODUCT_IDENTIFIER')&&!signals.includes('PRODUCT_OPTIONS')&&!signals.includes('PRODUCT_OFFER'))reasons.push('PRODUCT_STRUCTURE_WEAK');
  return {schema_version:'single-product-evidence-v1',role,score,confidence:Math.min(1,Math.max(0,score)/8),signals:[...new Set(signals)],reasons:[...new Set(reasons)]};
}
function templateStructureHash(page={}){
  const $=cheerio.load(String(page.html||'')),tokens=[];
  $('body *').slice(0,240).each((_,node)=>{
    const name=String(node.name||'').toLowerCase();if(!name)return;
    const classes=String($(node).attr('class')||'').split(/\s+/).map(cleanToken).filter(Boolean).slice(0,3);
    const itemprop=cleanToken($(node).attr('itemprop'));
    tokens.push([name,...classes,itemprop].filter(Boolean).join('.'));
  });
  return crypto.createHash('sha256').update(tokens.join('|')).digest('hex');
}
function failureCode(error){
  const nested=(error?.template_failures||[]).map(item=>String(item.message||'').match(/[A-Z][A-Z0-9_]+(?=[:；,]|$)/g)||[]).flat();
  return [String(error?.code||'EXTRACTION_FAILED'),...nested].sort().join('|');
}
function templateFailureSignature(page,error){return `${templateStructureHash(page)}:${crypto.createHash('sha256').update(failureCode(error)).digest('hex').slice(0,16)}`;}
function recordTemplateObservation(snapshot={},observation={}){
  const state={...(snapshot.template_drift_observations||{})},key=observation.signature,current=state[key]||{signature:key,urls:{},first_checkpoint:observation.checkpoint_index};
  const previous=current.urls[observation.source_url]||{attempts:0};
  current.urls={...current.urls,[observation.source_url]:{attempts:Number(previous.attempts||0)+1,last_error:observation.error_code,evidence_role:observation.assessment.role,score:observation.assessment.score,last_seen_at:new Date().toISOString()}};
  current.first_checkpoint=Math.min(Number(current.first_checkpoint??observation.checkpoint_index),Number(observation.checkpoint_index));
  current.updated_at=new Date().toISOString();state[key]=current;
  const entries=Object.values(state).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).slice(0,20);
  return {...snapshot,template_drift_observations:Object.fromEntries(entries.map(item=>[item.signature,item]))};
}
function templateDriftDecision(snapshot,observation){
  const group=snapshot.template_drift_observations?.[observation.signature]||{urls:{}},same=group.urls?.[observation.source_url],qualified=Object.entries(group.urls||{}).filter(([,value])=>value.evidence_role==='product_detail'&&Number(value.score||0)>=5);
  if(Number(same?.attempts||0)>=2)return {action:'skip',reason:'SAME_PAGE_SAME_FAILURE_NO_IMPROVEMENT',resume_checkpoint:null};
  if(observation.assessment.role!=='product_detail')return {action:'skip',reason:observation.assessment.role==='uncertain'?'PRODUCT_ROLE_UNCERTAIN':'SUSPECTED_NON_PRODUCT',resume_checkpoint:null};
  if(qualified.length<2)return {action:'skip',reason:'TEMPLATE_COHORT_NOT_ESTABLISHED',resume_checkpoint:null};
  return {action:'learn_template',reason:'QUALIFIED_TEMPLATE_COHORT',resume_checkpoint:Number(group.first_checkpoint||0)};
}

module.exports={assessSingleProductEvidence,templateStructureHash,templateFailureSignature,recordTemplateObservation,templateDriftDecision,failureCode};
