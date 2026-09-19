'use strict';

const crypto=require('crypto');
const cheerio=require('cheerio');
const {emptyDocument,addField,fieldPath,stableId:documentStableId,assertProductDocumentV2}=require('./product-schema-v2');
const {executeFieldSource,resolveFieldRule,embeddedJsonValues}=require('./product-ingestion-field-source-contract');

function clean(value,max=2000){return String(value??'').replace(/\s+/g,' ').trim().slice(0,max);}
function unique(values){return [...new Set(values.filter(Boolean))];}
function canonicalUrl(raw,base){const text=String(raw??'').trim();if(!text)return '';try{const value=new URL(text,base);if(!['http:','https:'].includes(value.protocol))return '';value.hash='';return value.toString();}catch{return '';}}
function bestSrcset(value){return String(value||'').split(',').map(item=>{const [url,size='']=item.trim().split(/\s+/,2);return {url,size:Number.parseFloat(size)||0};}).filter(item=>item.url).sort((a,b)=>b.size-a.size)[0]?.url||'';}
function safeFind(root,selector){try{return root.find(selector);}catch{return root.find('__invalid_selector__');}}
function jsonLdProduct($){let result={};$('script[type="application/ld+json"]').each((_,node)=>{if(Object.keys(result).length)return;try{const walk=value=>{if(!value||typeof value!=='object'||Object.keys(result).length)return;const types=Array.isArray(value['@type'])?value['@type']:[value['@type']];if(types.some(type=>String(type).toLowerCase()==='product')){result=value;return;}for(const child of Array.isArray(value)?value:Object.values(value))walk(child);};walk(JSON.parse($(node).html()||'null'));}catch{}});return result;}

