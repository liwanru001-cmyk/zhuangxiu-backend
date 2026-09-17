const { hydrateProducts } = require('../services/merchant-materials');
const { readDetails } = require('../services/product-details');
const db = require('../config/db');
const { requireProjectContext } = require('../utils/project-context');
const { success, error } = require('../utils/response');
const { validateOfficialMaterialSelection, hydrateOfficialMaterialSnapshots } = require('../services/official-material-selection');

const availableSql = `product.status = 'active' AND EXISTS (
  SELECT 1 FROM user_roles merchant_role WHERE merchant_role.user_id = product.merchant_user_id
  AND merchant_role.role = 'merchant' AND merchant_role.verified_status = 'approved'
  AND (merchant_role.verified_until IS NULL OR merchant_role.verified_until >= NOW()))`;

async function context(req, res, write = false) {
  // Path is authoritative even if a caller supplies a conflicting body project_id.
  if (req.body?.project_id != null && Number(req.body.project_id) !== Number(req.params.id)) {
    error(res, '项目参数不一致'); return null;
  }
  const ctx = await requireProjectContext(req, res);
  if (!ctx.ok) return null;
  if (ctx.projectId !== Number(req.params.id)) { error(res, '项目参数不一致'); return null; }
  if (write && (ctx.lifecycleStatus !== 'active' || !['owner', 'designer'].includes(ctx.role))) {
    error(res, '仅业主和项目设计师可维护方案产品', 403); return null;
  }
  const spaceId = Number(req.params.spaceId);
  if (!Number.isSafeInteger(spaceId) || spaceId <= 0) { error(res, '空间参数不正确'); return null; }
  const [spaces] = await db.query('SELECT id FROM project_spaces WHERE id = ? AND project_id = ?', [spaceId, ctx.projectId]);
  if (!spaces.length) { error(res, '空间不存在', 404); return null; }
  return { ...ctx, spaceId };
}

function parseInput(body) {
  const productId = body.merchant_product_id == null ? null : Number(body.merchant_product_id);
  const personalId = body.personal_product_id == null ? null : Number(body.personal_product_id);
  const publicProductId = body.public_product_id == null ? null : Number(body.public_product_id);
  const publicVersionId = body.public_product_version_id == null ? null : Number(body.public_product_version_id);
  const publicConfigurationId = body.public_product_configuration_id == null ? null : Number(body.public_product_configuration_id);
  const selectedSources = [productId, personalId, publicProductId].filter(value => value !== null);
  const sourceType = String(body.source_type || (publicProductId !== null ? 'public_library' : personalId !== null ? 'personal' : 'merchant'));
  const quantity = Number(body.quantity);
  const price = body.customer_unit_price === null || body.customer_unit_price === '' || body.customer_unit_price === undefined
    ? null : Number(body.customer_unit_price);
  const unit = String(body.unit ?? '件').trim();
  const spec = String(body.selected_spec ?? '').trim();
  const note = String(body.note ?? '').trim();
  const order = Number(body.sort_order ?? 0);
  const selection = parseSelectionDetails(body.selection_details);
  if (selectedSources.length !== 1 || !['merchant', 'personal', 'public_library'].includes(sourceType)) throw new Error('请选择一种有效的产品来源');
  if (productId !== null && (sourceType !== 'merchant' || !Number.isSafeInteger(productId) || productId <= 0)) throw new Error('商家产品来源不正确');
  if (personalId !== null && (sourceType !== 'personal' || !Number.isSafeInteger(personalId) || personalId <= 0)) throw new Error('个人产品来源不正确');
  if (publicProductId !== null && (sourceType !== 'public_library' || !Number.isSafeInteger(publicProductId) || publicProductId <= 0 || !Number.isSafeInteger(publicVersionId) || publicVersionId <= 0 || !Number.isSafeInteger(publicConfigurationId) || publicConfigurationId <= 0)) throw new Error('公共产品及规格来源不正确');
  if (sourceType !== 'public_library' && (publicVersionId !== null || publicConfigurationId !== null)) throw new Error('公共产品来源不正确');
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999999999 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.0001) throw new Error('数量必须大于0，最多三位小数');
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 9999999999.99 || Math.abs(price * 100 - Math.round(price * 100)) > 0.0001)) throw new Error('客户单价须为非负金额，最多两位小数');
  if (selection?.price_status === 'quoted' && price === null) throw new Error('已报价时请填写客户单价');
  if (selection?.price_status !== 'quoted' && selection?.ppt?.show_price) throw new Error('只有已报价产品才能在PPT中展示价格');
  if (!unit || unit.length > 20 || spec.length > 500 || note.length > 1000 || !Number.isSafeInteger(order) || Math.abs(order) > 1000000) throw new Error('产品配置超出允许范围');
  return { sourceType, productId, personalId, publicProductId, publicVersionId, publicConfigurationId, quantity, unit, spec, price, note, order, selection };
}

