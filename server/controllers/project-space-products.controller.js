const { hydrateProducts } = require('../services/merchant-materials');
const { readDetails } = require('../services/product-details');
const db = require('../config/db');
const { requireProjectContext } = require('../utils/project-context');
const { success, error } = require('../utils/response');

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
  const quantity = Number(body.quantity);
  const price = body.customer_unit_price === null || body.customer_unit_price === '' || body.customer_unit_price === undefined
    ? null : Number(body.customer_unit_price);
  const unit = String(body.unit ?? '件').trim();
  const spec = String(body.selected_spec ?? '').trim();
  const note = String(body.note ?? '').trim();
  const order = Number(body.sort_order ?? 0);
  const selection = parseSelectionDetails(body.selection_details);
  if ((productId === null) === (personalId === null) || (productId !== null && (!Number.isSafeInteger(productId) || productId <= 0)) || (personalId !== null && (!Number.isSafeInteger(personalId) || personalId <= 0))) throw new Error('请选择一种有效的产品来源');
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999999999 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.0001) throw new Error('数量必须大于0，最多三位小数');
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 9999999999.99 || Math.abs(price * 100 - Math.round(price * 100)) > 0.0001)) throw new Error('客户单价须为非负金额，最多两位小数');
  if (selection?.price_status === 'quoted' && price === null) throw new Error('已报价时请填写客户单价');
  if (selection?.price_status !== 'quoted' && selection?.ppt?.show_price) throw new Error('只有已报价产品才能在PPT中展示价格');
  if (!unit || unit.length > 20 || spec.length > 500 || note.length > 1000 || !Number.isSafeInteger(order) || Math.abs(order) > 1000000) throw new Error('产品配置超出允许范围');
  return { productId, personalId, quantity, unit, spec, price, note, order, selection };
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
      brand: bounded('brand', 120),
      series: bounded('series', 120),
      name: bounded('name', 120),
      code: bounded('code', 80),
      swatch_url: bounded('swatch_url', 1000),
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
    CASE WHEN item.personal_product_id IS NOT NULL THEN (personal.id IS NOT NULL AND personal.deleted_at IS NULL)
      WHEN ${availableSql} THEN 1 ELSE 0 END AS available
    FROM project_scheme_products item
    JOIN project_design_schemes scheme ON scheme.id = item.scheme_id AND scheme.version_no = 1
    LEFT JOIN merchant_products product ON product.id = item.merchant_product_id
    LEFT JOIN personal_products personal ON personal.id = item.personal_product_id
    WHERE item.project_id = ? AND item.space_id = ? ORDER BY item.sort_order, item.id`, [ctx.projectId, ctx.spaceId]);
  const products = await hydrateProducts(db, rows.map(row => ({
    ...row,
    product_details: readDetails(row.product_details),
    selection_details: readDetails(row.selection_details),
  })));
  return success(res, {
    can_edit: ctx.lifecycleStatus === 'active' && ['owner', 'designer'].includes(ctx.role),
    items: products.map(hydrateSelectionStatus),
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
  const [products] = input.personalId !== null
    ? await db.query(`SELECT personal.id FROM personal_products personal WHERE personal.id=? AND personal.deleted_at IS NULL
        AND (personal.user_id=? OR EXISTS (SELECT 1 FROM project_scheme_products item WHERE item.personal_product_id=personal.id AND item.project_id=?))`, [input.personalId, req.user.id, ctx.projectId])
    : await db.query(`SELECT product.id, product.product_details FROM merchant_products product WHERE product.id = ? AND ${availableSql}`, [input.productId]);
  if (!products.length) return error(res, '商品已下架或不可用，请重新选择');
  if (input.personalId === null) {
    try { validateSelectionAgainstProduct(products[0].product_details, input.selection); }
    catch (e) { return error(res, e.message); }
  }
  const values = [input.productId, input.personalId, input.quantity, input.unit, input.spec, input.selection == null ? null : JSON.stringify(input.selection), input.price, input.note, input.order];
  if (itemId !== null) {
    const [result] = await db.query(`UPDATE project_scheme_products SET merchant_product_id = ?, personal_product_id = ?, quantity = ?, unit = ?, selected_spec = ?, selection_details = ?, customer_unit_price = ?, note = ?, sort_order = ?
      WHERE id = ? AND project_id = ? AND space_id = ?`, [...values, itemId, ctx.projectId, ctx.spaceId]);
    if (!result.affectedRows) return error(res, '产品记录不存在', 404);
    return success(res, { id: itemId });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`INSERT INTO project_design_schemes (project_id, version_no) VALUES (?, 1) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [ctx.projectId]);
    const [schemes] = await conn.query('SELECT id FROM project_design_schemes WHERE project_id = ? AND version_no = 1', [ctx.projectId]);
    const [result] = await conn.query(`INSERT INTO project_scheme_products
      (merchant_product_id, personal_product_id, quantity, unit, selected_spec, selection_details, customer_unit_price, note, sort_order, project_id, space_id, scheme_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...values, ctx.projectId, ctx.spaceId, schemes[0].id, req.user.id]);
    await conn.commit(); return success(res, { id: result.insertId });
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

module.exports = { list, save, remove, parseInput, validateSelectionAgainstProduct, hydrateSelectionStatus };
