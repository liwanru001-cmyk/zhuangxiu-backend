'use strict';

const crypto = require('crypto');
const { normalizeDetails } = require('./product-details');
const { assertProductDocumentV2 } = require('./product-schema-v2');
const { archiveProductAssets } = require('./public-product-assets');
const { linkOfficialMaterialsToProduct } = require('./official-material-selection');

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function numberId(value, label = 'ID') { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) fail(`${label}不正确`); return id; }
function parseJson(value) { if (value == null || typeof value === 'object') return value; try { return JSON.parse(value); } catch (_) { return null; } }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function actorName(value) { return String(value || 'admin').trim().slice(0, 80) || 'admin'; }

function mapProduct(row) {
  return {
    ...row,
    id: Number(row.id),
    source_id: Number(row.source_id),
    current_version_id: Number(row.current_version_id),
    version_id: Number(row.version_id || row.current_version_id),
    version_no: Number(row.version_no),
    configuration_count: Number(row.configuration_count || 0),
    asset_count: Number(row.asset_count || 0),
    product_payload: parseJson(row.product_payload),
    category_codes: String(row.category_codes || '').split(',').filter(Boolean),
    category_names: String(row.category_names || '').split(',').filter(Boolean),
  };
}

function productIds(values) {
  const ids=[...new Set((Array.isArray(values)?values:[]).map(Number).filter(value=>Number.isSafeInteger(value)&&value>0))];
  if(!ids.length)fail('请选择需要处理的产品');
  if(ids.length>100)fail('单次最多处理100个产品');
  return ids;
}

function validateCandidate(candidate) {
  if (!candidate) fail('候选产品不存在', 404);
  if (candidate.validation_status !== 'valid') fail('只有结构校验有效的候选才能发布', 409);
  if (candidate.review_status !== 'approved') fail('候选必须先人工审核通过', 409);
  const payload = parseJson(candidate.normalized_payload);
  if (!payload) fail('候选缺少标准产品数据', 409);
  if(payload.product_document){
    try { assertProductDocumentV2(payload.product_document); }
    catch (error) { fail(`Product Schema v2 校验失败：${error.message}`, 409); }
    const document=payload.product_document,primary=document.data.product.names.primary;
    if(!primary||document.field_status['/product/names/primary']?.status!=='provided')fail('产品主名称没有官网证据',409);
    const blocking=Object.entries(document.field_status).filter(([,value])=>['extraction_failed','ambiguous'].includes(value.status));
    if(blocking.length)fail(`产品仍有 ${blocking.length} 个字段需要修正，不能发布`,409);
    for(const configuration of document.data.configurations)if(!configuration.name&&!configuration.code)fail('款型缺少名称和型号，不能发布',409);
  }else{
    if(!payload.product_details)fail('候选缺少标准产品数据',409);
    payload.product_details = normalizeDetails(payload.product_details, payload.product_type);
    if (!Array.isArray(payload.product_details.configurations) || !payload.product_details.configurations.length) fail('产品没有可发布的配置', 409);
  }
  return payload;
}
function payloadConfigurations(payload){return payload.product_document?.data?.configurations||payload.product_details?.configurations||[];}
function payloadModel(payload){return payload.product_document?.data?.product?.model||payload.product_details?.model||'';}
function payloadSourceUrl(payload){return payload.product_document?.data?.product?.source_url||payload.product_details?.source_url||'';}

