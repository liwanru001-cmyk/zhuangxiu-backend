function activeMerchantShopVisibleExistsSql(subjectIdSql) {
  return `EXISTS (
    SELECT 1
    FROM billing_entitlements be
    WHERE be.subject_type = 'merchant'
      AND be.subject_id = ${subjectIdSql}
      AND be.status = 'active'
      AND be.readonly_mode = 0
      AND be.expire_at > NOW()
      AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.shop_visible')) = 'true'
    LIMIT 1
  )`;
}

module.exports = {
  activeMerchantShopVisibleExistsSql,
};
