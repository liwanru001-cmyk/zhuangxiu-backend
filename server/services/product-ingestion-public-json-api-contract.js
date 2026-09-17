'use strict';

const RULE_VERSION='public-json-api-rule-v1';
const PATH_PATTERN='^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$';
const NULLABLE_PATH={anyOf:[{type:'string',pattern:PATH_PATTERN,maxLength:300},{type:'null'}]};
const API_RULE_SCHEMA={
  type:'object',additionalProperties:false,required:['schema_version','endpoint_url','method','items_path','total_path','identity_path','pagination','fields','images','configurations','option_groups','evidence_refs'],
  properties:{
    schema_version:{const:RULE_VERSION},endpoint_url:{type:'string',pattern:'^https://',maxLength:2000},method:{const:'GET'},
    items_path:{type:'string',pattern:PATH_PATTERN,maxLength:300},total_path:NULLABLE_PATH,identity_path:{type:'string',pattern:PATH_PATTERN,maxLength:300},
    pagination:{type:'object',additionalProperties:false,required:['mode','page_param','page_size_param','start_page','page_size','max_pages'],properties:{mode:{const:'page_number'},page_param:{type:'string',pattern:'^[A-Za-z_][A-Za-z0-9_]*$',maxLength:80},page_size_param:{type:'string',pattern:'^[A-Za-z_][A-Za-z0-9_]*$',maxLength:80},start_page:{type:'integer',minimum:0,maximum:10},page_size:{type:'integer',minimum:1,maximum:100},max_pages:{type:'integer',minimum:1,maximum:100}}},
    fields:{type:'object',additionalProperties:false,required:['name','description','model','category'],properties:{name:{type:'string',pattern:PATH_PATTERN,maxLength:300},description:NULLABLE_PATH,model:NULLABLE_PATH,category:NULLABLE_PATH}},
    images:{type:'object',additionalProperties:false,required:['paths','max_images'],properties:{paths:{type:'array',minItems:1,maxItems:10,uniqueItems:true,items:{type:'string',pattern:PATH_PATTERN,maxLength:300}},max_images:{type:'integer',minimum:1,maximum:20}}},
    configurations:{type:'object',additionalProperties:false,required:['items_path','name_path','code_path','dimensions_path'],properties:{items_path:NULLABLE_PATH,name_path:NULLABLE_PATH,code_path:NULLABLE_PATH,dimensions_path:NULLABLE_PATH}},
    option_groups:{type:'object',additionalProperties:false,required:['items_path','name_path','options_path','option_name_path','option_code_path'],properties:{items_path:NULLABLE_PATH,name_path:NULLABLE_PATH,options_path:NULLABLE_PATH,option_name_path:NULLABLE_PATH,option_code_path:NULLABLE_PATH}},
    evidence_refs:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',pattern:'^API-[0-9]{3}$'}},
  },
};

module.exports={RULE_VERSION,PATH_PATTERN,API_RULE_SCHEMA};
