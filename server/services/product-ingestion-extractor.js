'use strict';

const crypto = require('crypto');
const { normalizeDetails } = require('./product-details');
const { recognizeProductImages } = require('./product-ingestion-image-recognizer');

function cleanText(value, max = 2000) {
  return decodeHtml(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max);
}
function decodeHtml(value) {
  const named = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    const key = entity.toLowerCase();
    if (named[key] != null) return named[key];
    const number = key.startsWith('#x') ? parseInt(key.slice(2), 16) : key.startsWith('#') ? parseInt(key.slice(1), 10) : NaN;
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : _match;
  });
}
function values(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function typeIncludes(value, expected) { return values(value).some(item => String(item).toLowerCase() === expected.toLowerCase()); }
function findNodes(value, predicate, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (predicate(value)) found.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) findNodes(child, predicate, found);
  return found;
}
function jsonLdDocuments(html) {
  const documents = [];
  for (const match of String(html || '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(match[1])) continue;
    const raw = match[2].trim().replace(/^<!--|-->$/g, '').trim(); if (!raw) continue;
    try { documents.push(JSON.parse(raw)); } catch (_) {}
  }
  return documents;
}
function firstText(...items) {
  for (const item of items.flatMap(values)) {
    const value = typeof item === 'object' ? item?.name || item?.value : item;
    const result = cleanText(value, 500); if (result) return result;
  }
  return '';
}
function imageUrls(node, sourceUrl = '', max = 5) {
  const result = [];
  for (const item of values(node.image)) {
    const value = typeof item === 'object' ? item.url || item.contentUrl : item;
    try {
      const url = new URL(String(value || ''), sourceUrl || undefined);
      if (['http:', 'https:'].includes(url.protocol) && !result.includes(url.toString())) result.push(url.toString());
    } catch (_) {}
    if (result.length >= max) break;
  }
  return result;
}
function imageUrl(node, sourceUrl = '') { return imageUrls(node, sourceUrl, 1)[0] || ''; }
function numeric(value) {
  const raw = typeof value === 'object' ? value?.value : value;
  const number = Number(String(raw ?? '').replace(/,/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}
function unit(value) {
  const raw = String(typeof value === 'object' ? value?.unitCode || value?.unitText || '' : '').toLowerCase();
  if (['mm', 'millimeter', 'millimetre'].includes(raw)) return 'mm';
  if (['cm', 'centimeter', 'centimetre'].includes(raw)) return 'cm';
  return null;
}
function measure(value, targetUnit) {
  const number = numeric(value); if (number == null) return null;
  const sourceUnit = unit(value); if (!sourceUnit) return null;
  if (sourceUnit === targetUnit) return number;
  return targetUnit === 'mm' ? number * 10 : number / 10;
}
function additions(node) {
  const map = new Map();
  for (const item of values(node.additionalProperty)) {
    const key = cleanText(item?.name || item?.propertyID, 120).toLowerCase();
    if (key) map.set(key, item);
  }
  return map;
}
function property(node, names) {
  for (const name of names) if (node[name] != null) return node[name];
  const extra = additions(node);
  for (const name of names) if (extra.has(name.toLowerCase())) return extra.get(name.toLowerCase());
  return null;
}
function dimensions(node, productType, shape) {
  const candidates = [property(node, ['width', '宽', '宽度']), property(node, ['depth', '深', '深度', 'length', '长度']), property(node, ['height', '高', '高度']), property(node, ['diameter', '直径'])];
  const explicitUnit = candidates.map(unit).find(Boolean) || 'mm';
  const get = names => measure(property(node, names), explicitUnit);
  if (productType === 'rugs') {
    if (shape === 'circle') return { unit: explicitUnit, value: { diameter: get(['diameter', '直径']) } };
    if (shape === 'square') return { unit: explicitUnit, value: { side: get(['width', '宽', '宽度', 'side', '边长']) } };
    return { unit: explicitUnit, value: { length: get(['length', '长度', 'depth', '深度']), width: get(['width', '宽', '宽度']) } };
  }
  if (productType === 'curtains' || productType === 'artwork') return { unit: explicitUnit, value: { width: get(['width', '宽', '宽度']), height: get(['height', '高', '高度']) } };
  if (shape === 'round') return { unit: explicitUnit, value: { diameter: get(['diameter', '直径']), height: get(['height', '高', '高度']) } };
  return { unit: explicitUnit, value: { width: get(['width', '宽', '宽度']), depth: get(['depth', '深', '深度', 'length', '长度']), height: get(['height', '高', '高度']) } };
}
function defaults(productType) {
  if (productType === 'curtains') return { type:{product_kind:'curtains',curtain_type:'other'},shape:'curtain',unit:'樘',customFields:[],specs:{curtain_specs:{sizing:'custom',dimension_basis:'window',heading:'',opening:'',operation:'unknown',fullness_ratio:null,hardware_note:'',pricing_basis:''}} };
  if (productType === 'rugs') return { type:{ product_kind:'rugs',rug_type:'other' },shape:'rectangle',unit:'张',customFields:[],specs:{ rug_specs:{sizing:'ready',construction:'',pile_height_mm:null,thickness_mm:null,backing:'',edging:'',non_slip_note:'',care_note:'',pricing_basis:''} } };
  if (productType === 'artwork') return { type:{product_kind:'artwork',artwork_type:'other'},shape:'artwork',unit:'幅',customFields:[],specs:{artwork_specs:{form:'unknown',frame:'unknown',piece_count:1,composition:'',outer_width:null,outer_height:null,thickness:null,creator:'',technique:'',substrate:'',frame_material:'',frame_color:'',mounting:'',glazing:'',edition_note:'',installation:''}} };
  if (productType === 'accessories') return { type:{product_kind:'accessories',accessory_type:'other'},shape:'box',unit:'件',customFields:[],specs:{accessory_specs:{piece_count:1,composition:'',technique:'',finish:'',usage:'',care:'',installation:''}} };
  return { type:{furniture_type:'other'},shape:'box',unit:'件',customFields:[],specs:{} };
}
function offer(node) {
  const item = values(node.offers)[0] || {};
  const price = numeric(item.price ?? item.lowPrice);
  const currency = String(item.priceCurrency || '').toUpperCase();
  return price != null && currency === 'CNY' ? { price_state:'known',price } : { price_state:'unknown',price:null };
}
function stableId(node, index) {
  const source = firstText(node.sku, node.mpn, node.productID, node.name) || `configuration-${index + 1}`;
  return `cfg-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
}
function productNodes(documents) {
  const groups = documents.flatMap(doc => findNodes(doc, node => typeIncludes(node['@type'], 'ProductGroup')));
  if (groups.length) return groups;
  return documents.flatMap(doc => findNodes(doc, node => typeIncludes(node['@type'], 'Product')));
}
const CLASSIFICATION_RULES = Object.freeze({
  furniture: ['沙发','椅','凳','桌','茶几','边几','床','柜','架','sofa','chair','stool','table','desk','bed','cabinet','shelf','bench','dresser','ottoman','chaise longue','chaise-longue','console','sideboard','chest of drawers','magazine rack','bar cabinet'],
  curtains: ['窗帘','布帘','纱帘','百叶帘','卷帘','罗马帘','curtain','drape','sheer','blind','roman shade'],
  rugs: ['地毯','门垫','地垫','rug','carpet','floor mat','doormat'],
  artwork: ['装饰画','版画','挂画','油画','书法','摄影作品','artwork','painting','wall art','art print','calligraphy'],
  accessories: ['花瓶','摆件','雕塑','托盘','靠垫','抱枕','毛毯','时钟','镜子','灯具','收纳篮','vase','sculpture','tray','cushion','throw','blanket','comforter','clock','mirror','lamp','lighting','basket'],
});
function classificationFields(html) {
  const documents = jsonLdDocuments(html), nodes = productNodes(documents);
  const node = nodes[0] || {};
  const important = [node.name,node.category,node.sku,node.mpn].flatMap(values).map(value => firstText(value)).filter(Boolean).join(' ');
  const supporting = [node.description,node.additionalType].flatMap(values).map(value => firstText(value)).filter(Boolean).join(' ');
  const title = cleanText(String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '', 500);
  const heading = cleanText(String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1] || '', 500);
  return { important:`${important} ${title} ${heading}`.toLowerCase(), supporting:supporting.toLowerCase() };
}
function classifyProduct(html, adapterKey, sourceUrl, siteProfile = null) {
  const fields=classificationFields(html), url=String(sourceUrl || '').toLowerCase();
  const scores={}; const evidence={};
  for (const [type,keywords] of Object.entries(CLASSIFICATION_RULES)) {
    scores[type]=0;evidence[type]=[];
    for (const keyword of keywords) {
      const needle=keyword.toLowerCase(); let points=0;
      if(fields.important.includes(needle))points+=5;
      if(url.includes(needle.replace(/\s+/g,'-'))||url.includes(needle.replace(/\s+/g,'')))points+=3;
      if(fields.supporting.includes(needle))points+=1;
      if(points){scores[type]+=points;evidence[type].push(keyword);}
    }
  }
  const categoryPriority={accessories:5,rugs:4,artwork:3,curtains:2,furniture:1};
  const ranked=Object.entries(scores).sort((left,right)=>right[1]-left[1]||(categoryPriority[right[0]]||0)-(categoryPriority[left[0]]||0));
  const [winner,score]=ranked[0], runnerUp=ranked[1]?.[1] || 0;
  if(!score){
    const profileType=siteProfile?.default_product_type,profileConfidence=Number(siteProfile?.confidence||0);
    if(CLASSIFICATION_RULES[profileType]&&profileConfidence>=.6)return {product_group:'soft_furnishings',product_type:profileType,confidence:profileConfidence,method:'qwen_site_profile_v1',evidence:siteProfile.evidence||[]};
    return { product_group:null,product_type:null,confidence:0,method:'keyword_v1',evidence:[] };
  }
  const confidence=Math.min(.99,Math.max(.51,score/(score+runnerUp+2)));
  return { product_group:'soft_furnishings',product_type:winner,confidence:Number(confidence.toFixed(2)),method:'keyword_v1',evidence:evidence[winner].slice(0,8) };
}
function normalizeProductNode(node, productType, sourceUrl, imageRecognition = null) {
  const productName = firstText(node.name); if (!productName) throw new Error('JSON-LD Product 缺少产品名称');
  const variants = values(node.hasVariant).filter(item => item && typeof item === 'object');
  const saleNodes = variants.length ? variants : [node];
  const generatedFields = [];
  const base = defaults(productType);
  const configurations = saleNodes.slice(0, 100).map((variant, index) => {
    let name = firstText(variant.name);
    if (!name || (saleNodes.length === 1 && name === productName)) {
      name = saleNodes.length === 1 ? productName : '';
      if (name) generatedFields.push({ path:`product_details.configurations[${index}].name`,rule:'single_configuration_uses_official_product_name',value:name,evidence:['json_ld_product.name'] });
    }
    if (!name) throw new Error(`第 ${index + 1} 个配置缺少可区分名称`);
    const shape = base.shape;
    generatedFields.push({ path:`product_details.configurations[${index}].shape`,rule:'category_dimension_shape',value:shape });
    const size = dimensions({ ...node, ...variant }, productType, shape);
    const material = firstText(variant.material, node.material);
    const color = firstText(variant.color, node.color);
    const pricing = offer(variant.offers ? variant : node);
    const recognizedImages=Array.isArray(imageRecognition?.urls)?imageRecognition.urls:[];
    const configurationImages = [...new Set([...imageUrls(variant, sourceUrl), ...recognizedImages, ...(variant === node ? [] : imageUrls(node, sourceUrl))])].slice(0, 5);
    return { ...base.specs, id:stableId(variant,index), name, code:firstText(variant.sku,variant.mpn,variant.productID), shape,
      dimensions:size.value, dimension_unit:size.unit, dimension_note:'', parts:[{part:'',material,color,code:'',swatch_url:''}],
      material_options:[], image_urls:configurationImages, image_url:configurationImages[0] || '', drawing_url:'', drawing_name:'', unit:base.unit,
      price_state:pricing.price_state, currency:'CNY', price:pricing.price, includes:'' };
  });
  const details = normalizeDetails({ schema_version:1, ...base.type, model:firstText(node.model,node.mpn,node.sku), source_url:sourceUrl,
    source_merchant_id:null, configurations, customization:{enabled:false,fields:base.customFields,limits:'',pricing_note:''} }, productType);
  if(imageRecognition)generatedFields.push({path:'product_details.configurations[*].image_urls',rule:'product_image_recognizer_v1',value:`识别 ${imageRecognition.urls.length} 张产品图`,confidence:imageRecognition.confidence,evidence:imageRecognition.decisions.filter(item=>item.selected).map(item=>`${item.url} · ${item.reasons.join(',')}`).slice(0,5)});
  return { payload:{ name:productName,cover_url:imageRecognition?.urls?.[0]||imageUrl(node, sourceUrl),brand:firstText(node.brand),spec:'',price_text:'',description:cleanText(node.description),
    product_group:'soft_furnishings',product_type:productType,product_details:details }, generatedFields };
}
function extractProduct(html, productType, sourceUrl, siteProfile = null, options = {}) {
  const documents = jsonLdDocuments(html);
  if (!documents.length) return extractDomProduct(html,productType,sourceUrl,siteProfile,options);
  const nodes = productNodes(documents);
  if (!nodes.length) return extractDomProduct(html,productType,sourceUrl,siteProfile,options);
  if (nodes.length > 1 && !nodes[0].hasVariant) throw new Error('页面包含多个独立产品，必须提供单个产品详情页');
  const structuredImages=[...imageUrls(nodes[0],sourceUrl,100),...values(nodes[0].hasVariant).flatMap(item=>imageUrls(item,sourceUrl,100))];
  const imageRecognition=recognizeProductImages(html,sourceUrl,{structuredImages,productName:firstText(nodes[0].name),siteProfile,commonImageKeys:options.commonImageKeys,max:5});
  return { ...normalizeProductNode(nodes[0], productType, sourceUrl,imageRecognition), extracted:{...nodes[0],image_recognition:imageRecognition} };
}

function attributeValue(tag,name){return decodeHtml(String(tag||'').match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`,'i'))?.[2]||'');}
function metaContent(html,key){
  for(const tag of String(html||'').match(/<meta\b[^>]*>/gi)||[]){
    const name=attributeValue(tag,'property')||attributeValue(tag,'name');
    if(name.toLowerCase()===key.toLowerCase())return cleanText(attributeValue(tag,'content'),2000);
  }
  return '';
}
function metaContents(html,key){
  const result=[];
  for(const tag of String(html||'').match(/<meta\b[^>]*>/gi)||[]){
    const name=attributeValue(tag,'property')||attributeValue(tag,'name');
    const content=attributeValue(tag,'content');
    if(name.toLowerCase()===key.toLowerCase()&&content&&!result.includes(content))result.push(content);
  }
  return result;
}
function domImageUrls(html,sourceUrl,max=5,siteProfile=null){
  return recognizeProductImages(html,sourceUrl,{siteProfile,max}).urls;
}
function domFacts(html){
  const result=[];const add=(name,value)=>{const key=cleanText(name,120),content=cleanText(value,500);if(key&&content&&!result.some(item=>item.name===key&&item.value===content))result.push({name:key,value:content});};
  for(const match of String(html||'').matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt\s*>\s*<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi))add(match[1],match[2]);
  for(const match of String(html||'').matchAll(/<tr\b[^>]*>[\s\S]*?<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>[\s\S]*?<td\b[^>]*>([\s\S]*?)<\/td\s*>[\s\S]*?<\/tr\s*>/gi))add(match[1],match[2]);
  return result.slice(0,100);
}
function factValue(facts,pattern,aliases=[]){const normalizedAliases=aliases.map(value=>cleanText(value,60).toLowerCase());return facts.find(item=>pattern.test(item.name)||normalizedAliases.includes(cleanText(item.name,60).toLowerCase()))?.value||'';}
function measurementFact(name,raw){
  const match=String(raw||'').match(/(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)/i);if(!match)return {name,value:raw};
  return {name,value:Number(match[1]),unitText:/mm|毫米/i.test(match[2])?'mm':'cm'};
}
function extractDomProduct(html,productType,sourceUrl,siteProfile=null,options={}){
  const source=String(html||'');
  const heading=cleanText(source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1]||'',500);
  const ogTitle=metaContent(source,'og:title'),documentTitle=cleanText(source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]||'',500);
  const nameSources=siteProfile?.name_sources?.length?siteProfile.name_sources:['h1','og:title','title'],nameValues={h1:heading,'og:title':ogTitle,title:documentTitle};
  const name=nameSources.map(key=>nameValues[key]).find(Boolean)||heading||ogTitle||documentTitle;if(!name)throw new Error('已识别为产品页，但未提取到产品名称');
  const imageRecognition=recognizeProductImages(source,sourceUrl,{productName:name,siteProfile,commonImageKeys:options.commonImageKeys,max:5}),images=imageRecognition.urls,image=images[0]||'';
  const descriptionSources=siteProfile?.description_sources?.length?siteProfile.description_sources:['description','og:description'];
  const description=descriptionSources.map(key=>metaContent(source,key)).find(Boolean)||'';
  const mapping=siteProfile?.field_mapping||{},modelLabels=['SKU','型号','Model',...(mapping.model||[])].map(value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const sku=cleanText(source.match(new RegExp(`(?:${modelLabels})\\s*[#：:]?\\s*([A-Za-z0-9][A-Za-z0-9._/-]{1,80})`,'i'))?.[1]||'',120);
  const facts=domFacts(source),material=factValue(facts,/^(?:材质|材料|material)$/i,mapping.material),color=factValue(facts,/^(?:颜色|色彩|color|colour)$/i,mapping.color);
  const dimensionNames={width:['宽','宽度','width',...(mapping.width||[])],depth:['深','深度','depth',...(mapping.depth||[])],height:['高','高度','height',...(mapping.height||[])],length:['长','长度','length',...(mapping.length||[])],diameter:['直径','diameter',...(mapping.diameter||[])]};
  const additionalProperty=facts.map(item=>{const name=cleanText(item.name,60).toLowerCase(),canonical=Object.entries(dimensionNames).find(([,aliases])=>aliases.some(alias=>cleanText(alias,60).toLowerCase()===name))?.[0];return canonical?measurementFact(canonical,item.value):item;});
  const priceMatch=cleanText(source,200000).match(/(?:￥|¥|CNY|RMB|人民币)\s*([0-9][0-9,.]{0,20})/i);
  const node={'@type':'Product',name,sku,image:images,description,material,color,additionalProperty,
    offers:priceMatch?{price:String(priceMatch[1]).replace(/,/g,''),priceCurrency:'CNY'}:undefined};
  const result=normalizeProductNode(node,productType,sourceUrl,imageRecognition);
  result.generatedFields.push({path:'extraction',rule:'generic_dom_fallback_v2',value:'DOM/meta/key-value',evidence:facts.map(item=>item.name).slice(0,20)});
  if(siteProfile)result.generatedFields.push({path:'site_profile',rule:'qwen_site_profile_v1',value:siteProfile.site_summary||'',confidence:siteProfile.confidence,evidence:siteProfile.evidence||[]});
  return {...result,extracted:{extraction_method:siteProfile?'qwen_assisted_dom_v1':'generic_dom_fallback_v2',name,sku,image_urls:images,image_recognition:imageRecognition,description,material,color,facts}};
}
module.exports = { extractProduct, extractDomProduct, classifyProduct, jsonLdDocuments, normalizeProductNode, dimensions, cleanText, decodeHtml, domFacts, imageUrls, domImageUrls };
