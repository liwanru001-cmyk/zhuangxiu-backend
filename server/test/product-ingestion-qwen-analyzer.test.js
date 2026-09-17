'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeWebsite,validateProfile,SITE_PROFILE_SCHEMA}=require('../services/product-ingestion-qwen-analyzer');

function profile(overrides={}){
  return {
    schema_version:1,
    analyzer:'qwen_site_profile_v1',
    site_summary:'家具产品页',
    default_product_type:'furniture',
    confidence:.95,
    classification_keywords:['沙发'],
    name_sources:['h1'],
    description_sources:[],
    field_mapping:{model:['编码'],material:['产品描述'],color:[],width:[],depth:[],height:[],length:[],diameter:[]},
    image_prefer_tokens:['/uploads/'],
    image_exclude_tokens:['/assets/img/'],
    image_region_rules:{primary_container_tokens:['product-gallery'],supporting_container_tokens:['product-detail'],excluded_container_tokens:['recommendations']},
    evidence:['页面分类为沙发'],
    ...overrides,
  };
}
function completion(content){return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}),{status:200,headers:{'Content-Type':'application/json'}});}
const env={INGESTION_AI_API_KEY:'test-key',INGESTION_AI_MODEL:'qwen3.8-max',INGESTION_AI_BASE_URL:'https://example.invalid/compatible-mode/v1'};

test('唯一 Schema 要求产品分类是单个字符串',()=>{
  const invalid=profile({default_product_type:['furniture']});
  assert.throws(()=>validateProfile(invalid),error=>error.code==='INGESTION_AI_SCHEMA_INVALID'&&/must be string/.test(error.message));
  const valid=profile();
  assert.equal(validateProfile(valid),valid,'校验器应原样返回输入对象，不修正内容');
  assert.deepEqual(SITE_PROFILE_SCHEMA.properties.default_product_type.enum,['furniture','curtains','rugs','artwork','accessories']);
});

test('低置信度与格式错误使用不同错误码',()=>{
  assert.throws(()=>validateProfile(profile({confidence:.45})),error=>error.code==='INGESTION_AI_LOW_CONFIDENCE'&&/0.45/.test(error.message));
});

test('图片 URL 片段与容器 token 不能混填',()=>{
  assert.throws(()=>validateProfile(profile({image_prefer_tokens:['product-gallery']})),error=>error.code==='INGESTION_AI_SCHEMA_INVALID'&&/pattern/.test(error.message));
  assert.throws(()=>validateProfile(profile({image_exclude_tokens:['/']})),error=>error.code==='INGESTION_AI_SCHEMA_INVALID'&&/must NOT have fewer than 3 characters/.test(error.message));
  assert.throws(()=>validateProfile(profile({image_exclude_tokens:['/assets/','/assets/']})),error=>error.code==='INGESTION_AI_SCHEMA_INVALID'&&/不能包含重复值/.test(error.message));
  assert.throws(()=>validateProfile(profile({image_region_rules:{primary_container_tokens:['.product gallery'],supporting_container_tokens:[],excluded_container_tokens:[]}})),error=>error.code==='INGESTION_AI_SCHEMA_INVALID'&&/pattern/.test(error.message));
});

test('格式不合格时携带校验错误重试一次',async()=>{
  const requests=[];
  const fetchImpl=async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return requests.length===1?completion(profile({default_product_type:['furniture']})):completion(profile());
  };
  const result=await analyzeWebsite({brandName:'HC28',baseUrl:'https://example.com',pageUrl:'https://example.com/p/1',html:'<h1>沙发</h1>',fetchImpl,env});
  assert.equal(result.default_product_type,'furniture');
  assert.equal(requests.length,2);
  assert.equal(requests[0].response_format.type,'json_schema');
  assert.equal(requests[0].response_format.json_schema.strict,true);
  assert.deepEqual(requests[0].response_format.json_schema.schema,SITE_PROFILE_SCHEMA);
  assert.equal('max_tokens' in requests[0],false);
  assert.match(requests[1].messages.at(-1).content,/must be string/);
});

test('内容低置信度不进行格式重试',async()=>{
  let requests=0;
  await assert.rejects(analyzeWebsite({brandName:'未知品牌',baseUrl:'https://example.com',pageUrl:'https://example.com/p/1',html:'<h1>未知产品</h1>',fetchImpl:async()=>{requests+=1;return completion(profile({confidence:.3}));},env}),error=>error.code==='INGESTION_AI_LOW_CONFIDENCE');
  assert.equal(requests,1);
});
