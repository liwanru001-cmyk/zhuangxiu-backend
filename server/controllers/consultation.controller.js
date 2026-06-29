const db = require('../config/db');
const { success, error } = require('../utils/response');

const validTargetTypes = new Set(['company', 'professional', 'user']);
const validSourcePages = new Set(['marketplace', 'profile', 'project']);

async function resolveBusinessCatalog(businessCatalogId) {
  if (!businessCatalogId) {
    return { exists: true, businessGroup: null };
  }
  const [rows] = await db.query(
    `SELECT parent.code AS parent_code, parent.name AS parent_name
     FROM business_catalog bc
     LEFT JOIN business_catalog parent ON parent.id = bc.parent_id
     WHERE bc.id = ? AND bc.status = 'active'
     LIMIT 1`,
    [businessCatalogId]
  );
  if (!rows[0]) return { exists: false, businessGroup: null };
  return {
    exists: true,
    businessGroup: rows[0].parent_code || rows[0].parent_name || null,
  };
}

async function targetExists(targetType, targetId) {
  if (targetType === 'company') {
    if (targetId < 0) {
      const [rows] = await db.query(
        `SELECT 1 FROM merchant_profiles WHERE user_id = ? LIMIT 1`,
        [Math.abs(targetId)]
      );
      return Boolean(rows[0]);
    }
    const [rows] = await db.query(
      `SELECT 1 FROM companies WHERE id = ? AND status <> 'deleted' LIMIT 1`,
      [targetId]
    );
    return Boolean(rows[0]);
  }

  if (targetType === 'professional') {
    if (targetId < 0) {
      const encoded = Math.abs(targetId);
      const roleCode = encoded % 10;
      const userId = Math.floor(encoded / 10);
      const table = roleCode === 1 ? 'designer_profiles' : 'project_manager_profiles';
      const [rows] = await db.query(
        `SELECT 1 FROM ${table} WHERE user_id = ? LIMIT 1`,
        [userId]
      );
      return Boolean(rows[0]);
    }
    const [rows] = await db.query(
      `SELECT 1 FROM professionals WHERE id = ? AND status <> 'deleted' LIMIT 1`,
      [targetId]
    );
    return Boolean(rows[0]);
  }

  const [rows] = await db.query(
    `SELECT 1 FROM users WHERE id = ? LIMIT 1`,
    [targetId]
  );
  return Boolean(rows[0]);
}

async function createUnifiedConsultation(req, res) {
  const targetType = String(req.body.target_type || '').trim();
  const targetId = Number(req.body.target_id);
  const businessCatalogId = req.body.business_catalog_id === undefined ||
    req.body.business_catalog_id === null ||
    req.body.business_catalog_id === ''
    ? null
    : Number(req.body.business_catalog_id);
  const sourcePage = validSourcePages.has(req.body.source_page)
    ? req.body.source_page
    : 'marketplace';
  const message = String(req.body.message || '').trim().slice(0, 1000);

  if (!validTargetTypes.has(targetType)) return error(res, '咨询对象类型不正确');
  if (!targetId) return error(res, '咨询对象不正确');
  if (targetType === 'user' && Number(req.user.id) === targetId) {
    return error(res, '不能咨询自己');
  }
  if (businessCatalogId !== null && (!Number.isInteger(businessCatalogId) || businessCatalogId <= 0)) {
    return error(res, '业务分类不正确');
  }
  if (!message) return error(res, '请填写咨询内容');

  const exists = await targetExists(targetType, targetId);
  if (!exists) return error(res, '咨询对象不存在', 404);

  const catalog = await resolveBusinessCatalog(businessCatalogId);
  if (!catalog.exists) return error(res, '业务分类不存在', 404);
  const [result] = await db.query(
    `INSERT INTO consultation_targets
     (consultation_id, requester_user_id, target_type, target_id,
      business_catalog_id, business_group, source_page, message)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      targetType,
      targetId,
      businessCatalogId,
      catalog.businessGroup,
      sourcePage,
      message,
    ]
  );

  return success(res, {
    id: result.insertId,
    consultation_id: null,
    target_type: targetType,
    target_id: targetId,
    business_catalog_id: businessCatalogId,
    business_group: catalog.businessGroup,
    source_page: sourcePage,
  }, '咨询已发送');
}

module.exports = {
  createUnifiedConsultation,
};
