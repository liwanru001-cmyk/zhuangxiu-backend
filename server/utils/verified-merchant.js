const db = require('../config/db');

const ACTIVE_VERIFIED_MERCHANT_SQL = `
  SELECT 1
  FROM user_roles
  WHERE user_id = ?
    AND role = 'merchant'
    AND verified_status = 'approved'
    AND (verified_until IS NULL OR verified_until >= NOW())
  LIMIT 1`;

async function hasActiveVerifiedMerchant(userId) {
  const [rows] = await db.query(ACTIVE_VERIFIED_MERCHANT_SQL, [userId]);
  return rows.length > 0;
}

async function assertActiveVerifiedMerchant(userId) {
  if (await hasActiveVerifiedMerchant(userId)) return true;
  const error = new Error('未成为入驻商家，暂不能发布商家信息');
  error.statusCode = 403;
  throw error;
}

function activeVerifiedMerchantExistsSql(alias = 'ur') {
  return `${alias}.role = 'merchant'
    AND ${alias}.verified_status = 'approved'
    AND (${alias}.verified_until IS NULL OR ${alias}.verified_until >= NOW())`;
}

function activeVerifiedMerchantStateSql(alias = 'ur') {
  return `${alias}.verified_status = 'approved'
    AND (${alias}.verified_until IS NULL OR ${alias}.verified_until >= NOW())`;
}

module.exports = {
  ACTIVE_VERIFIED_MERCHANT_SQL,
  hasActiveVerifiedMerchant,
  assertActiveVerifiedMerchant,
  activeVerifiedMerchantExistsSql,
  activeVerifiedMerchantStateSql,
};