async function recordAssets(conn, versionId, assets) {
  for (const asset of assets) {
    const [stored] = await conn.query(
      `INSERT INTO public_product_library_assets
       (content_hash,storage_uri,original_url,content_type,byte_size)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [asset.contentHash, asset.storageUri, asset.originalUrl, asset.contentType, asset.byteSize]
    );
    await conn.query(
      `INSERT INTO public_product_library_version_assets
       (version_id,asset_id,asset_role,payload_path,original_url)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE asset_id=VALUES(asset_id),asset_role=VALUES(asset_role),original_url=VALUES(original_url)`,
      [versionId, stored.insertId, asset.role, asset.payloadPath, asset.originalUrl]
    );
  }
}

function createPublicProductLibrary(db, options = {}) {
  const archiveAssets = options.archiveProductAssets || archiveProductAssets;
  async function linkMaterials(conn,productId){
    try{return await linkOfficialMaterialsToProduct(conn,productId);}
    catch(error){if(options.strictMaterialLinking)throw error;return {linked:false,reason:error.code||'link_failed'};}
  }

  async function candidateCategories(conn, candidate) {
    const [rows] = await conn.query(
      `SELECT manual_assignment.category_id,NULL source_category_id,manual_assignment.assignment_type
       FROM product_ingestion_candidate_categories manual_assignment WHERE manual_assignment.candidate_id=?
       UNION ALL
       SELECT mapping.category_id,evidence.source_category_id,'source' assignment_type
       FROM product_ingestion_discovered_product_categories evidence
       JOIN product_ingestion_category_mappings mapping ON mapping.source_category_id=evidence.source_category_id
       WHERE evidence.job_id=? AND evidence.product_url_hash=?
       AND NOT EXISTS (SELECT 1 FROM product_ingestion_candidate_categories direct_assignment WHERE direct_assignment.candidate_id=?)`,
      [candidate.id, candidate.job_id, candidate.source_url_hash, candidate.id]
    );
    const unique = new Map();
    for (const row of rows) {
      const key=Number(row.category_id), current=unique.get(key);
      if (!current || row.assignment_type === 'manual') unique.set(key, { category_id:key, source_category_id:row.source_category_id==null?null:Number(row.source_category_id), assignment_type:row.assignment_type });
    }
    if (!unique.size) fail('候选尚未完成标准分类，不能发布', 409);
    return [...unique.values()];
  }

  async function attachCategories(conn, productId, classifications) {
    const [overrides] = await conn.query('SELECT product_id FROM public_product_category_overrides WHERE product_id=?', [productId]);
    if (overrides[0]) return;
    for (const item of classifications) {
      await conn.query(
        `INSERT IGNORE INTO public_product_category_relations
         (product_id,category_id,source_category_id,assignment_type) VALUES (?,?,?,?)`,
        [productId,item.category_id,item.source_category_id,item.assignment_type]
      );
    }
  }

  async function publishCandidate(candidateIdValue, actor) {
    const candidateId = numberId(candidateIdValue, '候选 ID');
    const conn = typeof db.getConnection === 'function' ? await db.getConnection() : db;
    let transaction = false;
    try {
      const [preparedRows] = await conn.query(
        `SELECT candidate.*,source.brand_name source_brand,source.base_url,source.allowed_hosts,source.allowed_asset_hosts,source.status source_status,source.request_interval_ms,job.status job_status
         FROM product_ingestion_candidates candidate
         JOIN product_ingestion_sources source ON source.id=candidate.source_id
         JOIN product_ingestion_jobs job ON job.id=candidate.job_id
         WHERE candidate.id=?`,
        [candidateId]
      );
      const prepared = preparedRows[0];
      if (!prepared) fail('候选产品不存在', 404);
      if (prepared.published_product_id && prepared.published_version_id) {
        const [publishedVersions] = await conn.query(
          'SELECT id,version_no,asset_status,asset_count FROM public_product_library_versions WHERE id=?',
          [prepared.published_version_id]
        );
        const published = publishedVersions[0];
        if (published?.asset_status === 'complete') {
          return {
            product_id: Number(prepared.published_product_id),
            version_id: Number(prepared.published_version_id),
            version_no: Number(published.version_no),
            asset_count: Number(published.asset_count || 0),
            already_published: true,
          };
        }
      }

      const sourcePayload = validateCandidate(prepared);
      const preparedClassifications = await candidateCategories(conn, prepared);
      const sourceCanonical = JSON.stringify(sourcePayload);
      const fingerprint = digest(sourceCanonical);
      const archived = await archiveAssets(sourcePayload, prepared, {db:conn});
      const payload = archived.payload;
      const configurations = payloadConfigurations(payload);
      const canonical = JSON.stringify(payload);
      const sourceUrl = String(prepared.source_url || payloadSourceUrl(payload) || '').slice(0, 1000);
      const sourceUrlHash = digest(sourceUrl);

      await conn.beginTransaction(); transaction = true;
      const [lockedRows] = await conn.query(
        `SELECT candidate.*,source.brand_name source_brand
         FROM product_ingestion_candidates candidate
         JOIN product_ingestion_sources source ON source.id=candidate.source_id
         WHERE candidate.id=? FOR UPDATE`,
        [candidateId]
      );
      const candidate = lockedRows[0];
      validateCandidate(candidate);
      const classifications = await candidateCategories(conn, candidate);
      if (digest(JSON.stringify(parseJson(candidate.normalized_payload))) !== digest(JSON.stringify(parseJson(prepared.normalized_payload)))) {
        fail('候选内容在发布期间发生变化，请重新发布', 409);
      }

      if (candidate.published_product_id && candidate.published_version_id) {
        await conn.query(
          `UPDATE public_product_library_versions
           SET cover_url=?,product_payload=?,asset_status='complete',asset_count=?,assets_archived_at=NOW()
           WHERE id=? AND product_id=?`,
          [String(payload.cover_url || '').slice(0, 1000) || null, canonical, archived.assets.length, candidate.published_version_id, candidate.published_product_id]
        );
        for (const configuration of configurations) {
          await conn.query(
            `UPDATE public_product_library_configurations
             SET name=?,code=?,configuration_payload=?
             WHERE version_id=? AND configuration_key=?`,
            [String(configuration.name || configuration.code || '').slice(0, 200), String(configuration.code || '').slice(0, 500) || null, JSON.stringify(configuration), candidate.published_version_id, String(configuration.id).slice(0, 80)]
          );
        }
        await recordAssets(conn, candidate.published_version_id, archived.assets);
        await attachCategories(conn, candidate.published_product_id, classifications);
        await linkMaterials(conn,candidate.published_product_id);
        await conn.commit(); transaction = false;
        return {
          product_id: Number(candidate.published_product_id),
          version_id: Number(candidate.published_version_id),
          configuration_count: configurations.length,
          asset_count: archived.assets.length,
          already_published: true,
          assets_archived: true,
        };
      }

      let [products] = await conn.query(
        'SELECT * FROM public_product_library_products WHERE source_id=? AND source_url_hash=? FOR UPDATE',
        [candidate.source_id, sourceUrlHash]
      );
      let product = products[0];
      if (!product) {
        const [created] = await conn.query(
          `INSERT INTO public_product_library_products
           (source_id,source_url,source_url_hash,brand_name,name,product_group,product_type,status,first_published_by,first_published_at)
           VALUES (?,?,?,?,?,?,?,'active',?,NOW())`,
          [candidate.source_id, sourceUrl, sourceUrlHash, String(payload.brand || candidate.source_brand || '').slice(0, 120), String(payload.name || '').slice(0, 120), payload.product_group, payload.product_type, actorName(actor)]
        );
        product = { id: created.insertId };
      } else if (product.current_version_id) {
        const [currentVersions] = await conn.query(
          'SELECT id,version_no,content_fingerprint,asset_count FROM public_product_library_versions WHERE id=? FOR UPDATE',
          [product.current_version_id]
        );
        const current = currentVersions[0];
        if (current && current.content_fingerprint === fingerprint) {
          await attachCategories(conn, product.id, classifications);
          await conn.query(
            'UPDATE product_ingestion_candidates SET published_product_id=?,published_version_id=?,published_at=NOW() WHERE id=?',
            [product.id, current.id, candidateId]
          );
          await linkMaterials(conn,product.id);
          await conn.commit(); transaction = false;
          return {
            product_id: Number(product.id),
            version_id: Number(current.id),
            version_no: Number(current.version_no),
            configuration_count: configurations.length,
            asset_count: Number(current.asset_count || 0),
            already_published: false,
            unchanged: true,
          };
        }
      }

      const [[versionState]] = await conn.query(
        'SELECT COALESCE(MAX(version_no),0) max_version FROM public_product_library_versions WHERE product_id=? FOR UPDATE',
        [product.id]
      );
      const versionNo = Number(versionState.max_version || 0) + 1;
      const [version] = await conn.query(
        `INSERT INTO public_product_library_versions
         (product_id,candidate_id,version_no,content_fingerprint,name,brand_name,cover_url,description,model,product_payload,product_schema_version,asset_status,asset_count,assets_archived_at,published_by,published_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'complete',?,NOW(),?,NOW())`,
        [product.id, candidateId, versionNo, fingerprint, String(payload.name || '').slice(0, 120), String(payload.brand || candidate.source_brand || '').slice(0, 120), String(payload.cover_url || '').slice(0, 1000) || null, String(payload.description || '').slice(0, 65535) || null, String(payloadModel(payload)).slice(0, 120) || null, canonical, Number(payload.product_schema_version||1), archived.assets.length, actorName(actor)]
      );
      for (let index = 0; index < configurations.length; index += 1) {
        const configuration = configurations[index];
        await conn.query(
          `INSERT INTO public_product_library_configurations
           (version_id,configuration_key,name,code,sort_order,configuration_payload)
           VALUES (?,?,?,?,?,?)`,
          [version.insertId, String(configuration.id || `configuration-${index + 1}`).slice(0, 80), String(configuration.name || configuration.code || '').slice(0, 200), String(configuration.code || '').slice(0, 500) || null, index, JSON.stringify(configuration)]
        );
      }
      await recordAssets(conn, version.insertId, archived.assets);
      await conn.query(
        `UPDATE public_product_library_products
         SET brand_name=?,name=?,product_group=?,product_type=?,status='active',current_version_id=? WHERE id=?`,
        [String(payload.brand || candidate.source_brand || '').slice(0, 120), String(payload.name || '').slice(0, 120), payload.product_group, payload.product_type, version.insertId, product.id]
      );
      await attachCategories(conn, product.id, classifications.length ? classifications : preparedClassifications);
      await conn.query(
        'UPDATE product_ingestion_candidates SET published_product_id=?,published_version_id=?,published_at=NOW() WHERE id=?',
        [product.id, version.insertId, candidateId]
      );
      await linkMaterials(conn,product.id);
      await conn.commit(); transaction = false;
      return {
        product_id: Number(product.id),
        version_id: Number(version.insertId),
        version_no: versionNo,
        configuration_count: configurations.length,
        asset_count: archived.assets.length,
        already_published: false,
      };
    } catch (error) {
      if (transaction) await conn.rollback();
      throw error;
    } finally {
      if (conn !== db && typeof conn.release === 'function') conn.release();
    }
  }

  async function listProducts(query = {}, onlyActive = false) {
    const type = String(query.product_type || '');
    const group = String(query.product_group || '');
    const brand = String(query.brand || '').trim().slice(0, 120);
    const search = String(query.q || '').trim().slice(0, 120);
    const categoryCode = String(query.category_code || '').trim().slice(0, 80);
    const requestedStatus = String(query.status || '').trim();
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const offset = Math.min(10000, Math.max(0, Number(query.offset) || 0));
    const includePayload = query.include_payload !== false && String(query.include_payload || '').toLowerCase() !== 'false';
    const where = []; const params = [];
    if (onlyActive) {
      where.push("product.status='active'");
      where.push("version.asset_status='complete'");
    } else if (requestedStatus && requestedStatus !== 'all') {
      if (!['active','archived','deleted'].includes(requestedStatus)) fail('产品状态筛选不正确');
      where.push('product.status=?'); params.push(requestedStatus);
    }
    if (type) { where.push('product.product_type=?'); params.push(type); }
    if (group) { where.push('product.product_group=?'); params.push(group); }
    if (brand) { where.push('product.brand_name=?'); params.push(brand); }
    if (categoryCode) {
      where.push(`EXISTS (SELECT 1 FROM public_product_category_relations relation
        JOIN public_product_categories category ON category.id=relation.category_id
        LEFT JOIN public_product_categories parent ON parent.id=category.parent_id
        WHERE relation.product_id=product.id AND (category.category_code=? OR parent.category_code=?))`);
      params.push(categoryCode, categoryCode);
    }
    if (search) {
      where.push(`(product.name LIKE ? OR product.brand_name LIKE ? OR version.model LIKE ? OR EXISTS
        (SELECT 1 FROM public_product_library_configurations searchable_configuration
         WHERE searchable_configuration.version_id=version.id AND (searchable_configuration.name LIKE ? OR searchable_configuration.code LIKE ?)))`);
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(like, like, like, like, like);
    }
    params.push(limit, offset);
    const [rows] = await db.query(
      `SELECT product.*,version.id version_id,version.version_no,version.product_schema_version,version.cover_url,version.description,version.model,
       ${includePayload ? 'version.product_payload,' : ''}version.asset_status,version.asset_count,version.published_by,version.published_at,
       (SELECT GROUP_CONCAT(DISTINCT category.category_code ORDER BY category.sort_order SEPARATOR ',') FROM public_product_category_relations relation JOIN public_product_categories category ON category.id=relation.category_id WHERE relation.product_id=product.id) category_codes,
       (SELECT GROUP_CONCAT(DISTINCT category.name ORDER BY category.sort_order SEPARATOR ',') FROM public_product_category_relations relation JOIN public_product_categories category ON category.id=relation.category_id WHERE relation.product_id=product.id) category_names,
       (SELECT COUNT(*) FROM public_product_library_configurations configuration WHERE configuration.version_id=version.id) configuration_count
       FROM public_product_library_products product
       JOIN public_product_library_versions version ON version.id=product.current_version_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY product.id DESC LIMIT ? OFFSET ?`,
      params
    );
    return rows.map(mapProduct);
  }

  async function changeProductStatus(idValues, targetStatus, actor) {
    const ids=productIds(idValues),status=String(targetStatus||'');
    if(!['active','archived','deleted'].includes(status))fail('目标产品状态不正确');
    const placeholders=ids.map(()=>'?').join(','),name=actorName(actor);
    const assignments={
      active:"status='active',archived_at=NULL,archived_by=NULL,deleted_at=NULL,deleted_by=NULL,lifecycle_updated_by=?",
      archived:"status='archived',archived_at=NOW(),archived_by=?,deleted_at=NULL,deleted_by=NULL,lifecycle_updated_by=?",
      deleted:"status='deleted',deleted_at=NOW(),deleted_by=?,lifecycle_updated_by=?",
    };
    const actorParams=status==='active'?[name]:[name,name];
    const [result]=await db.query(`UPDATE public_product_library_products SET ${assignments[status]} WHERE id IN (${placeholders})`,[...actorParams,...ids]);
    return {status,requested:ids.length,updated:Number(result.affectedRows||0),product_ids:ids};
  }

  async function facets(options = {}) {
    const lifecycleFilter=options.includeInactive?'':"AND product.status='active' AND version.asset_status='complete'";
    const [brands] = await db.query(
      `SELECT product.brand_name value,COUNT(*) count
       FROM public_product_library_products product
       JOIN public_product_library_versions version ON version.id=product.current_version_id
       WHERE 1=1 ${lifecycleFilter}
       GROUP BY product.brand_name ORDER BY product.brand_name`
    );
    const [categories] = await db.query(
      `SELECT category.id,category.parent_id,category.category_code code,category.name,category.level,category.sort_order,
       (SELECT COUNT(DISTINCT relation.product_id)
        FROM public_product_category_relations relation
        JOIN public_product_categories assigned ON assigned.id=relation.category_id
        JOIN public_product_library_products product ON product.id=relation.product_id ${options.includeInactive?'':"AND product.status='active'"}
        JOIN public_product_library_versions version ON version.id=product.current_version_id ${options.includeInactive?'':"AND version.asset_status='complete'"}
        WHERE assigned.id=category.id OR assigned.parent_id=category.id) count
       FROM public_product_categories category
       WHERE category.status='active'
       ORDER BY category.level,category.sort_order,category.id`
    );
    const mapped = categories.map(row => ({ id:Number(row.id), parent_id:row.parent_id==null?null:Number(row.parent_id), code:row.code, name:row.name, level:Number(row.level), count:Number(row.count || 0) }));
    return { brands:brands.map(row=>({ value:row.value,count:Number(row.count || 0) })), categories:mapped };
  }

  async function getProduct(idValue, onlyActive = false, versionIdValue = null) {
    const id = numberId(idValue, '产品 ID');
    const selectedVersionId=versionIdValue==null?null:numberId(versionIdValue,'版本 ID');
    const [rows] = await db.query(
      `SELECT product.*,version.id version_id,version.version_no,version.cover_url,version.description,version.model,
       version.product_payload,version.asset_status,version.asset_count,version.content_fingerprint,version.published_by,version.published_at,
       version.candidate_id,candidate.job_id,source.brand_name source_brand_name,source.base_url source_base_url,
       (SELECT site_rule.id FROM product_ingestion_site_rules site_rule WHERE site_rule.source_id=product.source_id AND site_rule.status='frozen' ORDER BY site_rule.version_number DESC LIMIT 1) current_frozen_site_rule_id,
       (SELECT site_rule.version_number FROM product_ingestion_site_rules site_rule WHERE site_rule.source_id=product.source_id AND site_rule.status='frozen' ORDER BY site_rule.version_number DESC LIMIT 1) current_frozen_site_rule_version,
       (SELECT GROUP_CONCAT(DISTINCT category.category_code ORDER BY category.sort_order SEPARATOR ',') FROM public_product_category_relations relation JOIN public_product_categories category ON category.id=relation.category_id WHERE relation.product_id=product.id) category_codes,
       (SELECT GROUP_CONCAT(DISTINCT category.name ORDER BY category.sort_order SEPARATOR ',') FROM public_product_category_relations relation JOIN public_product_categories category ON category.id=relation.category_id WHERE relation.product_id=product.id) category_names,
       (SELECT COUNT(*) FROM public_product_library_configurations configuration WHERE configuration.version_id=version.id) configuration_count
       FROM public_product_library_products product
       JOIN public_product_library_versions version ON ${selectedVersionId?'version.product_id=product.id':'version.id=product.current_version_id'}
       JOIN product_ingestion_sources source ON source.id=product.source_id
       LEFT JOIN product_ingestion_candidates candidate ON candidate.id=version.candidate_id
       WHERE product.id=?${selectedVersionId?' AND version.product_id=? AND version.id=?':''}${onlyActive ? " AND product.status='active' AND version.asset_status='complete'" : ''}`,
      selectedVersionId?[id,id,selectedVersionId]:[id]
    );
    if (!rows[0]) fail('公共产品不存在', 404);
    const product = mapProduct(rows[0]);
    const [configurations] = await db.query(
      `SELECT id,version_id,configuration_key,name,code,sort_order,configuration_payload
       FROM public_product_library_configurations WHERE version_id=? ORDER BY sort_order,id`,
      [product.version_id]
    );
    const [versions] = await db.query(
      'SELECT id,version_no,candidate_id,content_fingerprint,product_schema_version,asset_status,asset_count,published_by,published_at FROM public_product_library_versions WHERE product_id=? ORDER BY version_no DESC',
      [id]
    );
    const [archivedAssets]=await db.query(`SELECT relation.id relation_id,relation.asset_role,relation.payload_path,relation.original_url,
      asset.id asset_id,asset.content_hash,asset.storage_uri,asset.content_type,asset.byte_size,asset.created_at
      FROM public_product_library_version_assets relation JOIN public_product_library_assets asset ON asset.id=relation.asset_id
      WHERE relation.version_id=? ORDER BY relation.payload_path,relation.id`,[product.version_id]);
    return {
      ...product,
      configurations: configurations.map(item => ({
        ...item,
        id: Number(item.id),
        version_id: Number(item.version_id),
        sort_order: Number(item.sort_order),
        configuration_payload: parseJson(item.configuration_payload),
      })),
      versions: versions.map(item => ({ ...item, id: Number(item.id), candidate_id: Number(item.candidate_id), version_no: Number(item.version_no), product_schema_version:Number(item.product_schema_version||1),asset_count: Number(item.asset_count || 0) })),
      archived_assets:archivedAssets.map(item=>({...item,relation_id:Number(item.relation_id),asset_id:Number(item.asset_id),byte_size:Number(item.byte_size||0)})),
      provenance:{source_id:product.source_id,source_brand_name:product.source_brand_name,source_base_url:product.source_base_url,candidate_id:Number(product.candidate_id||0)||null,job_id:Number(product.job_id||0)||null,current_frozen_site_rule_id:Number(product.current_frozen_site_rule_id||0)||null,current_frozen_site_rule_version:Number(product.current_frozen_site_rule_version||0)||null,content_fingerprint:product.content_fingerprint},
    };
  }

  return { publishCandidate, listProducts, getProduct, facets, changeProductStatus };
}

module.exports = { createPublicProductLibrary, digest, mapProduct, validateCandidate, productIds };
