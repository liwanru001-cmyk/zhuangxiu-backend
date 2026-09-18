'use strict';

const crypto=require('crypto');

function fail(message,status=400){const error=new Error(message);error.status=status;throw error;}
function id(value,label='ID'){const result=Number(value);if(!Number.isSafeInteger(result)||result<1)fail(`${label}不正确`);return result;}
function ids(value){const source=Array.isArray(value)?value:[],result=[...new Set(source.map(Number))];if(result.some(item=>!Number.isSafeInteger(item)||item<1)||result.length>20)fail('分类选择不正确');return result;}
function candidateIds(value){const source=Array.isArray(value)?value:[],result=[...new Set(source.map(Number))];if(!result.length||result.length>2000||result.some(item=>!Number.isSafeInteger(item)||item<1))fail('请选择 1 至 2000 个候选产品');return result;}
function csv(value){return String(value||'').split(',').map(Number).filter(item=>Number.isSafeInteger(item)&&item>0);}
function json(value,fallback=null){if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function actorName(actor){return String(actor?.username||actor?.name||actor||'admin').slice(0,80);}
function candidateVisual(payloadValue){
  const payload=json(payloadValue,{})||{},document=payload.product_document?.data||{},product=document.product||{},details=payload.product_details||{},configurations=Array.isArray(document.configurations)?document.configurations:Array.isArray(details.configurations)?details.configurations:[],assets=Array.isArray(document.assets)?document.assets:[],assetById=new Map(assets.map(item=>[String(item?.id),item])),firstConfiguration=configurations[0]||{};
  const firstBoundImage=Array.isArray(firstConfiguration.asset_ids)?firstConfiguration.asset_ids.map(value=>assetById.get(String(value))?.url).find(Boolean):null,legacyImages=[payload.cover_url,details.image_url,...(Array.isArray(details.image_urls)?details.image_urls:[]),firstConfiguration.image_url,...(Array.isArray(firstConfiguration.image_urls)?firstConfiguration.image_urls:[])].filter(Boolean),hero=assets.find(item=>item?.role==='hero'&&item?.url)?.url;
  return {product_name:String(payload.name||product.names?.primary||product.names?.zh||product.names?.en||'未提取名称').trim(),model_code:String(payload.model||payload.sku||product.model||product.identifiers?.model||product.identifiers?.sku||'').trim(),description:String(payload.description||product.description||details.description||'').trim(),cover_image_url:String(payload.cover_url||hero||firstBoundImage||legacyImages[0]||''),configuration_count:configurations.length,asset_count:new Set([...assets.map(item=>item?.url),...legacyImages].filter(Boolean)).size};
}

function createPublicProductTaxonomy(db){
  async function categories(conn=db){
    const [rows]=await conn.query(`SELECT category.id,category.parent_id,category.category_code code,category.name,category.level,category.sort_order,category.status,
      NOT EXISTS (SELECT 1 FROM public_product_categories child WHERE child.parent_id=category.id AND child.status='active') selectable
      FROM public_product_categories category WHERE category.status='active' ORDER BY category.level,category.sort_order,category.id`);
    return rows.map(row=>({...row,id:Number(row.id),parent_id:row.parent_id==null?null:Number(row.parent_id),level:Number(row.level),sort_order:Number(row.sort_order),selectable:Boolean(Number(row.selectable??1))}));
  }
  async function validateCategoryIds(conn,categoryIds){
    if(!categoryIds.length)return;
    const [rows]=await conn.query(`SELECT category.id FROM public_product_categories category WHERE category.status='active' AND category.id IN (${categoryIds.map(()=>'?').join(',')})
      AND NOT EXISTS (SELECT 1 FROM public_product_categories child WHERE child.parent_id=category.id AND child.status='active')`,categoryIds);
    if(rows.length!==categoryIds.length)fail('包含不存在、已停用或不可直接选择的标准分类');
  }
  async function classificationIssues(conn=db,taxonomyValue=null){
    const taxonomy=taxonomyValue||await categories(conn),byId=new Map(taxonomy.map(item=>[item.id,item]));
    const rootOf=value=>{let current=byId.get(value),guard=0;while(current?.parent_id&&guard++<10)current=byId.get(current.parent_id);return current;};
    const [rows]=await conn.query(`SELECT candidate.id,candidate.source_url,candidate.normalized_payload,candidate.classification_suggestion,candidate.classification_override,source.brand_name,
      (SELECT GROUP_CONCAT(CONCAT(assignment.category_id,':',assignment.assignment_type) ORDER BY assignment.category_id) FROM product_ingestion_candidate_categories assignment WHERE assignment.candidate_id=candidate.id) direct_assignments,
      (SELECT GROUP_CONCAT(DISTINCT mapping.category_id ORDER BY mapping.category_id) FROM product_ingestion_discovered_product_categories evidence JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id WHERE evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash) mapped_category_ids,
      (SELECT GROUP_CONCAT(DISTINCT source_category.name ORDER BY source_category.name SEPARATOR '、') FROM product_ingestion_discovered_product_categories evidence JOIN product_ingestion_source_categories source_category ON source_category.id=evidence.source_category_id WHERE evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash) source_category_names
      FROM product_ingestion_candidates candidate JOIN product_ingestion_sources source ON source.id=candidate.source_id
      WHERE candidate.validation_status='valid' AND candidate.published_product_id IS NULL ORDER BY candidate.id DESC LIMIT 2000`);
    const issues=[];
    for(const row of rows){
      const direct=String(row.direct_assignments||'').split(',').filter(Boolean).map(item=>{const [categoryId,type]=item.split(':');return {id:Number(categoryId),type};}),manual=direct.filter(item=>item.type==='manual'),system=direct.filter(item=>item.type!=='manual'),mapped=csv(row.mapped_category_ids),effective=manual.length?manual.map(item=>item.id):mapped.length?mapped:system.map(item=>item.id),classification=json(row.classification_override)||json(row.classification_suggestion)||{},selected=effective.map(value=>byId.get(value)).filter(Boolean),roots=[...new Set(selected.map(item=>rootOf(item.id)?.code).filter(Boolean))];
      let issue_type='';
      if(!selected.length)issue_type='unclassified';
      else if(selected.some(item=>!item.selectable))issue_type='parent_only';
      else if(roots.length>1)issue_type='conflict';
      else if(classification.product_type&&roots[0]&&classification.product_type!==roots[0])issue_type='incompatible';
      if(!issue_type)continue;
      const payload=json(row.normalized_payload,{})||{},document=payload.product_document?.data?.product||{},visual=candidateVisual(payload);
      issues.push({id:Number(row.id),brand_name:row.brand_name,...visual,source_url:row.source_url,source_categories:String(row.source_category_names||'').split('、').filter(Boolean),category_ids:effective,category_names:selected.map(item=>item.name),product_type:classification.product_type||payload.product_type||document.product_type||null,assignment_source:manual.length?'manual':mapped.length?'source':'system',issue_type});
    }
    return issues;
  }
  async function listGovernance(){
    const [sourceRows]=await db.query(`SELECT source_category.id,source_category.source_id,source.brand_name,source_category.external_key,source_category.name,source_category.source_url,MAX(source_category.evidence_type) evidence_type,MAX(CAST(source_category.evidence_payload AS CHAR)) evidence_payload,MAX(source_category.last_seen_at) last_seen_at,
      GROUP_CONCAT(DISTINCT mapping.category_id ORDER BY mapping.category_id) mapped_category_ids,
      COUNT(DISTINCT evidence.product_url_hash) discovered_products,COUNT(DISTINCT candidate.published_product_id) published_products
      FROM product_ingestion_source_categories source_category JOIN product_ingestion_sources source ON source.id=source_category.source_id
      LEFT JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=source_category.id
      LEFT JOIN product_ingestion_discovered_product_categories evidence ON evidence.source_category_id=source_category.id
      LEFT JOIN product_ingestion_candidates candidate ON candidate.job_id=evidence.job_id AND candidate.source_url_hash=evidence.product_url_hash
      GROUP BY source_category.id,source_category.source_id,source.brand_name,source_category.external_key,source_category.name,source_category.source_url
      ORDER BY (mapped_category_ids IS NULL) DESC,source.brand_name,source_category.name`);
    const sourceCategoryIds=sourceRows.map(row=>Number(row.id)),sampleRows=sourceCategoryIds.length?(await db.query(`SELECT evidence.source_category_id,candidate.id,candidate.source_url,candidate.normalized_payload FROM product_ingestion_discovered_product_categories evidence JOIN product_ingestion_candidates candidate ON candidate.job_id=evidence.job_id AND candidate.source_url_hash=evidence.product_url_hash WHERE evidence.source_category_id IN (${sourceCategoryIds.map(()=>'?').join(',')}) ORDER BY evidence.source_category_id,candidate.id DESC LIMIT 1000`,sourceCategoryIds))[0]:[],samplesByCategory=new Map();
    for(const row of sampleRows){const sourceCategoryId=Number(row.source_category_id),items=samplesByCategory.get(sourceCategoryId)||[];if(items.length<4)items.push({id:Number(row.id),source_url:row.source_url,...candidateVisual(row.normalized_payload)});samplesByCategory.set(sourceCategoryId,items);}
    const taxonomy=await categories(),issues=await classificationIssues(db,taxonomy);
    const sourceCategories=sourceRows.map(row=>({...row,id:Number(row.id),source_id:Number(row.source_id),evidence_payload:json(row.evidence_payload,{}),mapped_category_ids:csv(row.mapped_category_ids),discovered_products:Number(row.discovered_products||0),published_products:Number(row.published_products||0),samples:samplesByCategory.get(Number(row.id))||[]}));
    const counts=issues.reduce((result,item)=>{result[item.issue_type]=(result[item.issue_type]||0)+1;return result;},{});
    return {categories:taxonomy,source_categories:sourceCategories,issues,pending_classification:issues.length,overview:{pending_candidates:issues.length,unmapped_source_categories:sourceCategories.filter(item=>!item.mapped_category_ids.length).length,mapped_source_categories:sourceCategories.filter(item=>item.mapped_category_ids.length).length,manual_candidates:issues.filter(item=>item.assignment_source==='manual').length,issue_counts:counts}};
  }
  async function mappingImpact(sourceCategoryValue,body={}){
    const sourceCategoryId=id(sourceCategoryValue,'官网分类 ID'),categoryIds=ids(body.category_ids);if(!categoryIds.length)fail('官网分类至少要映射一个装筱窝标准分类');
    await validateCategoryIds(db,categoryIds);
    const [sourceRows]=await db.query('SELECT id,name FROM product_ingestion_source_categories WHERE id=?',[sourceCategoryId]);if(!sourceRows[0])fail('官网分类不存在',404);
    const [[counts]]=await db.query(`SELECT COUNT(DISTINCT candidate.id) affected_candidates,COUNT(DISTINCT candidate.published_product_id) affected_products,
      COUNT(DISTINCT override_record.product_id) skipped_overrides FROM product_ingestion_discovered_product_categories evidence
      JOIN product_ingestion_candidates candidate ON candidate.job_id=evidence.job_id AND candidate.source_url_hash=evidence.product_url_hash
      LEFT JOIN public_product_category_overrides override_record ON override_record.product_id=candidate.published_product_id WHERE evidence.source_category_id=?`,[sourceCategoryId]);
    return {source_category_id:sourceCategoryId,source_category_name:sourceRows[0].name,category_ids:categoryIds,affected_candidates:Number(counts?.affected_candidates||0),affected_products:Number(counts?.affected_products||0),skipped_overrides:Number(counts?.skipped_overrides||0)};
  }
  async function saveSourceMapping(sourceCategoryValue,body,actor){
    if(body.confirmed!==true)fail('请先确认分类映射的影响范围');
    const preview=await mappingImpact(sourceCategoryValue,body),sourceCategoryId=preview.source_category_id,categoryIds=preview.category_ids,conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{
      await conn.beginTransaction();transaction=true;
      const [sourceRows]=await conn.query('SELECT id FROM product_ingestion_source_categories WHERE id=? FOR UPDATE',[sourceCategoryId]);if(!sourceRows[0])fail('官网分类不存在',404);await validateCategoryIds(conn,categoryIds);
      const [previousRows]=await conn.query('SELECT category_id FROM product_ingestion_category_mappings WHERE source_category_id=? ORDER BY category_id',[sourceCategoryId]),previousIds=previousRows.map(row=>Number(row.category_id));
      const [productRows]=await conn.query(`SELECT DISTINCT candidate.published_product_id id FROM product_ingestion_discovered_product_categories evidence JOIN product_ingestion_candidates candidate ON candidate.job_id=evidence.job_id AND candidate.source_url_hash=evidence.product_url_hash LEFT JOIN public_product_category_overrides override_record ON override_record.product_id=candidate.published_product_id WHERE evidence.source_category_id=? AND candidate.published_product_id IS NOT NULL AND override_record.product_id IS NULL`,[sourceCategoryId]),productIds=productRows.map(row=>Number(row.id));
      await conn.query('DELETE FROM product_ingestion_category_mappings WHERE source_category_id=?',[sourceCategoryId]);
      for(const categoryId of categoryIds)await conn.query('INSERT INTO product_ingestion_category_mappings (source_category_id,category_id,approved_by,approved_at) VALUES (?,?,?,NOW())',[sourceCategoryId,categoryId,actorName(actor)]);
      if(productIds.length){
        const placeholders=productIds.map(()=>'?').join(',');
        await conn.query(`DELETE FROM public_product_category_relations WHERE product_id IN (${placeholders}) AND assignment_type IN ('source','system')`,productIds);
        await conn.query(`INSERT IGNORE INTO public_product_category_relations (product_id,category_id,source_category_id,assignment_type)
          SELECT DISTINCT candidate.published_product_id,mapping.category_id,evidence.source_category_id,'source' FROM product_ingestion_candidates candidate
          JOIN product_ingestion_discovered_product_categories evidence ON evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id
          WHERE candidate.published_product_id IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories direct WHERE direct.candidate_id=candidate.id AND direct.assignment_type='manual')`,productIds);
        await conn.query(`INSERT IGNORE INTO public_product_category_relations (product_id,category_id,source_category_id,assignment_type)
          SELECT candidate.published_product_id,direct.category_id,NULL,'system' FROM product_ingestion_candidates candidate JOIN product_ingestion_candidate_categories direct ON direct.candidate_id=candidate.id AND direct.assignment_type='system'
          WHERE candidate.published_product_id IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM product_ingestion_discovered_product_categories evidence JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id WHERE evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash)`,productIds);
      }
      await conn.query(`INSERT INTO product_ingestion_category_mapping_changes (source_category_id,previous_category_ids,new_category_ids,affected_candidates,affected_products,skipped_overrides,change_reason,changed_by,changed_at) VALUES (?,?,?,?,?,?,?,?,NOW())`,[sourceCategoryId,JSON.stringify(previousIds),JSON.stringify(categoryIds),preview.affected_candidates,preview.affected_products,preview.skipped_overrides,String(body.reason||'').trim().slice(0,300)||null,actorName(actor)]);
      await conn.commit();transaction=false;return {...preview,previous_category_ids:previousIds};
    }catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
  }
  async function candidateCategoryImpact(body={},conn=db,lock=false){
    const selectedCandidateIds=candidateIds(body.candidate_ids),categoryIds=ids(body.category_ids);if(!categoryIds.length)fail('请选择一个可发布的标准细类');
    await validateCategoryIds(conn,categoryIds);
    const placeholders=selectedCandidateIds.map(()=>'?').join(','),[rows]=await conn.query(`SELECT candidate.id,candidate.normalized_payload,candidate.validation_status,candidate.published_product_id,source.brand_name,
      EXISTS (SELECT 1 FROM product_ingestion_candidate_categories manual_assignment WHERE manual_assignment.candidate_id=candidate.id AND manual_assignment.assignment_type='manual') has_manual
      FROM product_ingestion_candidates candidate JOIN product_ingestion_sources source ON source.id=candidate.source_id
      WHERE candidate.id IN (${placeholders}) ORDER BY candidate.id DESC${lock?' FOR UPDATE':''}`,selectedCandidateIds);
    const found=new Set(rows.map(row=>Number(row.id))),overwriteManual=body.overwrite_manual===true,eligible=rows.filter(row=>row.validation_status==='valid'&&!row.published_product_id),protectedRows=eligible.filter(row=>Number(row.has_manual)&&!overwriteManual),affected=eligible.filter(row=>!Number(row.has_manual)||overwriteManual),brands={};
    for(const row of affected)brands[row.brand_name]=(brands[row.brand_name]||0)+1;
    return {candidate_ids:selectedCandidateIds,category_ids:categoryIds,requested_count:selectedCandidateIds.length,affected_candidates:affected.length,skipped_manual:protectedRows.length,skipped_unavailable:selectedCandidateIds.length-found.size+(rows.length-eligible.length),overwrite_manual:overwriteManual,brands:Object.entries(brands).map(([brand_name,count])=>({brand_name,count})).sort((a,b)=>b.count-a.count||a.brand_name.localeCompare(b.brand_name)),sample:affected.slice(0,10).map(row=>{const payload=json(row.normalized_payload,{})||{},document=payload.product_document?.data?.product||{};return {id:Number(row.id),brand_name:row.brand_name,product_name:payload.name||document.names?.primary||document.names?.zh||'未提取名称'};}),affected_ids:affected.map(row=>Number(row.id))};
  }
  async function applyCandidateCategories(body,actor){
    if(body.confirmed!==true)fail('请先确认批量分类的影响范围');
    const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{
      await conn.beginTransaction();transaction=true;
      const preview=await candidateCategoryImpact(body,conn,true);if(!preview.affected_candidates)fail('没有可更新的候选产品',409);
      const placeholders=preview.affected_ids.map(()=>'?').join(','),[previousRows]=await conn.query(`SELECT candidate_id,category_id FROM product_ingestion_candidate_categories WHERE candidate_id IN (${placeholders}) ORDER BY candidate_id,category_id`,preview.affected_ids),previousByCandidate=new Map();
      for(const row of previousRows){const candidateId=Number(row.candidate_id);if(!previousByCandidate.has(candidateId))previousByCandidate.set(candidateId,[]);previousByCandidate.get(candidateId).push(Number(row.category_id));}
      const batchKey=crypto.randomUUID(),changedBy=actorName(actor),reason=String(body.reason||'Web 分类治理批量处理').trim().slice(0,300)||null;
      await conn.query(`DELETE FROM product_ingestion_candidate_categories WHERE candidate_id IN (${placeholders})`,preview.affected_ids);
      const assignments=preview.affected_ids.flatMap(candidateId=>preview.category_ids.map(categoryId=>[candidateId,categoryId,changedBy])),assignmentParams=assignments.flat();
      await conn.query(`INSERT INTO product_ingestion_candidate_categories (candidate_id,category_id,assigned_by,assigned_at,assignment_type) VALUES ${assignments.map(()=>"(?,?,?,NOW(),'manual')").join(',')}`,assignmentParams);
      const audits=preview.affected_ids.map(candidateId=>[batchKey,candidateId,JSON.stringify(previousByCandidate.get(candidateId)||[]),JSON.stringify(preview.category_ids),reason,changedBy]),auditParams=audits.flat();
      await conn.query(`INSERT INTO product_ingestion_candidate_category_changes (batch_key,candidate_id,previous_category_ids,new_category_ids,change_reason,changed_by,changed_at) VALUES ${audits.map(()=>'(?,?,?,?,?,?,NOW())').join(',')}`,auditParams);
      await conn.query(`UPDATE product_ingestion_candidates SET review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id IN (${placeholders})`,preview.affected_ids);
      await conn.commit();transaction=false;return {...preview,batch_key:batchKey,affected_ids:undefined};
    }catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
  }
  async function effectiveCandidateCategories(candidateValue){
    const candidateId=id(candidateValue,'候选 ID');
    const [rows]=await db.query(`SELECT DISTINCT category.id,category.parent_id,category.category_code code,category.name,category.level,category.sort_order,chosen.assignment_type
      FROM product_ingestion_candidates candidate JOIN (
        SELECT direct.candidate_id,direct.category_id,direct.assignment_type FROM product_ingestion_candidate_categories direct WHERE direct.candidate_id=? AND direct.assignment_type='manual'
        UNION ALL SELECT ?,mapping.category_id,'source' FROM product_ingestion_candidates current JOIN product_ingestion_discovered_product_categories evidence ON evidence.job_id=current.job_id AND evidence.product_url_hash=current.source_url_hash JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id WHERE current.id=? AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories manual_assignment WHERE manual_assignment.candidate_id=current.id AND manual_assignment.assignment_type='manual')
        UNION ALL SELECT direct.candidate_id,direct.category_id,direct.assignment_type FROM product_ingestion_candidate_categories direct WHERE direct.candidate_id=? AND direct.assignment_type='system' AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories manual_assignment WHERE manual_assignment.candidate_id=direct.candidate_id AND manual_assignment.assignment_type='manual') AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidates current JOIN product_ingestion_discovered_product_categories evidence ON evidence.job_id=current.job_id AND evidence.product_url_hash=current.source_url_hash JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id WHERE current.id=direct.candidate_id)
      ) chosen ON chosen.candidate_id=candidate.id JOIN public_product_categories category ON category.id=chosen.category_id AND category.status='active' WHERE candidate.id=? ORDER BY category.level,category.sort_order`,[candidateId,candidateId,candidateId,candidateId,candidateId]);
    return rows.map(row=>({...row,id:Number(row.id),parent_id:row.parent_id==null?null:Number(row.parent_id),level:Number(row.level)}));
  }
  async function setCandidateCategories(candidateValue, body, actor) {
    const candidateId=id(candidateValue,'候选 ID'),categoryIds=ids(body.category_ids);if(!categoryIds.length)fail('候选至少需要一个标准分类');
    const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{
      if(typeof conn.beginTransaction==='function'){await conn.beginTransaction();transaction=true;}
      const [candidateRows]=await conn.query('SELECT id,published_product_id FROM product_ingestion_candidates WHERE id=? FOR UPDATE',[candidateId]);if(!candidateRows[0])fail('候选不存在',404);if(candidateRows[0].published_product_id)fail('候选已经发布，请在正式产品中调整分类',409);
      await validateCategoryIds(conn,categoryIds);await conn.query('DELETE FROM product_ingestion_candidate_categories WHERE candidate_id=?',[candidateId]);
      for(const categoryId of categoryIds)await conn.query(`INSERT INTO product_ingestion_candidate_categories (candidate_id,category_id,assigned_by,assigned_at,assignment_type) VALUES (?,?,?,NOW(),'manual')`,[candidateId,categoryId,actorName(actor)]);
      await conn.query('UPDATE product_ingestion_candidates SET manual_revision=manual_revision+1 WHERE id=?',[candidateId]);
      if(transaction){await conn.commit();transaction=false;}
    }catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
    return effectiveCandidateCategories(candidateId);
  }
  async function setProductCategories(productValue,body,actor){
    const productId=id(productValue,'产品 ID'),categoryIds=ids(body.category_ids);if(!categoryIds.length)fail('正式产品至少需要一个标准分类');await validateCategoryIds(db,categoryIds);const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{await conn.beginTransaction();transaction=true;const [rows]=await conn.query('SELECT id FROM public_product_library_products WHERE id=? FOR UPDATE',[productId]);if(!rows[0])fail('正式产品不存在',404);await conn.query('DELETE FROM public_product_category_relations WHERE product_id=?',[productId]);for(const categoryId of categoryIds)await conn.query(`INSERT INTO public_product_category_relations (product_id,category_id,source_category_id,assignment_type) VALUES (?,?,NULL,'manual')`,[productId,categoryId]);await conn.query(`INSERT INTO public_product_category_overrides (product_id,updated_by,updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,[productId,actorName(actor)]);await conn.commit();transaction=false;return {product_id:productId,category_ids:categoryIds,override:true};}catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
  }
  async function resetProductCategories(productValue){
    const productId=id(productValue,'产品 ID'),conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{await conn.beginTransaction();transaction=true;const [rows]=await conn.query('SELECT id FROM public_product_library_products WHERE id=? FOR UPDATE',[productId]);if(!rows[0])fail('正式产品不存在',404);await conn.query('DELETE FROM public_product_category_overrides WHERE product_id=?',[productId]);await conn.query('DELETE FROM public_product_category_relations WHERE product_id=?',[productId]);await conn.query(`INSERT IGNORE INTO public_product_category_relations (product_id,category_id,source_category_id,assignment_type) SELECT DISTINCT ?,mapping.category_id,evidence.source_category_id,'source' FROM product_ingestion_candidates candidate JOIN product_ingestion_discovered_product_categories evidence ON evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id WHERE candidate.published_product_id=? AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories manual_assignment WHERE manual_assignment.candidate_id=candidate.id AND manual_assignment.assignment_type='manual')`,[productId,productId]);const [[count]]=await conn.query('SELECT COUNT(*) count FROM public_product_category_relations WHERE product_id=?',[productId]);if(!Number(count.count))fail('该产品没有可恢复的官网分类映射',409);await conn.commit();transaction=false;return {product_id:productId,override:false,category_count:Number(count.count)};}catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
  }
  return {categories,listGovernance,mappingImpact,saveSourceMapping,candidateCategoryImpact,applyCandidateCategories,effectiveCandidateCategories,setCandidateCategories,setProductCategories,resetProductCategories};
}

module.exports={createPublicProductTaxonomy};
