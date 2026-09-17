'use strict';

// Field-rule source names and their deterministic handlers live here so the
// schema and every field-rule consumer cannot drift independently. This module
// deliberately performs no network access, script execution or semantic guesses.
const FIELD_SOURCE_HANDLERS=Object.freeze({
  json_ld_product(source,context){return context.product?.[source.path];},
  css_text(source,context){return selectedNode(context,source.selector)?.text?.();},
  css_attr(source,context){return selectedNode(context,source.selector)?.attr?.(source.attribute);},
  meta(source,context){return context.$?.(`meta[property="${source.property}"],meta[name="${source.property}"]`).first().attr(source.attribute);},
  body_regex(source,context){try{return new RegExp(source.pattern,'u').exec(context.bodyText||'')?.[source.group];}catch{return ''; }},
  url_path(_source,context){try{return decodeURIComponent(new URL(context.baseUrl).pathname);}catch{return ''; }},
  constant(source){return source.value;},
});

const CANONICAL_FIELD_SOURCE_TYPES=Object.freeze(Object.keys(FIELD_SOURCE_HANDLERS));
const LEGACY_FIELD_SOURCE_TYPES=Object.freeze(['json_ld_product','css_text','meta','body_regex']);
const FIELD_SOURCE_ALIASES=Object.freeze({dom_text:'css_text',dom_attr:'css_attr',dom_attribute:'css_attr',json_ld:'json_ld_product'});

function selectedNode(context,selector){
  try{
    if(context.root){
      const own=context.root.is?.(selector)?context.root.first():null;
      if(own?.length)return own;
      return context.root.find(selector).first();
    }
    return context.$?.(selector).first();
  }catch{return null;}
}

function normalizeFieldSource(source){
  if(!source||typeof source!=='object'||Array.isArray(source))return source;
  return FIELD_SOURCE_ALIASES[source.type]?{...source,type:FIELD_SOURCE_ALIASES[source.type]}:source;
}

function cleanValue(value,source,options={}){
  let text=String(value??'');
  if(options.mode==='base'&&source.type==='meta')text=text.trim();
  else text=text.replace(/\s+/g,' ').trim();
  const handlerLimit=source.type==='url_path'?1000:null;
  const requested=Number.isFinite(options.maxLength)?Number(options.maxLength):null;
  const limit=handlerLimit==null?requested:requested==null?handlerLimit:Math.min(handlerLimit,requested);
  return limit==null?text:text.slice(0,Math.max(0,limit));
}

function executeFieldSource(source,context,options={}){
  const handler=FIELD_SOURCE_HANDLERS[source?.type];
  if(!handler)return '';
  return cleanValue(handler(source,context||{}),source,options);
}

function resolveFieldRule(rule,context,options={}){
  if(!rule||!Array.isArray(rule.sources)||!rule.sources.length)return {value:null,status:'rule_not_configured',evidence:null};
  for(const source of rule.sources){
    const value=executeFieldSource(source,context,options);
    if(value)return {value,status:'provided',evidence:{source_type:source.type,source}};
  }
  return {value:null,status:'source_absent',evidence:null};
}

module.exports={FIELD_SOURCE_HANDLERS,CANONICAL_FIELD_SOURCE_TYPES,LEGACY_FIELD_SOURCE_TYPES,FIELD_SOURCE_ALIASES,normalizeFieldSource,executeFieldSource,resolveFieldRule};
