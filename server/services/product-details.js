// Shared catalog contract for designer and merchant products. Project selections
// and customer quotes deliberately remain outside this source document.
const { randomUUID } = require('crypto');
const { isProductUrl } = require('./product-url');
const GROUPS = ['soft_furnishings', 'building_materials', 'woodwork'];
const TYPES = ['furniture', 'curtains', 'rugs', 'lighting', 'artwork', 'accessories'];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function text(v, max = 120) {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > max) throw new Error('产品字段格式或长度不正确');
  return v.trim();
}
function url(v) {
  const s = text(v, 1000); if (!s) return '';
  if (!isProductUrl(s)) throw new Error('图片或来源链接无效，请重新上传图片或填写有效的 http/https 地址');
  return s;
}
function number(v, max, decimals) {
  if (v == null || v === '') return null;
  if (!['number', 'string'].includes(typeof v) || (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v))) throw new Error('数量或金额格式不正确');
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max || Math.abs(n * 10 ** decimals - Math.round(n * 10 ** decimals)) > 0.0001) throw new Error('尺寸或金额超出范围');
  return n;
}
function choice(v, values, label) { if (!values.includes(v)) throw new Error(`请选择有效的${label}`); return v; }
function object(v) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('产品配置格式不正确'); return v; }
function readDetails(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v || null;
}
function normalizeDetails(raw, productType = 'furniture') {
  const curtain = productType === 'curtains';
  const rug = productType === 'rugs';
  const art = productType === 'artwork';
  const accessory = productType === 'accessories';
  const v = object(raw);
  if ((v.product_kind || 'furniture') !== productType) throw new Error('产品资料与分类不一致');
  if (v.schema_version !== 1) throw new Error('不支持的产品资料格式，请更新客户端');
  if (!Array.isArray(v.configurations) || v.configurations.length < 1 || v.configurations.length > 100) throw new Error('请保留1至100项实际可售配置');
  const ids = new Set();
  const configurations = v.configurations.map(item => {
    const c = object(item); const id = text(c.id, 80) || randomUUID();
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error('配置编号重复或格式不正确');
    ids.add(id); const name = text(c.name); if (!name) throw new Error('请填写配置名称');
    const shape = choice(c.shape, art ? ['artwork'] : rug ? ['rectangle', 'square', 'circle', 'oval', 'irregular'] : curtain ? ['curtain'] : ['box', 'round'], '尺寸表达');
    object(c.dimensions);
    const dimensions = {};
    for (const k of (art ? ['width', 'height'] : rug ? (shape === 'circle' ? ['diameter'] : shape === 'square' ? ['side'] : ['length', 'width']) : curtain ? ['width', 'height'] : shape === 'box' ? ['width', 'depth', 'height'] : ['diameter', 'height'])) {
      dimensions[k] = number(c.dimensions?.[k], 1000000, 3);
      if (dimensions[k] === 0) throw new Error('尺寸须大于零，未知请留空');
    }
    if (!Array.isArray(c.parts) || c.parts.length < 1 || c.parts.length > 20) throw new Error('请填写1至20个材质部位');
    const priceState = choice(c.price_state, ['known', 'quote', 'unknown'], '价格状态');
    const price = priceState === 'known' ? number(c.price, 9999999999.99, 2) : null;
    if (priceState === 'known' && price === null) throw new Error('请填写参考单价');
    const curtainSpecs = curtain ? normalizeCurtainSpecs(c.curtain_specs, priceState) : null;
    return { ...(accessory ? { accessory_specs: normalizeAccessorySpecs(c.accessory_specs) } : {}), ...(art ? { artwork_specs: normalizeArtworkSpecs(c.artwork_specs) } : {}), ...(rug ? { rug_specs: normalizeRugSpecs(c.rug_specs, priceState, c.unit) } : {}), ...(curtain ? { curtain_specs: curtainSpecs } : {}), id, name, code: text(c.code), shape, dimensions,
      dimension_unit: choice(c.dimension_unit, ['mm', 'cm'], '尺寸单位'), dimension_note: text(c.dimension_note, 500),
      parts: c.parts.map(rawPart => { const p = object(rawPart); return { part: text(p.part) || '整体', material: text(p.material), color: text(p.color), code: text(p.code), swatch_url: url(p.swatch_url), ...(p.material_id != null ? { material_id: positiveId(p.material_id), material_revision: p.material_revision == null ? null : positiveId(p.material_revision) } : {}), ...(curtain ? { fabric_width_cm: positiveMeasurement(p.fabric_width_cm), repeat_height_cm: positiveMeasurement(p.repeat_height_cm), blackout_note: text(p.blackout_note, 300) } : {}) }; }),
      material_options: normalizeConfigurationMaterialOptions(c.material_options),
      image_url: url(c.image_url), drawing_url: url(c.drawing_url), drawing_name: text(c.drawing_name, 255),
      unit: choice(c.unit, accessory ? ['件', '个', '只', '对', '套', '组'] : art ? ['幅', '套', '件'] : rug ? ['张', '块', '㎡', '套'] : curtain ? ['米', '㎡', '幅', '套', '樘'] : ['件', '把', '张', '套'], '销售单位'), price_state: priceState, currency: 'CNY', price,
      includes: text(c.includes, 500) };
  });
  const custom = object(v.customization);
  if (typeof custom.enabled !== 'boolean') throw new Error('定制开关格式不正确');
  if (!Array.isArray(custom.fields) || custom.fields.length > 6) throw new Error('定制范围格式不正确');
  const fields = [...new Set(custom.fields.map(f => choice(f, accessory ? ['material', 'color', 'size', 'pattern', 'finish', 'composition'] : art ? ['size', 'frame', 'mounting', 'image', 'material'] : rug ? ['material', 'color', 'size', 'shape', 'pattern', 'edging'] : curtain ? ['material', 'color', 'width', 'height', 'heading', 'operation'] : ['material', 'color', 'width', 'depth', 'height', 'combination'], '定制项目')))];
  return { ...(v.material_groups !== undefined ? { material_groups: normalizeMaterialGroups(v.material_groups) } : {}), schema_version: 1, ...(accessory ? { product_kind: 'accessories', accessory_type: choice(v.accessory_type, ['vase', 'sculpture', 'tray', 'floral', 'cushion', 'throw', 'clock', 'mirror', 'other'], '饰品类型') } : art ? { product_kind: 'artwork', artwork_type: choice(v.artwork_type, ['painting', 'print', 'photography', 'calligraphy', 'mixed', 'other'], '装饰画类型') } : rug ? { product_kind: 'rugs', rug_type: choice(v.rug_type, ['area', 'runner', 'mat', 'other'], '地毯类型') } : curtain ? { product_kind: 'curtains', curtain_type: choice(v.curtain_type, ['drape', 'sheer', 'combined', 'roller', 'blind', 'roman', 'other'], '窗帘类型') } : { furniture_type: choice(v.furniture_type, ['sofa', 'chair', 'table', 'bed', 'cabinet', 'other'], '家具类型') }), model: text(v.model), source_url: url(v.source_url), source_merchant_id: v.source_merchant_id == null ? null : positiveId(v.source_merchant_id),
    configurations, customization: { enabled: custom.enabled, fields, limits: text(custom.limits, 1000), pricing_note: text(custom.pricing_note, 500) } };
}
function positiveMeasurement(v) {
  const n = number(v, 1000000, 3);
  if (n === 0) throw new Error('尺寸须大于零，未知请留空');
  return n;
}
function normalizeCurtainSpecs(raw, priceState) {
  const v = object(raw);
  const pricingBasis = text(v.pricing_basis, 300);
  if (priceState === 'known' && !pricingBasis) throw new Error('请填写窗帘计价口径，例如按布料用米或成品宽度');
  const ratio = number(v.fullness_ratio, 10, 3);
  if (ratio !== null && ratio < 1) throw new Error('褶皱倍数不能小于1，未知请留空');
  return { sizing: choice(v.sizing, ['custom', 'ready'], '规格方式'),
    dimension_basis: choice(v.dimension_basis, ['panel', 'pair', 'window'], '成品尺寸口径'),
    heading: text(v.heading), opening: text(v.opening),
    operation: choice(v.operation, ['unknown', 'manual', 'motorized', 'compatible'], '操作方式'),
    fullness_ratio: ratio, hardware_note: text(v.hardware_note, 500), pricing_basis: pricingBasis };
}
function normalizeRugSpecs(raw, priceState, unit) {
  const v = object(raw);
  const basis = text(v.pricing_basis, 300);
  if (priceState === 'known' && unit === '㎡' && !basis) throw new Error('请填写地毯面积计价口径，例如按实际形状面积或外接尺寸计价');
  return { sizing: choice(v.sizing, ['ready', 'custom'], '规格方式'), construction: text(v.construction),
    pile_height_mm: positiveMeasurement(v.pile_height_mm), thickness_mm: positiveMeasurement(v.thickness_mm),
    backing: text(v.backing, 300), edging: text(v.edging, 300), non_slip_note: text(v.non_slip_note, 300),
    care_note: text(v.care_note, 500), pricing_basis: basis };
}
function normalizeArtworkSpecs(raw) {
  const v = object(raw);
  const count = number(v.piece_count, 100, 0);
  if (count === null || count < 1) throw new Error('请填写1至100幅的组画数量');
  const composition = text(v.composition, 500);
  if (count > 1 && !composition) throw new Error('请说明组画每幅尺寸、画面及排列方式');
  return { form: choice(v.form, ['unknown', 'original', 'reproduction'], '作品形式'),
    frame: choice(v.frame, ['unknown', 'none', 'included', 'optional'], '画框方式'),
    piece_count: count, composition,
    outer_width: positiveMeasurement(v.outer_width), outer_height: positiveMeasurement(v.outer_height),
    thickness: positiveMeasurement(v.thickness),
    creator: text(v.creator), technique: text(v.technique, 300), substrate: text(v.substrate, 300),
    frame_material: text(v.frame_material), frame_color: text(v.frame_color), mounting: text(v.mounting, 300),
    glazing: text(v.glazing, 300), edition_note: text(v.edition_note, 300), installation: text(v.installation, 500) };
}
function normalizeAccessorySpecs(raw) {
  const v = object(raw); const count = number(v.piece_count, 1000, 0);
  if (count === null || count < 1) throw new Error('请填写1至1000件的包装组成数量');
  const composition = text(v.composition, 500);
  if (count > 1 && !composition) throw new Error('请说明套装各单品、数量及尺寸');
  return { piece_count: count, composition, technique: text(v.technique, 300), finish: text(v.finish, 300),
    usage: text(v.usage, 500), care: text(v.care, 500), installation: text(v.installation, 500) };
}
function normalizeMaterialGroups(groups) {
 if(!Array.isArray(groups)||groups.length>20)throw new Error('可用材质部位最多20项');
 const names=new Set();return groups.map(g=>{object(g);const part=text(g.part);if(!part||names.has(part))throw new Error('材质部位名称不能为空或重复');names.add(part);
 if(!Array.isArray(g.material_ids)||g.material_ids.length>100)throw new Error('每个部位最多100项可用材质');
 return {part,material_ids:[...new Set(g.material_ids.map(positiveId))]};});
}
function normalizeConfigurationMaterialOptions(options) {
 if(options==null)return [];
 if(!Array.isArray(options)||options.length>20)throw new Error('每项配置最多设置20个材质部位');
 const names=new Set();return options.map(raw=>{const value=object(raw);const part=text(value.part);
 if(!part||names.has(part))throw new Error('配置材质部位不能为空或重复');names.add(part);
 if(!Array.isArray(value.material_ids)||value.material_ids.length>100)throw new Error('每个配置部位最多选择100项材质');
 return {part,material_ids:[...new Set(value.material_ids.map(positiveId))]};});
}
function positiveId(v) { if (!Number.isSafeInteger(v) || v <= 0) throw new Error('来源商家不正确'); return v; }
function catalogFields(body, existing = {}) {
  const out = {};
  const group = has(body, 'product_group') ? body.product_group : existing.product_group;
  const type = has(body, 'product_type') ? body.product_type : existing.product_type;
  if (has(body, 'product_group')) out.product_group = choice(group, GROUPS, '产品大类（软装、建材或木作）');
  if (has(body, 'product_type')) {
    if (type == null && group !== 'soft_furnishings') out.product_type = null;
    else if (group !== 'soft_furnishings') throw new Error('当前产品大类不支持软装类别');
    else out.product_type = choice(type, TYPES, '软装类别');
  }
  if (has(body, 'product_group') && group !== 'soft_furnishings') out.product_type = null;
  if (has(body, 'product_details')) {
    if (body.product_details == null) out.product_details = null;
    else {
      if (group !== 'soft_furnishings' || !['furniture', 'curtains', 'rugs', 'artwork', 'accessories'].includes(type)) throw new Error('当前类别尚不支持结构化产品配置');
      out.product_details = JSON.stringify(normalizeDetails(body.product_details, type));
    }
  }
  if ((has(body, 'product_group') || has(body, 'product_type')) && (group !== 'soft_furnishings' || !['furniture', 'curtains', 'rugs', 'artwork', 'accessories'].includes(type))) out.product_details = null;
  return out;
}
async function validateSourceMerchant(db, details) {
  const id = readDetails(details)?.source_merchant_id;
  if (id == null) return;
  const [rows] = await db.query(`SELECT mp.user_id, mp.shop_name FROM merchant_profiles mp WHERE mp.user_id=?
    AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=mp.user_id AND ur.role='merchant'
      AND ur.verified_status='approved' AND (ur.verified_until IS NULL OR ur.verified_until >= NOW()))`, [id]);
  if (!rows.length) throw new Error('来源商家不存在或暂不可用，请重新选择');
  const value = readDetails(details); value.source_merchant_name = rows[0].shop_name || '来源商家';
  return JSON.stringify(value);
}
module.exports = { catalogFields, normalizeDetails, readDetails, validateSourceMerchant };
