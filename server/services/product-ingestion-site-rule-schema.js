'use strict';

const Ajv = require('ajv');
const crypto = require('crypto');
const {getDomain}=require('tldts');
const {CANONICAL_FIELD_SOURCE_TYPES,LEGACY_FIELD_SOURCE_TYPES}=require('./product-ingestion-field-source-contract');
const {API_RULE_SCHEMA}=require('./product-ingestion-public-json-api-contract');
const {safePathPattern}=require('./product-ingestion-url-role-contract');

const SCHEMA_VERSION = 'site-rule-config-v1.0';
const RICH_SCHEMA_VERSION = 'site-rule-config-v1.1';
const PRODUCT_V2_SCHEMA_VERSION = 'site-rule-config-v2';
const MATCHING_PRIORITY = ['exclude', 'product_detail', 'listing'];
const SANDBOX_HARD_LIMITS = Object.freeze({ max_pages:5, max_products:5, min_request_interval_ms:1000 });

const STRING_LIST = { type:'array', uniqueItems:true, items:{type:'string',minLength:1,maxLength:500} };
const URL_LIST = { type:'array', uniqueItems:true, items:{type:'string',pattern:'^https://',maxLength:2000} };
const PATH_LIST = { type:'array', uniqueItems:true, items:{type:'string',pattern:'^/',maxLength:500} };
const PATH_PATTERN_LIST = {type:'array',uniqueItems:true,items:{type:'string',pattern:'^\\^',maxLength:240}};

const FIELD_SOURCE_SCHEMA = {
  type:'object', additionalProperties:false, required:['type'],
  properties:{
    type:{enum:LEGACY_FIELD_SOURCE_TYPES},
    path:{type:'string',enum:['name','description','sku','mpn','category']},
    selector:{type:'string',minLength:1,maxLength:200},
    attribute:{type:'string',enum:['content']},
    property:{type:'string',enum:['og:title','og:description','product:sku']},
    pattern:{type:'string',minLength:1,maxLength:200},
    group:{type:'integer',minimum:1,maximum:5},
  },
};

const FIELD_RULE_SCHEMA = {
  type:'object', additionalProperties:false, required:['required','sources'],
  properties:{ required:{type:'boolean'}, sources:{type:'array',minItems:1,maxItems:6,items:FIELD_SOURCE_SCHEMA} },
};
const LINK_SOURCE_SCHEMA = {
  type:'object',additionalProperties:false,required:['selector','attribute'],
  properties:{selector:{type:'string',minLength:1,maxLength:200},attribute:{enum:['href','data-href','data-url']}},
};
const IMAGE_SOURCE_SCHEMA = {
  type:'object',additionalProperties:false,required:['type'],
  properties:{
    type:{enum:['json_ld_product','meta','dom_attribute','css_background']},
    path:{type:'string',enum:['image']},property:{type:'string',enum:['og:image','twitter:image']},
    selector:{type:'string',minLength:1,maxLength:200},attribute:{enum:['src','data-src','data-original','data-lazy-src','srcset','data-srcset']},
  },
};

