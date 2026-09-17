'use strict';

const crypto=require('crypto');

const clean=(value,max=1000)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);
const digest=value=>crypto.createHash('sha256').update(String(value||'')).digest('hex');
const TRANSIENT_CLASSES=new Set(['active','current','selected','open','closed','show','hide','hidden','visible','hover','focus','disabled']);
const DIMENSION_RE=/(?:\d+(?:[.,]\d+)?)\s*(?:mm|cm|m|in|inch|英寸)?\s*(?:×|x|X|\*)\s*(?:\d+(?:[.,]\d+)?)(?:\s*(?:mm|cm|m|in|inch|英寸))?/g;
const MODEL_RE=/(?<![\p{L}\d])(?=[\p{L}\d_-]{3,24}(?![\p{L}\d]))(?=[\p{L}\d_-]*\p{L})(?=[\p{L}\d_-]*\d)[\p{L}\d_-]+/gu;
const OPTION_RE=/material|fabric|leather|finish|colour|color|swatch|option|材质|面料|皮革|饰面|色彩|颜色|色卡|选项/i;
const CONFIG_RE=/configuration|variant|model|sku|dimension|measurement|size|spec|款型|款式|规格|型号|尺寸|组合|模块/i;
const DOWNLOAD_ACTION_RE=/^(?:3d|2d|cad|pdf|dwg|dxf|download|downloads|material|catalog|资料下载|下载)$/i;

