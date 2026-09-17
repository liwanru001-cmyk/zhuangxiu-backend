'use strict';

const crypto = require('crypto');
const { normalizeDetails } = require('./product-details');
const {assertProductDocumentV2,FIELD_REGISTRY,ASSET_ROLES}=require('./product-schema-v2');

function fail(message,status=400){const error=new Error(message);error.status=status;throw error;}
function parse(value,fallback=null){if(typeof value!=='string')return value??fallback;try{return JSON.parse(value);}catch(_){return fallback;}}
function hash(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function scalar(value){if(value==null)return '';if(typeof value==='object')return value.name||value.value||'';return value;}
function values(value){return Array.isArray(value)?value:value==null?[]:[value];}
function unique(valuesList){const seen=new Set();return valuesList.filter(item=>{const key=JSON.stringify(item);if(item==null||item===''||seen.has(key))return false;seen.add(key);return true;});}
function configurationImages(configuration){return unique([...(Array.isArray(configuration?.image_urls)?configuration.image_urls:[]),configuration?.image_url].filter(Boolean)).slice(0,5);}
function payloadImages(payload){if(payload?.product_schema_version===2)return unique((payload.product_document?.data?.assets||[]).filter(item=>item.media_type==='image').map(item=>item.url));const result=[];if(payload?.cover_url)result.push(payload.cover_url);for(const configuration of payload?.product_details?.configurations||[])result.push(...configurationImages(configuration));return unique(result);}

function makeField(path,label,current,candidates=[],options={}){
  const selected=options.multiple?(Array.isArray(current)?current:[]):[current];
  const sourceCandidates=unique([...selected,...candidates.map(item=>item.value)]);
  return {path,label,multiple:Boolean(options.multiple),kind:options.kind||'text',options:sourceCandidates.map(value=>{
    const evidence=candidates.find(item=>JSON.stringify(item.value)===JSON.stringify(value));
    return {value,source:evidence?.source||'当前标准数据',source_path:evidence?.source_path||null,confidence:Number(evidence?.confidence??.9),selected:selected.some(item=>JSON.stringify(item)===JSON.stringify(value)),occurrence_count:options.occurrences?.get(String(value))||0};
  })};
}

function buildFields(candidate,occurrences=new Map()){
  const payload=parse(candidate.normalized_payload,{})||{},extracted=parse(candidate.extracted_payload,{})||{},classification=parse(candidate.classification_override)||parse(candidate.classification_suggestion)||{};
  if(payload.product_schema_version===2&&payload.product_document?.schema_version===2)return buildV2Fields(payload.product_document,extracted,occurrences);
  const fields=[];
  const rawImages=unique([...values(extracted.image_urls),...values(extracted.image).flatMap(item=>typeof item==='object'?[item.url,item.contentUrl]:[item]).filter(Boolean)]);
  fields.push(makeField('name','产品名称',payload.name,[{value:scalar(extracted.name),source:'官网结构化数据',source_path:'name',confidence:.92},{value:extracted.title,source:'网页标题',source_path:'title',confidence:.72}]));
  fields.push(makeField('brand','品牌',payload.brand,[{value:scalar(extracted.brand),source:'官网结构化数据',source_path:'brand',confidence:.9}]));
  fields.push(makeField('product_details.model','产品型号',payload.product_details?.model,[...['model','mpn','sku','productID'].map(key=>({value:scalar(extracted[key]),source:`官网 ${key}`,source_path:key,confidence:key==='model'?.92:.82}))]));
  fields.push(makeField('description','产品说明',payload.description,[{value:scalar(extracted.description),source:'官网结构化数据',source_path:'description',confidence:.86}]));
  fields.push(makeField('cover_url','产品主图',payload.cover_url,rawImages.map(value=>({value,source:'官网图片候选',confidence:.76})),{kind:'image',occurrences}));
  fields.push(makeField('product_type','产品分类',payload.product_type,[{value:classification.product_type,source:classification.method==='manual'?'人工判断':'系统分类',confidence:classification.confidence??1}]));
  for(const [index,configuration] of (payload.product_details?.configurations||[]).entries()){
    const prefix=`product_details.configurations[${index}]`,title=`型号 ${index+1}`;
    fields.push(makeField(`${prefix}.name`,`${title} · 名称`,configuration.name,index===0?[{value:scalar(extracted.name),source:'官网商品名称',source_path:'name',confidence:.65}]:[]));
    fields.push(makeField(`${prefix}.code`,`${title} · 编号`,configuration.code,index===0?['sku','mpn','productID'].map(key=>({value:scalar(extracted[key]),source:`官网 ${key}`,source_path:key,confidence:.82})):[]));
    for(const [key,value] of Object.entries(configuration.dimensions||{}))fields.push(makeField(`${prefix}.dimensions.${key}`,`${title} · 尺寸 ${key}`,value));
    for(const [partIndex,part] of (configuration.parts||[]).entries()){
      fields.push(makeField(`${prefix}.parts[${partIndex}].material`,`${title} · ${part.part||'未命名部位'}材质`,part.material));
      fields.push(makeField(`${prefix}.parts[${partIndex}].color`,`${title} · ${part.part||'未命名部位'}颜色`,part.color));
    }
    fields.push(makeField(`${prefix}.image_urls`,`${title} · 产品图片`,configurationImages(configuration),rawImages.map(value=>({value,source:'官网图片候选',confidence:.72})),{multiple:true,kind:'image',occurrences}));
    fields.push(makeField(`${prefix}.price_state`,`${title} · 价格状态`,configuration.price_state));
    fields.push(makeField(`${prefix}.price`,`${title} · 价格`,configuration.price));
    fields.push(makeField(`${prefix}.unit`,`${title} · 单位`,configuration.unit));
  }
  return fields;
}

function registryPath(path){return path.replace(/^\/configurations\/[^/]+/,'/configurations/*').replace(/^\/option_groups\/[^/]+\/options\/[^/]+/,'/option_groups/*/options/*').replace(/^\/option_groups\/[^/]+/,'/option_groups/*').replace(/^\/assets\/[^/]+/,'/assets/*');}
function contractLabel(path){return FIELD_REGISTRY[registryPath(path)]?.label||path;}
function v2Get(document,path){
  const tokens=String(path).split('/').slice(1).map(value=>value.replace(/~1/g,'/').replace(/~0/g,'~'));let node=document.data;
  for(let index=0;index<tokens.length;index+=1){const token=tokens[index];if(Array.isArray(node)){node=node.find(item=>String(item.id)===token);continue;}node=node?.[token];}
  return node;
}
function v2Set(document,path,value){
  const tokens=String(path).split('/').slice(1).map(item=>item.replace(/~1/g,'/').replace(/~0/g,'~'));let node=document.data;
  for(let index=0;index<tokens.length-1;index+=1){const token=tokens[index];node=Array.isArray(node)?node.find(item=>String(item.id)===token):node?.[token];if(node==null)fail(`V2 字段路径不存在：${path}`,409);}
  if(Array.isArray(node))fail(`V2 字段路径不能直接写入数组项：${path}`,409);node[tokens.at(-1)]=value;
}
function buildV2Fields(document,extracted,occurrences){
  const fields=[],sourceFields=extracted.fields||extracted,sourceNames={'/product/names/primary':'name','/product/names/zh':'name','/product/names/en':'english_name','/product/description':'description','/product/model':'model','/product/category':'category','/product/product_type':'product_type','/product/designer/name':'designer','/product/release_date/value':'release_date','/product/design_year':'design_year'},add=path=>{const sourceName=sourceNames[path],candidates=sourceName&&sourceFields[sourceName]!=null?[{value:sourceFields[sourceName],source:'冻结规则的官网证据',confidence:.92}]:[];fields.push(makeField(path,contractLabel(path),v2Get(document,path),candidates,{kind:'text',occurrences}));};
  for(const path of Object.keys(FIELD_REGISTRY).filter(path=>path.startsWith('/product/')))add(path);
  for(const configuration of document.data.configurations)for(const name of ['group','name','code','dimensions','unit'])add(`/configurations/${configuration.id}/${name}`);
  for(const group of document.data.option_groups){add(`/option_groups/${group.id}/name`);for(const option of group.options)for(const name of ['code','material','color','supplier','origin'])add(`/option_groups/${group.id}/options/${option.id}/${name}`);}
  for(const asset of document.data.assets){const path=`/assets/${asset.id}/role`;fields.push(makeField(path,contractLabel(path),asset.role,ASSET_ROLES.map(role=>({value:role,source:role===asset.role?'当前素材语义识别':'人工可选角色',confidence:(role===asset.role ? 0.9 : 1)}))));}
  return fields;
}

function setPath(target,path,value){const parts=path.replace(/\[(\d+)\]/g,'.$1').split('.');let node=target;for(let index=0;index<parts.length-1;index+=1){if(node?.[parts[index]]==null)fail(`字段路径不存在：${path}`,409);node=node[parts[index]];}node[parts[parts.length-1]]=value;}
function getPath(target,path){return String(path||'').replace(/\[(\d+)\]/g,'.$1').split('.').reduce((node,key)=>node==null?undefined:node[key],target);}
function sameValue(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function mappingValue(extracted,sourcePath){return scalar(getPath(extracted,sourcePath));}
function applyFieldMapping(payload,extracted,rule){
  const current=getPath(payload,rule.field_path),next=mappingValue(extracted,rule.source_path);
  if(next==null||next===''||!sameValue(current,rule.when_current_equals)||sameValue(current,next))return false;
  setPath(payload,rule.field_path,next);return true;
}
function removeImageFromPayload(payload,url){let changed=false;if(payload.cover_url===url){payload.cover_url='';changed=true;}for(const configuration of payload.product_details?.configurations||[]){const images=configurationImages(configuration).filter(value=>value!==url);if(images.length!==configurationImages(configuration).length){configuration.image_urls=images;configuration.image_url=images[0]||'';changed=true;}}return changed;}

function createFieldReview(db){
  async function loadCandidate(id){const candidateId=Number(id);if(!Number.isSafeInteger(candidateId)||candidateId<1)fail('候选 ID 不正确');const [rows]=await db.query('SELECT * FROM product_ingestion_candidates WHERE id=?',[candidateId]);if(!rows[0])fail('候选产品不存在',404);return rows[0];}
  async function imageOccurrences(sourceId){const [rows]=await db.query('SELECT normalized_payload FROM product_ingestion_candidates WHERE source_id=?',[sourceId]);const counts=new Map();for(const row of rows)for(const url of payloadImages(parse(row.normalized_payload,{})))counts.set(url,(counts.get(url)||0)+1);return counts;}
  async function resolveMapping(candidate,body){
    const fields=buildFields(candidate),field=fields.find(item=>item.path===String(body.field_path||''));
    if(!field||field.multiple||field.kind==='image')fail('该字段不能批量映射');
    const sourcePath=String(body.source_path||'').trim(),option=field.options.find(item=>item.source_path===sourcePath);
    if(!option)fail('请选择有官网证据来源的字段值');
    return {field_path:field.path,field_label:field.label,source_path:sourcePath,source_label:option.source};
  }
  async function mappingRows(candidate,scope){
    if(scope==='job')return (await db.query(`SELECT id,job_id,source_url,normalized_payload,extracted_payload,generated_fields,published_product_id FROM product_ingestion_candidates WHERE source_id=? AND job_id=?`,[candidate.source_id,candidate.job_id]))[0];
    if(scope==='source')return (await db.query(`SELECT id,job_id,source_url,normalized_payload,extracted_payload,generated_fields,published_product_id FROM product_ingestion_candidates WHERE source_id=?`,[candidate.source_id]))[0];
    fail('批量范围只能是当前任务或当前品牌');
  }
  function mappingMatches(rows,rule){
    const matches=[];
    for(const row of rows){if(row.published_product_id)continue;const payload=parse(row.normalized_payload,{}),extracted=parse(row.extracted_payload,{}),current=getPath(payload,rule.field_path),next=mappingValue(extracted,rule.source_path);if(next==null||next===''||!sameValue(current,rule.when_current_equals)||sameValue(current,next))continue;matches.push({row,payload,extracted,current,next});}
    return matches;
  }
  function completeMappingRule(candidate,rule,rows){
    const anchorPayload=parse(candidate.normalized_payload,{}),anchorExtracted=parse(candidate.extracted_payload,{}),anchorCurrent=getPath(anchorPayload,rule.field_path),anchorNext=mappingValue(anchorExtracted,rule.source_path);
    if(!sameValue(anchorCurrent,anchorNext))return {...rule,when_current_equals:anchorCurrent};
    const counts=new Map();
    for(const row of rows){if(row.published_product_id)continue;const payload=parse(row.normalized_payload,{}),extracted=parse(row.extracted_payload,{}),current=getPath(payload,rule.field_path),next=mappingValue(extracted,rule.source_path);if(current==null||current===''||next==null||next===''||sameValue(current,next))continue;const key=JSON.stringify(current),entry=counts.get(key)||{value:current,count:0};entry.count+=1;counts.set(key,entry);}
    const ranked=[...counts.values()].sort((left,right)=>right.count-left.count);
    if(!ranked.length)fail('当前范围没有需要批量修正的同类旧值',409);
    if(ranked[1]&&ranked[1].count===ranked[0].count)fail('当前范围存在多个同等常见的旧值，请从尚未修正的产品发起批量操作',409);
    return {...rule,when_current_equals:ranked[0].value};
  }
  return {
    async listFields(id){const candidate=await loadCandidate(id),occurrences=await imageOccurrences(candidate.source_id);return {candidate_id:Number(candidate.id),fields:buildFields(candidate,occurrences)};},
    async saveSelections(id,body,actor){
      const candidate=await loadCandidate(id);if(candidate.published_product_id)fail('已发布候选不能修改字段',409);
      if(!Array.isArray(body.selections)||!body.selections.length||body.selections.length>200)fail('请选择需要保存的字段');
      const occurrences=await imageOccurrences(candidate.source_id),fields=buildFields(candidate,occurrences),fieldMap=new Map(fields.map(field=>[field.path,field]));
      const payload=parse(candidate.normalized_payload,{}),changed=[];
      for(const selection of body.selections){const field=fieldMap.get(String(selection.path||''));if(!field)fail(`字段不可修改：${selection.path}`);const chosen=field.multiple?(Array.isArray(selection.value)?unique(selection.value):[]):[selection.value];if(chosen.some(value=>!field.options.some(option=>JSON.stringify(option.value)===JSON.stringify(value))))fail(`字段包含未记录的候选值：${field.label}`);const value=field.multiple?chosen:chosen[0];if(payload.product_schema_version===2){v2Set(payload.product_document,field.path,value);payload.product_document.field_status[field.path]={status:'provided'};}else{setPath(payload,field.path,value);if(field.path.endsWith('.image_urls'))setPath(payload,field.path.replace(/image_urls$/,'image_url'),value[0]||'');}changed.push(field.path);}
      if(payload.product_schema_version===2)assertProductDocumentV2(payload.product_document);else payload.product_details=normalizeDetails(payload.product_details,payload.product_type);
      const generated=parse(candidate.generated_fields,[])||[];generated.push({path:'field_review',rule:'manual_field_selection',fields:changed,updated_by:String(actor).slice(0,80),updated_at:new Date().toISOString()});
      await db.query(`UPDATE product_ingestion_candidates SET normalized_payload=?,generated_fields=?,review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?`,[JSON.stringify(payload),JSON.stringify(generated),candidate.id]);
      return {candidate_id:Number(candidate.id),updated_fields:changed};
    },
    async previewFieldMapping(id,body){
      const candidate=await loadCandidate(id),scope=String(body.scope||'job'),mapping=await resolveMapping(candidate,body),rows=await mappingRows(candidate,scope),rule=completeMappingRule(candidate,mapping,rows),matches=mappingMatches(rows,rule);
      return {source_id:Number(candidate.source_id),job_id:Number(candidate.job_id),scope,field_path:rule.field_path,field_label:rule.field_label,source_path:rule.source_path,source_label:rule.source_label,affected_count:matches.length,examples:matches.slice(0,5).map(item=>({candidate_id:Number(item.row.id),source_url:item.row.source_url,current_value:item.current,new_value:item.next}))};
    },
    async applyFieldMapping(id,body,actor){
      if(body.confirmed!==true)fail('请确认批量修正字段');
      const candidate=await loadCandidate(id);if(candidate.published_product_id)fail('已发布候选不能发起批量字段修正',409);
      const scope=String(body.scope||'job'),mapping=await resolveMapping(candidate,body),rows=await mappingRows(candidate,scope),rule=completeMappingRule(candidate,mapping,rows),matches=mappingMatches(rows,rule),updatedBy=String(actor).slice(0,80);
      for(const match of matches){
        if(!applyFieldMapping(match.payload,match.extracted,rule))continue;
        match.payload.product_details=normalizeDetails(match.payload.product_details,match.payload.product_type);
        const generated=parse(match.row.generated_fields,[])||[];generated.push({path:rule.field_path,rule:'batch_map_from_extracted',source_path:rule.source_path,previous_value:match.current,value:match.next,updated_by:updatedBy,updated_at:new Date().toISOString()});
        await db.query(`UPDATE product_ingestion_candidates SET normalized_payload=?,generated_fields=?,review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=? AND published_product_id IS NULL`,[JSON.stringify(match.payload),JSON.stringify(generated),match.row.id]);
      }
      let savedRule=false;
      if(body.save_rule===true){
        const stored={field_path:rule.field_path,source_path:rule.source_path,when_current_equals:rule.when_current_equals},serialized=JSON.stringify(stored);
        await db.query(`INSERT INTO product_ingestion_field_review_rules (source_id,field_path,rule_type,match_hash,match_value,status,affected_count,created_by) VALUES (?,?,'map_from_extracted',?,?, 'active',?,?) ON DUPLICATE KEY UPDATE status='active',match_value=VALUES(match_value),affected_count=VALUES(affected_count),created_by=VALUES(created_by)`,[candidate.source_id,rule.field_path,hash(serialized),serialized,matches.length,updatedBy]);
        savedRule=true;
      }
      return {source_id:Number(candidate.source_id),job_id:Number(candidate.job_id),scope,field_path:rule.field_path,source_path:rule.source_path,affected_count:matches.length,rule_saved:savedRule};
    },
    async previewImageExclusion(id,body){const candidate=await loadCandidate(id),url=String(body.image_url||'').trim();if(!url)fail('请选择图片');const occurrences=await imageOccurrences(candidate.source_id);return {image_url:url,affected_count:occurrences.get(url)||0,source_id:Number(candidate.source_id)};},
    async excludeImage(id,body,actor){
      if(body.confirmed!==true)fail('请确认批量排除图片');const candidate=await loadCandidate(id),url=String(body.image_url||'').trim();if(!url)fail('请选择图片');
      const [rows]=await db.query('SELECT id,normalized_payload,generated_fields,published_product_id FROM product_ingestion_candidates WHERE source_id=?',[candidate.source_id]);let affected=0;
      for(const row of rows){if(row.published_product_id)continue;const payload=parse(row.normalized_payload,{});if(!removeImageFromPayload(payload,url))continue;payload.product_details=normalizeDetails(payload.product_details,payload.product_type);const generated=parse(row.generated_fields,[])||[];generated.push({path:'images',rule:'exclude_repeated_image',value:url,updated_by:String(actor).slice(0,80)});await db.query(`UPDATE product_ingestion_candidates SET normalized_payload=?,generated_fields=?,review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?`,[JSON.stringify(payload),JSON.stringify(generated),row.id]);affected+=1;}
      await db.query(`INSERT INTO product_ingestion_field_review_rules (source_id,field_path,rule_type,match_hash,match_value,status,affected_count,created_by) VALUES (?,'images','exclude_exact',?,?, 'active',?,?) ON DUPLICATE KEY UPDATE status='active',affected_count=VALUES(affected_count),created_by=VALUES(created_by)`,[candidate.source_id,hash(url),JSON.stringify(url),affected,String(actor).slice(0,80)]);
      return {image_url:url,affected_count:affected};
    },
    async applyRules(sourceId,payload,extracted={}){const [rows]=await db.query(`SELECT field_path,rule_type,match_value FROM product_ingestion_field_review_rules WHERE source_id=? AND status='active'`,[sourceId]);for(const row of rows){if(row.rule_type==='exclude_exact'&&row.field_path==='images')removeImageFromPayload(payload,parse(row.match_value,''));else if(row.rule_type==='map_from_extracted')applyFieldMapping(payload,extracted,parse(row.match_value,{}));}return payload;},
  };
}

module.exports={createFieldReview,buildFields,payloadImages,removeImageFromPayload,getPath,applyFieldMapping};