const SITE_RULE_SCHEMA = {
  $id:'site-rule-config-v1.0', type:'object', additionalProperties:false,
  required:['schema_version','site_id','brand','scope','template','discovery','extraction','sandbox','validation','provenance'],
  properties:{
    schema_version:{const:SCHEMA_VERSION},
    site_id:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{1,79}$'},
    brand:{type:'string',minLength:1,maxLength:120},
    scope:{
      type:'object',additionalProperties:false,required:['base_url','allowed_page_hosts','allowed_asset_hosts','allowed_path_prefixes'],
      properties:{
        base_url:{type:'string',pattern:'^https://',maxLength:2000},
        allowed_page_hosts:{type:'array',minItems:1,maxItems:10,uniqueItems:true,items:{type:'string',pattern:'^[a-z0-9.-]+$',maxLength:253}},
        allowed_asset_hosts:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',pattern:'^[a-z0-9.-]+$',maxLength:253}},
        allowed_path_prefixes:{...PATH_LIST,minItems:1,maxItems:30},
      },
    },
    template:{
      type:'object',additionalProperties:false,required:['fingerprint_algorithm','required_signals'],
      properties:{
        fingerprint_algorithm:{const:'site-template-fingerprint-v1'},
        required_signals:{type:'array',minItems:2,maxItems:12,uniqueItems:true,items:{enum:['PRODUCT_NAME','JSON_LD_PRODUCT','H1','OG_IMAGE','PRODUCT_DESCRIPTION','TECHNICAL_HEADING','PRODUCT_GALLERY','PRODUCT_SPECIFICATION']}},
      },
    },
    discovery:{
      type:'object',additionalProperties:false,required:['seed_urls','matching_priority','product_detail_path_prefixes','listing_path_prefixes','exclude_path_prefixes','follow_same_role_links','max_candidates','link_sources'],
      properties:{
        seed_urls:{...URL_LIST,minItems:1,maxItems:20},
        matching_priority:{type:'array',minItems:3,maxItems:3,items:{enum:MATCHING_PRIORITY}},
        product_detail_path_prefixes:{...PATH_LIST,minItems:1,maxItems:30},
        listing_path_prefixes:{...PATH_LIST,maxItems:30},
        exclude_path_prefixes:{...PATH_LIST,maxItems:50},
        product_detail_paths:{...PATH_LIST,maxItems:50},listing_paths:{...PATH_LIST,maxItems:50},exclude_paths:{...PATH_LIST,maxItems:50},
        product_detail_path_patterns:{...PATH_PATTERN_LIST,maxItems:30},listing_path_patterns:{...PATH_PATTERN_LIST,maxItems:30},exclude_path_patterns:{...PATH_PATTERN_LIST,maxItems:30},
        follow_same_role_links:{type:'boolean'},
        max_candidates:{type:'integer',minimum:1,maximum:50},
        link_sources:{type:'array',minItems:1,maxItems:10,items:LINK_SOURCE_SCHEMA},
      },
    },
    extraction:{
      type:'object',additionalProperties:false,required:['product_type','fields','images','variants','attachments','relationships'],
      properties:{
        product_type:{const:'furniture'},
        fields:{
          type:'object',additionalProperties:false,required:['name','description'],
          properties:{
            name:FIELD_RULE_SCHEMA,description:FIELD_RULE_SCHEMA,model:FIELD_RULE_SCHEMA,
            category:FIELD_RULE_SCHEMA,designer:FIELD_RULE_SCHEMA,design_year:FIELD_RULE_SCHEMA,
            material:FIELD_RULE_SCHEMA,dimensions:FIELD_RULE_SCHEMA,
          },
        },
        images:{
          type:'object',additionalProperties:false,required:['sources','max_images','prefer_tokens','exclude_tokens'],
          properties:{
            sources:{type:'array',minItems:1,maxItems:12,items:IMAGE_SOURCE_SCHEMA},
            max_images:{type:'integer',minimum:1,maximum:5},
            prefer_tokens:{...STRING_LIST,maxItems:30},
            exclude_tokens:{...STRING_LIST,maxItems:50},
          },
        },
        variants:{
          type:'object',additionalProperties:false,required:['mode','identity_fields','item_selector'],
          properties:{mode:{enum:['none','same_page','linked_pages']},identity_fields:{type:'array',maxItems:8,uniqueItems:true,items:{enum:['name','model','sku','size','material','color','finish']}},item_selector:{anyOf:[{type:'string',minLength:1,maxLength:200},{type:'null'}]}},
        },
        attachments:{
          type:'object',additionalProperties:false,required:['link_sources','allowed_extensions'],
          properties:{link_sources:{type:'array',maxItems:10,items:LINK_SOURCE_SCHEMA},allowed_extensions:{type:'array',maxItems:10,uniqueItems:true,items:{enum:['pdf','dwg','dxf','zip']}},},
        },
        relationships:{
          type:'object',additionalProperties:false,required:['mode','component_link_sources'],
          properties:{mode:{enum:['standalone','parent_with_components','component']},component_link_sources:{type:'array',maxItems:10,items:LINK_SOURCE_SCHEMA}},
        },
      },
    },
    sandbox:{
      type:'object',additionalProperties:false,required:['max_pages','max_products','request_interval_ms','request_method','write_candidates','publish_products'],
      properties:{
        max_pages:{type:'integer',minimum:1,maximum:SANDBOX_HARD_LIMITS.max_pages},
        max_products:{type:'integer',minimum:1,maximum:SANDBOX_HARD_LIMITS.max_products},
        request_interval_ms:{type:'integer',minimum:SANDBOX_HARD_LIMITS.min_request_interval_ms,maximum:60000},
        request_method:{const:'GET'},write_candidates:{const:false},publish_products:{const:false},
      },
    },
    validation:{
      type:'object',additionalProperties:false,required:['required_fields','minimum_images','minimum_accepted_products','require_template_match'],
      properties:{
        required_fields:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{enum:['name','description','model','category','designer','design_year','material','dimensions']}},
        minimum_images:{type:'integer',minimum:1,maximum:5},
        minimum_accepted_products:{type:'integer',minimum:1,maximum:5},
        require_template_match:{const:true},
      },
    },
    provenance:{
      type:'object',additionalProperties:false,required:['generator','prompt_version','evidence_ids','generated_at'],
      properties:{
        generator:{type:'string',minLength:1,maxLength:120},prompt_version:{type:'string',minLength:1,maxLength:80},
        evidence_ids:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'string',minLength:1,maxLength:200}},
        generated_at:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}T'},model:{type:'string',maxLength:120},
      },
    },
  },
};

