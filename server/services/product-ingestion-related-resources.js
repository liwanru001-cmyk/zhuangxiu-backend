'use strict';

const crypto=require('crypto');
const Ajv=require('ajv');
const cheerio=require('cheerio');
const {CANONICAL_FIELD_SOURCE_TYPES}=require('./product-ingestion-field-source-contract');
const {field}=require('./product-ingestion-site-rule-structured');

const RULE_VERSION='official-material-rule-v1';
const FIELD_NAMES=Object.freeze(['name','code','kind','series','color','composition','description']);
const fieldSourceTypes=CANONICAL_FIELD_SOURCE_TYPES.filter(type=>type!=='constant');
const FIELD_SOURCE_SCHEMA={type:'object',additionalProperties:false,required:['type'],properties:{
  type:{enum:fieldSourceTypes},path:{type:'string',maxLength:120},selector:{type:'string',minLength:1,maxLength:240},
  attribute:{type:'string',minLength:1,maxLength:80},property:{type:'string',minLength:1,maxLength:120},
  pattern:{type:'string',minLength:1,maxLength:300},group:{type:'integer',minimum:1,maximum:10},
}};
const FIELD_RULE_SCHEMA={type:'object',additionalProperties:false,required:['required','sources'],properties:{
  required:{type:'boolean'},sources:{type:'array',minItems:1,maxItems:8,items:FIELD_SOURCE_SCHEMA},
}};
const LINK_SOURCE_SCHEMA={type:'object',additionalProperties:false,required:['selector','attribute'],properties:{
  selector:{type:'string',minLength:1,maxLength:240},attribute:{enum:['href','data-href','data-url']},
}};
const SWATCH_SOURCE_SCHEMA={type:'object',additionalProperties:false,required:['type','selector'],properties:{
  type:{enum:['dom_attribute','css_background']},selector:{type:'string',minLength:1,maxLength:240},
  attribute:{enum:['src','data-src','data-original','data-lazy-src','srcset','data-srcset']},
}};
const MATERIAL_RULE_SCHEMA={
  $id:RULE_VERSION,type:'object',additionalProperties:false,
  required:['schema_version','item_selector','fields','swatches','pagination','limits'],
  properties:{
    schema_version:{const:RULE_VERSION},item_selector:{type:'string',minLength:1,maxLength:240},
    group:{type:'object',additionalProperties:false,required:['selector','item_selector','fields'],properties:{
      selector:{type:'string',minLength:1,maxLength:240},item_selector:{type:'string',minLength:1,maxLength:240},
      fields:{type:'object',additionalProperties:false,properties:{kind:FIELD_RULE_SCHEMA,series:FIELD_RULE_SCHEMA}},
    }},
    fields:{type:'object',additionalProperties:false,required:['name'],properties:Object.fromEntries(FIELD_NAMES.map(name=>[name,FIELD_RULE_SCHEMA]))},
    swatches:{type:'array',maxItems:8,items:SWATCH_SOURCE_SCHEMA},
    item_assertion:{enum:['confirmed_available','confirmed_unavailable']},
    assertion_evidence:FIELD_RULE_SCHEMA,
    constraint:{type:'object',additionalProperties:false,required:['mode','evidence'],properties:{
      mode:{enum:['open_world','closed_allowlist']},evidence:FIELD_RULE_SCHEMA,
    }},
    pagination:{type:'object',additionalProperties:false,required:['link_sources'],properties:{link_sources:{type:'array',maxItems:5,items:LINK_SOURCE_SCHEMA}}},
    related_link_sources:{type:'array',maxItems:8,items:LINK_SOURCE_SCHEMA},
    limits:{type:'object',additionalProperties:false,required:['max_pages','max_items','max_assets'],properties:{
      max_pages:{type:'integer',minimum:1,maximum:100},max_items:{type:'integer',minimum:1,maximum:10000},max_assets:{type:'integer',minimum:0,maximum:1000},
    }},
  },
};
const ajv=new Ajv({allErrors:true,strict:false});
const validate=ajv.compile(MATERIAL_RULE_SCHEMA);

