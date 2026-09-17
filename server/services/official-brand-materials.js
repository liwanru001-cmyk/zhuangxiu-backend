'use strict';

const {fetchHtml}=require('./product-ingestion-fetch');
const {downloadAsset,storeAsset}=require('./public-product-assets');
const {validateMaterialRule,discoverLinks,extractMaterialPage,digest,canonicalUrl}=require('./product-ingestion-related-resources');
const {selectionState,normalizeBrand}=require('./official-material-selection');

const MATERIAL_SOURCE='official_brand';
const POLICY_MODES=Object.freeze(['open_world','closed_allowlist']);
const ASSERTIONS=Object.freeze(['confirmed_available','confirmed_unavailable']);

function fail(message,status=409,code='OFFICIAL_MATERIAL_INVALID'){const error=new Error(message);error.status=status;error.code=code;throw error;}
function parse(value,fallback=null){if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function number(value,fallback,min=0,max=Number.MAX_SAFE_INTEGER){const parsed=Number(value??fallback);if(!Number.isInteger(parsed)||parsed<min||parsed>max)fail('数字参数超出允许范围',400);return parsed;}
function text(value,max,name,required=false){const result=String(value??'').trim();if(required&&!result)fail(`${name}不能为空`,400);if(result.length>max)fail(`${name}过长`,400);return result||null;}
function json(value){return JSON.stringify(value==null?null:value);}
function sourceLists(row){return {...row,allowed_hosts:parse(row.allowed_hosts,[]),allowed_asset_hosts:parse(row.allowed_asset_hosts,[]),allowed_path_prefixes:parse(row.allowed_path_prefixes,[])};}
function materialRow(row){return {...row,id:Number(row.id),source_id:Number(row.source_id),revision:Number(row.revision),evidence:parse(row.evidence,{}),image_urls:parse(row.image_urls,[]),material_source:MATERIAL_SOURCE,brand:row.brand_name};}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
const effectiveSelection=selectionState;

function createOfficialBrandMaterials(db,options={}){
  const pageFetcher=options.fetchHtml||fetchHtml,assetDownloader=options.downloadAsset||downloadAsset,assetStore=options.storeAsset||storeAsset;

  async function loadSource(id){const sourceId=number(id,null,1);const [rows]=await db.query('SELECT * FROM product_ingestion_sources WHERE id=?',[sourceId]);if(!rows[0])fail('抓取来源不存在',404);return sourceLists(rows[0]);}
  async function loadCatalog(id){const catalogId=number(id,null,1);const [rows]=await db.query(`SELECT catalog.*,source.brand_name,source.base_url,source.allowed_hosts,source.allowed_asset_hosts,source.allowed_path_prefixes,source.request_interval_ms,source.status source_status
    FROM official_brand_material_catalogs catalog JOIN product_ingestion_sources source ON source.id=catalog.source_id WHERE catalog.id=?`,[catalogId]);if(!rows[0])fail('品牌官方材料库不存在',404);const row=sourceLists(rows[0]);return {...row,id:Number(row.id),source_id:Number(row.source_id),catalog_rule:parse(row.catalog_rule,{}),product_subset_rule:parse(row.product_subset_rule,null),validation_evidence:parse(row.validation_evidence,null)};}
  function validateRuleOrFail(rule,label){const result=validateMaterialRule(rule);if(!result.valid)fail(`${label}未通过校验：${[...result.schema_errors,...result.semantic_errors].join('；')}`,400,'MATERIAL_RULE_INVALID');return result;}
  function pageScope(source,limit){return {source_id:Number(source.source_id||source.id),job_id:null,source_status:source.source_status||source.status,job_status:'discovering',allowed_hosts:source.allowed_hosts,allowed_asset_hosts:source.allowed_asset_hosts,allowed_path_prefixes:source.allowed_path_prefixes,request_interval_ms:Number(source.request_interval_ms||2000),page_quota:{used:0,limit},policy_db:db,policy_authorizer:async()=>{const [rows]=await db.query('SELECT status source_status FROM product_ingestion_sources WHERE id=?',[source.source_id||source.id]);return {source_status:rows[0]?.source_status||'missing',job_status:'discovering'};}};}
  function assetScope(source,limit){return {source_id:Number(source.source_id||source.id),job_id:null,source_status:source.source_status||source.status,job_status:'completed',allowed_hosts:[],allowed_asset_hosts:source.allowed_asset_hosts,allowed_path_prefixes:['/'],request_interval_ms:Number(source.request_interval_ms||2000),asset_quota:{used:0,limit:Math.min(2000,limit*2)},policy_db:db,policy_authorizer:async()=>{const [rows]=await db.query('SELECT status source_status FROM product_ingestion_sources WHERE id=?',[source.source_id||source.id]);return {source_status:rows[0]?.source_status||'missing',job_status:'completed'};}};}

  async function snapshot(source,url,role,parentUrl,scope,cacheSeconds,forceRefresh=false){
    const urlHash=digest(url);
    if(!forceRefresh){const [cached]=await db.query(`SELECT * FROM product_ingestion_related_resource_snapshots WHERE source_id=? AND resource_url_hash=? AND expires_at>NOW() ORDER BY id DESC LIMIT 1`,[source.source_id||source.id,urlHash]);if(cached[0])return {...cached[0],id:Number(cached[0].id),html:Buffer.isBuffer(cached[0].html)?cached[0].html.toString('utf8'):String(cached[0].html),cache_status:'hit'};}
    const page=await pageFetcher(url,scope),html=String(page.html||'');
    const [stored]=await db.query(`INSERT INTO product_ingestion_related_resource_snapshots
      (source_id,resource_role,resource_url,resource_url_hash,final_url,parent_url,http_status,content_type,content_hash,html,fetched_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),DATE_ADD(NOW(),INTERVAL ? SECOND))`,[source.source_id||source.id,role,url,urlHash,page.url,parentUrl||null,Number(page.status||200),page.contentType||'text/html',digest(html),html,cacheSeconds]);
    return {id:Number(stored.insertId),source_id:Number(source.source_id||source.id),resource_url:url,final_url:page.url,html,cache_status:'miss'};
  }

  async function createScan(catalog,kind,body,actor){const productUrl=body.product_url?canonicalUrl(body.product_url,catalog.base_url):null;if(kind==='product_subset'&&!productUrl)fail('产品 URL 不合法',400);const [result]=await db.query(`INSERT INTO official_brand_material_scans
    (catalog_id,source_id,scan_kind,product_id,product_url,product_url_hash,resource_url,rule_hash,status,created_by)
    VALUES (?,?,?,?,?,?,?,?, 'queued',?)`,[catalog.id,catalog.source_id,kind,body.product_id||null,productUrl,productUrl?digest(productUrl):null,body.resource_url||productUrl||catalog.source_url,catalog.rule_hash,actor]);return Number(result.insertId);}
  async function markScan(id,fields){const keys=Object.keys(fields);if(!keys.length)return;await db.query(`UPDATE official_brand_material_scans SET ${keys.map(key=>`${key}=?`).join(',')} WHERE id=?`,[...keys.map(key=>fields[key]),id]);}

  async function upsertMaterial(scanId,catalog,observation,membershipKind=null){
    const sourceId=catalog.source_id;
    const values=observation.fields,[rows]=await db.query('SELECT * FROM official_brand_materials WHERE source_id=? AND canonical_key=?',[sourceId,observation.canonical_key]);
    let result;if(!rows[0]){const [created]=await db.query(`INSERT INTO official_brand_materials
      (source_id,canonical_key,kind,series,name,code,color,composition,description,first_seen_scan_id,last_seen_scan_id,evidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[sourceId,observation.canonical_key,values.kind,values.series,values.name,values.code,values.color,values.composition,values.description,scanId,scanId,json(observation.evidence)]);result={id:Number(created.insertId),changed:true};}
    else {const existing=rows[0],merged=Object.fromEntries(['kind','series','name','code','color','composition','description'].map(key=>[key,values[key]??existing[key]??null])),changed=Object.keys(merged).some(key=>String(existing[key]??'')!==String(merged[key]??'')),priorEvidence=parse(existing.evidence,{}),nextEvidence={...priorEvidence};for(const key of Object.keys(observation.evidence||{}))if(values[key]!=null)nextEvidence[key]=observation.evidence[key];
      await db.query(`UPDATE official_brand_materials SET kind=?,series=?,name=?,code=?,color=?,composition=?,description=?,status='active',verification_status='official_observed',last_seen_scan_id=?,evidence=?,revision=revision+? WHERE id=?`,[merged.kind,merged.series,merged.name,merged.code,merged.color,merged.composition,merged.description,scanId,json(nextEvidence),changed?1:0,existing.id]);result={id:Number(existing.id),changed};}
    if(membershipKind)await db.query(`INSERT INTO official_brand_material_catalog_items (catalog_id,material_id,membership_kind,evidence,first_seen_scan_id,last_seen_scan_id)
      VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status='active',evidence=VALUES(evidence),last_seen_scan_id=VALUES(last_seen_scan_id)`,[catalog.id,result.id,membershipKind,json(observation.evidence),scanId,scanId]);
    return result;
  }

  async function archiveSwatch(scanId,source,materialId,observation,scope){
    if(!observation.swatch_url)return false;const urlHash=digest(observation.swatch_url);
    const [cached]=await db.query(`SELECT relation.id FROM official_brand_material_assets relation WHERE relation.material_id=? AND relation.original_url_hash=?`,[materialId,urlHash]);
    if(cached[0]){await db.query('UPDATE official_brand_material_assets SET last_seen_scan_id=? WHERE id=?',[scanId,cached[0].id]);return false;}
    const [urlAssets]=await db.query('SELECT id FROM public_product_library_assets WHERE original_url=? ORDER BY id LIMIT 1',[observation.swatch_url]);let assetId=Number(urlAssets[0]?.id||0);
    if(!assetId){let stored,lastError;for(let attempt=1;attempt<=2;attempt+=1){try{stored=await assetStore(await assetDownloader(observation.swatch_url,scope));break;}catch(error){lastError=error;if(attempt===2||!['FETCH_TIMEOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENETUNREACH'].includes(String(error.code||'')))throw error;}}if(!stored)throw lastError;const [asset]=await db.query(`INSERT INTO public_product_library_assets (content_hash,storage_uri,original_url,content_type,byte_size) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,[stored.contentHash,stored.storageUri,observation.swatch_url,stored.contentType,stored.byteSize]);assetId=Number(asset.insertId);}
    await db.query(`INSERT INTO official_brand_material_assets (material_id,asset_id,original_url,original_url_hash,evidence,first_seen_scan_id,last_seen_scan_id) VALUES (?,?,?,?,?,?,?)`,[materialId,assetId,observation.swatch_url,urlHash,json(observation.swatch_evidence||{}),scanId,scanId]);return true;
  }

  async function processPages({catalog,scanId,rule,initialUrls,parentUrl,kind,product,forceRefresh,cacheSeconds}){
    const allowedHosts=new Set(catalog.allowed_hosts.map(value=>String(value).toLowerCase())),scope=pageScope(catalog,rule.limits.max_pages),swatchScope=rule.limits.max_assets?assetScope(catalog,rule.limits.max_assets):null;
    const queue=[...new Set(initialUrls)],visited=new Set(),failures=[],seenKeys=new Set(),assertions=[],constraintEvidence=[],stats={pages_attempted:0,pages_succeeded:0,observations_found:0,materials_upserted:0,assets_archived:0,cache_hits:0};
    while(queue.length&&visited.size<rule.limits.max_pages&&seenKeys.size<rule.limits.max_items){
      const url=queue.shift();if(!url||visited.has(url))continue;visited.add(url);stats.pages_attempted+=1;
      try{
        const saved=await snapshot(catalog,url,kind==='catalog'?'brand_material_catalog':'product_material_subset',parentUrl,scope,cacheSeconds,forceRefresh);if(saved.cache_status==='hit')stats.cache_hits+=1;stats.pages_succeeded+=1;
        const page={url:saved.final_url,html:saved.html},extracted=extractMaterialPage(page,rule);if(extracted.constraint)constraintEvidence.push(extracted.constraint);
        for(const observation of extracted.items){
          stats.observations_found+=1;let materialId=null,outcome=observation.outcome,issueCode=observation.issue_code;
          if(outcome==='accepted'&&seenKeys.size<rule.limits.max_items){
            if(kind==='product_subset'&&extracted.item_assertion==='confirmed_unavailable'&&!extracted.assertion_evidence){outcome='rejected';issueCode='NEGATIVE_ASSERTION_EVIDENCE_MISSING';}
            else {const stored=await upsertMaterial(scanId,catalog,observation,kind==='catalog'?'catalog_listing':null);materialId=stored.id;seenKeys.add(observation.canonical_key);stats.materials_upserted+=1;if(observation.swatch_url&&swatchScope&&stats.assets_archived<rule.limits.max_assets){try{if(await archiveSwatch(scanId,catalog,materialId,observation,swatchScope))stats.assets_archived+=1;}catch(error){failures.push({url:observation.swatch_url,code:error.code||'SWATCH_ARCHIVE_FAILED',message:String(error.message||error).slice(0,500)});}}if(kind==='product_subset')assertions.push({material_id:materialId,assertion:extracted.item_assertion,evidence:{fields:observation.evidence,assertion:extracted.assertion_evidence||{type:'resource_membership',resource_url:page.url}}});}
          }
          await db.query(`INSERT INTO product_ingestion_material_observations (scan_id,snapshot_id,source_id,ordinal,canonical_key,extracted_fields,field_evidence,swatch_url,swatch_evidence,outcome,issue_code,material_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[scanId,saved.id,catalog.source_id,observation.ordinal,observation.canonical_key,json(observation.fields),json(observation.evidence),observation.swatch_url,json(observation.swatch_evidence),outcome,issueCode,materialId]);
        }
        for(const link of extracted.pagination_links){let host='';try{host=new URL(link.url).hostname.toLowerCase();}catch{}if(allowedHosts.has(host)&&!visited.has(link.url)&&queue.length+visited.size<rule.limits.max_pages)queue.push(link.url);}
      }catch(error){failures.push({url,code:error.code||'RELATED_RESOURCE_FAILED',message:String(error.message||error).slice(0,500)});}
    }
    const bounded=queue.length>0||seenKeys.size>=rule.limits.max_items,hasRejected=await (async()=>{const [rows]=await db.query("SELECT COUNT(*) total FROM product_ingestion_material_observations WHERE scan_id=? AND outcome='rejected'",[scanId]);return Number(rows[0]?.total||0)>0;})();
    return {stats,assertions,constraint:constraintEvidence.at(-1)||null,failures,completeness:!failures.length&&!bounded&&!hasRejected&&stats.observations_found>0?'complete':'partial',bounded};
  }

  async function persistProductRelations(catalog,scanId,product,result){
    const productUrl=canonicalUrl(product.product_url,catalog.base_url),productHash=digest(productUrl),constraint=result.constraint||{mode:'open_world',basis:'system_default',evidence:null};
    if(constraint.mode==='closed_allowlist'&&(constraint.basis!=='official_explicit'||!constraint.evidence))fail('完整白名单缺少官网明确证据，不能形成限制',409,'CLOSED_ALLOWLIST_EVIDENCE_REQUIRED');
    await db.query(`INSERT INTO official_product_material_constraints (source_id,product_id,product_url,product_url_hash,policy_mode,policy_basis,policy_evidence,last_scan_id)
      VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE product_id=COALESCE(VALUES(product_id),product_id),policy_mode=VALUES(policy_mode),policy_basis=VALUES(policy_basis),policy_evidence=VALUES(policy_evidence),last_scan_id=VALUES(last_scan_id),revision=revision+IF(policy_mode<>VALUES(policy_mode) OR policy_basis<>VALUES(policy_basis),1,0)`,[catalog.source_id,product.product_id||null,productUrl,productHash,constraint.mode,constraint.basis,json(constraint.evidence),scanId]);
    const activeKeys=[];
    for(const item of result.assertions){activeKeys.push(`${item.material_id}:${item.assertion}`);await db.query(`INSERT INTO official_product_material_assertions (source_id,product_id,product_url,product_url_hash,material_id,assertion,evidence,first_seen_scan_id,last_seen_scan_id)
      VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE product_id=COALESCE(VALUES(product_id),product_id),status='active',evidence=VALUES(evidence),last_seen_scan_id=VALUES(last_seen_scan_id)`,[catalog.source_id,product.product_id||null,productUrl,productHash,item.material_id,item.assertion,json(item.evidence),scanId,scanId]);}
    if(result.completeness==='complete')await db.query(`UPDATE official_product_material_assertions SET status='stale' WHERE source_id=? AND product_url_hash=? AND last_seen_scan_id<>?`,[catalog.source_id,productHash,scanId]);
    return {policy:constraint,assertions:activeKeys.length};
  }

  async function runScan(catalog,scanId,kind,body){
    const rule=kind==='catalog'?catalog.catalog_rule:catalog.product_subset_rule;if(!rule)fail('尚未配置产品材料子集规则',409,'PRODUCT_SUBSET_RULE_MISSING');validateRuleOrFail(rule,kind==='catalog'?'品牌材料总库规则':'产品材料子集规则');
    if(catalog.status==='frozen'&&catalog.frozen_rule_hash!==catalog.rule_hash)fail('冻结材料规则的哈希已变化，已拒绝执行',409,'FROZEN_MATERIAL_RULE_CHANGED');
    await markScan(scanId,{status:'running',started_at:new Date()});
    try{
      const cacheSeconds=number(body.cache_max_age_seconds,86400,0,604800),forceRefresh=body.force_refresh===true;let initialUrls=[],parentUrl=null;
      if(kind==='catalog')initialUrls=[catalog.source_url];
      else {
        const productUrl=canonicalUrl(body.product_url,catalog.base_url);parentUrl=productUrl;
        if(body.resource_url)initialUrls=[canonicalUrl(body.resource_url,productUrl)].filter(Boolean);
        else {
          const scope=pageScope(catalog,1),saved=await snapshot(catalog,productUrl,'product_material_entry',null,scope,cacheSeconds,forceRefresh),links=discoverLinks(saved.html,saved.final_url,rule.related_link_sources||[],new Set(catalog.allowed_hosts.map(String)));
          for(const link of links){await db.query(`INSERT INTO product_ingestion_related_resource_links (scan_id,source_id,parent_url,target_url,target_url_hash,resource_role,link_text,locator) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE link_text=VALUES(link_text),locator=VALUES(locator)`,[scanId,catalog.source_id,productUrl,link.url,digest(link.url),'product_material_subset',link.text,json(link.locator)]);initialUrls.push(link.url);}
          if(!initialUrls.length)fail('产品页没有发现符合规则的材料关联页面',409,'RELATED_MATERIAL_PAGE_NOT_FOUND');
        }
      }
      const result=await processPages({catalog,scanId,rule,initialUrls,parentUrl,kind,product:body,forceRefresh,cacheSeconds});
      if(kind==='product_subset')await persistProductRelations(catalog,scanId,body,result);
      const status=result.completeness==='complete'?'completed':'partial',evidence={failures:result.failures,bounded:result.bounded,policy:result.constraint||{mode:'open_world',basis:'system_default'}};
      await markScan(scanId,{status,completeness:result.completeness,cache_status:result.stats.cache_hits===result.stats.pages_succeeded?'hit':result.stats.cache_hits?'mixed':'miss',pages_attempted:result.stats.pages_attempted,pages_succeeded:result.stats.pages_succeeded,observations_found:result.stats.observations_found,materials_upserted:result.stats.materials_upserted,assets_archived:result.stats.assets_archived,evidence:json(evidence),finished_at:new Date()});
      if(kind==='catalog'){await db.query(`UPDATE official_brand_material_catalogs SET last_scan_id=?,last_complete_scan_id=${result.completeness==='complete'?'?':'last_complete_scan_id'},current_revision=current_revision+1 WHERE id=?`,result.completeness==='complete'?[scanId,scanId,catalog.id]:[scanId,catalog.id]);if(result.completeness==='complete'){await db.query("UPDATE official_brand_material_catalog_items SET status='stale' WHERE catalog_id=? AND membership_kind='catalog_listing' AND last_seen_scan_id<>?",[catalog.id,scanId]);await db.query(`UPDATE official_brand_materials material SET status=IF(
        EXISTS (SELECT 1 FROM official_brand_material_catalog_items membership WHERE membership.material_id=material.id AND membership.status='active') OR
        EXISTS (SELECT 1 FROM official_product_material_assertions assertion WHERE assertion.material_id=material.id AND assertion.status='active'),
        'active','stale') WHERE material.source_id=?`,[catalog.source_id]);}}
      return getScan(scanId);
    }catch(error){await markScan(scanId,{status:'failed',completeness:'unknown',failure_code:String(error.code||'MATERIAL_SCAN_FAILED').slice(0,80),last_error:String(error.message||error).slice(0,1000),finished_at:new Date()});throw error;}
  }

  async function getScan(id){const [rows]=await db.query('SELECT * FROM official_brand_material_scans WHERE id=?',[number(id,null,1)]);if(!rows[0])fail('材料扫描不存在',404);return {...rows[0],id:Number(rows[0].id),catalog_id:Number(rows[0].catalog_id),source_id:Number(rows[0].source_id),evidence:parse(rows[0].evidence,{})};}
  async function activateCatalog(id,body,actor){
    const catalog=await loadCatalog(id);if(catalog.status==='frozen'||catalog.status==='active')return catalog;
    if(body?.confirmed!==true)fail('请确认启用经过抽样检查的材料规则',400,'MATERIAL_RULE_ACTIVATION_REQUIRED');
    validateRuleOrFail(catalog.catalog_rule,'品牌材料总库规则');if(catalog.product_subset_rule)validateRuleOrFail(catalog.product_subset_rule,'产品材料子集规则');
    await db.query("UPDATE official_brand_material_catalogs SET status='active',approved_by=?,approved_at=NOW() WHERE id=?",[actor,catalog.id]);return loadCatalog(catalog.id);
  }
  async function queueCatalogScan(id,body,actor){
    const catalog=await loadCatalog(id);if(!['active','frozen'].includes(catalog.status)||catalog.source_status!=='active')fail('材料库规则或抓取来源未启用');
    const scanId=await createScan(catalog,'catalog',{resource_url:catalog.source_url},actor),options={...(body||{})};
    setImmediate(async()=>{
      try{
        const result=await runScan(catalog,scanId,'catalog',options);
        if(options.auto_freeze===true&&result.status==='completed')await db.query("UPDATE official_brand_material_catalogs SET status='frozen',frozen_rule_hash=rule_hash,validation_evidence=?,frozen_at=NOW(),approved_by=?,approved_at=NOW() WHERE id=? AND status='active'",[json({outcome:'PASS',reference:`official-material-scan:${scanId}`,scope:'fabric_leather_upholstery'}),actor,catalog.id]);
      }catch(error){console.error('Official material background scan failed:',{catalogId:catalog.id,scanId,code:error.code||error.name,message:error.message});}
    });
    return getScan(scanId);
  }
  async function listMaterials(query={}){const params=[],where=["material.status<>'deleted'"];if(query.source_id){where.push('material.source_id=?');params.push(number(query.source_id,null,1));}if(query.kind){where.push('material.kind=?');params.push(text(query.kind,120,'材料分类'));}if(query.series){where.push('material.series=?');params.push(text(query.series,200,'材料系列'));}const limit=number(query.limit,100,1,500),offset=number(query.offset,0,0);params.push(limit,offset);const [rows]=await db.query(`SELECT material.*,source.brand_name,
    COALESCE((SELECT JSON_ARRAYAGG(asset.storage_uri) FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id WHERE relation.material_id=material.id),JSON_ARRAY()) image_urls
    FROM official_brand_materials material JOIN product_ingestion_sources source ON source.id=material.source_id WHERE ${where.join(' AND ')} ORDER BY material.kind,material.series,material.code,material.name LIMIT ? OFFSET ?`,params);return rows.map(materialRow);}

  async function materialFacets(){
    const [brands]=await db.query(`SELECT source.id source_id,source.brand_name,COUNT(material.id) material_count,
      COUNT(DISTINCT CASE WHEN material.status='active' THEN material.id END) active_count,
      COUNT(DISTINCT asset_relation.material_id) swatch_count
      FROM product_ingestion_sources source JOIN official_brand_materials material ON material.source_id=source.id AND material.status<>'deleted'
      LEFT JOIN official_brand_material_assets asset_relation ON asset_relation.material_id=material.id
      GROUP BY source.id,source.brand_name ORDER BY source.brand_name`);
    const [kinds]=await db.query(`SELECT source_id,kind,COUNT(*) count FROM official_brand_materials
      WHERE status<>'deleted' AND kind IS NOT NULL GROUP BY source_id,kind ORDER BY source_id,count DESC,kind`);
    const [series]=await db.query(`SELECT source_id,series,COUNT(*) count FROM official_brand_materials
      WHERE status<>'deleted' AND series IS NOT NULL AND series<>'' GROUP BY source_id,series ORDER BY source_id,count DESC,series`);
    const [relations]=await db.query(`SELECT source_id,COUNT(*) product_count,
      SUM((SELECT COUNT(*) FROM official_product_material_assertions assertion WHERE assertion.source_id=constraint_row.source_id AND assertion.product_url_hash=constraint_row.product_url_hash AND assertion.status='active')) assertion_count
      FROM official_product_material_constraints constraint_row GROUP BY source_id`);
    return {brands:brands.map(row=>({...row,source_id:Number(row.source_id),material_count:Number(row.material_count||0),active_count:Number(row.active_count||0),swatch_count:Number(row.swatch_count||0)})),kinds:kinds.map(row=>({...row,source_id:Number(row.source_id),count:Number(row.count||0)})),series:series.map(row=>({...row,source_id:Number(row.source_id),count:Number(row.count||0)})),relations:relations.map(row=>({...row,source_id:Number(row.source_id),product_count:Number(row.product_count||0),assertion_count:Number(row.assertion_count||0)}))};
  }

  async function browseMaterials(query={}){
    const params=[],where=["material.status<>'deleted'"];
    if(query.source_id){where.push('material.source_id=?');params.push(number(query.source_id,null,1));}
    if(query.kind){where.push('material.kind=?');params.push(text(query.kind,120,'材料分类'));}
    if(query.series){where.push('material.series=?');params.push(text(query.series,200,'材料系列'));}
    if(query.status&&query.status!=='all'){where.push('material.status=?');params.push(text(query.status,24,'材料状态'));}
    if(query.q){const keyword=`%${text(query.q,200,'搜索词')}%`;where.push('(material.name LIKE ? OR material.code LIKE ? OR material.composition LIKE ? OR material.description LIKE ?)');params.push(keyword,keyword,keyword,keyword);}
    const limit=number(query.limit,48,1,100),offset=number(query.offset,0,0),filterSql=where.join(' AND ');
    const [countRows]=await db.query(`SELECT COUNT(*) total FROM official_brand_materials material WHERE ${filterSql}`,params);
    const pageParams=[...params,limit,offset],[rows]=await db.query(`SELECT material.*,source.brand_name,
      COALESCE((SELECT JSON_ARRAYAGG(asset.storage_uri) FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id WHERE relation.material_id=material.id),JSON_ARRAY()) image_urls,
      (SELECT COUNT(*) FROM official_product_material_assertions assertion WHERE assertion.material_id=material.id AND assertion.status='active') active_assertion_count,
      (SELECT COUNT(*) FROM official_brand_material_catalog_items membership WHERE membership.material_id=material.id AND membership.status='active') active_catalog_count
      FROM official_brand_materials material JOIN product_ingestion_sources source ON source.id=material.source_id
      WHERE ${filterSql} ORDER BY material.kind,material.series,material.code,material.name LIMIT ? OFFSET ?`,pageParams);
    return {items:rows.map(row=>({...materialRow(row),active_assertion_count:Number(row.active_assertion_count||0),active_catalog_count:Number(row.active_catalog_count||0)})),total:Number(countRows[0]?.total||0),limit,offset};
  }

  async function materialWorkbench(id){
    const materialId=number(id,null,1),material=await (async()=>{const [rows]=await db.query(`SELECT material.*,source.brand_name,
      COALESCE((SELECT JSON_ARRAYAGG(asset.storage_uri) FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id WHERE relation.material_id=material.id),JSON_ARRAY()) image_urls
      FROM official_brand_materials material JOIN product_ingestion_sources source ON source.id=material.source_id WHERE material.id=?`,[materialId]);if(!rows[0])fail('官方材料不存在',404);return materialRow(rows[0]);})();
    const [assets]=await db.query(`SELECT relation.id,relation.asset_role,relation.original_url,relation.evidence,relation.first_seen_scan_id,relation.last_seen_scan_id,
      asset.id asset_id,asset.storage_uri,asset.content_type,asset.byte_size,asset.content_hash
      FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id
      WHERE relation.material_id=? ORDER BY relation.id`,[materialId]);
    const [catalogs]=await db.query(`SELECT catalog.id,catalog.name,catalog.status,membership.membership_kind,membership.status membership_status,membership.evidence,membership.first_seen_scan_id,membership.last_seen_scan_id
      FROM official_brand_material_catalog_items membership JOIN official_brand_material_catalogs catalog ON catalog.id=membership.catalog_id
      WHERE membership.material_id=? ORDER BY catalog.id DESC`,[materialId]);
    const [relations]=await db.query(`SELECT assertion.assertion,assertion.status,assertion.evidence,assertion.first_seen_scan_id,assertion.last_seen_scan_id,
      assertion.product_id,assertion.product_url,constraint_row.policy_mode,constraint_row.policy_basis,
      COALESCE(product_by_id.id,product_by_url.id) resolved_product_id,COALESCE(product_by_id.name,product_by_url.name) product_name
      FROM official_product_material_assertions assertion
      LEFT JOIN official_product_material_constraints constraint_row ON constraint_row.source_id=assertion.source_id AND constraint_row.product_url_hash=assertion.product_url_hash
      LEFT JOIN public_product_library_products product_by_id ON product_by_id.id=assertion.product_id
      LEFT JOIN public_product_library_products product_by_url ON product_by_url.source_id=assertion.source_id AND product_by_url.source_url=assertion.product_url
      WHERE assertion.material_id=? ORDER BY assertion.status,assertion.product_url`,[materialId]);
    return {...material,assets:assets.map(row=>({...row,id:Number(row.id),asset_id:Number(row.asset_id),byte_size:Number(row.byte_size||0),first_seen_scan_id:Number(row.first_seen_scan_id),last_seen_scan_id:Number(row.last_seen_scan_id),evidence:parse(row.evidence,{})})),catalogs:catalogs.map(row=>({...row,id:Number(row.id),first_seen_scan_id:Number(row.first_seen_scan_id),last_seen_scan_id:Number(row.last_seen_scan_id),evidence:parse(row.evidence,{})})),product_relations:relations.map(row=>({...row,product_id:Number(row.product_id||0)||null,resolved_product_id:Number(row.resolved_product_id||0)||null,first_seen_scan_id:Number(row.first_seen_scan_id),last_seen_scan_id:Number(row.last_seen_scan_id),evidence:parse(row.evidence,{})}))};
  }

  async function listProductDeclarations(query={}){
    const params=[],where=['1=1'];if(query.source_id){where.push('constraint_row.source_id=?');params.push(number(query.source_id,null,1));}
    const limit=number(query.limit,100,1,200);params.push(limit);
    const [rows]=await db.query(`SELECT constraint_row.*,source.brand_name,
      COALESCE(product_by_id.id,product_by_url.id) resolved_product_id,COALESCE(product_by_id.name,product_by_url.name) product_name,
      SUM(CASE WHEN assertion.status='active' AND assertion.assertion='confirmed_available' THEN 1 ELSE 0 END) confirmed_available_count,
      SUM(CASE WHEN assertion.status='active' AND assertion.assertion='confirmed_unavailable' THEN 1 ELSE 0 END) confirmed_unavailable_count
      FROM official_product_material_constraints constraint_row JOIN product_ingestion_sources source ON source.id=constraint_row.source_id
      LEFT JOIN official_product_material_assertions assertion ON assertion.source_id=constraint_row.source_id AND assertion.product_url_hash=constraint_row.product_url_hash
      LEFT JOIN public_product_library_products product_by_id ON product_by_id.id=constraint_row.product_id
      LEFT JOIN public_product_library_products product_by_url ON product_by_url.source_id=constraint_row.source_id AND product_by_url.source_url=constraint_row.product_url
      WHERE ${where.join(' AND ')} GROUP BY constraint_row.id,source.brand_name,product_by_id.id,product_by_url.id ORDER BY constraint_row.id DESC LIMIT ?`,params);
    return rows.map(row=>({...row,id:Number(row.id),source_id:Number(row.source_id),product_id:Number(row.product_id||0)||null,resolved_product_id:Number(row.resolved_product_id||0)||null,revision:Number(row.revision||1),last_scan_id:Number(row.last_scan_id||0)||null,confirmed_available_count:Number(row.confirmed_available_count||0),confirmed_unavailable_count:Number(row.confirmed_unavailable_count||0),policy_evidence:parse(row.policy_evidence,null)}));
  }

  return {
    validateRule:validateMaterialRule,
    async saveCatalog(body,actor){const source=await loadSource(body.source_id),catalogKey=text(body.catalog_key,120,'材料库标识',true),[existingRows]=await db.query('SELECT id,status FROM official_brand_material_catalogs WHERE source_id=? AND catalog_key=?',[source.id,catalogKey]);if(existingRows[0]?.status==='frozen')fail('冻结的材料规则不能被覆盖，请创建新版本',409,'FROZEN_MATERIAL_RULE_IMMUTABLE');const catalogRule=body.catalog_rule,subsetRule=body.product_subset_rule||null;validateRuleOrFail(catalogRule,'品牌材料总库规则');if(subsetRule)validateRuleOrFail(subsetRule,'产品材料子集规则');const sourceUrl=canonicalUrl(body.source_url,source.base_url);if(!sourceUrl)fail('材料总库 URL 不合法',400);const allowed=new Set(source.allowed_hosts.map(String));if(!allowed.has(new URL(sourceUrl).hostname.toLowerCase()))fail('材料总库 URL 不在页面授权域名内',400);const status=body.status==='active'?'active':'draft';if(status==='active'&&body.confirmed!==true)fail('请确认启用品牌官方材料库规则',400);const ruleHash=digest(json(canonical({catalogRule,subsetRule})));const [result]=await db.query(`INSERT INTO official_brand_material_catalogs (source_id,catalog_key,name,source_url,source_url_hash,catalog_rule,product_subset_rule,rule_hash,status,created_by,approved_by,approved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),name=VALUES(name),source_url=VALUES(source_url),source_url_hash=VALUES(source_url_hash),catalog_rule=VALUES(catalog_rule),product_subset_rule=VALUES(product_subset_rule),rule_hash=VALUES(rule_hash),status=VALUES(status),approved_by=VALUES(approved_by),approved_at=VALUES(approved_at)`,[source.id,text(body.catalog_key,120,'材料库标识',true),text(body.name,200,'材料库名称',true),sourceUrl,digest(sourceUrl),json(catalogRule),json(subsetRule),ruleHash,status,actor,status==='active'?actor:null,status==='active'?new Date():null]);return loadCatalog(result.insertId);},
    async listCatalogs(query={}){const params=[],where=[];if(query.source_id){where.push('catalog.source_id=?');params.push(number(query.source_id,null,1));}const [rows]=await db.query(`SELECT catalog.*,source.brand_name FROM official_brand_material_catalogs catalog JOIN product_ingestion_sources source ON source.id=catalog.source_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY catalog.id DESC`,params);return rows.map(row=>({...row,id:Number(row.id),source_id:Number(row.source_id),catalog_rule:parse(row.catalog_rule,{}),product_subset_rule:parse(row.product_subset_rule,null)}));},
    getCatalog:loadCatalog,
    activateCatalog,
    async freezeCatalog(id,body,actor){const catalog=await loadCatalog(id);if(catalog.status==='frozen')return catalog;if(body.confirmation!=='冻结材料规则')fail('请输入“冻结材料规则”完成确认',400);validateRuleOrFail(catalog.catalog_rule,'品牌材料总库规则');if(catalog.product_subset_rule)validateRuleOrFail(catalog.product_subset_rule,'产品材料子集规则');const evidence=body.validation_evidence;if(!evidence||evidence.outcome!=='PASS'||!evidence.reference)fail('冻结前必须提供通过的沙箱验收依据',400,'MATERIAL_SANDBOX_EVIDENCE_REQUIRED');await db.query("UPDATE official_brand_material_catalogs SET status='frozen',frozen_rule_hash=rule_hash,validation_evidence=?,frozen_at=NOW(),approved_by=?,approved_at=NOW() WHERE id=?",[json(evidence),actor,catalog.id]);return loadCatalog(catalog.id);},
    async scanCatalog(id,body,actor){const catalog=await loadCatalog(id);if(!['active','frozen'].includes(catalog.status)||catalog.source_status!=='active')fail('材料库规则或抓取来源未启用');const scanId=await createScan(catalog,'catalog',{resource_url:catalog.source_url},actor);return runScan(catalog,scanId,'catalog',body||{});},
    queueCatalogScan,
    async scanProductSubset(id,body,actor){const catalog=await loadCatalog(id);if(!['active','frozen'].includes(catalog.status)||catalog.source_status!=='active')fail('材料库规则或抓取来源未启用');if(body.product_id){const [products]=await db.query('SELECT * FROM public_product_library_products WHERE id=?',[number(body.product_id,null,1)]);if(!products[0]||normalizeBrand(products[0].brand_name)!==normalizeBrand(catalog.brand_name))fail('产品不存在或不属于该品牌',404);body={...body,product_url:body.product_url||products[0].source_url};}const scanId=await createScan(catalog,'product_subset',body,actor);return runScan(catalog,scanId,'product_subset',body);},
    async listScans(query={}){const params=[],where=[];if(query.catalog_id){where.push('catalog_id=?');params.push(number(query.catalog_id,null,1));}if(query.source_id){where.push('source_id=?');params.push(number(query.source_id,null,1));}const limit=number(query.limit,50,1,200);params.push(limit);const [rows]=await db.query(`SELECT * FROM official_brand_material_scans ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT ?`,params);return rows.map(row=>({...row,id:Number(row.id),catalog_id:Number(row.catalog_id),source_id:Number(row.source_id),evidence:parse(row.evidence,{})}));},
    getScan,
    listMaterials,
    materialFacets,
    browseMaterials,
    materialWorkbench,
    listProductDeclarations,
    async getMaterial(id){const [rows]=await db.query(`SELECT material.*,source.brand_name,
      COALESCE((SELECT JSON_ARRAYAGG(asset.storage_uri) FROM official_brand_material_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id WHERE relation.material_id=material.id),JSON_ARRAY()) image_urls
      FROM official_brand_materials material JOIN product_ingestion_sources source ON source.id=material.source_id WHERE material.id=?`,[number(id,null,1)]);if(!rows[0])fail('官方材料不存在',404);return materialRow(rows[0]);},
    async productMaterials(input={}){let sourceId=input.source_id?number(input.source_id,null,1):null,productUrl=input.product_url?String(input.product_url):null,productId=input.product_id?number(input.product_id,null,1):null;if(productId){const [products]=await db.query('SELECT * FROM public_product_library_products WHERE id=?',[productId]);if(!products[0])fail('产品不存在',404);sourceId=Number(products[0].source_id);productUrl=products[0].source_url;}if(!sourceId||!productUrl)fail('需要产品 ID，或来源 ID 与产品 URL',400);productUrl=canonicalUrl(productUrl);if(!productUrl)fail('产品 URL 不合法',400);const hash=digest(productUrl),[constraints]=await db.query('SELECT * FROM official_product_material_constraints WHERE source_id=? AND product_url_hash=?',[sourceId,hash]),constraint=constraints[0]||{policy_mode:'open_world',policy_basis:'system_default',policy_evidence:null,revision:1};const materials=await listMaterials({source_id:sourceId,limit:input.limit||200,offset:input.offset||0}),[assertionRows]=await db.query('SELECT material_id,assertion,status,evidence,last_seen_scan_id FROM official_product_material_assertions WHERE source_id=? AND product_url_hash=?',[sourceId,hash]),byMaterial=new Map();for(const row of assertionRows){const id=Number(row.material_id);if(!byMaterial.has(id))byMaterial.set(id,[]);byMaterial.get(id).push({...row,evidence:parse(row.evidence,{})});}return {material_source:MATERIAL_SOURCE,product_id:productId,product_url:productUrl,constraint:{mode:constraint.policy_mode,basis:constraint.policy_basis,evidence:parse(constraint.policy_evidence,null),revision:Number(constraint.revision||1)},materials:materials.map(material=>{const assertions=byMaterial.get(material.id)||[];return {...material,assertions,...effectiveSelection(constraint.policy_mode,assertions)};})};},
  };
}

module.exports={createOfficialBrandMaterials,effectiveSelection,MATERIAL_SOURCE,POLICY_MODES,ASSERTIONS};