// v1.1 keeps every v1.0 safety boundary and adds a declarative mapping from a
// product page to the desktop product_details contract.  It deliberately does
// not add scripts, arbitrary attributes, additional hosts or network methods.
const RICH_FIELD_SOURCE_SCHEMA = {
  type:'object',additionalProperties:false,required:['type'],
  properties:{
    type:{enum:CANONICAL_FIELD_SOURCE_TYPES},
    path:{type:'string',enum:['name','description','sku','mpn','category']},
    selector:{type:'string',minLength:1,maxLength:200},
    attribute:{type:'string',enum:['content','href','src','data-src','data-original','data-lazy-src','srcset','data-srcset','data-file-url','data-code','data-model','alt','title','value']},
    property:{type:'string',enum:['og:title','og:description','product:sku']},
    pattern:{type:'string',minLength:1,maxLength:200},group:{type:'integer',minimum:1,maximum:8},
    value:{type:'string',maxLength:500},
  },
};
const RICH_FIELD_RULE_SCHEMA={
  type:'object',additionalProperties:false,required:['required','sources'],
  properties:{required:{type:'boolean'},sources:{type:'array',maxItems:8,items:RICH_FIELD_SOURCE_SCHEMA}},
};
const RICH_IMAGE_SOURCE_SCHEMA={
  type:'object',additionalProperties:false,required:['type','role'],
  properties:{
    type:{enum:['json_ld_product','meta','dom_attribute','css_background']},
    role:{enum:['main','angle','scene','detail','dimension_diagram','swatch','drawing','unknown']},
    path:{type:'string',enum:['image']},property:{type:'string',enum:['og:image','twitter:image']},
    selector:{type:'string',minLength:1,maxLength:200},attribute:{enum:['src','data-src','data-original','data-lazy-src','srcset','data-srcset']},
  },
};
const RICH_LINK_SOURCE_SCHEMA={
  type:'object',additionalProperties:false,required:['selector','attribute'],
  properties:{selector:{type:'string',minLength:1,maxLength:200},attribute:{enum:['href','data-href','data-url','data-file-url']},kind:{enum:['drawing','technical','catalog','material','configurator','component','other']}},
};
const SITE_RULE_SCHEMA_V1_1=JSON.parse(JSON.stringify(SITE_RULE_SCHEMA));
SITE_RULE_SCHEMA_V1_1.$id=RICH_SCHEMA_VERSION;
SITE_RULE_SCHEMA_V1_1.properties.schema_version={const:RICH_SCHEMA_VERSION};
SITE_RULE_SCHEMA_V1_1.properties.extraction.properties.fields.additionalProperties=false;
for(const name of Object.keys(SITE_RULE_SCHEMA_V1_1.properties.extraction.properties.fields.properties))SITE_RULE_SCHEMA_V1_1.properties.extraction.properties.fields.properties[name]=RICH_FIELD_RULE_SCHEMA;
SITE_RULE_SCHEMA_V1_1.properties.extraction.properties.images={
  type:'object',additionalProperties:false,required:['sources','max_images','prefer_tokens','exclude_tokens','top5_roles'],
  properties:{sources:{type:'array',minItems:1,maxItems:16,items:RICH_IMAGE_SOURCE_SCHEMA},max_images:{type:'integer',minimum:1,maximum:20},prefer_tokens:{...STRING_LIST,maxItems:30},exclude_tokens:{...STRING_LIST,maxItems:50},top5_roles:{type:'array',minItems:1,maxItems:5,uniqueItems:true,items:{enum:['main','angle','scene','detail']}}},
};
SITE_RULE_SCHEMA_V1_1.properties.extraction.properties.attachments={
  type:'object',additionalProperties:false,required:['link_sources','allowed_extensions'],
  properties:{link_sources:{type:'array',maxItems:16,items:RICH_LINK_SOURCE_SCHEMA},allowed_extensions:{type:'array',maxItems:12,uniqueItems:true,items:{enum:['pdf','dwg','dxf','zip','3dm','fbx','max','skp']}},},
};
SITE_RULE_SCHEMA_V1_1.properties.extraction.properties.structured={
  type:'object',additionalProperties:false,required:['furniture_type','configurations','ocr','customization'],
  properties:{
    furniture_type:{enum:['sofa','chair','table','bed','cabinet','other']},
    furniture_type_rule:{type:'object',additionalProperties:false,required:['source','keywords'],properties:{source:RICH_FIELD_RULE_SCHEMA,keywords:{type:'object',additionalProperties:false,required:['sofa','chair','table','bed','cabinet'],properties:{sofa:{...STRING_LIST,maxItems:20},chair:{...STRING_LIST,maxItems:20},table:{...STRING_LIST,maxItems:20},bed:{...STRING_LIST,maxItems:20},cabinet:{...STRING_LIST,maxItems:20},other:{...STRING_LIST,maxItems:20}}}}},
    configurations:{
      type:'object',additionalProperties:false,required:['mode','item_selector','max_items','fields','dimensions','images','parts'],
      properties:{
        mode:{enum:['single','repeated']},item_selector:{anyOf:[{type:'string',minLength:1,maxLength:200},{type:'null'}]},max_items:{type:'integer',minimum:1,maximum:100},
        fields:{type:'object',additionalProperties:false,properties:{name:RICH_FIELD_RULE_SCHEMA,code:RICH_FIELD_RULE_SCHEMA,includes:RICH_FIELD_RULE_SCHEMA,price:RICH_FIELD_RULE_SCHEMA}},
        dimensions:{type:'object',additionalProperties:false,required:['source','format','default_unit'],properties:{source:RICH_FIELD_RULE_SCHEMA,format:{enum:['auto','width_depth_height','width_height','diameter_height']},default_unit:{enum:['mm','cm']}}},
        images:{type:'array',maxItems:8,items:RICH_IMAGE_SOURCE_SCHEMA},
        parts:{type:'object',additionalProperties:false,required:['mode','item_selector','part','material','color','code','swatch'],properties:{mode:{enum:['single','repeated','none']},item_selector:{anyOf:[{type:'string',minLength:1,maxLength:200},{type:'null'}]},part:RICH_FIELD_RULE_SCHEMA,material:RICH_FIELD_RULE_SCHEMA,color:RICH_FIELD_RULE_SCHEMA,code:RICH_FIELD_RULE_SCHEMA,swatch:{anyOf:[RICH_IMAGE_SOURCE_SCHEMA,{type:'null'}]}}},
      },
    },
    ocr:{type:'object',additionalProperties:false,required:['enabled','max_images','roles','outputs'],properties:{enabled:{type:'boolean'},max_images:{type:'integer',minimum:0,maximum:5},roles:{type:'array',maxItems:4,uniqueItems:true,items:{enum:['dimension_diagram','swatch','drawing']}},outputs:{type:'array',maxItems:5,uniqueItems:true,items:{enum:['dimensions','material','color','code']}}}},
    customization:{type:'object',additionalProperties:false,required:['enabled','fields','limits','pricing_note'],properties:{enabled:{type:'boolean'},fields:{type:'array',maxItems:6,uniqueItems:true,items:{enum:['material','color','width','depth','height','combination']}},limits:{type:'string',maxLength:1000},pricing_note:{type:'string',maxLength:500}}},
  },
};
SITE_RULE_SCHEMA_V1_1.properties.extraction.required.push('structured');
SITE_RULE_SCHEMA_V1_1.properties.validation.properties.minimum_images.maximum=20;
const SITE_RULE_EXTRACTION_PROPOSAL_SCHEMA=JSON.parse(JSON.stringify(SITE_RULE_SCHEMA_V1_1.properties.extraction));
SITE_RULE_EXTRACTION_PROPOSAL_SCHEMA.$id='site-rule-extraction-proposal-v1.1';

