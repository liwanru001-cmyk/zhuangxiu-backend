'use strict';

const crypto = require('crypto');
const Ajv = require('ajv');
const { isProductUrl } = require('./product-url');

const PRODUCT_SCHEMA_VERSION = 2;
const FIELD_STATUSES = Object.freeze(['provided','source_absent','extraction_failed','ambiguous','defaulted','inferred','not_applicable']);
const ASSET_ROLES = Object.freeze(['hero','product_gallery','scene','detail','configuration_image','dimension_diagram','material_swatch','drawing','certificate','catalog','technical_document','model_file','decorative','unknown']);
const CORRECTION_ACTIONS = Object.freeze(['set_value','clear_value','reclassify','bind','unbind','exclude','reorder','reextract']);

// This registry is the semantic source of truth shared by AI prompting, runtime
// mapping and review. UI layout remains hand-authored and only consumes labels.
const FIELD_REGISTRY = Object.freeze({
  '/product/names/primary':{label:'产品主名称',type:'string',entity:'product'},
  '/product/names/zh':{label:'产品中文名',type:'string',entity:'product'},
  '/product/names/en':{label:'产品英文名',type:'string',entity:'product'},
  '/product/description':{label:'产品说明',type:'string',entity:'product'},
  '/product/model':{label:'产品公共型号',type:'string',entity:'product'},
  '/product/category':{label:'官网分类',type:'string',entity:'product'},
  '/product/product_type':{label:'标准产品类型',type:'string',entity:'product'},
  '/product/designer/name':{label:'设计师',type:'string',entity:'product'},
  '/product/designer/name_zh':{label:'设计师中文名',type:'string',entity:'product'},
  '/product/designer/name_en':{label:'设计师英文名',type:'string',entity:'product'},
  '/product/release_date/value':{label:'发布日期',type:'string',entity:'product'},
  '/product/design_year':{label:'设计年份',type:'string',entity:'product'},
  '/configurations/*/group':{label:'款型分组',type:'string',entity:'configuration'},
  '/configurations/*/name':{label:'款型名称',type:'string',entity:'configuration'},
  '/configurations/*/code':{label:'型号/SKU',type:'string',entity:'configuration'},
  '/configurations/*/dimensions':{label:'款型尺寸',type:'array',entity:'configuration'},
  '/configurations/*/price':{label:'参考价格',type:'number',entity:'configuration'},
  '/configurations/*/unit':{label:'销售单位',type:'string',entity:'configuration'},
  '/option_groups/*/name':{label:'选项组',type:'string',entity:'option_group'},
  '/option_groups/*/options/*/code':{label:'选项编号',type:'string',entity:'option'},
  '/option_groups/*/options/*/material':{label:'材质',type:'string',entity:'option'},
  '/option_groups/*/options/*/color':{label:'颜色',type:'string',entity:'option'},
  '/option_groups/*/options/*/supplier':{label:'供应品牌',type:'string',entity:'option'},
  '/option_groups/*/options/*/origin':{label:'产地',type:'string',entity:'option'},
  '/assets/*/role':{label:'图片角色',type:'enum',entity:'asset'},
  '/assets/*/bindings':{label:'图片绑定关系',type:'array',entity:'asset'},
});