function digest(value){return crypto.createHash('sha256').update(String(value||'')).digest('hex');}
function clean(value,max=2000){const text=String(value??'').replace(/\s+/g,' ').trim();return text?text.slice(0,max):null;}
function identityText(value){return String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();}
function canonicalUrl(raw,base){const value=String(raw??'').trim();if(!value)return null;try{const url=new URL(value,base);if(!['http:','https:'].includes(url.protocol))return null;url.hash='';return url.toString();}catch{return null;}}
function safeFind(root,selector){try{return root.find(selector);}catch{return root.find('__invalid_selector__');}}
function bestSrcset(value){return String(value||'').split(',').map(item=>{const [url,size='']=item.trim().split(/\s+/,2);return {url,size:Number.parseFloat(size)||0};}).filter(item=>item.url).sort((a,b)=>b.size-a.size)[0]?.url||'';}
function backgroundUrl(node){const style=String(node.attr('style')||'');return /background(?:-image)?\s*:[^;]*url\((['"]?)(.*?)\1\)/i.exec(style)?.[2]||null;}
function jsonLdProduct($){let found={};$('script[type="application/ld+json"]').each((_,node)=>{if(Object.keys(found).length)return;try{const walk=value=>{if(!value||typeof value!=='object'||Object.keys(found).length)return;const types=Array.isArray(value['@type'])?value['@type']:[value['@type']];if(types.some(type=>String(type).toLowerCase()==='product')){found=value;return;}for(const child of Array.isArray(value)?value:Object.values(value))walk(child);};walk(JSON.parse($(node).html()||'null'));}catch{}});return found;}

function semanticRuleErrors(rule){
  const errors=[];
  if(rule?.fields?.name?.required!==true)errors.push('材料名称必须是必填且有官网来源');
  if(rule?.item_assertion==='confirmed_unavailable'&&!rule.assertion_evidence)errors.push('官网确认不可用必须提供明确的定位证据规则');
  if(rule?.constraint?.mode==='closed_allowlist'&&rule.constraint.evidence?.required!==true)errors.push('完整白名单约束必须提供必填的官网证据规则');
  const walk=value=>{if(!value||typeof value!=='object')return;if(value.selector&&/[{};]/.test(value.selector))errors.push(`选择器包含禁止字符：${value.selector}`);if(value.pattern){try{const regex=new RegExp(value.pattern,'u');if(regex.test(''.padEnd(10000,'a'))&&value.pattern.length>250)errors.push('正则表达式范围过宽');}catch{errors.push(`正则表达式无效：${value.pattern}`);}}for(const child of Array.isArray(value)?value:Object.values(value))walk(child);};
  walk(rule);
  return [...new Set(errors)];
}
function validateMaterialRule(rule){
  const schemaValid=validate(rule),schemaErrors=schemaValid?[]:(validate.errors||[]).map(error=>`${error.instancePath||'/'} ${error.message}`);
  const semanticErrors=schemaValid?semanticRuleErrors(rule):[];
  return {valid:schemaValid&&!semanticErrors.length,schema_valid:schemaValid,schema_errors:schemaErrors,semantic_errors:semanticErrors};
}

function discoverLinks(html,pageUrl,sources,allowedHosts){
  const $=cheerio.load(html||''),root=$('body'),seen=new Set(),links=[];
  for(const source of sources||[]){
    safeFind(root,source.selector).each((_,node)=>{
      const url=canonicalUrl($(node).attr(source.attribute),pageUrl);if(!url||seen.has(url))return;
      let host='';try{host=new URL(url).hostname.toLowerCase();}catch{return;}
      if(allowedHosts?.size&&!allowedHosts.has(host))return;
      seen.add(url);links.push({url,text:clean($(node).text(),500),locator:{type:'dom_attribute',selector:source.selector,attribute:source.attribute}});
    });
  }
  return links;
}

function extractMaterialPage(page,rule){
  const validation=validateMaterialRule(rule);if(!validation.valid){const error=new Error(`材料规则未通过校验：${[...validation.schema_errors,...validation.semantic_errors].join('；')}`);error.code='MATERIAL_RULE_INVALID';error.status=409;throw error;}
  const $=cheerio.load(page.html||''),bodyText=clean($('body').text(),200000)||'',product=jsonLdProduct($),items=[];
  const work=[];
  if(rule.group){
    let groups;try{groups=$(rule.group.selector);}catch{groups=$('__invalid_selector__');}
    groups.each((groupIndex,groupNode)=>{const groupRoot=$(groupNode),groupContext={$,root:groupRoot,product,bodyText:clean(groupRoot.text(),50000)||'',baseUrl:page.url},inherited={};for(const name of ['kind','series'])if(rule.group.fields[name])inherited[name]=field(rule.group.fields[name],groupContext);let roots;try{roots=safeFind(groupRoot,rule.group.item_selector);}catch{roots=$('__invalid_selector__');}roots.each((_,node)=>work.push({node,inherited,groupIndex}));});
  }else {let roots;try{roots=$(rule.item_selector);}catch{roots=$('__invalid_selector__');}roots.each((_,node)=>work.push({node,inherited:{},groupIndex:null}));}
  for(const [ordinal,entry] of work.slice(0,rule.limits.max_items).entries()){
    const root=$(entry.node),context={$,root,product,bodyText:clean(root.text(),20000)||'',baseUrl:page.url},fields={},evidence={};
    for(const name of FIELD_NAMES){const fieldRule=rule.fields[name];if(!fieldRule)continue;const resolved=field(fieldRule,context);fields[name]=clean(resolved.value,name==='description'?5000:500);evidence[name]={status:resolved.status,source:resolved.evidence?.source||null,locator:resolved.evidence?.source||null,raw_value:fields[name]};}
    for(const name of ['kind','series'])if(!fields[name]&&entry.inherited[name]){const resolved=entry.inherited[name];fields[name]=clean(resolved.value,500);evidence[name]={status:resolved.status,source:resolved.evidence?.source||null,locator:{group_selector:rule.group.selector,group_index:entry.groupIndex,source:resolved.evidence?.source||null},raw_value:fields[name],inherited_from_group:true};}
    let swatchUrl=null,swatchEvidence=null;
    for(const source of rule.swatches||[]){
      const match=root.is(source.selector)?root:safeFind(root,source.selector).first();if(!match?.length)continue;
      const raw=source.type==='css_background'?backgroundUrl(match):match.attr(source.attribute);
      swatchUrl=canonicalUrl(/srcset$/i.test(source.attribute||'')?bestSrcset(raw):raw,page.url);
      if(swatchUrl){swatchEvidence={type:source.type,selector:source.selector,attribute:source.attribute||null};break;}
    }
    // The source id is the brand boundary in storage. Product subset pages are
    // commonly sparse, so optional kind/series/color must never split one
    // official code (or one code-less official name) into duplicate entities.
    const canonicalKey=fields.name?digest(JSON.stringify(fields.code?
      ['code',identityText(fields.code)]:['name',identityText(fields.name)])):null;
    items.push({ordinal,canonical_key:canonicalKey,fields,evidence,swatch_url:swatchUrl,swatch_evidence:swatchEvidence,outcome:fields.name?'accepted':'rejected',issue_code:fields.name?null:'MATERIAL_NAME_MISSING'});
  }
  const pageContext={$,root:$('body'),product,bodyText,baseUrl:page.url};
  const assertionEvidence=rule.assertion_evidence?field(rule.assertion_evidence,pageContext):null;
  const constraintEvidence=rule.constraint?.evidence?field(rule.constraint.evidence,pageContext):null;
  return {items,pagination_links:discoverLinks(page.html,page.url,rule.pagination.link_sources),content_hash:digest(page.html),
    item_assertion:rule.item_assertion||'confirmed_available',
    assertion_evidence:assertionEvidence?.status==='provided'?assertionEvidence:null,
    constraint:rule.constraint&&constraintEvidence?.status==='provided'?{mode:rule.constraint.mode,basis:'official_explicit',evidence:constraintEvidence}:null};
}

module.exports={RULE_VERSION,FIELD_NAMES,MATERIAL_RULE_SCHEMA,validateMaterialRule,discoverLinks,extractMaterialPage,digest,canonicalUrl,clean};