// v2 changes product semantics, not the network or execution boundary. Existing
// v1/v1.1 rules remain readable, while every newly generated rule targets the
// shared Product Schema v2 contract.
const PRODUCT_ASSET_ROLES=['hero','product_gallery','scene','detail','configuration_image','dimension_diagram','material_swatch','drawing','certificate','catalog','technical_document','model_file','decorative','unknown'];
const SITE_RULE_SCHEMA_V2=JSON.parse(JSON.stringify(SITE_RULE_SCHEMA_V1_1));
SITE_RULE_SCHEMA_V2.$id=PRODUCT_V2_SCHEMA_VERSION;
SITE_RULE_SCHEMA_V2.properties.schema_version={const:PRODUCT_V2_SCHEMA_VERSION};
SITE_RULE_SCHEMA_V2.properties.public_json_api={anyOf:[API_RULE_SCHEMA,{type:'null'}]};
const v2Extraction=SITE_RULE_SCHEMA_V2.properties.extraction;
for(const name of ['english_name','release_date'])v2Extraction.properties.fields.properties[name]=RICH_FIELD_RULE_SCHEMA;
v2Extraction.properties.images.properties.sources.items.properties.role.enum=PRODUCT_ASSET_ROLES;
v2Extraction.properties.images.properties.top5_roles.items.enum=['hero','product_gallery','scene','detail'];
const v2Configurations=v2Extraction.properties.structured.properties.configurations;
v2Configurations.properties.max_items.maximum=200;
v2Configurations.properties.max_items.minimum=0;
v2Configurations.properties.mode.enum=['none','single','repeated'];
v2Configurations.properties.fields.properties.group=RICH_FIELD_RULE_SCHEMA;
v2Configurations.properties.images.items.properties.role.enum=PRODUCT_ASSET_ROLES;
v2Configurations.properties.parts.properties.swatch.anyOf[0].properties.role.enum=PRODUCT_ASSET_ROLES;
const OPTION_GROUP_SCHEMA={
  type:'object',additionalProperties:false,required:['mode','item_selector','max_items','fields','options'],
  properties:{
    mode:{enum:['none','single','repeated']},item_selector:{anyOf:[{type:'string',minLength:1,maxLength:200},{type:'null'}]},max_items:{type:'integer',minimum:0,maximum:200},
    fields:{type:'object',additionalProperties:false,required:['name','type'],properties:{name:RICH_FIELD_RULE_SCHEMA,type:RICH_FIELD_RULE_SCHEMA}},
    options:{type:'object',additionalProperties:false,required:['mode','item_selector','max_items','fields','swatch','applies_to_configuration_code'],properties:{
      mode:{enum:['single','repeated']},item_selector:{anyOf:[{type:'string',minLength:1,maxLength:200},{type:'null'}]},max_items:{type:'integer',minimum:1,maximum:1000},
      fields:{type:'object',additionalProperties:false,required:['name','code','material','color','supplier','origin'],properties:{name:RICH_FIELD_RULE_SCHEMA,code:RICH_FIELD_RULE_SCHEMA,material:RICH_FIELD_RULE_SCHEMA,color:RICH_FIELD_RULE_SCHEMA,supplier:RICH_FIELD_RULE_SCHEMA,origin:RICH_FIELD_RULE_SCHEMA}},
      swatch:{anyOf:[JSON.parse(JSON.stringify(RICH_IMAGE_SOURCE_SCHEMA)),{type:'null'}]},applies_to_configuration_code:RICH_FIELD_RULE_SCHEMA,
    }},
  },
};
OPTION_GROUP_SCHEMA.properties.options.properties.swatch.anyOf[0].properties.role.enum=PRODUCT_ASSET_ROLES;
v2Extraction.properties.structured.properties.option_groups={type:'array',maxItems:20,items:OPTION_GROUP_SCHEMA};
v2Extraction.properties.structured.required.push('option_groups');
v2Extraction.properties.structured.properties.ocr.properties.roles.items.enum=['dimension_diagram','material_swatch','drawing'];
const SITE_RULE_EXTRACTION_PROPOSAL_SCHEMA_V2=JSON.parse(JSON.stringify(v2Extraction));
SITE_RULE_EXTRACTION_PROPOSAL_SCHEMA_V2.$id='site-rule-extraction-proposal-v2';