function sourceValue(source,context){return executeFieldSource(source,context,{mode:'structured',maxLength:2000});}
function field(rule,context){return resolveFieldRule(rule,context,{mode:'structured',maxLength:2000});}
function imageValues(source,context){
  const {$,root,product,baseUrl}=context,values=[];
  if(source.type==='json_ld_product')values.push(...(Array.isArray(product.image)?product.image:[product.image]).map(value=>typeof value==='object'?value.url||value.contentUrl:value));
  else if(source.type==='meta')values.push($(`meta[property="${source.property}"],meta[name="${source.property}"]`).first().attr('content'));
  else if(source.type==='dom_attribute')safeFind(root,source.selector).each((_,node)=>{const raw=$(node).attr(source.attribute);values.push(/srcset$/i.test(source.attribute)?bestSrcset(raw):raw);});
  else if(source.type==='css_background')safeFind(root,source.selector).each((_,node)=>{const style=$(node).attr('style')||'';for(const match of style.matchAll(/background(?:-image)?\s*:[^;]*url\((['"]?)(.*?)\1\)/gi))values.push(match[2]);});
  else if(source.type==='embedded_json')values.push(...embeddedJsonValues(source,context));
  return unique(values.map(value=>canonicalUrl(value,baseUrl)));
}
function assetsFromSources(sources,context,allowedHosts,excluded=[]){
  const seen=new Set(),assets=[];
  for(const source of sources||[])for(const url of imageValues(source,context)){
    let host='';try{host=new URL(url).hostname.toLowerCase();}catch{}
    if(!allowedHosts.has(host)||excluded.some(token=>url.toLowerCase().includes(token))||seen.has(url))continue;
    seen.add(url);assets.push({url,role:source.role||'unknown',source_type:source.type,source});
  }
  return assets;
}
function productAssetRole(role){return ({main:'hero',angle:'product_gallery',swatch:'material_swatch'})[role]||role||'unknown';}
function assetMediaType(url,role){
  let extension='';try{extension=new URL(url).pathname.split('.').pop().toLowerCase();}catch{}
  if(extension==='pdf')return 'pdf';
  if(['3dm','fbx','max','skp','dwg','dxf','zip'].includes(extension))return 'model';
  if(['doc','docx','xls','xlsx','ppt','pptx','txt','rtf'].includes(extension)||['catalog','technical_document','certificate'].includes(productAssetRole(role)))return 'document';
  if(['jpg','jpeg','png','webp','gif','avif','svg','bmp','tif','tiff'].includes(extension))return 'image';
  return ['hero','product_gallery','scene','detail','configuration_image','dimension_diagram','material_swatch','decorative'].includes(productAssetRole(role))?'image':'other';
}
function businessPresence(bodyText,fieldName){
  const patterns={english_name:/(?:英文名|english\s+name)\s*[:：]\s*[A-Za-z]/i,description:/设计主题|产品说明|product\s+description|design\s+concept/i,model:/(?:型号|货号|sku|model)\s*[:：]\s*[A-Za-z0-9]/i,category:/(?:分类|category)\s*[:：]\s*\S+/i,designer:/(?:设计师|designer)\s*[:：]\s*\S+|(?:19|20)\d{2}\s*年\s+由.{1,100}设计|designed\s+by\s+\S+/i,design_year:/(?:设计年份|design\s+year)\s*[:：]?\s*(?:19|20)\d{2}/i,release_date:/(?:发布日期|发布日|release\s+date|published)\s*[:：]?\s*(?:19|20)\d{2}/i,material:/(?:材质|面料|皮革|饰面|material|fabric|leather|finish)\s*[:：]\s*\S+/i,dimensions:/(?:尺寸|dimension|measurement|\bsize\b)[^\d]{0,30}\d+(?:\.\d+)?\s*(?:mm|cm|m|毫米|厘米)?\s*[×xX*]/i,configurations:/(?:产品)?(?:款型|款式|组合方式)|configuration\s+(?:options?|variants?)|product\s+variants?/i,option_groups:/(?:色彩|颜色|色卡|面料|皮革|材质|饰面)(?:选择|选项|可选)|(?:colour|color|fabric|leather|material|finish)\s+(?:options?|choices?|swatches?)/i};
  return Boolean(patterns[fieldName]?.test(String(bodyText||'')));
}
function documentStatus(result,present=false){if(result?.value!=null&&result.value!=='')return 'provided';return present?'extraction_failed':'source_absent';}
function explicitSemanticValue(bodyText,name){
  const text=String(bodyText||''),patterns={designer:[/(?:设计师|设计者)\s*[:：]\s*([^\n|]{1,120}?)(?=\s{2,}|发布日期|发布日|$)/i,/(?:19|20)\d{2}\s*年\s+由\s*(.{1,120}?)\s*设计/i,/designed\s+by\s+([^\n|]{1,120})/i],release_date:[/(?:发布日期|发布日|release\s+date|published)\s*[:：]?\s*((?:19|20)\d{2}(?:[.\-/年]\d{1,2})?(?:[.\-/月]\d{1,2})?)/i],design_year:[/((?:19|20)\d{2})\s*年\s+由.{1,120}?设计/i],model:[/(?:型号|货号|sku|model)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,119})/i]};
  for(const pattern of patterns[name]||[]){const value=clean(pattern.exec(text)?.[1],500);if(value)return {value,evidence:{type:'regex',pattern:pattern.source,raw_value:value,confidence:.9}};}return null;
}
function typeForOption(value){const text=String(value||'').toLowerCase();if(/material.*color|材质.*颜色|面料|皮革/.test(text))return 'material_color';if(/material|材质/.test(text))return 'material';if(/colou?r|色彩|颜色|色卡/.test(text))return 'color';if(/finish|饰面/.test(text))return 'finish';if(/component|部件|组件/.test(text))return 'component';return 'other';}
function parseDimensions(raw,format,defaultUnit){
  const text=clean(raw,500),unit=/(?:cm)\b|厘米/i.test(text)?'cm':/(?:mm)\b|毫米/i.test(text)?'mm':defaultUnit;
  // Technical sheets often print metric and imperial values together, for
  // example `300cm/118,11'' x 120cm/47,24'' H 74cm/29,13''`. Once a metric
  // unit is present, the slash value is an alternate representation, not the
  // next dimension.
  const metricText=/(?:cm|mm)\b/i.test(text)
    ? text.replace(/(\d+(?:[.,]\d+)?\s*(?:cm|mm))\s*\/\s*\d+(?:[.,]\d+)?\s*[’'”"]{1,2}/gi,'$1')
    : text;
  const numbers=[...metricText.matchAll(/\d+(?:[.,]\d+)?/g)].map(match=>Number(match[0].replace(',','.'))).filter(value=>value>0);
  const named={};
  const aliases={width:/\b(?:w|width)\b|宽(?:度)?/i,depth:/\b(?:d|depth|length|l)\b|深(?:度)?|长(?:度)?/i,height:/\b(?:h|height)\b|高(?:度)?/i,diameter:/ø|\b(?:dia|diameter)\b|直径/i};
  for(const [name,label] of Object.entries(aliases)){
    const before=metricText.match(new RegExp(`(${label.source})\\s*[:=：]?\\s*(\\d+(?:[.,]\\d+)?)`,label.flags));
    const after=metricText.match(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:mm|cm|毫米|厘米)?\\s*(${label.source})`,label.flags));
    const value=Number(String(before?.[2]||after?.[1]||'').replace(',','.'));if(value>0)named[name]=value;
  }
  if(!named.diameter&&!/[×xX*]/.test(metricText)&&/^\s*(?:D|Ø)\s*\d/i.test(metricText)&&/\bH\s*\d/i.test(metricText))named.diameter=numbers[0];
  let shape='box',dimensions={width:null,depth:null,height:null};
  const resolved=format==='auto'?(named.diameter?'diameter_height':numbers.length===2?'width_height':'width_depth_height'):format;
  if(resolved==='diameter_height'){shape='round';dimensions={diameter:named.diameter||numbers[0]||null,height:named.height||numbers[1]||null};}
  else if(resolved==='width_height')dimensions={width:named.width||numbers[0]||null,depth:null,height:named.height||numbers[1]||null};
  else dimensions={width:named.width||numbers[0]||null,depth:named.depth||numbers[1]||null,height:named.height||numbers[2]||null};
  return {raw:text,shape,dimensions,dimension_unit:unit,status:Object.values(dimensions).some(value=>value!=null)?'provided':'evidence_insufficient'};
}
function stableId(code,name,index){return `cfg-${crypto.createHash('sha256').update(code||name||String(index)).digest('hex').slice(0,16)}`;}
function alphabeticLabel(index){let value=Math.max(0,Number(index)||0),label='';do{label=String.fromCharCode(65+(value%26))+label;value=Math.floor(value/26)-1;}while(value>=0);return `规格 ${label}`;}
function productDimensionConfigurations(productAssets,ocrEvidence,configurationRule){
  const configurations=[],assessments=[];
  for(const asset of productAssets.filter(item=>item.role==='dimension_diagram')){
    const evidence=ocrEvidence?.[asset.url];if(!evidence)continue;
    const interpretation=evidence.configuration_interpretation||'ambiguous_views_or_options',proof=evidence.configuration_proof||'none',confidence=Number(evidence.confidence||0),rawOptions=Array.isArray(evidence.configuration_options)?evidence.configuration_options:[];
    const candidates=rawOptions.map((option,index)=>({option,index,parsed:parseDimensions(option.dimensions,configurationRule.dimensions.format,configurationRule.dimensions.default_unit)})).filter(item=>item.parsed.status==='provided'&&Number(item.option.confidence||0)>=.9&&clean(item.option.evidence_text,500));
    const fingerprints=new Set(candidates.map(item=>JSON.stringify({shape:item.parsed.shape,dimensions:item.parsed.dimensions,unit:item.parsed.dimension_unit})));
    const multiple=interpretation==='multiple_explicit_options'&&proof!=='none'&&confidence>=.9&&candidates.length>=2&&fingerprints.size===candidates.length;
    const single=interpretation==='single_explicit_option'&&proof!=='none'&&confidence>=.9&&candidates.length===1;
    assessments.push({url:asset.url,interpretation,proof,confidence,auto_generated:multiple||single,option_count:candidates.length,response_id:evidence.response_id||null,prompt_version:evidence.prompt_version||null});
    if(!multiple&&!single)continue;
    for(const {option,index,parsed} of candidates){
      const officialName=clean(option.label,200),name=officialName||alphabeticLabel(configurations.length),generatedIdentity=!officialName,id=stableId('',`${asset.url}|${name}|${option.dimensions}`,index);
      configurations.push({id,group:null,name,code:null,shape:parsed.shape,dimensions:parsed.dimensions,dimension_unit:parsed.dimension_unit,dimension_note:parsed.raw,parts:[],material_options:[],image_urls:[],image_url:null,drawing_url:null,drawing_name:null,unit:null,price_state:'unknown',currency:null,price:null,includes:null,dimension_status:'provided',dimension_presence:true,dimension_format:configurationRule.dimensions.format,evidence:{group:{value:null,status:'source_absent'},name:{value:name,status:generatedIdentity?'inferred':'provided',evidence:generatedIdentity?{type:'system',raw_value:name,section:'generated_configuration_identity',confidence:1}:{type:'ocr',raw_value:officialName,section:clean(option.evidence_text,500),confidence:Number(option.confidence)}},code:{value:null,status:'source_absent'},includes:{value:null,status:'source_absent'},price:{value:null,status:'source_absent'},dimensions:{value:option.dimensions,status:'provided',evidence:{type:'ocr',raw_value:option.dimensions,section:clean(option.evidence_text,500),confidence:Number(option.confidence)}}},asset_relations:[asset],ocr:{attempted:true,selected_images:[asset.url],results:[{url:asset.url,...evidence}],missing_reason:null},generated_identity:generatedIdentity});
    }
  }
  return {configurations,assessments};
}
function extractParts(rule,context){
  if(rule.mode==='none')return [];
  const roots=rule.mode==='repeated'?[...safeFind(context.root,rule.item_selector).toArray()].map(node=>context.$(node)):[context.root];
  return roots.slice(0,20).map(root=>{
    const nested={...context,root,bodyText:clean(root.text(),10000)};
    const part=field(rule.part,nested),material=field(rule.material,nested),color=field(rule.color,nested),code=field(rule.code,nested);
    const swatch=rule.swatch?assetsFromSources([rule.swatch],nested,new Set(context.allowedHosts),[])[0]?.url||'':'';
    return {part:part.value||null,material:material.value||null,color:color.value||null,code:code.value||null,swatch_url:swatch||null,evidence:{part,material,color,code}};
  });
}
function applyOcr(configuration,assets,ocrRule,ocrEvidence){
  if(!ocrRule.enabled)return {attempted:false,results:[],missing_reason:'rule_not_configured'};
  const selected=assets.filter(asset=>ocrRule.roles.includes(asset.role)).slice(0,ocrRule.max_images),results=[];
  for(const asset of selected){const evidence=ocrEvidence?.[asset.url];if(!evidence)continue;results.push({url:asset.url,...evidence});if(ocrRule.outputs.includes('dimensions')&&configuration.dimension_status!=='provided'&&evidence.dimensions){const parsed=parseDimensions(evidence.dimensions,configuration.dimension_format,configuration.dimension_unit);configuration.dimensions=parsed.dimensions;configuration.shape=parsed.shape;configuration.dimension_unit=parsed.dimension_unit;configuration.dimension_note=parsed.raw;configuration.dimension_status=parsed.status;}}
  return {attempted:Boolean(selected.length),selected_images:selected.map(item=>item.url),results,missing_reason:selected.length&&!results.length?'ocr_not_executed':selected.length?null:'source_absent'};
}

function extractStructuredPage(page,config,baseRow={},options={}){
  const $=cheerio.load(page.html||''),product=jsonLdProduct($),root=$.root(),baseContext={$,root,product,bodyText:clean($('body').text(),200000),baseUrl:page.url,allowedHosts:config.scope.allowed_asset_hosts};
  const structured=config.extraction.structured,configurationRule=structured.configurations,allowedHosts=new Set(config.scope.allowed_asset_hosts),excluded=config.extraction.images.exclude_tokens.map(value=>value.toLowerCase());
  let furnitureType=structured.furniture_type,furnitureTypeEvidence={status:'constant_fallback',value:furnitureType};
  if(structured.furniture_type_rule){const observed=field(structured.furniture_type_rule.source,baseContext),haystack=String(observed.value||'').toLowerCase();for(const [candidate,tokens] of Object.entries(structured.furniture_type_rule.keywords)){if(tokens.some(token=>haystack.includes(String(token).toLowerCase()))){furnitureType=candidate;furnitureTypeEvidence={...observed,matched_type:candidate};break;}}}
  const v2=config.schema_version==='site-rule-config-v2';
  let heroSeen=false;
  const productAssets=assetsFromSources(config.extraction.images.sources,baseContext,allowedHosts,excluded).slice(0,config.extraction.images.max_images).map(item=>{
    const requestedRole=productAssetRole(item.role),role=requestedRole==='hero'&&heroSeen?'product_gallery':requestedRole;
    if(requestedRole==='hero'&&!heroSeen)heroSeen=true;
    return {...item,role,normalized_from_role:role!==requestedRole?requestedRole:null};
  });
  const itemRoots=configurationRule.mode==='none'?[]:configurationRule.mode==='repeated'?[...safeFind(root,configurationRule.item_selector).toArray()].map(node=>$(node)):[root];
  let configurations=itemRoots.slice(0,configurationRule.max_items).map((itemRoot,index)=>{
    const context={...baseContext,root:itemRoot,index,bodyText:clean(itemRoot.text(),20000)};
    const group=field(configurationRule.fields.group,context),name=field(configurationRule.fields.name,context),code=field(configurationRule.fields.code,context),includes=field(configurationRule.fields.includes,context),price=field(configurationRule.fields.price,context),dimensionField=field(configurationRule.dimensions.source,context);
    const parsed=parseDimensions(dimensionField.value,configurationRule.dimensions.format,configurationRule.dimensions.default_unit);
    const localAssets=assetsFromSources(configurationRule.images,context,allowedHosts,excluded).map(item=>({...item,role:productAssetRole(item.role)}));
    const fallbackRoles=v2?['hero','product_gallery','scene','detail']:['main','angle','scene','detail'];
    const bound=unique([...localAssets.map(item=>item.url),...productAssets.filter(item=>fallbackRoles.includes(item.role)).map(item=>item.url)]).slice(0,5);
    const value={id:stableId(code.value,name.value,index),group:group.value||null,name:name.value||null,code:code.value||null,shape:parsed.shape,dimensions:parsed.dimensions,dimension_unit:parsed.dimension_unit,dimension_note:parsed.raw||null,parts:extractParts(configurationRule.parts,context),material_options:[],image_urls:bound,image_url:bound[0]||null,drawing_url:null,drawing_name:null,unit:v2?null:'件',price_state:price.value?'known':'unknown',currency:price.value?'CNY':null,price:price.value?Number(String(price.value).replace(/[^\d.]/g,''))||null:null,includes:includes.value||null,dimension_status:parsed.status,dimension_presence:businessPresence(context.bodyText,'dimensions'),dimension_format:configurationRule.dimensions.format,evidence:{group,name,code,includes,price,dimensions:dimensionField},asset_relations:localAssets};
    if(!v2&&!value.parts.length)value.parts=[{part:'',material:'',color:'',code:'',swatch_url:'',evidence:{material:{status:'rule_not_configured'},color:{status:'rule_not_configured'}}}];
    value.ocr=applyOcr(value,localAssets,structured.ocr,options.ocrEvidence||{});
    return value;
  });
  let dimensionConfigurationAssessment=[];
  if(v2&&!configurations.length){const generated=productDimensionConfigurations(productAssets,options.ocrEvidence||{},configurationRule);configurations=generated.configurations.slice(0,configurationRule.max_items||generated.configurations.length);dimensionConfigurationAssessment=generated.assessments;}
  if(v2&&configurationRule.mode==='single'&&!businessPresence(baseContext.bodyText,'configurations'))configurations=configurations.filter(item=>item.name||item.code||item.group||item.includes||item.price!=null||item.dimension_status==='provided'||item.asset_relations.length);
  const optionGroups=[];
  for(const [ruleIndex,groupRule] of (structured.option_groups||[]).entries()){
    if(groupRule.mode==='none')continue;
    const groupRoots=groupRule.mode==='repeated'?[...safeFind(root,groupRule.item_selector).toArray()].map(node=>$(node)):[root];
    for(const [groupIndex,groupRoot] of groupRoots.slice(0,groupRule.max_items).entries()){
      const groupContext={...baseContext,root:groupRoot,bodyText:clean(groupRoot.text(),30000)},name=field(groupRule.fields.name,groupContext),type=field(groupRule.fields.type,groupContext),optionRule=groupRule.options;
      const optionRoots=optionRule.mode==='repeated'?[...safeFind(groupRoot,optionRule.item_selector).toArray()].map(node=>$(node)):[groupRoot],items=[];
      for(const [optionIndex,optionRoot] of optionRoots.slice(0,optionRule.max_items).entries()){
        const optionContext={...groupContext,root:optionRoot,index:optionIndex,bodyText:clean(optionRoot.text(),5000)},values={};for(const fieldName of ['name','code','material','color','supplier','origin'])values[fieldName]=field(optionRule.fields[fieldName],optionContext);
        const swatch=optionRule.swatch?assetsFromSources([optionRule.swatch],optionContext,allowedHosts,excluded)[0]:null,applies=field(optionRule.applies_to_configuration_code,optionContext),identity=values.code.value||values.name.value||`${ruleIndex}-${groupIndex}-${optionIndex}`,id=stableId(identity,values.name.value,optionIndex);
        items.push({id,name:values.name.value||null,code:values.code.value||null,material:values.material.value||null,color:values.color.value||null,supplier:values.supplier.value||null,origin:values.origin.value||null,swatch:swatch?{...swatch,role:'material_swatch'}:null,applies_to_configuration_code:applies.value||null,evidence:{...values,applies_to_configuration_code:applies}});
      }
      const identity=name.value||`${ruleIndex}-${groupIndex}`;optionGroups.push({id:stableId(identity,type.value,groupIndex),name:name.value||null,type:typeForOption(type.value||name.value),items,evidence:{name,type}});
    }
  }
  if(v2&&!optionGroups.some(group=>group.items.length)){
    const swatchSources=(config.extraction.images.sources||[]).filter(source=>productAssetRole(source.role)==='material_swatch');
    for(const [sourceIndex,source] of swatchSources.entries()){
      const items=[];safeFind(root,source.selector).slice(0,200).each((optionIndex,node)=>{const raw=$(node).attr(source.attribute),url=canonicalUrl(/srcset$/i.test(source.attribute)?bestSrcset(raw):raw,page.url);if(!url||!allowedHosts.has(new URL(url).hostname.toLowerCase())||items.some(item=>item.swatch?.url===url))return;const container=$(node).closest('figure,li,article,[class*="item"],div').first(),label=clean($(node).attr('alt')||$(node).attr('title')||container.text(),300)||null,code=label?.match(/\b[A-Z]{1,8}[-_ ]?\d{1,8}[A-Z0-9_-]*\b/i)?.[0]||null,id=stableId(code||url,label,optionIndex);items.push({id,name:label,code,material:null,color:null,supplier:null,origin:null,swatch:{url,role:'material_swatch',source_type:source.type,source},applies_to_configuration_code:null,evidence:{name:label?{value:label,status:'provided',evidence:{source_type:'dom_attribute',source:{type:'dom_attribute',selector:source.selector,attribute:'alt'}}}:{value:null,status:'source_absent'},code:code?{value:code,status:'provided',evidence:{source_type:'dom_text',source:{type:'css_text',selector:source.selector}}}:{value:null,status:'source_absent'}}});});
      if(items.length)optionGroups.push({id:stableId('material-swatch-group',source.selector,sourceIndex),name:null,type:'material_color',items,evidence:{name:{value:null,status:'source_absent'},type:{value:'material_color',status:'provided',evidence:{source_type:'image',source}}}});
    }
  }
  const links=[];
  for(const source of config.extraction.attachments.link_sources||[]){const values=source.type==='embedded_json'?embeddedJsonValues(source,baseContext):safeFind(root,source.selector).map((_,node)=>$(node).attr(source.attribute)).get();for(const value of values){const url=canonicalUrl(value,page.url);if(!url)continue;const extension=new URL(url).pathname.split('.').pop().toLowerCase();if(config.extraction.attachments.allowed_extensions.includes(extension))links.push({url,kind:source.kind||'other'});}}
  const drawings=unique(links.filter(item=>item.kind==='drawing'||(item.kind==='technical'&&!/\.(?:pdf|zip)(?:$|[?#])/i.test(item.url))).map(item=>item.url));
  if(drawings[0]&&configurations[0]){configurations[0].drawing_url=drawings[0];configurations[0].drawing_name=new URL(drawings[0]).pathname.split('/').pop();}
  const top5Roles=new Set((config.extraction.images.top5_roles||[]).map(productAssetRole));
  const top5=productAssets.filter(asset=>top5Roles.has(asset.role)).slice(0,5).map((asset,index)=>({...asset,top5_rank:index+1}));
  const fieldStatus={};for(const [name,value] of Object.entries(baseRow.field_evidence||{}))fieldStatus[name]={status:baseRow.fields?.[name]?'provided':config.extraction.fields[name]?'source_absent':'rule_not_configured',evidence:value};
  const coverage={
    fields:fieldStatus,configurations:{expected:itemRoots.length,extracted:configurations.length,status:configurationRule.mode==='none'?'source_absent':itemRoots.length===configurations.length&&configurations.length?'provided':'extraction_failed'},
    dimensions:{provided:configurations.filter(item=>item.dimension_status==='provided').length,total:configurations.length},
    materials:{provided:optionGroups.reduce((count,group)=>count+group.items.filter(item=>item.material||item.color).length,0),total:optionGroups.reduce((count,group)=>count+group.items.length,0)},
    images:{all:productAssets.length,top5:top5.length,bound_configurations:configurations.filter(item=>item.image_urls.length).length},attachments:{provided:links.length,status:links.length?'provided':'source_absent'},
  };
  const result={schema_version:v2?'site-rule-extraction-result-v2':'site-rule-extraction-result-v1.1',furniture_type:furnitureType,furniture_type_evidence:furnitureTypeEvidence,configurations,option_groups:optionGroups,assets:productAssets,top5,attachments:unique(links.map(item=>JSON.stringify(item))).map(value=>JSON.parse(value)),customization:structured.customization,dimension_configuration_assessment:dimensionConfigurationAssessment,coverage};
  if(v2)result.product_document=buildProductDocumentV2(page,config,baseRow,result);
  return result;
}

function buildProductDocumentV2(page,config,baseRow,structured){
  const document=emptyDocument(page.url),product=document.data.product,fields={...(baseRow.fields||{})},evidence={...(baseRow.field_evidence||{})},bodyText=clean(cheerio.load(page.html||'')('body').text(),200000);
  for(const name of ['designer','release_date','design_year','model'])if(!fields[name]){const fallback=explicitSemanticValue(bodyText,name);if(fallback){fields[name]=fallback.value;evidence[name]=fallback.evidence;}}
  product.names.primary=fields.name||null;product.names.zh=/[\u3400-\u9fff]/u.test(fields.name||'')?fields.name:null;product.names.en=fields.english_name||(!product.names.zh?fields.name:null);product.description=fields.description||null;product.technical_specifications=fields.technical_specifications||null;product.model=fields.model||null;product.category=fields.category||null;product.designer.name=fields.designer||null;product.designer.name_zh=/[\u3400-\u9fff]/u.test(fields.designer||'')?fields.designer:null;product.designer.name_en=fields.designer&&!product.designer.name_zh?fields.designer:null;product.design_year=fields.design_year||null;
  const release=fields.release_date||null;product.release_date.value=release;product.release_date.precision=release?/\d{4}[-./年]\d{1,2}[-./月]\d{1,2}/.test(release)?'day':/\d{4}[-./年]\d{1,2}/.test(release)?'month':/\d{4}/.test(release)?'year':'unknown':null;
  const typeEvidence=structured.furniture_type_evidence||{};product.product_type=typeEvidence.status==='provided'?structured.furniture_type:null;
  const productFields={name:['/product/names/primary',product.names.primary],english_name:['/product/names/en',product.names.en],description:['/product/description',product.description],technical_specifications:['/product/technical_specifications',product.technical_specifications],model:['/product/model',product.model],category:['/product/category',product.category],designer:['/product/designer/name',product.designer.name],design_year:['/product/design_year',product.design_year],release_date:['/product/release_date/value',product.release_date.value]};
  for(const [name,[path,value]] of Object.entries(productFields))addField(document,path,value,documentStatus({value},businessPresence(bodyText,name)),evidence[name]?{...evidence[name],raw_value:value}:null);
  addField(document,'/product/product_type',product.product_type,product.product_type?'provided':businessPresence(bodyText,'configurations')?'extraction_failed':'source_absent',typeEvidence);
  const assetsByUrl=new Map();
  const addAsset=(raw,role,binding=null)=>{if(!raw?.url)return null;const id=documentStableId('asset',raw.url);let asset=assetsByUrl.get(raw.url);if(!asset){asset={id,url:raw.url,media_type:assetMediaType(raw.url,role),role:productAssetRole(role),sort_order:assetsByUrl.size,bindings:[]};assetsByUrl.set(raw.url,asset);}if(binding&&!asset.bindings.some(item=>item.target_type===binding.target_type&&item.target_id===binding.target_id))asset.bindings.push(binding);return asset;};
  for(const raw of structured.assets)addAsset(raw,raw.role,{target_type:'product',target_id:'product'});
  for(const [index,item] of structured.configurations.entries()){
    const id=item.id||documentStableId('cfg',`${index}|${item.code||''}|${item.name||''}`),values={};for(const [key,value] of Object.entries(item.dimensions||{}))values[key]=value==null?null:Number(value);const hasDimensions=Object.values(values).some(value=>Number.isFinite(value)&&value>0),dimensionId=documentStableId('dim',`${id}|overall`),assetIds=[];
    for(const raw of item.asset_relations||[]){const asset=addAsset(raw,raw.role,{target_type:'configuration',target_id:id});if(asset)assetIds.push(asset.id);}
    const configuration={id,group:item.group||null,name:item.name||null,code:item.code||null,dimensions:hasDimensions?[{id:dimensionId,kind:'overall',label:null,values,unit:item.dimension_unit||null,note:item.dimension_note||null,asset_ids:[]}]:[],asset_ids:[...new Set(assetIds)],option_group_ids:[],price_state:item.price_state||'unknown',price:item.price??null,currency:item.currency||'CNY',unit:item.unit||null,includes:item.includes||null};document.data.configurations.push(configuration);
    const present=businessPresence(bodyText,'configurations'),missingIdentity=present&&!configuration.name&&!configuration.code;for(const [name,value] of [['group',configuration.group],['name',configuration.name],['code',configuration.code]]){const fieldPresent=name==='group'?/(?:款型分组|配置分组|系列)\s*[:：]/i.test(bodyText):missingIdentity,status=name==='name'&&item.generated_identity?'inferred':documentStatus({value},fieldPresent);addField(document,fieldPath('configurations',id,name),value,status,item.evidence?.[name]);}
    const dimensionConfigured=Boolean(config.extraction.structured.configurations.dimensions.source.sources?.length);
    addField(document,fieldPath('configurations',id,'dimensions'),configuration.dimensions,hasDimensions?'provided':dimensionConfigured&&item.dimension_presence?'extraction_failed':'source_absent',item.evidence?.dimensions);
    addField(document,fieldPath('configurations',id,'unit'),configuration.unit,configuration.unit?'provided':'source_absent',null);
  }
  for(const group of structured.option_groups||[]){const groupId=group.id,applies=new Set();for(const option of group.items||[])if(option.applies_to_configuration_code)for(const configuration of document.data.configurations)if(configuration.code===option.applies_to_configuration_code)applies.add(configuration.id);const options=[];for(const item of group.items||[]){const assetIds=[];if(item.swatch){const asset=addAsset(item.swatch,'material_swatch',{target_type:'option',target_id:item.id});if(asset)assetIds.push(asset.id);}const option={id:item.id,name:item.name,code:item.code,material:item.material,color:item.color,supplier:item.supplier,origin:item.origin,asset_ids:assetIds};options.push(option);for(const [name,value] of Object.entries(option).filter(([name])=>!['id','asset_ids'].includes(name))){const configured=item.evidence?.[name]?.status!=='rule_not_configured';addField(document,fieldPath('option_groups',groupId,'options',item.id,name),value,documentStatus({value},configured&&businessPresence(bodyText,'option_groups')),item.evidence?.[name]);}}
    const value={id:groupId,type:group.type,name:group.name,applies_to_configuration_ids:[...applies],options};document.data.option_groups.push(value);for(const configuration of document.data.configurations)if(!applies.size||applies.has(configuration.id))configuration.option_group_ids.push(groupId);addField(document,fieldPath('option_groups',groupId,'name'),group.name,documentStatus({value:group.name},businessPresence(bodyText,'option_groups')),group.evidence?.name);
  }
  for(const attachment of structured.attachments||[]){
    const extension=(()=>{try{return new URL(attachment.url).pathname.split('.').pop().toLowerCase();}catch{return '';}})(),role=attachment.kind==='drawing'?'drawing':attachment.kind==='catalog'?'catalog':attachment.kind==='material'?'technical_document':['3dm','fbx','max','skp','dwg','dxf','zip'].includes(extension)?'model_file':'technical_document';
    addAsset({url:attachment.url,source_type:'dom_attribute'},role,{target_type:'product',target_id:'product'});
  }
  document.data.assets=[...assetsByUrl.values()];for(const asset of document.data.assets){const path=fieldPath('assets',asset.id,'role'),raw=[...(structured.assets||[]),...structured.configurations.flatMap(item=>item.asset_relations||[])].find(item=>item.url===asset.url),roleEvidence=raw?.source?{source:raw.source,raw_value:asset.role,section:raw.normalized_from_role?'single_hero_normalization':null,confidence:raw.normalized_from_role?.95:null}:{type:asset.media_type==='image'?'image':'dom_attribute',raw_value:asset.role};addField(document,path,asset.role,asset.role==='unknown'?'ambiguous':'provided',roleEvidence);}
  for(const assessment of structured.dimension_configuration_assessment||[]){if(assessment.auto_generated||assessment.interpretation!=='ambiguous_views_or_options')continue;const asset=assetsByUrl.get(assessment.url);if(!asset)continue;document.issues.push({id:documentStableId('issue',`${asset.id}|dimension-configuration-ambiguous`),target_type:'asset',target_id:asset.id,path:fieldPath('assets',asset.id,'bindings'),issue_type:'ambiguous',current_value:asset.bindings,expected_value:null,action:'bind',evidence_paths:[fieldPath('assets',asset.id,'role')],note:'尺寸图无法明确区分多个可选规格与同一产品的不同视图，已保留产品级绑定，需人工确认。'});}
  return assertProductDocumentV2(document);
}

module.exports={extractStructuredPage,buildProductDocumentV2,sourceValue,field,parseDimensions,assetsFromSources,applyOcr,businessPresence,documentStatus,productAssetRole,explicitSemanticValue,alphabeticLabel,productDimensionConfigurations};
