const db = require('../config/db');
const { success, error } = require('../utils/response');
const { activeVerifiedMerchantExistsSql } = require('../utils/verified-merchant');

const SUPPORTED_TYPES = new Set(['merchant_product', 'merchant_case']);

function normalizeSummary(value) {
  return String(value || '').trim().slice(0, 160);
}

async function loadProductPreview(id) {
  const [rows] = await db.query(
    `SELECT product.id, product.name AS title,
            COALESCE(NULLIF(product.cover_url, ''),
              JSON_UNQUOTE(JSON_EXTRACT(product.image_urls, '$[0]')), '') AS cover_url,
            product.summary,
            COALESCE(NULLIF(profile.shop_name, ''), merchant.nickname, '商家店铺') AS merchant_name
     FROM merchant_products product
     JOIN merchant_profiles profile ON profile.user_id = product.merchant_user_id
     JOIN users merchant ON merchant.id = product.merchant_user_id
     WHERE product.id = ? AND product.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = product.merchant_user_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function loadCasePreview(id) {
  const [rows] = await db.query(
    `SELECT merchant_case.id, merchant_case.title,
            COALESCE(NULLIF(merchant_case.cover_image, ''),
              JSON_UNQUOTE(JSON_EXTRACT(merchant_case.images, '$[0]')), '') AS cover_url,
            merchant_case.description AS summary,
            COALESCE(NULLIF(profile.shop_name, ''), merchant.nickname, '商家店铺') AS merchant_name
     FROM merchant_cases merchant_case
     JOIN merchant_profiles profile ON profile.user_id = merchant_case.merchant_id
     JOIN users merchant ON merchant.id = merchant_case.merchant_id
     WHERE merchant_case.id = ? AND merchant_case.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = merchant_case.merchant_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function getSharePreview(req, res) {
  const type = String(req.query.type || '').trim();
  const id = Number(req.query.id || 0);
  if (!SUPPORTED_TYPES.has(type) || !Number.isInteger(id) || id <= 0) {
    return error(res, '分享内容参数不正确', 400);
  }

  const item = type === 'merchant_product'
    ? await loadProductPreview(id)
    : await loadCasePreview(id);
  if (!item) {
    return success(res, { type, id, available: false });
  }
  return success(res, {
    type,
    id: Number(item.id),
    title: item.title || (type === 'merchant_product' ? '装修好物' : '装修案例'),
    cover_url: item.cover_url || '',
    merchant_name: item.merchant_name || '商家店铺',
    summary: normalizeSummary(item.summary),
    available: true,
  });
}

module.exports = { getSharePreview };