const ajv = new Ajv({allErrors:true,strict:true});
const validateSchema = ajv.compile(SITE_RULE_SCHEMA);
const validateRichSchema = ajv.compile(SITE_RULE_SCHEMA_V1_1);
const validateProductV2Schema = ajv.compile(SITE_RULE_SCHEMA_V2);

function decodePath(value) { try { return decodeURIComponent(value); } catch { return value; } }
function semanticPath(raw) { try { return decodePath(new URL(raw).pathname); } catch { return ''; } }
function safeRegex(pattern) {
  const value=String(pattern||'');
  return value.length<=200&&!/\\[1-9]|\(\?[=!<]|(?:\+|\*|\{\d+,?\d*\})\s*(?:\+|\*|\{)|\([^)]*(?:\+|\*|\{\d+,?\d*\})[^)]*\)\s*(?:\+|\*|\{)/.test(value);
}
function host(value) { try { return new URL(value).hostname.toLowerCase(); } catch { return ''; } }

function semanticErrors(config) {
  const errors=[];
  if(JSON.stringify(config.discovery?.matching_priority)!==JSON.stringify(MATCHING_PRIORITY))errors.push('matching_priority 必须为 exclude → product_detail → listing');
  const pageHosts=new Set(config.scope?.allowed_page_hosts||[]),assetHosts=new Set(config.scope?.allowed_asset_hosts||[]);
  if(!pageHosts.has(host(config.scope?.base_url)))errors.push('base_url 域名不在页面域名白名单');
  if(config.public_json_api){
    const endpointHost=host(config.public_json_api.endpoint_url),baseHost=host(config.scope?.base_url),endpointDomain=getDomain(endpointHost,{allowPrivateDomains:false}),baseDomain=getDomain(baseHost,{allowPrivateDomains:false});
    if(!pageHosts.has(endpointHost))errors.push('公开 JSON API 域名不在页面域名白名单');
    if(!endpointDomain||endpointDomain!==baseDomain)errors.push('公开 JSON API 必须与官网属于同一注册域');
  }
  for(const url of config.discovery?.seed_urls||[]){
    if(!pageHosts.has(host(url)))errors.push(`种子 URL 超出页面域名范围：${url}`);
    const pathname=semanticPath(url),allowed=(config.scope?.allowed_path_prefixes||[]).some(prefix=>prefix==='/'||pathname.startsWith(decodePath(prefix)));
    if(!allowed)errors.push(`种子 URL 超出允许路径：${url}`);
  }
  const discovery=config.discovery||{};
  const activePrefixes=role=>(discovery[`${role}_paths`]?.length||discovery[`${role}_path_patterns`]?.length)?[]:(discovery[`${role}_path_prefixes`]||[]);
  const detail=activePrefixes('product_detail'),listing=activePrefixes('listing'),excluded=activePrefixes('exclude');
  for(const role of ['product_detail','listing','exclude'])for(const pattern of config.discovery?.[`${role}_path_patterns`]||[])if(!safePathPattern(pattern))errors.push(`${role} 路径模式不安全或未完整锚定：${pattern}`);
  if(detail.some(prefix=>listing.includes(prefix)))errors.push('产品详情路径和列表路径不能完全相同');
  if(detail.some(prefix=>excluded.includes(prefix)))errors.push('产品详情路径和排除路径不能完全相同');
  for(const productPrefix of detail)for(const excludedPrefix of excluded)if(decodePath(productPrefix).startsWith(decodePath(excludedPrefix)))errors.push(`产品详情路径 ${productPrefix} 被排除路径 ${excludedPrefix} 覆盖`);
  for(const [name,field] of Object.entries(config.extraction?.fields||{}))for(const source of field.sources||[]){
    if(source.type==='json_ld_product'&&!source.path)errors.push(`${name} 的 json_ld_product 来源缺少 path`);
    if(source.type==='css_text'&&(!source.selector||/[{};]/.test(source.selector)||(!['name'].includes(name)&&/^(?:\*|p|div|span|li|section|article)$/i.test(String(source.selector).trim()))))errors.push(`${name} 的 css_text 来源缺少或使用了不安全、过宽 selector`);
    if(source.type==='meta'&&(!source.property||source.attribute!=='content'))errors.push(`${name} 的 meta 来源必须提供允许的 property 和 content 属性`);
    if(source.type==='body_regex'&&(!source.pattern||!source.group||!safeRegex(source.pattern)))errors.push(`${name} 的 body_regex 缺少安全 pattern/group 或使用了禁止的复杂表达式`);
    if(source.type==='css_attr'&&(!source.selector||!source.attribute))errors.push(`${name} 的 css_attr 来源缺少 selector/attribute`);
    if(source.type==='constant'&&!source.value)errors.push(`${name} 的 constant 来源缺少 value`);
  }
  const selectorValues=[...(config.discovery?.link_sources||[]),...(config.extraction?.images?.sources||[]),...(config.extraction?.attachments?.link_sources||[]),...(config.extraction?.relationships?.component_link_sources||[])].map(source=>source.selector).filter(Boolean);
  if(selectorValues.some(selector=>/[{};]/.test(selector)))errors.push('发现、图片或关系选择器包含禁止字符');
  for(const source of config.extraction?.images?.sources||[]){
    if(source.type==='json_ld_product'&&source.path!=='image')errors.push('JSON-LD 图片来源必须指定 image');
    if(source.type==='meta'&&!source.property)errors.push('meta 图片来源缺少 property');
    if(source.type==='dom_attribute'&&(!source.selector||!source.attribute))errors.push('DOM 图片来源缺少 selector/attribute');
    if(source.type==='css_background'&&!source.selector)errors.push('CSS 背景图来源缺少 selector');
    if(['dom_attribute','css_background'].includes(source.type)&&/^(?:\*|img|picture\s+img|main\s+img|body\s+img)$/i.test(String(source.selector||'').trim()))errors.push(`图片选择器范围过宽，无法证明图片属于当前产品：${source.selector}`);
  }
  if(config.extraction?.variants?.mode==='none'&&(config.extraction.variants.item_selector!==null||config.extraction.variants.identity_fields.length))errors.push('无变体模式不得提供变体选择器或身份字段');
  if(config.extraction?.variants?.mode!=='none'&&(!config.extraction.variants.item_selector||!config.extraction.variants.identity_fields.length))errors.push('变体模式必须提供 item_selector 和身份字段');
  const structured=config.extraction?.structured;
  if(structured){
    const walk=(value,visit)=>{if(!value||typeof value!=='object')return;visit(value);for(const child of Array.isArray(value)?value:Object.values(value))walk(child,visit);};
    walk(structured,value=>{
      if(value.selector&&/[{};]/.test(value.selector))errors.push(`结构化选择器包含禁止字符：${value.selector}`);
      if(value.pattern&&(!value.group||!safeRegex(value.pattern)))errors.push('结构化字段使用了不安全或不完整的正则来源');
    });
    const configurations=structured.configurations;
    if(config.schema_version===PRODUCT_V2_SCHEMA_VERSION&&configurations.mode==='none'&&(configurations.item_selector!==null||configurations.max_items!==0))errors.push('无配置证据时 configurations.mode=none 必须使用 null item_selector 和 0 max_items');
    if(structured.furniture_type_rule&&!structured.furniture_type_rule.source.sources.length&&Object.values(structured.furniture_type_rule.keywords).some(tokens=>tokens.length))errors.push('家具细类关键词已配置，但缺少用于匹配的页面文字来源');
    if(configurations.mode==='single'&&configurations.item_selector!==null)errors.push('单配置模式不得提供 item_selector');
    if(configurations.mode==='repeated'&&!configurations.item_selector)errors.push('重复配置模式必须提供 item_selector');
    if(structured.ocr.enabled&&(!structured.ocr.max_images||!structured.ocr.roles.length||!structured.ocr.outputs.length))errors.push('OCR 启用时必须限定图片数、图片角色和输出字段');
    if(!structured.ocr.enabled&&(structured.ocr.max_images||structured.ocr.roles.length||structured.ocr.outputs.length))errors.push('OCR 未启用时不得声明 OCR 输入或输出');
    walk(structured,value=>{if(value.required===true&&Array.isArray(value.sources)&&!value.sources.length)errors.push('标记为 required 的结构化字段必须提供证据来源');});
    if(config.schema_version===PRODUCT_V2_SCHEMA_VERSION){
      walk(structured,value=>{if(Array.isArray(value.sources)&&value.sources.some(source=>source.type==='constant'))errors.push('Product Schema v2 业务字段不得使用 constant 生成官网值');});
      for(const group of structured.option_groups||[]){
        if(group.mode==='none'&&(group.item_selector!==null||group.max_items!==0))errors.push('无选项组模式不得提供 item_selector，max_items 必须为 0');
        if(group.mode==='single'&&group.item_selector!==null)errors.push('单选项组模式不得提供 item_selector');
        if(group.mode==='repeated'&&!group.item_selector)errors.push('重复选项组模式必须提供 item_selector');
        if(group.options.mode==='single'&&group.options.item_selector!==null)errors.push('单选项模式不得提供 item_selector');
        if(group.options.mode==='repeated'&&!group.options.item_selector)errors.push('重复选项模式必须提供 item_selector');
      }
    }
  }
  for(const [name,field] of Object.entries(config.extraction?.fields||{}))if((field.sources||[]).some(source=>source.type==='constant'))errors.push(`产品字段 ${name} 不得使用 constant 伪造来源证据`);
  if(config.validation?.minimum_images>config.extraction?.images?.max_images)errors.push('minimum_images 不能超过 max_images');
  if(config.validation?.minimum_accepted_products>config.sandbox?.max_products)errors.push('minimum_accepted_products 不能超过沙箱产品上限');
  for(const name of config.validation?.required_fields||[])if(config.extraction?.fields?.[name]?.required!==true)errors.push(`必验字段 ${name} 的规则必须标记 required=true`);
  if([...pageHosts,...assetHosts].some(value=>value==='localhost'||value.endsWith('.local')))errors.push('域名白名单不能包含本机或内网名称');
  for(const url of [config.scope?.base_url,...(config.discovery?.seed_urls||[])]){try{const value=new URL(url);if(value.protocol!=='https:'||value.username||value.password||value.port)errors.push(`URL 不是安全的标准 HTTPS 地址：${url}`);}catch{}}
  return errors;
}

function validateSiteRule(config) {
  const validator=config?.schema_version===PRODUCT_V2_SCHEMA_VERSION?validateProductV2Schema:config?.schema_version===RICH_SCHEMA_VERSION?validateRichSchema:validateSchema;
  const schemaValid=validator(config);
  const schemaErrors=schemaValid?[]:(validator.errors||[]).map(error=>`${error.instancePath||'/'} ${error.message}`);
  const semantics=schemaValid?semanticErrors(config):[];
  return {valid:schemaValid&&!semantics.length,schema_valid:schemaValid,schema_errors:schemaErrors,semantic_errors:semantics};
}

function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
function configHash(config) { return crypto.createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex'); }

module.exports={SCHEMA_VERSION,RICH_SCHEMA_VERSION,PRODUCT_V2_SCHEMA_VERSION,SITE_RULE_SCHEMA,SITE_RULE_SCHEMA_V1_1,SITE_RULE_SCHEMA_V2,SITE_RULE_EXTRACTION_PROPOSAL_SCHEMA,SITE_RULE_EXTRACTION_PROPOSAL_SCHEMA_V2,MATCHING_PRIORITY,SANDBOX_HARD_LIMITS,validateSiteRule,configHash,semanticPath,decodePath,safeRegex};
