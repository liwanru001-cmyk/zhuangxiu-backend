'use strict';

const crypto=require('crypto');
const {canonicalUrl}=require('./product-ingestion-related-resources');

const MATERIAL_SOURCE='official_brand';

function parse(value,fallback=null){if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function digest(value){return crypto.createHash('sha256').update(String(value||'')).digest('hex');}
function normalizeBrand(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');}
function integer(value,fallback,min,max){const parsed=Number(value??fallback);if(!Number.isInteger(parsed)||parsed<min||parsed>max){const error=new Error('数字参数超出允许范围');error.status=400;throw error;}return parsed;}
function bounded(value,max){return String(value??'').trim().slice(0,max);}
function selectionState(policyMode,assertions){
  const values=new Set((assertions||[]).filter(item=>item.status!=='stale').map(item=>typeof item==='string'?item:item.assertion));
  if(values.has('confirmed_available')&&values.has('confirmed_unavailable'))return {effective_status:'needs_review',selectable:false,selection_basis:'conflicting_official_evidence'};
  if(values.has('confirmed_unavailable'))return {effective_status:'officially_unavailable',selectable:false,selection_basis:'official_explicit'};
  if(values.has('confirmed_available'))return {effective_status:'officially_available',selectable:true,selection_basis:'official_explicit'};
  if(policyMode==='closed_allowlist')return {effective_status:'not_in_official_allowlist',selectable:false,selection_basis:'official_closed_allowlist'};
  return {effective_status:'unconfirmed',selectable:true,selection_basis:'open_world'};
}

async function loadProduct(db,productId){
  const [rows]=await db.query(`SELECT product.id,product.source_url,product.brand_name,product.status,
    source.id product_source_id,source.brand_name source_brand_name
    FROM public_product_library_products product
    JOIN product_ingestion_sources source ON source.id=product.source_id WHERE product.id=?`,[productId]);
  if(!rows[0]){const error=new Error('公共产品不存在');error.status=404;throw error;}
  return rows[0];
}

async function resolveMaterialContext(db,productOrId){
  const product=typeof productOrId==='object'?productOrId:await loadProduct(db,integer(productOrId,null,1,Number.MAX_SAFE_INTEGER));
  const productId=Number(product.id||product.product_id);
  const brandKey=normalizeBrand(product.brand_name||product.source_brand_name);
  if(!brandKey)return {product,material_source_id:null,constraint:null,resolution:'brand_missing'};
  const [catalogRows]=await db.query(`SELECT DISTINCT catalog.source_id,source.brand_name
    FROM official_brand_material_catalogs catalog JOIN product_ingestion_sources source ON source.id=catalog.source_id
    WHERE catalog.status IN ('active','frozen')`);
  const sourceIds=[...new Set(catalogRows.filter(row=>normalizeBrand(row.brand_name)===brandKey).map(row=>Number(row.source_id)))];
  if(sourceIds.length!==1)return {product,material_source_id:null,constraint:null,resolution:sourceIds.length?'brand_ambiguous':'catalog_missing'};
  const materialSourceId=sourceIds[0],canonicalProductUrl=canonicalUrl(product.source_url),urlHash=digest(canonicalProductUrl||product.source_url);
  const [constraints]=await db.query(`SELECT * FROM official_product_material_constraints
    WHERE product_id=? OR (source_id=? AND product_url_hash=?) ORDER BY product_id=? DESC,id DESC`,[productId,materialSourceId,urlHash,productId]);
  return {product,material_source_id:materialSourceId,constraint:constraints[0]||null,resolution:'resolved'};
}

async function linkOfficialMaterialsToProduct(db,productId){
  const context=await resolveMaterialContext(db,productId);
  if(context.resolution!=='resolved')return {linked:false,reason:context.resolution,product_id:Number(productId)};
  if(context.constraint&&Number(context.constraint.product_id||0)===Number(productId))return {linked:true,already_linked:true,product_id:Number(productId),constraint_id:Number(context.constraint.id),material_source_id:Number(context.constraint.source_id)};
  const matches=[];
  if(context.constraint&&Number(context.constraint.product_id||0)!==Number(productId))matches.push(context.constraint);
  if(!context.constraint){
    const normalizedUrl=canonicalUrl(context.product.source_url)||context.product.source_url;
    const [rows]=await db.query('SELECT * FROM official_product_material_constraints WHERE source_id=? AND product_url_hash=?',[context.material_source_id,digest(normalizedUrl)]);
    matches.push(...rows);
  }
  if(matches.length!==1)return {linked:false,reason:matches.length?'ambiguous_exact_url':'no_product_declaration',product_id:Number(productId)};
  const relation=matches[0];
  await db.query('UPDATE official_product_material_constraints SET product_id=? WHERE id=? AND (product_id IS NULL OR product_id=?)',[productId,relation.id,productId]);
  await db.query('UPDATE official_product_material_assertions SET product_id=? WHERE source_id=? AND product_url_hash=? AND (product_id IS NULL OR product_id=?)',[productId,relation.source_id,relation.product_url_hash,productId]);
  return {linked:true,product_id:Number(productId),constraint_id:Number(relation.id),material_source_id:Number(relation.source_id)};
}

async function reconcileOfficialMaterialProductLinks(db){
  const [products]=await db.query("SELECT id FROM public_product_library_products WHERE status<>'deleted'");
  const results=[];for(const product of products)results.push(await linkOfficialMaterialsToProduct(db,Number(product.id)));
  return {checked:results.length,linked:results.filter(item=>item.linked).length,results};
}

async function publicProductMaterials(db,productId,query={}){
  const context=await resolveMaterialContext(db,integer(productId,null,1,Number.MAX_SAFE_INTEGER));
  const limit=integer(query.limit,60,1,100),offset=integer(query.offset,0,0,10000);
  if(context.resolution!=='resolved')return {material_source:MATERIAL_SOURCE,product_id:Number(productId),brand:context.product.brand_name||'',available:false,resolution:context.resolution,constraint:{mode:'open_world',basis:'system_default',revision:1},items:[],total:0,limit,offset};
  const where=["material.source_id=?","material.status='active'","EXISTS (SELECT 1 FROM official_brand_material_catalog_items membership WHERE membership.material_id=material.id AND membership.status='active')"],params=[context.material_source_id];
  if(query.kind){where.push('material.kind=?');params.push(bounded(query.kind,120));}
  if(query.q){const keyword=`%${bounded(query.q,120).replace(/[\\%_]/g,'\\$&')}%`;where.push('(material.name LIKE ? OR material.code LIKE ? OR material.series LIKE ? OR material.composition LIKE ?)');params.push(keyword,keyword,keyword,keyword);}
  const filter=where.join(' AND '),[countRows]=await db.query(`SELECT COUNT(*) total FROM official_brand_materials material WHERE ${filter}`,params);
  const [rows]=await db.query(`SELECT material.id,material.revision,material.kind,material.series,material.name,material.code,material.color,material.composition,material.description,material.status,source.brand_name,
    COALESCE((SELECT JSON_ARRAYAGG(asset.storage_uri) FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id WHERE relation.material_id=material.id),JSON_ARRAY()) image_urls
    FROM official_brand_materials material JOIN product_ingestion_sources source ON source.id=material.source_id
    WHERE ${filter} ORDER BY material.kind,material.series,material.code,material.name LIMIT ? OFFSET ?`,[...params,limit,offset]);
  const constraint=context.constraint||{policy_mode:'open_world',policy_basis:'system_default',revision:1};
  const [assertionRows]=context.constraint?await db.query(`SELECT material_id,assertion,status FROM official_product_material_assertions
    WHERE source_id=? AND product_url_hash=? AND status='active'`,[context.material_source_id,context.constraint.product_url_hash]):[[]];
  const byMaterial=new Map();for(const row of assertionRows){const id=Number(row.material_id);if(!byMaterial.has(id))byMaterial.set(id,[]);byMaterial.get(id).push(row);}
  const items=rows.map(row=>{const state=selectionState(constraint.policy_mode,byMaterial.get(Number(row.id))||[]);return {id:Number(row.id),revision:Number(row.revision),material_source:MATERIAL_SOURCE,brand:row.brand_name,kind:row.kind,series:row.series,name:row.name,code:row.code,color:row.color,composition:row.composition,description:row.description,status:row.status,image_urls:parse(row.image_urls,[]),...state};});
  const [kinds]=await db.query(`SELECT material.kind,COUNT(DISTINCT material.id) count FROM official_brand_materials material JOIN official_brand_material_catalog_items membership ON membership.material_id=material.id AND membership.status='active' WHERE material.source_id=? AND material.status='active' GROUP BY material.kind ORDER BY count DESC,material.kind`,[context.material_source_id]);
  return {material_source:MATERIAL_SOURCE,product_id:Number(productId),brand:context.product.brand_name||'',available:true,resolution:'resolved',constraint:{mode:constraint.policy_mode,basis:constraint.policy_basis,revision:Number(constraint.revision||1)},items,total:Number(countRows[0]?.total||0),limit,offset,kinds:kinds.map(row=>({value:row.kind,count:Number(row.count)}))};
}

async function validateOfficialMaterialSelection(db,product,materials){
  if(!materials.length)return materials;
  const context=await resolveMaterialContext(db,product);
  if(context.resolution!=='resolved')throw new Error('该品牌尚无可用的官方材质库');
  const ids=[...new Set(materials.map(item=>Number(item.material_id)))],placeholders=ids.map(()=>'?').join(',');
  const [rows]=await db.query(`SELECT material.id,material.revision,material.kind,material.series,material.name,material.code,material.color,material.composition,material.status,source.brand_name,
    COALESCE((SELECT JSON_ARRAYAGG(asset.storage_uri) FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id WHERE relation.material_id=material.id),JSON_ARRAY()) image_urls
    FROM official_brand_materials material JOIN product_ingestion_sources source ON source.id=material.source_id
    WHERE material.source_id=? AND material.status='active' AND material.id IN (${placeholders})`,[context.material_source_id,...ids]);
  if(rows.length!==ids.length)throw new Error('所选官方材质已不存在或不属于当前品牌');
  const constraint=context.constraint||{policy_mode:'open_world',policy_basis:'system_default',revision:1};
  const [assertions]=context.constraint?await db.query(`SELECT material_id,assertion,status FROM official_product_material_assertions WHERE source_id=? AND product_url_hash=? AND material_id IN (${placeholders}) AND status='active'`,[context.material_source_id,context.constraint.product_url_hash,...ids]):[[]];
  const byId=new Map(rows.map(row=>[Number(row.id),row])),byAssertion=new Map();for(const row of assertions){const id=Number(row.material_id);if(!byAssertion.has(id))byAssertion.set(id,[]);byAssertion.get(id).push(row);}
  return materials.map(item=>{const row=byId.get(Number(item.material_id)),state=selectionState(constraint.policy_mode,byAssertion.get(Number(item.material_id))||[]);if(!state.selectable)throw new Error(`${item.part}所选材质不符合官网明确约束`);const images=parse(row.image_urls,[]);return {...item,material_source:MATERIAL_SOURCE,material_revision:Number(row.revision),brand:bounded(row.brand_name,120),kind:bounded(row.kind,120),series:bounded(row.series,120),name:bounded(row.name,120),code:bounded(row.code,80),composition:bounded(row.composition,500),swatch_url:bounded(images[0],1000),official_status:state.effective_status,selection_basis:state.selection_basis};});
}

async function hydrateOfficialMaterialSnapshots(db,productId,snapshots){
  if(!snapshots.length)return [];
  const context=await resolveMaterialContext(db,productId);
  if(context.resolution!=='resolved')return snapshots.map(snapshot=>({...snapshot,live_material:null,current_selection_status:'catalog_unavailable'}));
  const ids=[...new Set(snapshots.map(item=>Number(item.material_id)).filter(Number.isSafeInteger))];
  if(!ids.length)return snapshots;
  const placeholders=ids.map(()=>'?').join(','),[rows]=await db.query(`SELECT material.id,material.revision,material.kind,material.series,material.name,material.code,material.color,material.composition,material.status,source.brand_name,
    COALESCE((SELECT JSON_ARRAYAGG(asset.storage_uri) FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id WHERE relation.material_id=material.id),JSON_ARRAY()) image_urls
    FROM official_brand_materials material JOIN product_ingestion_sources source ON source.id=material.source_id
    WHERE material.source_id=? AND material.id IN (${placeholders})`,[context.material_source_id,...ids]);
  const constraint=context.constraint||{policy_mode:'open_world'};
  const [assertions]=context.constraint?await db.query(`SELECT material_id,assertion,status FROM official_product_material_assertions WHERE source_id=? AND product_url_hash=? AND material_id IN (${placeholders}) AND status='active'`,[context.material_source_id,context.constraint.product_url_hash,...ids]):[[]];
  const byId=new Map(rows.map(row=>[Number(row.id),row])),byAssertion=new Map();for(const row of assertions){const id=Number(row.material_id);if(!byAssertion.has(id))byAssertion.set(id,[]);byAssertion.get(id).push(row);}
  return snapshots.map(snapshot=>{const row=byId.get(Number(snapshot.material_id));if(!row)return {...snapshot,live_material:null,current_selection_status:'material_missing'};const state=selectionState(constraint.policy_mode,byAssertion.get(Number(snapshot.material_id))||[]),images=parse(row.image_urls,[]);return {...snapshot,current_selection_status:state.effective_status,live_material:{id:Number(row.id),revision:Number(row.revision),material_source:MATERIAL_SOURCE,brand:row.brand_name,kind:row.kind,series:row.series,name:row.name,code:row.code,color:row.color,composition:row.composition,status:row.status,image_urls:images,...state}};});
}

module.exports={MATERIAL_SOURCE,normalizeBrand,selectionState,resolveMaterialContext,linkOfficialMaterialsToProduct,reconcileOfficialMaterialProductLinks,publicProductMaterials,validateOfficialMaterialSelection,hydrateOfficialMaterialSnapshots};
