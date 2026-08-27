const db = require('../config/db');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { success, error } = require('../utils/response');
const storageService = require('../services/storage.service');
const {
  activeVerifiedMerchantExistsSql,
} = require('../utils/verified-merchant');

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeStatus(value) {
  const status = normalizeString(value || 'active', 20);
  return ['draft', 'active', 'hidden'].includes(status) ? status : 'active';
}

function normalizeHttpUrl(value) {
  const raw = normalizeString(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

const MERCHANT_PRODUCT_QUOTAS = {
  maxCategories: 10,
  maxProducts: 50,
};

function normalizeImageUrls(value) {
  return parseJsonArray(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeContentDelta(value) {
  const source = parseJsonArray(value);
  const operations = [];
  let imageCount = 0;
  let consecutiveNewlines = 0;
  const inline = new Set(['bold', 'italic', 'underline', 'strike', 'color', 'background']);
  const block = new Set(['header', 'list', 'blockquote', 'align', 'indent', 'direction']);
  for (const operation of source) {
    if (!operation || typeof operation !== 'object' || !('insert' in operation)) continue;
    const attributes = {};
    for (const [key, attributeValue] of Object.entries(operation.attributes || {})) {
      if (inline.has(key) || block.has(key)) attributes[key] = attributeValue;
    }
    if (typeof operation.insert === 'string') {
      let text = '';
      for (const character of operation.insert.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n')) {
        if (character === '\n') {
          consecutiveNewlines += 1;
          if (consecutiveNewlines <= 3) text += character;
        } else {
          consecutiveNewlines = 0;
          text += character;
        }
      }
      if (text) operations.push(Object.keys(attributes).length ? { insert: text, attributes } : { insert: text });
    } else if (operation.insert && typeof operation.insert.image === 'string') {
      imageCount += 1;
      if (imageCount > 15) return { error: '产品图文详情配图最多 15 张' };
      const url = normalizeString(operation.insert.image, 500);
      if (url) operations.push({ insert: { image: url } });
      consecutiveNewlines = 0;
    }
  }
  const textLength = [...operations
    .filter((operation) => typeof operation.insert === 'string')
    .map((operation) => operation.insert)
    .join('').trim()].length;
  if (textLength > 1500) return { error: '产品图文详情文字最多 1500 字' };
  if (operations.length &&
      (typeof operations.at(-1).insert !== 'string' || !operations.at(-1).insert.endsWith('\n'))) {
    operations.push({ insert: '\n' });
  }
  return { value: operations };
}

async function assertMerchant(req, res) {
  const [rows] = await db.query(
    `SELECT 1 FROM user_roles
     WHERE user_id = ? AND role = 'merchant'
     LIMIT 1`,
    [req.user.id]
  );
  if (!rows[0]) {
    error(res, '当前账号没有商家身份，暂不能管理产品', 403);
    return false;
  }
  return true;
}

function mapCategory(row) {
  return {
    id: Number(row.id),
    merchant_user_id: Number(row.merchant_user_id),
    parent_id: row.parent_id ? Number(row.parent_id) : null,
    name: row.name || '',
    sort_order: Number(row.sort_order || 0),
    status: row.status || 'active',
  };
}

function mapProduct(row) {
  return {
    id: Number(row.id),
    merchant_user_id: Number(row.merchant_user_id),
    category_id: row.category_id ? Number(row.category_id) : null,
    category_name: row.category_name || '',
    parent_category_id: row.parent_category_id ? Number(row.parent_category_id) : null,
    parent_category_name: row.parent_category_name || '',
    name: row.name || '',
    cover_url: row.cover_url || '',
    image_urls: normalizeImageUrls(row.image_urls),
    summary: row.summary || '',
    description: row.description || '',
    content_delta: normalizeContentDelta(row.content_delta).value || [],
    case_link_title: row.case_link_title || '',
    case_link_url: row.case_link_url || '',
    brand: row.brand || '',
    spec: row.spec || '',
    price_text: row.price_text || '',
    sort_order: Number(row.sort_order || 0),
    status: row.status || 'active',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function mapFavoriteProduct(row) {
  return {
    id: Number(row.favorite_id || 0),
    created_at: row.favorite_created_at,
    merchant_user_id: Number(row.merchant_user_id),
    merchant_name: row.merchant_name || row.merchant_nickname || '商家',
    merchant_intro: row.merchant_intro || '',
    consultation_enabled:
      row.consultation_enabled === 1 ||
      row.consultation_enabled === true ||
      row.consultation_enabled === '1',
    product: mapProduct(row),
  };
}

async function getCategoryForMerchant(categoryId, merchantUserId) {
  if (!categoryId) return null;
  const [rows] = await db.query(
    `SELECT id, merchant_user_id, parent_id, name, sort_order, status
     FROM merchant_product_categories
     WHERE id = ? AND merchant_user_id = ?`,
    [categoryId, merchantUserId]
  );
  return rows[0] ? mapCategory(rows[0]) : null;
}

async function listCategoriesForMerchant(merchantUserId, activeOnly = false) {
  const [rows] = await db.query(
    `SELECT id, merchant_user_id, parent_id, name, sort_order, status
     FROM merchant_product_categories
     WHERE merchant_user_id = ? ${activeOnly ? `AND status = 'active'` : ''}
     ORDER BY COALESCE(parent_id, id) ASC, parent_id IS NOT NULL ASC, sort_order ASC, id ASC`,
    [merchantUserId]
  );
  return rows.map(mapCategory);
}

async function listMyCategories(req, res) {
  if (!(await assertMerchant(req, res))) return;
  return success(res, await listCategoriesForMerchant(req.user.id));
}

async function createCategory(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const name = normalizeString(req.body.name, 80);
  if (!name) return error(res, '分类名称不能为空');

  const [[categoryCount]] = await db.query(
    `SELECT COUNT(*) AS total FROM merchant_product_categories
     WHERE merchant_user_id = ?`,
    [req.user.id]
  );
  if (Number(categoryCount.total || 0) >= MERCHANT_PRODUCT_QUOTAS.maxCategories) {
    return error(res, `产品分类最多 ${MERCHANT_PRODUCT_QUOTAS.maxCategories} 个，请先删除不需要的分类`, 429);
  }

  const parentId = Number(req.body.parent_id || 0) || null;
  if (parentId) {
    const parent = await getCategoryForMerchant(parentId, req.user.id);
    if (!parent) return error(res, '父级分类不存在', 404);
    if (parent.parent_id) return error(res, '产品分类最多支持二级');
  }

  const status = normalizeStatus(req.body.status);
  const sortOrder = Number(req.body.sort_order || 0);
  const [result] = await db.query(
    `INSERT INTO merchant_product_categories
     (merchant_user_id, parent_id, name, sort_order, status)
     VALUES (?, ?, ?, ?, ?)`,
    [req.user.id, parentId, name, sortOrder, status]
  );
  const created = await getCategoryForMerchant(result.insertId, req.user.id);
  return success(res, created, '分类已创建');
}

async function updateCategory(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const categoryId = Number(req.params.id);
  const category = await getCategoryForMerchant(categoryId, req.user.id);
  if (!category) return error(res, '分类不存在', 404);

  const name = normalizeString(req.body.name ?? category.name, 80);
  if (!name) return error(res, '分类名称不能为空');
  const status = normalizeStatus(req.body.status ?? category.status);
  const sortOrder = Number(req.body.sort_order ?? category.sort_order);

  await db.query(
    `UPDATE merchant_product_categories
     SET name = ?, sort_order = ?, status = ?
     WHERE id = ? AND merchant_user_id = ?`,
    [name, sortOrder, status, categoryId, req.user.id]
  );
  return success(res, await getCategoryForMerchant(categoryId, req.user.id), '分类已保存');
}

async function deleteCategory(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const categoryId = Number(req.params.id);
  const category = await getCategoryForMerchant(categoryId, req.user.id);
  if (!category) return error(res, '分类不存在', 404);

  const [[childCount]] = await db.query(
    `SELECT COUNT(*) AS total FROM merchant_product_categories
     WHERE merchant_user_id = ? AND parent_id = ?`,
    [req.user.id, categoryId]
  );
  if (Number(childCount.total) > 0) return error(res, '请先删除该分类下的二级分类');

  const [[productCount]] = await db.query(
    `SELECT COUNT(*) AS total FROM merchant_products
     WHERE merchant_user_id = ? AND category_id = ?`,
    [req.user.id, categoryId]
  );
  if (Number(productCount.total) > 0) return error(res, '请先移动或删除该分类下的产品');

  await db.query(
    `DELETE FROM merchant_product_categories WHERE id = ? AND merchant_user_id = ?`,
    [categoryId, req.user.id]
  );
  return success(res, { deleted: true }, '分类已删除');
}

async function listProductsForMerchant(merchantUserId, activeOnly = false) {
  const [rows] = await db.query(
    `SELECT p.*, c.name AS category_name, c.parent_id AS parent_category_id,
            parent.name AS parent_category_name
     FROM merchant_products p
     LEFT JOIN merchant_product_categories c
       ON c.id = p.category_id AND c.merchant_user_id = p.merchant_user_id
     LEFT JOIN merchant_product_categories parent
       ON parent.id = c.parent_id AND parent.merchant_user_id = p.merchant_user_id
     WHERE p.merchant_user_id = ? ${activeOnly ? `AND p.status = 'active'` : ''}
     ORDER BY p.sort_order ASC, p.id DESC`,
    [merchantUserId]
  );
  return rows.map(mapProduct);
}

async function getProductForMerchant(productId, merchantUserId) {
  const [rows] = await db.query(
    `SELECT p.*, c.name AS category_name, c.parent_id AS parent_category_id,
            parent.name AS parent_category_name
     FROM merchant_products p
     LEFT JOIN merchant_product_categories c
       ON c.id = p.category_id AND c.merchant_user_id = p.merchant_user_id
     LEFT JOIN merchant_product_categories parent
       ON parent.id = c.parent_id AND parent.merchant_user_id = p.merchant_user_id
     WHERE p.id = ? AND p.merchant_user_id = ?`,
    [productId, merchantUserId]
  );
  return rows[0] ? mapProduct(rows[0]) : null;
}

async function normalizeProductPayload(body, merchantUserId) {
  const categoryId = Number(body.category_id || 0) || null;
  if (categoryId) {
    const category = await getCategoryForMerchant(categoryId, merchantUserId);
    if (!category) return { error: '产品分类不存在' };
  }
  const name = normalizeString(body.name, 120);
  if (!name) return { error: '产品名称不能为空' };
  const imageUrls = normalizeImageUrls(body.image_urls);
  const coverUrl = normalizeString(body.cover_url || imageUrls[0] || '', 500);
  const contentDelta = normalizeContentDelta(body.content_delta);
  if (contentDelta.error) return { error: contentDelta.error };
  const caseLinkTitle = normalizeString(body.case_link_title, 80);
  const caseLinkUrl = normalizeHttpUrl(body.case_link_url);
  if (caseLinkUrl === null) return { error: '案例链接必须是有效的 http/https 地址' };
  if (Boolean(caseLinkTitle) !== Boolean(caseLinkUrl)) {
    return { error: '案例链接标题和地址需要同时填写' };
  }
  return {
    value: {
      categoryId,
      name,
      coverUrl,
      imageUrls,
      summary: normalizeString(body.summary, 300),
      description: normalizeString(body.description, 3000),
      contentDelta: contentDelta.value,
      caseLinkTitle,
      caseLinkUrl,
      brand: normalizeString(body.brand, 120),
      spec: normalizeString(body.spec, 200),
      priceText: normalizeString(body.price_text, 80),
      sortOrder: Number(body.sort_order || 0),
      status: normalizeStatus(body.status),
    },
  };
}

async function listMyProducts(req, res) {
  if (!(await assertMerchant(req, res))) return;
  return success(res, await listProductsForMerchant(req.user.id));
}

async function createProduct(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const [[productCount]] = await db.query(
    `SELECT COUNT(*) AS total FROM merchant_products
     WHERE merchant_user_id = ?`,
    [req.user.id]
  );
  if (Number(productCount.total || 0) >= MERCHANT_PRODUCT_QUOTAS.maxProducts) {
    return error(res, `产品最多 ${MERCHANT_PRODUCT_QUOTAS.maxProducts} 个，请先删除不需要的产品`, 429);
  }

  const payload = await normalizeProductPayload(req.body, req.user.id);
  if (payload.error) return error(res, payload.error);
  const item = payload.value;
  const [result] = await db.query(
    `INSERT INTO merchant_products
     (merchant_user_id, category_id, name, cover_url, image_urls, summary,
      description, content_delta, case_link_title, case_link_url,
      brand, spec, price_text, sort_order, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      item.categoryId,
      item.name,
      item.coverUrl || null,
      JSON.stringify(item.imageUrls),
      item.summary || null,
      item.description || null,
      JSON.stringify(item.contentDelta),
      item.caseLinkTitle || null,
      item.caseLinkUrl || null,
      item.brand || null,
      item.spec || null,
      item.priceText || null,
      item.sortOrder,
      item.status,
    ]
  );
  return success(res, await getProductForMerchant(result.insertId, req.user.id), '产品已创建');
}

async function updateProduct(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const productId = Number(req.params.id);
  const existing = await getProductForMerchant(productId, req.user.id);
  if (!existing) return error(res, '产品不存在', 404);
  const payload = await normalizeProductPayload({ ...existing, ...req.body }, req.user.id);
  if (payload.error) return error(res, payload.error);
  const item = payload.value;
  await db.query(
    `UPDATE merchant_products
     SET category_id = ?, name = ?, cover_url = ?, image_urls = ?, summary = ?,
         description = ?, content_delta = ?, case_link_title = ?, case_link_url = ?,
         brand = ?, spec = ?, price_text = ?, sort_order = ?, status = ?
     WHERE id = ? AND merchant_user_id = ?`,
    [
      item.categoryId,
      item.name,
      item.coverUrl || null,
      JSON.stringify(item.imageUrls),
      item.summary || null,
      item.description || null,
      JSON.stringify(item.contentDelta),
      item.caseLinkTitle || null,
      item.caseLinkUrl || null,
      item.brand || null,
      item.spec || null,
      item.priceText || null,
      item.sortOrder,
      item.status,
      productId,
      req.user.id,
    ]
  );
  return success(res, await getProductForMerchant(productId, req.user.id), '产品已保存');
}

async function deleteProduct(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const productId = Number(req.params.id);
  const existing = await getProductForMerchant(productId, req.user.id);
  if (!existing) return error(res, '产品不存在', 404);
  await db.query(
    `DELETE FROM merchant_products WHERE id = ? AND merchant_user_id = ?`,
    [productId, req.user.id]
  );
  return success(res, { deleted: true }, '产品已删除');
}

async function listPublicProducts(req, res) {
  const merchantUserId = Number(req.params.userId);
  if (!merchantUserId) return error(res, '商家不存在', 404);
  const [profileRows] = await db.query(
    `SELECT mp.user_id
     FROM merchant_profiles mp
     WHERE mp.user_id = ?
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = mp.user_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )
     LIMIT 1`,
    [merchantUserId]
  );
  if (!profileRows.length) return error(res, '商家不存在', 404);
  const [categories, products] = await Promise.all([
    listCategoriesForMerchant(merchantUserId, true),
    listProductsForMerchant(merchantUserId, true),
  ]);
  return success(res, { categories, products });
}

async function getActivePublicProduct(productId) {
  const [rows] = await db.query(
    `SELECT p.*, c.name AS category_name, c.parent_id AS parent_category_id,
            parent.name AS parent_category_name,
            mp.shop_name AS merchant_name, mp.logo_url AS merchant_logo_url,
            mp.brand_intro AS merchant_intro,
            mp.consultation_enabled, u.nickname AS merchant_nickname
     FROM merchant_products p
     JOIN merchant_profiles mp ON mp.user_id = p.merchant_user_id
     JOIN users u ON u.id = p.merchant_user_id
     LEFT JOIN merchant_product_categories c
       ON c.id = p.category_id AND c.merchant_user_id = p.merchant_user_id
     LEFT JOIN merchant_product_categories parent
       ON parent.id = c.parent_id AND parent.merchant_user_id = p.merchant_user_id
     WHERE p.id = ? AND p.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = p.merchant_user_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )
     LIMIT 1`,
    [productId]
  );
  return rows[0] || null;
}

async function getPublicProduct(req, res) {
  const productId = Number(req.params.id);
  if (!productId) return error(res, '产品不存在', 404);
  const row = await getActivePublicProduct(productId);
  if (!row) return error(res, '产品不存在或已下架', 404);
  return success(res, {
    product: mapProduct(row),
    merchant: {
      user_id: Number(row.merchant_user_id),
      shop_name: row.merchant_name || row.merchant_nickname || '商家店铺',
      logo_url: row.merchant_logo_url || '',
      brand_intro: row.merchant_intro || '',
      consultation_enabled: Boolean(row.consultation_enabled),
    },
  });
}

async function favoriteProduct(req, res) {
  const productId = Number(req.params.id);
  if (!productId) return error(res, '产品不存在', 404);
  const product = await getActivePublicProduct(productId);
  if (!product) return error(res, '产品不存在或已下架', 404);
  if (Number(product.merchant_user_id) === Number(req.user.id)) {
    return error(res, '不能收藏自己的产品');
  }
  await db.query(
    `INSERT IGNORE INTO merchant_product_favorites
     (user_id, product_id, merchant_user_id)
     VALUES (?, ?, ?)`,
    [req.user.id, productId, product.merchant_user_id]
  );
  return success(res, { favorited: true }, '已收藏');
}

async function unfavoriteProduct(req, res) {
  const productId = Number(req.params.id);
  if (!productId) return error(res, '产品不存在', 404);
  await db.query(
    `DELETE FROM merchant_product_favorites
     WHERE user_id = ? AND product_id = ?`,
    [req.user.id, productId]
  );
  return success(res, { favorited: false }, '已取消收藏');
}

async function listFavoriteProducts(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const [rows] = await db.query(
    `SELECT f.id AS favorite_id, f.created_at AS favorite_created_at,
            p.*, c.name AS category_name, c.parent_id AS parent_category_id,
            parent.name AS parent_category_name,
            mp.shop_name AS merchant_name, mp.brand_intro AS merchant_intro,
            mp.consultation_enabled, u.nickname AS merchant_nickname
     FROM merchant_product_favorites f
     JOIN merchant_products p ON p.id = f.product_id
     JOIN merchant_profiles mp ON mp.user_id = p.merchant_user_id
     JOIN users u ON u.id = p.merchant_user_id
     LEFT JOIN merchant_product_categories c
       ON c.id = p.category_id AND c.merchant_user_id = p.merchant_user_id
     LEFT JOIN merchant_product_categories parent
       ON parent.id = c.parent_id AND parent.merchant_user_id = p.merchant_user_id
     WHERE f.user_id = ?
       AND p.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = p.merchant_user_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ? OFFSET ?`,
    [req.user.id, pageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM merchant_product_favorites f
     JOIN merchant_products p ON p.id = f.product_id
     WHERE f.user_id = ? AND p.status = 'active'`,
    [req.user.id]
  );
  return success(res, {
    items: rows.map(mapFavoriteProduct),
    total: Number(countRow.total || 0),
    page,
    pageSize,
  });
}

async function uploadProductImage(req, res) {
  if (!(await assertMerchant(req, res))) return;
  if (!req.file) return error(res, '请选择产品图片');
  const sourcePath = req.file.path;
  const extension = path.extname(req.file.filename).toLowerCase();
  const isGif = extension === '.gif' || req.file.mimetype === 'image/gif';
  const outputName = req.file.filename.replace(/\.[^.]+$/, isGif ? '.gif' : '.webp');
  const outputPath = path.join(path.dirname(sourcePath), `processed-${outputName}`);
  try {
    let metadata;
    if (isGif) {
      const sourceMetadata = await sharp(sourcePath, {
        animated: true,
        limitInputPixels: 80_000_000,
      }).metadata();
      const pageCount = Math.max(1, Number(sourceMetadata.pages || 1));
      const delays = Array.isArray(sourceMetadata.delay) ? sourceMetadata.delay : [];
      const normalizedDelays = Array.from(
        { length: pageCount },
        (_, index) => Math.max(67, Number(delays[index] || delays[0] || 100))
      );
      let compressed = false;
      for (const option of [
        { width: 1080, colours: 128, effort: 7 },
        { width: 900, colours: 96, effort: 8 },
        { width: 720, colours: 64, effort: 9 },
        { width: 540, colours: 48, effort: 10 },
      ]) {
        await sharp(sourcePath, { animated: true, limitInputPixels: 80_000_000 })
          .resize({ width: option.width, withoutEnlargement: true })
          .gif({
            effort: option.effort,
            colours: option.colours,
            dither: 0.5,
            delay: normalizedDelays,
            loop: Number(sourceMetadata.loop || 0),
          })
          .toFile(outputPath);
        if ((await fs.stat(outputPath)).size <= 300 * 1024) {
          compressed = true;
          break;
        }
      }
      if (!compressed) {
        await Promise.all([fs.rm(sourcePath, { force: true }), fs.rm(outputPath, { force: true })]);
        return error(res, 'GIF 压缩后仍超过 300KB，请裁剪时长或更换图片');
      }
      metadata = await sharp(outputPath, { animated: true }).metadata();
    } else {
      await sharp(sourcePath, { limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: 1080, withoutEnlargement: true })
        .webp({ quality: 86, effort: 5 })
        .toFile(outputPath);
      metadata = await sharp(outputPath).metadata();
    }
    await fs.rm(sourcePath, { force: true });
    const imageUrl = storageService.useOss()
      ? (await storageService.putFile({
          sourcePath: outputPath,
          key: `uploads/merchant-products/${path.basename(outputPath)}`,
          req,
          contentType: isGif ? 'image/gif' : 'image/webp',
        })).url
      : `${req.protocol}://${req.get('host')}/api/uploads/merchant-products/${path.basename(outputPath)}`;
    if (storageService.useOss()) await fs.rm(outputPath, { force: true });
    return success(res, {
      url: imageUrl,
      width: Number(metadata.width || 0),
      height: Number(metadata.pageHeight || metadata.height || 0),
      is_gif: isGif,
    }, '图片上传成功');
  } catch (uploadError) {
    await Promise.all([fs.rm(sourcePath, { force: true }), fs.rm(outputPath, { force: true })]);
    console.error('merchant product image processing failed', {
      code: uploadError.code || '',
      message: uploadError.message || String(uploadError),
    });
    return error(res, '图片处理失败，请更换图片或降低图片大小', 422);
  }
}

module.exports = {
  listMyCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listMyProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  listPublicProducts,
  getPublicProduct,
  favoriteProduct,
  unfavoriteProduct,
  listFavoriteProducts,
  uploadProductImage,
};