const nullableString={anyOf:[{type:'string',maxLength:4000},{type:'null'}]};
const idSchema={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'};
const stringArray={type:'array',uniqueItems:true,items:idSchema,maxItems:500};
const sourceUrl={anyOf:[{type:'string',pattern:'^https?://',maxLength:2000},{type:'null'}]};
const fieldRule={type:'object',additionalProperties:false,required:['status'],properties:{status:{enum:FIELD_STATUSES}}};

const PRODUCT_DOCUMENT_V2_SCHEMA={
  $id:'product-document-v2',type:'object',additionalProperties:false,
  required:['schema_version','data','field_status','evidence','issues'],
  properties:{
    schema_version:{const:PRODUCT_SCHEMA_VERSION},
    data:{type:'object',additionalProperties:false,required:['product','configurations','option_groups','assets'],properties:{
      product:{type:'object',additionalProperties:false,required:['names','description','model','category','product_type','designer','release_date','design_year','source_url'],properties:{
        names:{type:'object',additionalProperties:false,required:['primary','zh','en'],properties:{primary:nullableString,zh:nullableString,en:nullableString}},
        description:nullableString,model:nullableString,category:nullableString,product_type:nullableString,
        designer:{type:'object',additionalProperties:false,required:['name','name_zh','name_en'],properties:{name:nullableString,name_zh:nullableString,name_en:nullableString}},
        release_date:{type:'object',additionalProperties:false,required:['value','precision'],properties:{value:nullableString,precision:{enum:['day','month','year','unknown',null]}}},
        design_year:nullableString,source_url:sourceUrl,
      }},
      configurations:{type:'array',maxItems:500,items:{type:'object',additionalProperties:false,required:['id','group','name','code','dimensions','asset_ids','option_group_ids','price_state','price','currency','unit','includes'],properties:{
        id:idSchema,group:nullableString,name:nullableString,code:nullableString,
        dimensions:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['id','kind','label','values','unit','note','asset_ids'],properties:{id:idSchema,kind:{enum:['overall','seat','module','package','other']},label:nullableString,values:{type:'object',maxProperties:20,additionalProperties:{anyOf:[{type:'number',exclusiveMinimum:0},{type:'null'}]}},unit:{enum:['mm','cm','m','in',null]},note:nullableString,asset_ids:stringArray}}},
        asset_ids:stringArray,option_group_ids:stringArray,price_state:{enum:['known','quote','unknown','not_applicable']},price:{anyOf:[{type:'number',minimum:0},{type:'null'}]},currency:{enum:['CNY','USD','EUR','GBP',null]},unit:nullableString,includes:nullableString,
      }}},
      option_groups:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,required:['id','type','name','applies_to_configuration_ids','options'],properties:{
        id:idSchema,type:{enum:['material','color','material_color','finish','component','other']},name:nullableString,applies_to_configuration_ids:stringArray,
        options:{type:'array',maxItems:1000,items:{type:'object',additionalProperties:false,required:['id','name','code','material','color','supplier','origin','asset_ids'],properties:{id:idSchema,name:nullableString,code:nullableString,material:nullableString,color:nullableString,supplier:nullableString,origin:nullableString,asset_ids:stringArray}}},
      }}},
      assets:{type:'array',maxItems:2000,items:{type:'object',additionalProperties:false,required:['id','url','media_type','role','sort_order','bindings'],properties:{
        id:idSchema,url:{type:'string',pattern:'^https?://',maxLength:2000},media_type:{enum:['image','pdf','document','model','other']},role:{enum:ASSET_ROLES},sort_order:{type:'integer',minimum:0,maximum:100000},bindings:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['target_type','target_id'],properties:{target_type:{enum:['product','configuration','option_group','option']},target_id:idSchema}}},
      }}},
    }},
    field_status:{type:'object',propertyNames:{pattern:'^/'},additionalProperties:fieldRule,maxProperties:20000},
    evidence:{type:'object',propertyNames:{pattern:'^/'},additionalProperties:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['source_url','source_type','selector','source_path','property','raw_value','asset_id','section','confidence'],properties:{source_url:sourceUrl,source_type:{enum:['json_ld','dom_text','dom_attribute','meta','regex','url_path','image','ocr','legacy','system','unknown']},selector:nullableString,source_path:nullableString,property:nullableString,raw_value:{},asset_id:{anyOf:[idSchema,{type:'null'}]},section:nullableString,confidence:{anyOf:[{type:'number',minimum:0,maximum:1},{type:'null'}]}}}},maxProperties:20000},
    issues:{type:'array',maxItems:5000,items:{$ref:'#/$defs/issue'}},
  },
  $defs:{issue:{type:'object',additionalProperties:false,required:['id','target_type','target_id','path','issue_type','current_value','expected_value','action','evidence_paths','note'],properties:{id:idSchema,target_type:{enum:['product','configuration','option_group','option','asset','relationship']},target_id:{anyOf:[idSchema,{type:'null'}]},path:{type:'string',pattern:'^/',maxLength:1000},issue_type:{enum:['missing','incorrect','misclassified','misbound','extra','ambiguous','order','evidence']},current_value:{},expected_value:{},action:{enum:CORRECTION_ACTIONS},evidence_paths:{type:'array',uniqueItems:true,maxItems:50,items:{type:'string',pattern:'^/',maxLength:1000}},note:{type:'string',maxLength:2000}}}},
};

