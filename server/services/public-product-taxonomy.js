'use strict';

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function id(value, label = 'ID') { const result=Number(value); if(!Number.isSafeInteger(result)||result<1)fail(`${label}不正确`); return result; }
function ids(value) { const source=Array.isArray(value)?value:[]; const result=[...new Set(source.map(Number))]; if(result.some(item=>!Number.isSafeInteger(item)||item<1)||result.length>20)fail('分类选择不正确'); return result; }
function csv(value) { return String(value || '').split(',').map(Number).filter(Number.isSafeInteger); }

function createPublicProductTaxonomy(db) {
  async function categories(conn = db) {
    const [rows]=await conn.query(`SELECT id,parent_id,category_code code,name,level,sort_order,status FROM public_product_categories WHERE status='active' ORDER BY level,sort_order,id`);
    return rows.map(row=>({...row,id:Number(row.id),parent_id:row.parent_id==null?null:Number(row.parent_id),level:Number(row.level),sort_order:Number(row.sort_order)}));
  }
  async function validateCategoryIds(conn, categoryIds) {
    if (!categoryIds.length) return;
    const [rows]=await conn.query(`SELECT id FROM public_product_categories WHERE status='active' AND id IN (${categoryIds.map(()=>'?').join(',')})`,categoryIds);
    if(rows.length!==categoryIds.length)fail('包含不存在或已停用的标准分类');
  }
  async function listGovernance() {
    const [sourceRows]=await db.query(
      `SELECT source_category.id,source_category.source_id,source.brand_name,source_category.external_key,source_category.name,source_category.source_url,
       GROUP_CONCAT(DISTINCT mapping.category_id ORDER BY mapping.category_id) mapped_category_ids,
       COUNT(DISTINCT evidence.product_url_hash) discovered_products,
       COUNT(DISTINCT candidate.published_product_id) published_products
       FROM product_ingestion_source_categories source_category
       JOIN product_ingestion_sources source ON source.id=source_category.source_id
       LEFT JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=source_category.id
       LEFT JOIN product_ingestion_discovered_product_categories evidence ON evidence.source_category_id=source_category.id
       LEFT JOIN product_ingestion_candidates candidate ON candidate.job_id=evidence.job_id AND candidate.source_url_hash=evidence.product_url_hash
       GROUP BY source_category.id,source_category.source_id,source.brand_name,source_category.external_key,source_category.name,source_category.source_url
       ORDER BY source.brand_name,source_category.external_key`
    );
    const [[pending]]=await db.query(
      `SELECT COUNT(*) count FROM product_ingestion_candidates candidate
       WHERE candidate.validation_status='valid' AND candidate.published_product_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories manual_assignment WHERE manual_assignment.candidate_id=candidate.id)
       AND NOT EXISTS (SELECT 1 FROM product_ingestion_discovered_product_categories evidence
         JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id
         WHERE evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash)`
    );
    return { categories:await categories(), source_categories:sourceRows.map(row=>({...row,id:Number(row.id),source_id:Number(row.source_id),mapped_category_ids:csv(row.mapped_category_ids),discovered_products:Number(row.discovered_products||0),published_products:Number(row.published_products||0)})), pending_classification:Number(pending?.count||0) };
  }
  async function saveSourceMapping(sourceCategoryValue, body, actor) {
    const sourceCategoryId=id(sourceCategoryValue,'官网分类 ID'), categoryIds=ids(body.category_ids);
    if(!categoryIds.length)fail('官网分类至少要映射一个装筱窝标准分类');
    const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try {
      await conn.beginTransaction();transaction=true;
      const [sourceRows]=await conn.query('SELECT id FROM product_ingestion_source_categories WHERE id=? FOR UPDATE',[sourceCategoryId]);if(!sourceRows[0])fail('官网分类不存在',404);
      await validateCategoryIds(conn,categoryIds);
      await conn.query('DELETE FROM public_product_category_relations WHERE source_category_id=? AND assignment_type=\'source\'',[sourceCategoryId]);
      await conn.query('DELETE FROM product_ingestion_category_mappings WHERE source_category_id=?',[sourceCategoryId]);
      for(const categoryId of categoryIds)await conn.query(`INSERT INTO product_ingestion_category_mappings (source_category_id,category_id,approved_by,approved_at) VALUES (?,?,?,NOW())`,[sourceCategoryId,categoryId,String(actor).slice(0,80)]);
      await conn.query(
        `INSERT IGNORE INTO public_product_category_relations (product_id,category_id,source_category_id,assignment_type)
         SELECT DISTINCT candidate.published_product_id,mapping.category_id,evidence.source_category_id,'source'
         FROM product_ingestion_discovered_product_categories evidence
         JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id
         JOIN product_ingestion_candidates candidate ON candidate.job_id=evidence.job_id AND candidate.source_url_hash=evidence.product_url_hash
         LEFT JOIN public_product_category_overrides override_record ON override_record.product_id=candidate.published_product_id
         WHERE evidence.source_category_id=? AND candidate.published_product_id IS NOT NULL AND override_record.product_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories direct_assignment WHERE direct_assignment.candidate_id=candidate.id)`,
        [sourceCategoryId]
      );
      await conn.commit();transaction=false;return { source_category_id:sourceCategoryId,category_ids:categoryIds };
    } catch(error){if(transaction)await conn.rollback();throw error;} finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
  }
  async function effectiveCandidateCategories(candidateValue) {
    const candidateId=id(candidateValue,'候选 ID');
    const [rows]=await db.query(
      `SELECT DISTINCT category.id,category.parent_id,category.category_code code,category.name,category.level,category.sort_order,
       COALESCE(manual_assignment.assignment_type,'source') assignment_type
       FROM product_ingestion_candidates candidate
       JOIN public_product_categories category ON category.status='active' AND (
         category.id IN (SELECT category_id FROM product_ingestion_candidate_categories WHERE candidate_id=candidate.id)
         OR (NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories direct_assignment WHERE direct_assignment.candidate_id=candidate.id)
           AND category.id IN (SELECT mapping.category_id FROM product_ingestion_discovered_product_categories evidence JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id WHERE evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash))
       )
       LEFT JOIN product_ingestion_candidate_categories manual_assignment ON manual_assignment.candidate_id=candidate.id AND manual_assignment.category_id=category.id
       WHERE candidate.id=? ORDER BY category.level,category.sort_order`,[candidateId]);
    return rows.map(row=>({...row,id:Number(row.id),parent_id:row.parent_id==null?null:Number(row.parent_id),level:Number(row.level)}));
  }
  async function setCandidateCategories(candidateValue, body, actor) {
    const candidateId=id(candidateValue,'候选 ID'),categoryIds=ids(body.category_ids);if(!categoryIds.length)fail('候选至少需要一个标准分类');
    const [candidateRows]=await db.query('SELECT id,published_product_id FROM product_ingestion_candidates WHERE id=?',[candidateId]);if(!candidateRows[0])fail('候选不存在',404);if(candidateRows[0].published_product_id)fail('候选已经发布，请在正式产品中调整分类',409);
    await validateCategoryIds(db,categoryIds);await db.query('DELETE FROM product_ingestion_candidate_categories WHERE candidate_id=?',[candidateId]);
    for(const categoryId of categoryIds)await db.query(`INSERT INTO product_ingestion_candidate_categories (candidate_id,category_id,assigned_by,assigned_at,assignment_type) VALUES (?,?,?,NOW(),'manual')`,[candidateId,categoryId,String(actor).slice(0,80)]);
    return effectiveCandidateCategories(candidateId);
  }
  async function setProductCategories(productValue, body, actor) {
    const productId=id(productValue,'产品 ID'),categoryIds=ids(body.category_ids);if(!categoryIds.length)fail('正式产品至少需要一个标准分类');
    await validateCategoryIds(db,categoryIds);const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{await conn.beginTransaction();transaction=true;const [rows]=await conn.query('SELECT id FROM public_product_library_products WHERE id=? FOR UPDATE',[productId]);if(!rows[0])fail('正式产品不存在',404);await conn.query('DELETE FROM public_product_category_relations WHERE product_id=?',[productId]);for(const categoryId of categoryIds)await conn.query(`INSERT INTO public_product_category_relations (product_id,category_id,source_category_id,assignment_type) VALUES (?,?,NULL,'manual')`,[productId,categoryId]);await conn.query(`INSERT INTO public_product_category_overrides (product_id,updated_by,updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`,[productId,String(actor).slice(0,80)]);await conn.commit();transaction=false;return {product_id:productId,category_ids:categoryIds,override:true};}catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
  }
  async function resetProductCategories(productValue) {
    const productId=id(productValue,'产品 ID'),conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
    try{await conn.beginTransaction();transaction=true;const [rows]=await conn.query('SELECT id FROM public_product_library_products WHERE id=? FOR UPDATE',[productId]);if(!rows[0])fail('正式产品不存在',404);await conn.query('DELETE FROM public_product_category_overrides WHERE product_id=?',[productId]);await conn.query('DELETE FROM public_product_category_relations WHERE product_id=?',[productId]);await conn.query(`INSERT IGNORE INTO public_product_category_relations (product_id,category_id,source_category_id,assignment_type) SELECT DISTINCT ?,mapping.category_id,evidence.source_category_id,'source' FROM product_ingestion_candidates candidate JOIN product_ingestion_discovered_product_categories evidence ON evidence.job_id=candidate.job_id AND evidence.product_url_hash=candidate.source_url_hash JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id WHERE candidate.published_product_id=?`,[productId,productId]);const [[count]]=await conn.query('SELECT COUNT(*) count FROM public_product_category_relations WHERE product_id=?',[productId]);if(!Number(count.count))fail('该产品没有可恢复的官网分类映射',409);await conn.commit();transaction=false;return {product_id:productId,override:false,category_count:Number(count.count)};}catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
  }
  return { categories,listGovernance,saveSourceMapping,effectiveCandidateCategories,setCandidateCategories,setProductCategories,resetProductCategories };
}

module.exports={createPublicProductTaxonomy};
