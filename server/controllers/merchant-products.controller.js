const db = require('../config/db');
const { success, error } = require('../utils/response');

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

function normalizeImageUrls(value) {
  return parseJsonArray(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function assertMerchant(req, res) {
  const [rows] = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'merchant' LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length && req.user.role !== 'merchant') {
    error(res, '只有商家身份可以管理产品展示', 403);
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
    brand: row.brand || '',
    spec: row.spec || '',
    price_text: row.price_text || '',
    sort_order: Number(row.sort_order || 0),
    status: row.status || 'active',
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
  return {
    value: {
      categoryId,
      name,
      coverUrl,
      imageUrls,
      summary: normalizeString(body.summary, 300),
      description: normalizeString(body.description, 3000),
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
  const payload = await normalizeProductPayload(req.body, req.user.id);
  if (payload.error) return error(res, payload.error);
  const item = payload.value;
  const [result] = await db.query(
    `INSERT INTO merchant_products
     (merchant_user_id, category_id, name, cover_url, image_urls, summary,
      description, brand, spec, price_text, sort_order, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      item.categoryId,
      item.name,
      item.coverUrl || null,
      JSON.stringify(item.imageUrls),
      item.summary || null,
      item.description || null,
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
         description = ?, brand = ?, spec = ?, price_text = ?, sort_order = ?, status = ?
     WHERE id = ? AND merchant_user_id = ?`,
    [
      item.categoryId,
      item.name,
      item.coverUrl || null,
      JSON.stringify(item.imageUrls),
      item.summary || null,
      item.description || null,
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
    `SELECT user_id FROM merchant_profiles WHERE user_id = ? LIMIT 1`,
    [merchantUserId]
  );
  if (!profileRows.length) return error(res, '商家不存在', 404);
  const [categories, products] = await Promise.all([
    listCategoriesForMerchant(merchantUserId, true),
    listProductsForMerchant(merchantUserId, true),
  ]);
  return success(res, { categories, products });
}

async function uploadProductImage(req, res) {
  if (!(await assertMerchant(req, res))) return;
  if (!req.file) return error(res, '请选择产品图片');
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/merchant-products/${req.file.filename}`;
  return success(res, { url: imageUrl }, '图片上传成功');
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
  uploadProductImage,
};