function dimensionMatches(value){
  const text=clean(value,1800),matches=[...new Set(text.match(DIMENSION_RE)||[])];
  const labelled=[
    /(?:\d+(?:[.,]\d+)?\s*cm)(?:\s*\/\s*\d+(?:[.,]\d+)?\s*[’'”"]{1,2})?\s*(?:×|x|X|\*)\s*(?:\d+(?:[.,]\d+)?\s*cm)(?:\s*\/\s*\d+(?:[.,]\d+)?\s*[’'”"]{1,2})?(?:\s*H\s*\d+(?:[.,]\d+)?\s*cm(?:\s*\/\s*\d+(?:[.,]\d+)?\s*[’'”"]{1,2})?)?/gi,
    /(?:D|Ø|直径)\s*\d+(?:[.,]\d+)?\s*cm(?:\s*\/\s*\d+(?:[.,]\d+)?\s*[’'”"]{1,2})?(?:\s*H\s*\d+(?:[.,]\d+)?\s*cm(?:\s*\/\s*\d+(?:[.,]\d+)?\s*[’'”"]{1,2})?)?/gi,
  ].flatMap(pattern=>text.match(pattern)||[]);
  return [...new Set([...matches,...labelled])].slice(0,12);
}

function simpleSelector(node,$){
  const value=$(node),id=value.attr('id');
  if(id&&/^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(id))return `#${id}`;
  const classes=String(value.attr('class')||'').split(/\s+/).filter(item=>/^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(item)&&!TRANSIENT_CLASSES.has(item.toLowerCase())).slice(0,4);
  return `${node.tagName||node.name||'*'}${classes.map(item=>`.${item}`).join('')}`.slice(0,240);
}

function selectorCount($,selector){try{return $(selector).length;}catch{return 0;}}

function containerSelector(node,$){
  let selector=simpleSelector(node,$);
  if(selectorCount($,selector)<=1)return selector;
  let current=node;
  for(let depth=0;depth<3;depth+=1){
    const parent=$(current).parent()[0];
    if(!parent||['html','body'].includes(parent.name))break;
    selector=`${simpleSelector(parent,$)} > ${selector}`;
    if(selectorCount($,selector)<=1)return selector;
    current=parent;
  }
  return selector;
}

function ownText(node,$){const copy=$(node).clone();copy.children().remove();return clean(copy.text(),180);}
function facts(node,$){
  const text=clean($(node).text(),1800),dimensions=dimensionMatches(text),models=[...new Set(text.match(MODEL_RE)||[])].filter(value=>!/^(?:\d+(?:[.,]\d+)?)(?:mm|cm|m|in)$/i.test(value)).slice(0,12);
  const label=ownText(node,$)||clean($(node).find('h2,h3,h4,h5,strong,b,[class*="name" i],[class*="title" i]').first().text(),180)||(text.length<=180?text:'');
  return {text,dimensions,models,label,image_count:$(node).find('img,picture').length,option_signal:OPTION_RE.test(text),config_signal:CONFIG_RE.test(text)};
}

function itemSignature(item){
  const stable=[...item.models,...item.dimensions,item.label].map(value=>clean(value,180).toLowerCase()).filter(Boolean);
  return digest(stable.join('|')||item.text.toLowerCase()).slice(0,20);
}

function relativeEvidence(item,$){
  const result=[],seen=new Set();
  $(item).find('h2,h3,h4,h5,strong,b,p,span,li,dd,dt,[class*="name" i],[class*="title" i],[class*="spec" i],[class*="size" i],[class*="dimension" i],[class*="model" i],[class*="price" i],[class*="series" i],[class*="code" i]').each((_,node)=>{
    if(result.length>=12)return;
    const text=clean($(node).text(),360);if(!text||text.length>320)return;
    let selector=simpleSelector(node,$);
    const siblings=$(node).parent().children(node.name),position=siblings.toArray().indexOf(node);
    if(siblings.length>1&&position===0)selector=`${selector}:first-child`;
    const parent=$(node).parent()[0],parentSelector=parent&&parent!==item?simpleSelector(parent,$):null;
    const selectorCandidates=[selector,...(parentSelector?[`${parentSelector} ${selector}`]:[])];
    const key=`${selector}|${text}`;if(seen.has(key))return;seen.add(key);
    const dimensions=dimensionMatches(text).slice(0,6),models=[...new Set(text.match(MODEL_RE)||[])].slice(0,6);
    const structuredParent=/price|series|spec|size|dimension|model|name|code/i.test(parentSelector||'');
    if(dimensions.length||models.length||OPTION_RE.test(text)||/price|价格|名称|name/i.test(`${selector} ${text}`)||/[￥¥$€£]\s*\d/.test(text)||structuredParent)result.push({selector,selector_candidates:selectorCandidates,text,signals:{dimensions,models,option:OPTION_RE.test(text),price:/[￥¥$€£]\s*\d/.test(text)}});
  });
  return result;
}

function classifyGroup(parent,nodes,$){
  const items=nodes.map(node=>({...facts(node,$),node}));
  const parentText=clean($(parent).text(),3000),ancestorHints=$(parent).parents('section,article,div,fieldset').slice(0,2).map((_,node)=>`${simpleSelector(node,$)} ${ownText(node,$)}`).get().join(' '),parentHint=`${simpleSelector(parent,$)} ${parentText.slice(0,400)} ${ancestorHints}`;
  const configurationCandidates=items.map(item=>item.dimensions.length>0&&item.dimensions.length<=4&&(item.models.length>0||(item.image_count>0&&/[\p{L}]/u.test(item.label))));
  const optionCandidates=items.map(item=>OPTION_RE.test(parentHint)&&!DOWNLOAD_ACTION_RE.test(item.label)&&(item.option_signal||item.image_count>0)&&(item.label.length>=1||item.models.length>0));
  const configCount=configurationCandidates.filter(Boolean).length,optionCount=optionCandidates.filter(Boolean).length;
  if(configCount>=2&&configCount/items.length>=0.55)return {kind:'configurations',valid:configurationCandidates,basis:['repeated_sibling_structure','dimension_signal',...(items.some(item=>item.models.length)?['model_identity_signal']:[])]};
  if(optionCount>=2&&optionCount/items.length>=0.6)return {kind:'option_groups',valid:optionCandidates,basis:['repeated_sibling_structure','option_semantic_anchor']};
  return null;
}

function buildRegion(parent,nodes,classification,$,pageId,index){
  const parentSelector=containerSelector(parent,$),childSelector=simpleSelector(nodes[0],$),itemSelector=`${parentSelector} > ${childSelector}`;
  const exclusions=[],accepted=[],signatures=new Map();
  nodes.forEach((node,itemIndex)=>{
    const item=facts(node,$),valid=classification.valid[itemIndex];
    if(!valid){exclusions.push({item_index:itemIndex,reason:classification.kind==='configurations'?'missing_configuration_structure_signal':'missing_option_structure_signal',evidence:{text:clean(item.text,220),dimensions:item.dimensions,models:item.models}});return;}
    const signature=itemSignature(item);
    if(signatures.has(signature)){exclusions.push({item_index:itemIndex,reason:'duplicate_template_item',duplicate_of:signatures.get(signature),evidence:{signature,text:clean(item.text,220)}});return;}
    signatures.set(signature,itemIndex);accepted.push({item_index:itemIndex,signature,text:clean(item.text,700),dimensions:item.dimensions,models:item.models,label:item.label,relative_evidence:relativeEvidence(node,$),html:clean($.html(node),1200)});
  });
  if(accepted.length<2)return null;
  const matched=selectorCount($,itemSelector);
  if(matched<accepted.length)return null;
  return {
    region_id:`${pageId}-SR${String(index+1).padStart(2,'0')}`,
    kind:classification.kind,status:'routable',source:'current_page_dom',container_selector:parentSelector,item_selector:itemSelector,
    selector_match_count:matched,raw_item_count:nodes.length,valid_item_count:accepted.length,excluded_item_count:exclusions.length,
    classification_basis:classification.basis,
    accepted_samples:accepted.slice(0,4),
    exclusions:exclusions.slice(0,12),
    exclusion_summary:Object.entries(exclusions.reduce((all,item)=>({...all,[item.reason]:(all[item.reason]||0)+1}),{})).map(([reason,count])=>({reason,count})),
    content_hash:digest(accepted.map(item=>item.signature).join('|')),
  };
}

function discoverSemanticAnchors($,root){
  const anchors=[],seen=new Set();
  $(root).find('h2,h3,h4,h5,dt,th,legend,summary,button,div,span,p').each((_,node)=>{
    if(anchors.length>=80)return;
    if($(node).closest('header,nav,footer').length)return;
    const label=ownText(node,$),semanticTag=['h2','h3','h4','h5','dt','th','legend','summary','button'].includes(node.name);
    if(!label||label.length>120||(!semanticTag&&label.length>48)||(!CONFIG_RE.test(label)&&!OPTION_RE.test(label)))return;
    if(!semanticTag&&$(node).children().length>2)return;
    let target=$(node).nextAll('section,article,div,ul,ol,table,dl').first()[0];
    if(!target)target=$(node).closest('section,article,div,table,dl').first()[0]||node;
    const selector=containerSelector(target,$),key=`${label}|${selector}`;if(seen.has(key))return;seen.add(key);
    anchors.push({kind:CONFIG_RE.test(label)?'configuration':'options',label,selector,text:clean($(target).text(),2200),image_count:$(target).find('img,picture').length,source:'semantic_anchor'});
  });
  return anchors;
}

function mineStructuredEvidence($,root,pageId){
  const regions=[],seen=new Set();
  $(root).find('section,article,ul,ol,tbody,dl,div').addBack('section,article,ul,ol,tbody,dl,div').each((_,parent)=>{
    if(regions.length>=30||$(parent).closest('header,nav,footer').length)return;
    const groups=new Map();
    $(parent).children().each((__,node)=>{const selector=simpleSelector(node,$);if(!groups.has(selector))groups.set(selector,[]);groups.get(selector).push(node);});
    for(const localNodes of groups.values()){
      let nodes=localNodes;
      if(nodes.length<2||nodes.length>100)continue;
      const parentSelector=containerSelector(parent,$),childSelector=simpleSelector(nodes[0],$),itemSelector=`${parentSelector} > ${childSelector}`;
      const selected=$(itemSelector).toArray();if(selected.length>=nodes.length&&selected.length<=100)nodes=selected;
      const classification=classifyGroup(parent,nodes,$);if(!classification)continue;
      const region=buildRegion(parent,nodes,classification,$,pageId,regions.length);if(!region)continue;
      const key=`${region.kind}|${region.item_selector}`;if(seen.has(key))continue;seen.add(key);regions.push(region);
    }
  });
  regions.sort((left,right)=>right.valid_item_count-left.valid_item_count||left.excluded_item_count-right.excluded_item_count);
  return {anchors:discoverSemanticAnchors($,root),regions:regions.slice(0,12)};
}

module.exports={mineStructuredEvidence,simpleSelector,containerSelector};
