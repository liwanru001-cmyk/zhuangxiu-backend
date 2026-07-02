const db = require('../config/db');

const ACTIVE_MERCHANT_PERMISSION_SQL = `
  SELECT 1
  FROM user_roles
  WHERE user_id = ?
    AND role = 'merchant'
    AND permission_status = 'approved'
    AND (paid_until IS NULL OR paid_until >= NOW())
  LIMIT 1`;

async function hasActiveMerchantPermission(userId) {
  const [rows] = await db.query(ACTIVE_MERCHANT_PERMISSION_SQL, [userId]);
  return rows.length > 0;
}

async function assertActiveMerchantPermission(userId) {
  if (await hasActiveMerchantPermission(userId)) return true;
  const error = new Error('商家权限未审核通过');
  error.statusCode = 403;
  throw error;
}

function activeMerchantPermissionExistsSql(alias = 'ur') {
  return `${alias}.role = 'merchant'
    AND ${alias}.permission_status = 'approved'
    AND (${alias}.paid_until IS NULL OR ${alias}.paid_until >= NOW())`;
}

function activeMerchantPermissionStateSql(alias = 'ur') {
  return `${alias}.permission_status = 'approved'
    AND (${alias}.paid_until IS NULL OR ${alias}.paid_until >= NOW())`;
}

module.exports = {
  ACTIVE_MERCHANT_PERMISSION_SQL,
  hasActiveMerchantPermission,
  assertActiveMerchantPermission,
  activeMerchantPermissionExistsSql,
  activeMerchantPermissionStateSql,
};
