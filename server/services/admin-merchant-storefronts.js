const { attachLocations } = require('./phone-location.service');

const VERIFIED_LABELS = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  suspended: '已暂停',
};

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function merchantStatus(value) {
  const status = String(value || 'pending');
  return VERIFIED_LABELS[status] ? status : 'pending';
}

function displayState(row) {
  const visible = Boolean(Number(row.directory_visible));
  const billingVisible = Boolean(Number(row.billing_shop_visible));
  let reason = '';
  if (!row.shop_name) reason = '未填写店铺名称';
  else if (row.verified_status !== 'approved') reason = VERIFIED_LABELS[merchantStatus(row.verified_status)];
  else if (!visible) reason = '入驻审核有效期已过';

  let billingLabel = '未开通';
  if (billingVisible) billingLabel = '有效';
  else if (row.entitlement_id) {
    if (row.entitlement_reason === 'manual_suspend') billingLabel = '已暂停';
    else if (['refund_closed', 'contract_closed', 'manual_close'].includes(row.entitlement_reason)) billingLabel = '已关闭';
    else if (Number(row.entitlement_expired)) billingLabel = '已到期';
    else billingLabel = '未生效';
  }
  return {
    directory_visible: visible,
    display_label: visible ? '展示中' : '未展示',
    display_reason: reason,
    billing_shop_visible: billingVisible,
    billing_display_label: billingLabel,
    billing_expire_at: row.entitlement_expire_at || null,
    display_mismatch: visible && !billingVisible,
  };
}

async function list(db, query = {}) {
  const keyword = String(query.keyword || '').trim().slice(0, 100);
  const verificationStatus = String(query.verification_status || '').trim();
  if (verificationStatus && !Object.hasOwn(VERIFIED_LABELS, verificationStatus)) {
    throw fail('认证状态不正确');
  }

  const clauses = ["ur.role = 'merchant'"];
  const params = [];
  if (query.includeTests !== '1') clauses.push('COALESCE(u.is_test_account, 0) = 0');
  if (verificationStatus) {
    clauses.push('ur.verified_status = ?');
    params.push(verificationStatus);
  }
  if (keyword) {
    const like = `%${keyword}%`;
    clauses.push(`(
      u.nickname LIKE ? OR u.phone LIKE ? OR mp.shop_name LIKE ? OR mp.contact_phone LIKE ?
      OR u.city LIKE ? OR mp.service_area LIKE ? OR mp.category_group LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like);
  }

  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
     WHERE ${clauses.join(' AND ')}`,
    params
  );
  const total = Number(countRow.total || 0);
  const pageSize = 20;
  const page = Math.min(Math.max(1, Number.parseInt(query.page, 10) || 1), Math.max(1, Math.ceil(total / pageSize)));

  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.nickname, u.phone, u.city, u.is_test_account,
            ur.verified_status, ur.verified_at, ur.verified_until, ur.verified_applied_at, ur.review_note,
            (COALESCE(mp.shop_name, '') <> '' AND ur.verified_status = 'approved'
             AND (ur.verified_until IS NULL OR ur.verified_until >= NOW())) AS directory_visible,
            be.id AS entitlement_id, be.reason AS entitlement_reason, be.expire_at AS entitlement_expire_at,
            (be.expire_at <= NOW()) AS entitlement_expired,
            (be.status = 'active' AND be.readonly_mode = 0 AND be.expire_at > NOW()
             AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.shop_visible')) = 'true') AS billing_shop_visible,
            mp.shop_name, mp.contact_phone, mp.category_group, mp.categories, mp.service_types, mp.service_area,
            COALESCE(product_stats.product_count, 0) AS product_count,
            COALESCE(case_stats.case_count, 0) AS case_count,
            NULLIF(GREATEST(
              COALESCE(mp.updated_at, '1970-01-01'),
              COALESCE(product_stats.last_product_at, '1970-01-01'),
              COALESCE(case_stats.last_case_at, '1970-01-01')
            ), '1970-01-01') AS last_active_at
     FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
     LEFT JOIN billing_entitlements be ON be.id = (
       SELECT entitlement.id FROM billing_entitlements entitlement
       WHERE entitlement.subject_type = 'merchant' AND entitlement.subject_id = u.id
       ORDER BY (entitlement.status = 'active' AND entitlement.expire_at > NOW()) DESC,
                entitlement.updated_at DESC, entitlement.id DESC
       LIMIT 1
     )
     LEFT JOIN (
       SELECT merchant_user_id, COUNT(*) AS product_count, MAX(updated_at) AS last_product_at
       FROM merchant_products
       WHERE status = 'active'
       GROUP BY merchant_user_id
     ) product_stats ON product_stats.merchant_user_id = u.id
     LEFT JOIN (
       SELECT merchant_id, COUNT(*) AS case_count, MAX(updated_at) AS last_case_at
       FROM merchant_cases
       WHERE status = 'active'
       GROUP BY merchant_id
     ) case_stats ON case_stats.merchant_id = u.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY last_active_at DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );

  await attachLocations(db, rows);
  return {
    merchants: rows.map(row => ({
      user_id: Number(row.user_id),
      nickname: row.nickname || '',
      phone: row.phone || '',
      phone_location: row.phone_location || null,
      city: row.city || '',
      shop_name: row.shop_name || '',
      contact_phone: row.contact_phone || '',
      verification_status: merchantStatus(row.verified_status),
      verification_label: VERIFIED_LABELS[merchantStatus(row.verified_status)],
      verified_at: row.verified_at || null,
      verified_until: row.verified_until || null,
      verified_applied_at: row.verified_applied_at || null,
      review_note: row.review_note || '',
      ...displayState(row),
      category_group: row.category_group || '',
      categories: parseJsonArray(row.categories),
      service_types: parseJsonArray(row.service_types),
      service_area: row.service_area || '',
      product_count: Number(row.product_count || 0),
      case_count: Number(row.case_count || 0),
      last_active_at: row.last_active_at || null,
      is_test_account: Boolean(Number(row.is_test_account)),
    })),
    total,
    page,
    pageSize,
  };
}

module.exports = { list, parseJsonArray, merchantStatus, displayState };
