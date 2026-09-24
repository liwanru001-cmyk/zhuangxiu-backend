const { rejectPersonalReferences } = require('../services/merchant-materials');
const { catalogFields, readDetails, validateSourceMerchant } = require('../services/product-details');
const db = require('../config/db');
const { success, error } = require('../utils/response');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const dns = require('dns/promises');
const net = require('net');
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
  if (body.image_urls !== undefined) {
    if (!Array.isArray(body.image_urls) || body.image_urls.length > 5) throw new Error('每个产品最多保留5张图片');
    const imageUrls = [...new Set(body.image_urls.map(item => String(item || '').trim()).filter(Boolean))];
    if (imageUrls.some(item => !isProductUrl(item))) throw new Error('产品图片地址无效，请重新选择');
    value.image_urls = JSON.stringify(imageUrls);
  }
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
  return success(res, items.map(hydrate));
}
function hydrate(item) {
  return { ...item, image_urls: readDetails(item.image_urls) || [], product_details: readDetails(item.product_details) };
}
async function get(req, res) {
  const [items] = await db.query(`SELECT p.* FROM personal_products p WHERE p.id = ? AND p.deleted_at IS NULL AND
    (p.user_id = ? OR EXISTS (SELECT 1 FROM project_scheme_products item
      JOIN renovation_projects project ON project.id = item.project_id
      LEFT JOIN project_members member ON member.project_id=project.id AND member.user_id=? AND member.status=1
      WHERE item.personal_product_id=p.id AND COALESCE(project.lifecycle_status,'active') <> 'deleted'
      AND (project.user_id=? OR member.id IS NOT NULL)))`, [req.params.id, req.user.id, req.user.id, req.user.id]);
  if (!items.length) return error(res, '产品不存在或无权限', 404);
  return success(res, hydrate(items[0]));
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
  return success(res, hydrate(item));
}
async function remove(req, res) {
  const [result] = await db.query('UPDATE personal_products SET deleted_at=NOW() WHERE id=? AND user_id=? AND deleted_at IS NULL', [req.params.id, req.user.id]);
  if (!result.affectedRows) return error(res, '产品不存在或无权限', 404);
  return success(res);
}
async function persistImage(req, buffer) {
  const folder = path.join(__dirname, '../uploads/personal-products');
  await fs.mkdir(folder, { recursive: true });
  const name = `${req.user.id}-${randomUUID()}.webp`; const output = path.join(folder, name);
  try {
    await sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toFile(output);
  } catch (_) { await fs.rm(output, { force: true }); throw new Error('图片无法读取，请使用 JPG、PNG 或 WebP'); }
  try {
    return storage.useOss() ? (await storage.putFile({ sourcePath: output, key: `uploads/personal-products/${name}`, req, contentType: 'image/webp' })).url
      : `${req.protocol}://${req.get('host')}/api/uploads/personal-products/${name}`;
  } finally { if (storage.useOss()) await fs.rm(output, { force: true }); }
}
async function upload(req, res) {
  if (!req.file) return error(res, '请选择图片');
  try { return success(res, { url: await persistImage(req, req.file.buffer) }); }
  catch (e) { return error(res, e.message); }
}

function blockedAddress(address) {
  if (!address) return true;
  address = address.toLowerCase();
  if (address === '::1' || address === '::' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('ff')) return true;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (net.isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && [18, 19, 51].includes(b))
    || (a === 203 && b === 0);
}
async function assertPublicImageUrl(raw) {
  const value = new URL(raw);
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) throw new Error('图片链接不安全');
  const host = value.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('图片链接不安全');
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => blockedAddress(item.address))) throw new Error('图片链接不安全');
  return value;
}
async function fetchImage(raw) {
  let url = await assertPublicImageUrl(raw);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'image/*', 'User-Agent': 'ZhuangxiaoProductBrowser/1.0' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('图片跳转地址无效');
        url = await assertPublicImageUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('image/')) throw new Error('链接内容不是图片');
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > 8 * 1024 * 1024) throw new Error('图片不能超过8MB');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('图片内容为空');
      const chunks = []; let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('图片不能超过8MB'); }
        chunks.push(Buffer.from(value));
      }
      if (!total) throw new Error('图片内容为空');
      return Buffer.concat(chunks, total);
    } finally { clearTimeout(timer); }
  }
  throw new Error('图片跳转次数过多');
}
async function importImages(req, res) {
  const urls = Array.isArray(req.body?.urls) ? [...new Set(req.body.urls.map(item => String(item || '').trim()).filter(Boolean))] : [];
  if (!urls.length || urls.length > 5) return error(res, '请选1至5张产品图片');
  const saved = []; const items = []; const failed = [];
  for (const sourceUrl of urls) {
    try {
      const url = await persistImage(req, await fetchImage(sourceUrl));
      saved.push(url); items.push({ source_url: sourceUrl, url });
    }
    catch (e) { failed.push({ url: sourceUrl, message: e.message }); }
  }
  if (!saved.length) return error(res, failed[0]?.message || '图片保存失败');
  return success(res, { urls: saved, items, failed });
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
module.exports = { list, get, save, remove, upload, importImages, uploadDocument, payload, blockedAddress };