function publicSnapshot(row) {
  const payload = readDetails(row.product_payload);
  const configuration = readDetails(row.configuration_payload);
  if (!payload || !configuration) throw new Error('公共产品正式版本数据不完整');
  const product = {
    name: String(payload.name || row.name || ''),
    brand: String(payload.brand || row.brand_name || ''),
    model: String(payload.product_details?.model || row.model || ''),
    description: String(payload.description || row.description || ''),
    product_group: payload.product_group || row.product_group || null,
    product_type: payload.product_type || row.product_type || null,
    cover_url: String(payload.cover_url || row.cover_url || ''),
    source_url: String(row.source_url || payload.product_details?.source_url || ''),
  };
  return {
    schema_version: 1,
    source_type: 'public_library',
    product_id: Number(row.product_id),
    version_id: Number(row.version_id),
    version_no: Number(row.version_no),
    content_fingerprint: row.content_fingerprint,
    configuration_id: Number(row.configuration_id),
    configuration_key: String(row.configuration_key),
    product,
    configuration,
  };
}

function selectionForPublicProduct(selection, configuration, configurationKey) {
  const base = selection || {
    schema_version: 1,
    materials: [],
    price_status: 'pending',
    ppt: { included: true, show_materials: true, show_quantity: true, show_price: false },
  };
  return {
    ...base,
    configuration_id: String(configurationKey),
    configuration_name: String(configuration.name || ''),
  };
}

