'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const cheerio=require('cheerio');
const {
  FIELD_SOURCE_HANDLERS,CANONICAL_FIELD_SOURCE_TYPES,LEGACY_FIELD_SOURCE_TYPES,
  FIELD_SOURCE_ALIASES,normalizeFieldSource,executeFieldSource,resolveFieldRule,
}=require('../services/product-ingestion-field-source-contract');
const {SITE_RULE_SCHEMA,SITE_RULE_SCHEMA_V1_1,SITE_RULE_SCHEMA_V2,validateSiteRule}=require('../services/product-ingestion-site-rule-schema');
const {extractPage}=require('../services/product-ingestion-site-rule-sandbox');
const {field:structuredField}=require('../services/product-ingestion-site-rule-structured');
const {normalizeV2ProposalShape}=require('../services/product-ingestion-site-rule-ai');
const {schemaFor}=require('../services/product-ingestion-ai-context-builder');

const html='<!doctype html><html><head><meta property="og:title" content="META VALUE"><script type="application/ld+json">{"@type":"Product","name":"JSON VALUE"}</script><script id="__NEXT_DATA__" type="application/json">{"product":{"specs":["<p>TECH ONE</p>","TECH TWO"]}}</script></head><body><main><h1 data-model="ATTR VALUE">CSS VALUE</h1><p>Code: REGEX-VALUE.</p><ol><li data-code="A">FIRST</li><li data-code="B">SECOND</li></ol></main></body></html>';
const url='https://example.com/%E4%BA%A7%E5%93%81/source-contract/';
const cases=[
  [{type:'json_ld_product',path:'name'},'JSON VALUE'],
  [{type:'css_text',selector:'h1'},'CSS VALUE'],
  [{type:'css_attr',selector:'h1',attribute:'data-model'},'ATTR VALUE'],
  [{type:'meta',property:'og:title',attribute:'content'},'META VALUE'],
  [{type:'body_regex',pattern:'Code: ([A-Z-]+)',group:1},'REGEX-VALUE'],
  [{type:'url_path'},'/产品/source-contract/'],
  [{type:'constant',value:'CONSTANT VALUE'},'CONSTANT VALUE'],
  [{type:'embedded_json_text',selector:'#__NEXT_DATA__',json_path:'product.specs[*]',strip_html:true,join_with:' '},'TECH ONE TECH TWO'],
  [{type:'indexed_css_text',selector:'ol li'},'FIRST'],
  [{type:'indexed_css_attr',selector:'ol li',attribute:'data-code'},'A'],
];

function context({scoped=false}={}){
  const $=cheerio.load(html),product={name:'JSON VALUE'};
  return {$,root:scoped?$('main'):null,product,bodyText:$('body').text().replace(/\s+/g,' ').trim(),baseUrl:url};
}
function richRule(){return JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','docs','research-artifacts','hc28-site-rule-config-v1.1.json'),'utf8'));}
function fieldSourceEnums(value,found=[]){
  if(!value||typeof value!=='object')return found;
  const candidate=value.properties?.required?.type==='boolean'&&value.properties?.sources?.items?.properties?.type?.enum;
  if(candidate)found.push(candidate);
  for(const child of Array.isArray(value)?value:Object.values(value))fieldSourceEnums(child,found);
  return found;
}

test('rich FieldRule schema source enum is exactly the executable handler registry',()=>{
  const handlers=Object.keys(FIELD_SOURCE_HANDLERS);
  const v11=SITE_RULE_SCHEMA_V1_1.properties.extraction.properties.fields.properties.name.properties.sources.items.properties.type.enum;
  const v2=SITE_RULE_SCHEMA_V2.properties.extraction.properties.fields.properties.name.properties.sources.items.properties.type.enum;
  const legacy=SITE_RULE_SCHEMA.properties.extraction.properties.fields.properties.name.properties.sources.items.properties.type.enum;
  assert.deepEqual(v11,handlers);assert.deepEqual(v2,handlers);assert.deepEqual(CANONICAL_FIELD_SOURCE_TYPES,handlers);
  assert.deepEqual(legacy,LEGACY_FIELD_SOURCE_TYPES);assert.ok(legacy.every(type=>handlers.includes(type)));
  const allRichConsumers=[...fieldSourceEnums(SITE_RULE_SCHEMA_V1_1),...fieldSourceEnums(SITE_RULE_SCHEMA_V2),...['product_fields','configurations','option_groups'].flatMap(task=>fieldSourceEnums(schemaFor(task)))];
  assert.ok(allRichConsumers.length>10);
  for(const sourceEnum of allRichConsumers)assert.deepEqual(sourceEnum,handlers);
});

test('every schema-declared field source executes through the shared contract',()=>{
  for(const [source,expected] of cases){
    assert.equal(executeFieldSource(source,context(),{mode:'base'}),expected,source.type);
    assert.equal(resolveFieldRule({required:false,sources:[source]},context(),{mode:'base'}).value,expected,source.type);
    assert.equal(structuredField({required:false,sources:[source]},context({scoped:true})).value,expected,source.type);
  }
});

test('the base page executor really executes all rich FieldRule source handlers',()=>{
  for(const [source,expected] of cases){
    const config=richRule();config.extraction.fields.name={required:true,sources:[source]};
    const result=extractPage({url,html,status:200,contentType:'text/html'},config);
    assert.equal(result.fields.name,expected,source.type);
    assert.equal(result.field_evidence.name.source_type,source.type,source.type);
  }
});

test('AI aliases terminate at normalization and canonical rule sources remain unchanged',()=>{
  assert.deepEqual(FIELD_SOURCE_ALIASES,{dom_text:'css_text',dom_attr:'css_attr',dom_attribute:'css_attr',json_ld:'json_ld_product'});
  for(const [alias,type] of Object.entries(FIELD_SOURCE_ALIASES))assert.equal(normalizeFieldSource({type:alias,selector:'h1'}).type,type);
  for(const type of CANONICAL_FIELD_SOURCE_TYPES)assert.equal(normalizeFieldSource({type}).type,type);
});

test('shared constant execution does not expand existing Product Schema V2 business permissions',()=>{
  const topLevel=richRule();topLevel.extraction.fields.name={required:true,sources:[{type:'constant',value:'not evidence'}]};
  assert.match(validateSiteRule(topLevel).semantic_errors.join(';'),/不得使用 constant/);
  const structured=richRule();structured.schema_version='site-rule-config-v2';structured.extraction=normalizeV2ProposalShape(structured.extraction);structured.extraction.fields.english_name={required:false,sources:[]};structured.extraction.fields.release_date={required:false,sources:[]};structured.extraction.structured.configurations.fields.group={required:false,sources:[]};structured.extraction.structured.option_groups=[];structured.extraction.structured.configurations.fields.name={required:false,sources:[{type:'constant',value:'not evidence'}]};
  assert.match(validateSiteRule(structured).semantic_errors.join(';'),/Product Schema v2 业务字段不得使用 constant/);
});