const ajv=new Ajv({allErrors:true,strict:true,allowUnionTypes:true});
const validateDocument=ajv.compile(PRODUCT_DOCUMENT_V2_SCHEMA);

function clone(value){return JSON.parse(JSON.stringify(value));}
function stableId(prefix,value){return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16)}`;}
function nullText(value){const text=String(value??'').replace(/\s+/g,' ').trim();return text||null;}
function pointerToken(value){return String(value).replace(/~/g,'~0').replace(/\//g,'~1');}
function fieldPath(...parts){return `/${parts.map(pointerToken).join('/')}`;}
function statusEntry(status){return {status:FIELD_STATUSES.includes(status)?status:'extraction_failed'};}
function normalizeEvidence(raw,sourceUrlValue=null){
  const source=raw?.source||raw||{},type=String(source.type||raw?.source_type||'unknown');
  const types={json_ld_product:'json_ld',css_text:'dom_text',css_attr:'dom_attribute',dom_attribute:'dom_attribute',css_background:'dom_attribute',body_regex:'regex',meta:'meta',url_path:'url_path',constant:'system'};
  return {source_url:sourceUrlValue&&isProductUrl(sourceUrlValue)?sourceUrlValue:null,source_type:types[type]||(['image','ocr','legacy','system'].includes(type)?type:'unknown'),selector:nullText(source.selector),source_path:nullText(source.path),property:nullText(source.property||source.attribute),raw_value:raw?.raw_value??raw?.value??null,asset_id:null,section:nullText(raw?.section),confidence:Number.isFinite(Number(raw?.confidence))?Math.max(0,Math.min(1,Number(raw.confidence))):null};
}
function addField(document,path,value,status,evidence=null){document.field_status[path]=statusEntry(status);if(evidence)document.evidence[path]=[normalizeEvidence(evidence,document.data.product.source_url)];return value;}
function emptyDocument(sourceUrlValue=null){return {schema_version:2,data:{product:{names:{primary:null,zh:null,en:null},description:null,model:null,category:null,product_type:null,designer:{name:null,name_zh:null,name_en:null},release_date:{value:null,precision:null},design_year:null,source_url:sourceUrlValue&&isProductUrl(sourceUrlValue)?sourceUrlValue:null},configurations:[],option_groups:[],assets:[]},field_status:{},evidence:{},issues:[]};}
function assertProductDocumentV2(value){const valid=validateDocument(value);if(valid)return value;const error=new Error(`Product Schema v2 校验失败：${(validateDocument.errors||[]).map(item=>`${item.instancePath||'/'} ${item.message}`).join('；')}`);error.code='PRODUCT_SCHEMA_V2_INVALID';error.validation_errors=clone(validateDocument.errors||[]);throw error;}

function fromLegacyPayload(payload){
  const details=payload?.product_details||{},document=emptyDocument(details.source_url||payload?.source_url||null),product=document.data.product;
  product.names.primary=nullText(payload?.name);product.names.zh=product.names.primary;product.description=nullText(payload?.description);product.model=nullText(details.model);product.product_type=nullText(payload?.product_type);
  for(const [path,value] of [['/product/names/primary',product.names.primary],['/product/names/zh',product.names.zh],['/product/description',product.description],['/product/model',product.model],['/product/product_type',product.product_type]])addField(document,path,value,value==null?'source_absent':'provided',{type:'legacy',raw_value:value});
  for(const [index,raw] of (Array.isArray(details.configurations)?details.configurations:[]).entries()){
    const id=nullText(raw.id)||stableId('cfg',`${index}|${raw.code||''}|${raw.name||''}`),dimensionValues={};for(const [key,value] of Object.entries(raw.dimensions||{}))dimensionValues[key]=value==null||value===''?null:Number(value);
    const dimensionId=stableId('dim',`${id}|overall`),hasDimension=Object.values(dimensionValues).some(value=>Number.isFinite(value)&&value>0);
    const configuration={id,group:null,name:nullText(raw.name),code:nullText(raw.code),dimensions:hasDimension?[{id:dimensionId,kind:'overall',label:null,values:dimensionValues,unit:raw.dimension_unit||null,note:nullText(raw.dimension_note),asset_ids:[]}]:[],asset_ids:[],option_group_ids:[],price_state:['known','quote','unknown'].includes(raw.price_state)?raw.price_state:'unknown',price:raw.price_state==='known'&&Number.isFinite(Number(raw.price))?Number(raw.price):null,currency:raw.currency||'CNY',unit:nullText(raw.unit),includes:nullText(raw.includes)};
    document.data.configurations.push(configuration);
    addField(document,fieldPath('configurations',id,'name'),configuration.name,configuration.name?'provided':'source_absent',{type:'legacy',raw_value:configuration.name});
    addField(document,fieldPath('configurations',id,'code'),configuration.code,configuration.code?'provided':'source_absent',{type:'legacy',raw_value:configuration.code});
    addField(document,fieldPath('configurations',id,'dimensions'),configuration.dimensions,hasDimension?'provided':'source_absent',hasDimension?{type:'legacy',raw_value:dimensionValues}:null);
    const urls=[...(raw.image_urls||[]),raw.image_url,raw.drawing_url].filter(Boolean);for(const [assetIndex,url] of [...new Set(urls)].entries()){if(!isProductUrl(url))continue;const role=url===raw.drawing_url?'drawing':'configuration_image',assetId=stableId('asset',url);if(!document.data.assets.some(item=>item.id===assetId))document.data.assets.push({id:assetId,url,media_type:/\.pdf(?:$|[?#])/i.test(url)?'pdf':'image',role,sort_order:document.data.assets.length,bindings:[{target_type:'configuration',target_id:id}]});configuration.asset_ids.push(assetId);}
  }
  return assertProductDocumentV2(document);
}

function toProductDocumentV2(value){if(value?.schema_version===2&&value?.data)return assertProductDocumentV2(clone(value));return fromLegacyPayload(value||{});}

function validateCorrectionIssues(issues){const document=emptyDocument();document.issues=clone(Array.isArray(issues)?issues:[]);const valid=validateDocument(document);if(valid)return document.issues;const errors=(validateDocument.errors||[]).filter(item=>item.instancePath.startsWith('/issues'));if(!errors.length)return document.issues;const error=new Error(`结构化纠错格式不正确：${errors.map(item=>`${item.instancePath} ${item.message}`).join('；')}`);error.code='PRODUCT_CORRECTION_INVALID';throw error;}

module.exports={PRODUCT_SCHEMA_VERSION,FIELD_STATUSES,ASSET_ROLES,CORRECTION_ACTIONS,FIELD_REGISTRY,PRODUCT_DOCUMENT_V2_SCHEMA,emptyDocument,addField,fieldPath,stableId,normalizeEvidence,assertProductDocumentV2,toProductDocumentV2,validateCorrectionIssues};