function parseSelectionDetails(raw) {
  if (raw == null || raw === '') return null;
  let value = raw;
  if (typeof value === 'string') {
    if (value.length > 30000) throw new Error('选用配置内容过长');
    try { value = JSON.parse(value); } catch (_) { throw new Error('选用配置格式不正确'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('选用配置格式不正确');
  const configurationId = String(value.configuration_id || '').trim();
  if (!configurationId || configurationId.length > 80) throw new Error('请选择标准配置');
  const materials = Array.isArray(value.materials) ? value.materials : [];
  if (materials.length > 20) throw new Error('每件产品最多选择20个材质部位');
  const seen = new Set();
  const normalizedMaterials = materials.map(rawMaterial => {
    if (!rawMaterial || typeof rawMaterial !== 'object' || Array.isArray(rawMaterial)) throw new Error('材质选择格式不正确');
    const part = String(rawMaterial.part || '').trim();
    const materialId = Number(rawMaterial.material_id);
    if (!part || part.length > 120 || seen.has(part) || !Number.isSafeInteger(materialId) || materialId <= 0) throw new Error('材质选择格式不正确');
    seen.add(part);
    const revision = rawMaterial.material_revision == null ? null : Number(rawMaterial.material_revision);
    if (revision !== null && (!Number.isSafeInteger(revision) || revision <= 0)) throw new Error('材质版本格式不正确');
    const bounded = (key, max) => String(rawMaterial[key] || '').trim().slice(0, max);
    return {
      part,
      material_id: materialId,
      material_revision: revision,
      material_source: bounded('material_source', 40),
      brand: bounded('brand', 120),
      kind: bounded('kind', 120),
      series: bounded('series', 120),
      name: bounded('name', 120),
      code: bounded('code', 80),
      composition: bounded('composition', 500),
      swatch_url: bounded('swatch_url', 1000),
      official_status: bounded('official_status', 40),
      selection_basis: bounded('selection_basis', 80),
    };
  });
  const priceStatus = ['pending', 'quoted', 'included'].includes(value.price_status) ? value.price_status : 'pending';
  const ppt = value.ppt && typeof value.ppt === 'object' && !Array.isArray(value.ppt) ? value.ppt : {};
  return {
    schema_version: 1,
    configuration_id: configurationId,
    configuration_name: String(value.configuration_name || '').trim().slice(0, 120),
    materials: normalizedMaterials,
    price_status: priceStatus,
    ppt: {
      included: ppt.included !== false,
      show_materials: ppt.show_materials !== false,
      show_quantity: ppt.show_quantity !== false,
      show_price: ppt.show_price === true,
    },
  };
}

function validateSelectionAgainstProduct(details, selection) {
  const value = readDetails(details);
  if (!value || !Array.isArray(value.configurations)) return;
  // Legacy clients still submit selected_spec only. New clients send this
  // structure and receive strict configuration/material validation.
  if (!selection) return;
  const configuration = value.configurations.find(item => String(item.id) === selection.configuration_id);
  if (!configuration) throw new Error('所选标准配置已变化，请重新选择');
  const groups = Array.isArray(value.material_groups) ? value.material_groups : [];
  const configuredOptions = Array.isArray(configuration.material_options) ? configuration.material_options : [];
  const availableOptions = configuredOptions.length ? configuredOptions : groups;
  for (const option of availableOptions) {
    const allowedIds = Array.isArray(option.material_ids) ? option.material_ids.map(Number) : [];
    if (!allowedIds.length) continue;
    const selected = selection.materials.find(item => item.part === option.part);
    if (!selected || !allowedIds.includes(selected.material_id)) throw new Error(`请选择“${option.part}”的可用材质`);
  }
  for (const selected of selection.materials) {
    const option = availableOptions.find(item => item.part === selected.part);
    if (!option || !(option.material_ids || []).map(Number).includes(selected.material_id)) throw new Error('所选材质不在当前配置的可用范围内');
  }
}

async function list(req, res) {
  const ctx = await context(req, res); if (!ctx) return;
  const [rows] = await db.query(`SELECT item.*,
    COALESCE(product.id, personal.id) AS source_id,
    COALESCE(product.name, personal.name) AS name, COALESCE(product.brand, personal.brand) AS brand,
    COALESCE(product.spec, personal.spec) AS spec, COALESCE(product.cover_url, personal.cover_url) AS cover_url,
    product.merchant_user_id, product.image_urls, COALESCE(product.price_text, personal.price_text) AS price_text,
    COALESCE(product.product_group, personal.product_group) AS product_group,
    COALESCE(product.product_type, personal.product_type) AS product_type,
    COALESCE(product.product_details, personal.product_details) AS product_details,
    public_library.status AS public_product_status,public_library.current_version_id AS public_current_version_id,
    CASE WHEN item.source_type='public_library' THEN 1
      WHEN item.personal_product_id IS NOT NULL THEN (personal.id IS NOT NULL AND personal.deleted_at IS NULL)
      WHEN ${availableSql} THEN 1 ELSE 0 END AS available
    FROM project_scheme_products item
    JOIN project_design_schemes scheme ON scheme.id = item.scheme_id AND scheme.version_no = 1
    LEFT JOIN merchant_products product ON product.id = item.merchant_product_id
    LEFT JOIN personal_products personal ON personal.id = item.personal_product_id
    LEFT JOIN public_product_library_products public_library ON public_library.id = item.public_product_id
    WHERE item.project_id = ? AND item.space_id = ? ORDER BY item.sort_order, item.id`, [ctx.projectId, ctx.spaceId]);
  const prepared = rows.map(row => {
    const selectionDetails = readDetails(row.selection_details);
    if (row.source_type !== 'public_library') return {
      ...row,
      product_details: readDetails(row.product_details),
      selection_details: selectionDetails,
    };
    const snapshot = readDetails(row.product_snapshot) || {};
    const snapshotProduct = snapshot.product || {};
    const snapshotConfiguration = snapshot.configuration || {};
    return {
      ...row,
      source_id: Number(row.public_product_id),
      name: snapshotProduct.name || '公共产品',
      brand: snapshotProduct.brand || '',
      spec: snapshotConfiguration.name || row.selected_spec || '',
      cover_url: snapshotProduct.cover_url || '',
      price_text: snapshotConfiguration.price_state === 'known' && snapshotConfiguration.price != null
        ? String(snapshotConfiguration.price) : '',
      product_group: snapshotProduct.product_group || null,
      product_type: snapshotProduct.product_type || null,
      product_details: {
        schema_version: 1,
        model: snapshotProduct.model || '',
        configurations: [snapshotConfiguration],
        material_groups: [],
        customization: { enabled: false, fields: [], limits: '', pricing_note: '' },
      },
      selection_details: selectionDetails,
      source_available: row.public_product_status === 'active',
      library_update_available: Number(row.public_current_version_id || 0) > 0 && Number(row.public_current_version_id) !== Number(row.public_product_version_id),
    };
  });
  const products = await hydrateProducts(db, prepared);
  for (const item of products) {
    if (item.source_type !== 'public_library' || !item.selection_details?.materials?.length) continue;
    const official=item.selection_details.materials.filter(material=>material.material_source==='official_brand');
    if (!official.length) continue;
    const hydrated=await hydrateOfficialMaterialSnapshots(db,Number(item.public_product_id),official);
    const byPart=new Map(hydrated.map(material=>[material.part,material]));
    item.selection_details.materials=item.selection_details.materials.map(material=>byPart.get(material.part)||material);
  }
  return success(res, {
    can_edit: ctx.lifecycleStatus === 'active' && ['owner', 'designer'].includes(ctx.role),
    items: products.map(item => {
      const hydrated = hydrateSelectionStatus(item);
      if (item.source_type === 'public_library' && item.library_update_available) {
        hydrated.selection_warnings.push({ type: 'library_version_available', message: '公共产品库已有新版本，当前项目仍使用原版本' });
      }
      return hydrated;
    }),
  });
}

function hydrateSelectionStatus(item) {
  const selection = item.selection_details;
  const details = item.product_details;
  if (!selection || !details) return { ...item, selection_warnings: [] };
  const warnings = [];
  const configuration = (details.configurations || []).find(
    value => String(value.id) === String(selection.configuration_id)
  );
  if (!configuration) {
    warnings.push({ type: 'configuration_missing', message: '原选标准配置已下架或删除，请重新选择' });
  } else if (selection.configuration_name && selection.configuration_name !== configuration.name) {
    warnings.push({ type: 'configuration_changed', message: '标准配置名称或资料已更新，请核对' });
  }
  const materials = (details.material_groups || []).flatMap(group => group.materials || []);
  selection.materials = (selection.materials || []).map(snapshot => {
    if (snapshot.material_source === 'official_brand') {
      const live=snapshot.live_material;
      if (!live || live.status !== 'active' || live.selectable === false) {
        warnings.push({type:'material_unavailable',part:snapshot.part,message:`${snapshot.part}所选官方材质已不可用或受到官网明确限制`});
      } else if (snapshot.material_revision && Number(snapshot.material_revision) !== Number(live.revision)) {
        warnings.push({type:'material_changed',part:snapshot.part,message:`${snapshot.part}官方材质资料已更新，请核对`});
      }
      return snapshot;
    }
    const live = materials.find(material => Number(material.id) === Number(snapshot.material_id));
    if (!live || live.status !== 'active') {
      warnings.push({
        type: 'material_unavailable',
        part: snapshot.part,
        message: `${snapshot.part}所选材质已暂停供应、停产或不可用`,
      });
    } else if (snapshot.material_revision && Number(snapshot.material_revision) !== Number(live.revision)) {
      warnings.push({ type: 'material_changed', part: snapshot.part, message: `${snapshot.part}材质资料已更新，请核对` });
    }
    return { ...snapshot, live_material: live || null };
  });
  return {
    ...item,
    selection_details: selection,
    selection_warnings: warnings,
    preview_image_url: configuration?.image_url || item.cover_url || '',
  };
}

async function save(req, res) {
  const ctx = await context(req, res, true); if (!ctx) return;
  let input;
  try { input = parseInput(req.body || {}); } catch (e) { return error(res, e.message); }
  const itemId = req.params.itemId === undefined ? null : Number(req.params.itemId);
  if (itemId !== null && (!Number.isSafeInteger(itemId) || itemId <= 0)) return error(res, '产品记录参数不正确');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    let existing = null;
    if (itemId !== null) {
      const [existingRows] = await conn.query(
        'SELECT * FROM project_scheme_products WHERE id=? AND project_id=? AND space_id=? FOR UPDATE',
        [itemId, ctx.projectId, ctx.spaceId]
      );
      existing = existingRows[0];
      if (!existing) { await conn.rollback(); return error(res, '产品记录不存在', 404); }
    }

    let selection = input.selection;
    let selectedSpec = input.spec;
    let snapshot = null;
    let publicConfigurationKey = null;
    let snapshotChanged = false;
    if (input.sourceType === 'public_library') {
      const samePinnedSelection = existing && existing.source_type === 'public_library'
        && Number(existing.public_product_id) === input.publicProductId
        && Number(existing.public_product_version_id) === input.publicVersionId
        && Number(existing.public_product_configuration_id) === input.publicConfigurationId;
      const [products] = await conn.query(
        `SELECT product.id product_id,product.source_url,product.status,product.current_version_id,product.product_group,product.product_type,
         version.id version_id,version.version_no,version.content_fingerprint,version.name,version.brand_name,version.model,version.cover_url,version.description,version.product_payload,version.asset_status,
         configuration.id configuration_id,configuration.configuration_key,configuration.configuration_payload
         FROM public_product_library_products product
         JOIN public_product_library_versions version ON version.product_id=product.id
         JOIN public_product_library_configurations configuration ON configuration.version_id=version.id
         WHERE product.id=? AND version.id=? AND configuration.id=? FOR UPDATE`,
        [input.publicProductId, input.publicVersionId, input.publicConfigurationId]
      );
      const publicProduct = products[0];
      if (!publicProduct || publicProduct.asset_status !== 'complete') {
        await conn.rollback(); return error(res, '公共产品或规格不可用，请重新选择');
      }
      if (!samePinnedSelection && (publicProduct.status !== 'active' || Number(publicProduct.current_version_id) !== input.publicVersionId)) {
        await conn.rollback(); return error(res, '公共产品已有新版本或已下架，请重新选择');
      }
      const configuration = readDetails(publicProduct.configuration_payload);
      selection = selectionForPublicProduct(selection, configuration, publicProduct.configuration_key);
      try {
        const productPayload = readDetails(publicProduct.product_payload);
        const officialMaterials=selection.materials.filter(material=>material.material_source==='official_brand');
        const embeddedSelection={...selection,materials:selection.materials.filter(material=>material.material_source!=='official_brand')};
        validateSelectionAgainstProduct(productPayload?.product_details, embeddedSelection);
        if(officialMaterials.length){
          const canonical=await validateOfficialMaterialSelection(conn,publicProduct,officialMaterials);
          const officialParts=new Set(officialMaterials.map(material=>material.part));
          selection={...selection,materials:[...selection.materials.filter(material=>!officialParts.has(material.part)),...canonical]};
        }
      } catch (e) { await conn.rollback(); return error(res, e.message); }
      selectedSpec = input.spec || String(configuration.name || '');
      publicConfigurationKey = String(publicProduct.configuration_key);
      snapshotChanged = !samePinnedSelection || !existing?.product_snapshot;
      snapshot = snapshotChanged ? publicSnapshot(publicProduct) : readDetails(existing.product_snapshot);
    } else {
      const [products] = input.sourceType === 'personal'
        ? await conn.query(`SELECT personal.id FROM personal_products personal WHERE personal.id=? AND personal.deleted_at IS NULL
            AND (personal.user_id=? OR EXISTS (SELECT 1 FROM project_scheme_products item WHERE item.personal_product_id=personal.id AND item.project_id=?))`, [input.personalId, req.user.id, ctx.projectId])
        : await conn.query(`SELECT product.id, product.product_details FROM merchant_products product WHERE product.id = ? AND ${availableSql}`, [input.productId]);
      if (!products.length) { await conn.rollback(); return error(res, '商品已下架或不可用，请重新选择'); }
      if (input.sourceType === 'merchant') {
        try { validateSelectionAgainstProduct(products[0].product_details, selection); }
        catch (e) { await conn.rollback(); return error(res, e.message); }
      }
    }

    const values = [
      input.productId, input.personalId, input.sourceType,
      input.publicProductId, input.publicVersionId, input.publicConfigurationId, publicConfigurationKey,
      snapshot == null ? null : JSON.stringify(snapshot), snapshot == null ? null : 1,
      input.quantity, input.unit, selectedSpec, selection == null ? null : JSON.stringify(selection),
      input.price, input.note, input.order,
    ];
    if (itemId !== null) {
      const [result] = await conn.query(
        `UPDATE project_scheme_products SET
         merchant_product_id=?,personal_product_id=?,source_type=?,public_product_id=?,public_product_version_id=?,public_product_configuration_id=?,public_configuration_key=?,
         product_snapshot=?,snapshot_schema_version=?,snapshot_created_at=${snapshotChanged ? 'NOW()' : 'snapshot_created_at'},
         quantity=?,unit=?,selected_spec=?,selection_details=?,customer_unit_price=?,note=?,sort_order=?
         WHERE id=? AND project_id=? AND space_id=?`,
        [...values, itemId, ctx.projectId, ctx.spaceId]
      );
      await conn.commit();
      return success(res, { id: itemId, snapshot_updated: snapshotChanged && result.affectedRows > 0 });
    }
    await conn.query(`INSERT INTO project_design_schemes (project_id, version_no) VALUES (?, 1) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [ctx.projectId]);
    const [schemes] = await conn.query('SELECT id FROM project_design_schemes WHERE project_id = ? AND version_no = 1', [ctx.projectId]);
    const [result] = await conn.query(`INSERT INTO project_scheme_products
      (merchant_product_id,personal_product_id,source_type,public_product_id,public_product_version_id,public_product_configuration_id,public_configuration_key,
       product_snapshot,snapshot_schema_version,snapshot_created_at,quantity,unit,selected_spec,selection_details,customer_unit_price,note,sort_order,project_id,space_id,scheme_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,${snapshot == null ? 'NULL' : 'NOW()'},?,?,?,?,?,?,?,?,?,?,?)`,
      [...values.slice(0, 9), ...values.slice(9), ctx.projectId, ctx.spaceId, schemes[0].id, req.user.id]);
    await conn.commit(); return success(res, { id: result.insertId, snapshot_updated: snapshot != null });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

async function remove(req, res) {
  const ctx = await context(req, res, true); if (!ctx) return;
  const id = Number(req.params.itemId);
  if (!Number.isSafeInteger(id) || id <= 0) return error(res, '产品记录参数不正确');
  const [result] = await db.query('DELETE FROM project_scheme_products WHERE id = ? AND project_id = ? AND space_id = ?', [id, ctx.projectId, ctx.spaceId]);
  if (!result.affectedRows) return error(res, '产品记录不存在', 404);
  return success(res);
}

module.exports = { list, save, remove, parseInput, validateSelectionAgainstProduct, hydrateSelectionStatus, publicSnapshot, selectionForPublicProduct };
