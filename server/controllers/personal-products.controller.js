const { rejectPersonalReferences } = require('../services/merchant-materials');
const { catalogFields, readDetails, validateSourceMerchant } = require('../services/product-details');
const db = require('../config/db');
const { success, error } = require('../utils/response');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const storage = require('../services/storage.service');
const { isProductUrl } = require('../services/product-url');

function payload(body) {
  const limits = { name: 120, cover_url: 1000, brand: 120, spec: 500, price_text: 80, source_url: 1000, description: 2000 };
  const value = {};
  for (const [key, limit] of Object.entries(limits)) {
    value[key] = String(body[key] ?? '').trim();
    if (value[key].length > limit) throw new Error('产品信息超出长度限制');
  }
  if (!value.name) throw new Error('请填写产品名称');
  Object.assign(value, catalogFields(body));
  rejectPersonalReferences(value.product_details);
  for (const key of ['cover_url', 'source_url']) {
    if (!value[key]) continue;
    if (!isProductUrl(value[key])) throw new Error(key === 'cover_url'
      ? '产品主图地址无效，请重新上传图片'
      : '来源链接格式不正确，请填写有效的 http/https 地址');
  }
  return value;
}

async function list(req, res) {
  const [items] = await db.query('SELECT * FROM personal_products WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC', [req.user.id]);
  return success(res, items.map(item => ({ ...item, product_details: readDetails(item.product_details) })));
}
async function get(req, res) {
  const [items] = await db.query(`SELECT p.* FROM personal_products p WHERE p.id = ? AND p.deleted_at IS NULL AND
    (p.user_id = ? OR EXISTS (SELECT 1 FROM project_scheme_products item
      JOIN renovation_projects project ON project.id = item.project_id
      LEFT JOIN project_members member ON member.project_id=project.id AND member.user_id=? AND member.status=1
      WHERE item.personal_product_id=p.id AND COALESCE(project.lifecycle_status,'active') <> 'deleted'
      AND (project.user_id=? OR member.id IS NOT NULL)))`, [req.params.id, req.user.id, req.user.id, req.user.id]);
  if (!items.length) return error(res, '产品不存在或无权限', 404);
  return success(res, { ...items[0], product_details: readDetails(items[0].product_details) });
}
async function save(req, res) {
  let value; try { value = payload(req.body || {}); } catch (e) { return error(res, e.message); }
  try { if (value.product_details != null) { const enriched = await validateSourceMerchant(db, value.product_details); if (enriched) value.product_details = enriched; } } catch (e) { return error(res, e.message); }
  const keys = Object.keys(value); const values = Object.values(value);
  let id = req.params.id;
  if (id) {
    const [result] = await db.query(`UPDATE personal_products SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=? AND user_id=? AND deleted_at IS NULL`, [...values, id, req.user.id]);
    if (!result.affectedRows) return error(res, '产品不存在或无编辑权限', 404);
  } else {
    const [[count]] = await db.query('SELECT COUNT(*) AS total FROM personal_products WHERE user_id=? AND deleted_at IS NULL', [req.user.id]);
    if (count.total >= 500) return error(res, '个人产品最多保存500项');
    const [result] = await db.query(`INSERT INTO personal_products (${keys.join(',')},user_id) VALUES (${keys.map(() => '?').join(',')},?)`, [...values, req.user.id]);
    id = result.insertId;
  }
  const [[item]] = await db.query('SELECT * FROM personal_products WHERE id=? AND user_id=?', [id, req.user.id]);
  return success(res, { ...item, product_details: readDetails(item.product_details) });
}
async function remove(req, res) {
  const [result] = await db.query('UPDATE personal_products SET deleted_at=NOW() WHERE id=? AND user_id=? AND deleted_at IS NULL', [req.params.id, req.user.id]);
  if (!result.affectedRows) return error(res, '产品不存在或无权限', 404);
  return success(res);
}
async function upload(req, res) {
  if (!req.file) return error(res, '请选择图片');
  const folder = path.join(__dirname, '../uploads/personal-products');
  await fs.mkdir(folder, { recursive: true });
  const name = `${req.user.id}-${randomUUID()}.webp`; const output = path.join(folder, name);
  try {
    await sharp(req.file.buffer, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toFile(output);
  } catch (_) { await fs.rm(output, { force: true }); return error(res, '图片无法读取，请使用 JPG、PNG 或 WebP'); }
  try {
    const url = storage.useOss() ? (await storage.putFile({ sourcePath: output, key: `uploads/personal-products/${name}`, req, contentType: 'image/webp' })).url
      : `${req.protocol}://${req.get('host')}/api/uploads/personal-products/${name}`;
    return success(res, { url });
  } finally { if (storage.useOss()) await fs.rm(output, { force: true }); }
}
async function uploadDocument(req, res) {
  const buffer = req.file?.buffer;
  if (!buffer || buffer.subarray(0, 5).toString() !== '%PDF-' || !buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) return error(res, '请选择有效的 PDF 尺寸图');
  const folder = path.join(__dirname, '../uploads/product-drawings');
  await fs.mkdir(folder, { recursive: true });
  const name = `${req.user.id}-${randomUUID()}.pdf`; const output = path.join(folder, name);
  await fs.writeFile(output, buffer);
  try {
    const url = storage.useOss() ? (await storage.putFile({ sourcePath: output, key: `uploads/product-drawings/${name}`, req, contentType: 'application/pdf' })).url
      : `${req.protocol}://${req.get('host')}/api/uploads/product-drawings/${name}`;
    return success(res, { url });
  } finally { if (storage.useOss()) await fs.rm(output, { force: true }); }
}
module.exports = { list, get, save, remove, upload, uploadDocument, payload };
