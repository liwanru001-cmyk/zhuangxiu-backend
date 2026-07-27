const db = require('../config/db');
const { success, error } = require('../utils/response');
const {
  activeVerifiedMerchantExistsSql,
} = require('../utils/verified-merchant');

const ENTITY_TYPES = new Set(['shop', 'company', 'merchant_case', 'company_case']);

function parseTarget(req, res) {
  const type = String(req.params.type || req.query.type || '').trim();
  const id = Number(req.params.id || req.query.id);
  if (!ENTITY_TYPES.has(type) || !id) {
    error(res, '收藏对象不正确', 400);
    return null;
  }
  return { type, id };
}

async function loadEntity(type, id) {
  if (type === 'shop') {
    const [rows] = await db.query(
      `SELECT mp.user_id AS entity_id, COALESCE(NULLIF(mp.shop_name, ''), u.nickname, '商家店铺') AS title,
              mp.logo_url AS image_url, mp.brand_intro AS summary, u.city,
              mp.user_id AS merchant_user_id
       FROM merchant_profiles mp
       JOIN users u ON u.id = mp.user_id
       WHERE mp.user_id = ?
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = mp.user_id
             AND ${activeVerifiedMerchantExistsSql('ur')}
         )
       LIMIT 1`,
      [id]
    );
    return rows[0];
  }
  if (type === 'company') {
    const [rows] = await db.query(
      `SELECT id AS entity_id, name AS title, logo_url AS image_url, intro AS summary, city,
              id AS company_id
       FROM companies
       WHERE id = ?
         AND status = 'active'
         AND verification_status = 'verified'
       LIMIT 1`,
      [id]
    );
    return rows[0];
  }
  if (type === 'merchant_case') {
    const [rows] = await db.query(
      `SELECT mc.id AS entity_id, mc.title, mc.cover_image AS image_url,
              mc.description AS summary, mc.city, mc.merchant_id AS merchant_user_id,
              COALESCE(NULLIF(mp.shop_name, ''), u.nickname, '商家店铺') AS owner_name
       FROM merchant_cases mc
       JOIN merchant_profiles mp ON mp.user_id = mc.merchant_id
       JOIN users u ON u.id = mc.merchant_id
       WHERE mc.id = ?
         AND mc.status = 'active'
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = mc.merchant_id
             AND ${activeVerifiedMerchantExistsSql('ur')}
         )
       LIMIT 1`,
      [id]
    );
    return rows[0];
  }
  const [rows] = await db.query(
    `SELECT share.id AS entity_id, share.title,
            JSON_UNQUOTE(JSON_EXTRACT(share.image_urls, '$[0]')) AS image_url,
            share.summary, '' AS city, company.id AS company_id,
            company.name AS owner_name
     FROM project_case_shares share
     JOIN renovation_projects project ON project.id = share.project_id
     JOIN companies company
       ON company.status = 'active'
      AND company.verification_status = 'verified'
      AND (
        company.owner_user_id = share.designer_id OR
        EXISTS (
          SELECT 1 FROM company_members member
          WHERE member.company_id = company.id
            AND member.user_id = share.designer_id
            AND member.status = 'active'
        )
      )
     WHERE share.id = ? AND share.status = 1
     ORDER BY company.id ASC LIMIT 1`,
    [id]
  );
  return rows[0];
}

async function setFavorite(req, res) {
  const target = parseTarget(req, res);
  if (!target) return;
  const entity = await loadEntity(target.type, target.id);
  if (!entity) return error(res, '收藏对象不存在或已下架', 404);
  await db.query(
    `INSERT IGNORE INTO user_entity_favorites (user_id, entity_type, entity_id)
     VALUES (?, ?, ?)`,
    [req.user.id, target.type, target.id]
  );
  return success(res, { favorited: true }, '已收藏');
}

async function unsetFavorite(req, res) {
  const target = parseTarget(req, res);
  if (!target) return;
  await db.query(
    `DELETE FROM user_entity_favorites
     WHERE user_id = ? AND entity_type = ? AND entity_id = ?`,
    [req.user.id, target.type, target.id]
  );
  return success(res, { favorited: false }, '已取消收藏');
}

async function getFavoriteStatus(req, res) {
  const target = parseTarget(req, res);
  if (!target) return;
  const [rows] = await db.query(
    `SELECT id FROM user_entity_favorites
     WHERE user_id = ? AND entity_type = ? AND entity_id = ? LIMIT 1`,
    [req.user.id, target.type, target.id]
  );
  return success(res, { favorited: rows.length > 0 });
}

async function listFavorites(req, res) {
  const type = String(req.query.type || '').trim();
  if (!ENTITY_TYPES.has(type)) return error(res, '收藏类型不正确', 400);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const [favorites] = await db.query(
    `SELECT id, entity_id, created_at
     FROM user_entity_favorites
     WHERE user_id = ? AND entity_type = ?
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [req.user.id, type, pageSize, offset]
  );
  const items = [];
  for (const favorite of favorites) {
    const entity = await loadEntity(type, Number(favorite.entity_id));
    if (entity) {
      items.push({
        ...entity,
        entity_type: type,
        favorite_id: Number(favorite.id),
        favorite_created_at: favorite.created_at,
      });
    }
  }
  return success(res, { items, page, pageSize });
}

module.exports = {
  setFavorite,
  unsetFavorite,
  getFavoriteStatus,
  listFavorites,
};
