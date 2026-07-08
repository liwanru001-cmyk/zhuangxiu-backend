const crypto = require('crypto');
const db = require('../config/db');

const MERCHANT_PLAN_CODE = 'merchant_display_monthly';
const COMPANY_PLAN_CODE = 'company_display_monthly';

class BillingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function generateNo(prefix) {
  return `${prefix}${Date.now()}${crypto.randomInt(100000, 999999)}`;
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function assertMerchantProfile(userId, executor = db) {
  const [rows] = await executor.query(
    `SELECT mp.user_id, mp.shop_name
     FROM merchant_profiles mp
     JOIN user_roles ur ON ur.user_id = mp.user_id AND ur.role = 'merchant'
     WHERE mp.user_id = ?
     LIMIT 1`,
    [userId]
  );
  if (!rows[0]) {
    throw new BillingError('请先创建商家资料并拥有商家身份', 403);
  }
  if (!String(rows[0].shop_name || '').trim()) {
    throw new BillingError('请先完善店铺名称', 400);
  }
  return rows[0];
}

async function assertCompanyProfile(companyId, executor = db) {
  const [rows] = await executor.query(
    `SELECT id, name, status, verification_status
     FROM companies
     WHERE id = ?
       AND status <> 'deleted'
     LIMIT 1`,
    [companyId]
  );
  const company = rows[0];
  if (!company) {
    throw new BillingError('装修公司不存在', 404);
  }
  if (company.status !== 'active') {
    throw new BillingError('装修公司未启用，不能开通付费展示', 400);
  }
  if (company.verification_status !== 'verified') {
    throw new BillingError('装修公司必须认证通过后才能开通付费展示', 403);
  }
  if (!String(company.name || '').trim()) {
    throw new BillingError('装修公司名称不能为空', 400);
  }
  return company;
}

async function ensureMerchantSubject(userId, executor = db) {
  await assertMerchantProfile(userId, executor);
  await executor.query(
    `INSERT INTO billing_subjects (subject_type, subject_id, status)
     VALUES ('merchant', ?, 'active')
     ON DUPLICATE KEY UPDATE status = 'active'`,
    [userId]
  );
}

async function ensureCompanySubject(companyId, executor = db) {
  await assertCompanyProfile(companyId, executor);
  await executor.query(
    `INSERT INTO billing_subjects (subject_type, subject_id, status)
     VALUES ('company', ?, 'active')
     ON DUPLICATE KEY UPDATE status = 'active'`,
    [companyId]
  );
}

async function getMerchantDisplayPlan(executor = db) {
  const [rows] = await executor.query(
    `SELECT p.id AS plan_id,
            pv.id AS plan_version_id,
            pv.name,
            pv.price_cents,
            pv.currency,
            pv.duration_days,
            pv.feature_json,
            pv.limit_json
     FROM billing_plans p
     JOIN billing_plan_versions pv ON pv.plan_id = p.id
     WHERE p.code = ?
       AND p.subject_type = 'merchant'
       AND p.status = 'active'
       AND pv.status = 'published'
     ORDER BY pv.version DESC
     LIMIT 1`,
    [MERCHANT_PLAN_CODE]
  );
  if (!rows[0]) {
    throw new BillingError('商家展示套餐未初始化，请先执行 billing migration', 500);
  }
  return rows[0];
}

async function getCompanyDisplayPlan(executor = db) {
  const [rows] = await executor.query(
    `SELECT p.id AS plan_id,
            pv.id AS plan_version_id,
            pv.name,
            pv.price_cents,
            pv.currency,
            pv.duration_days,
            pv.feature_json,
            pv.limit_json
     FROM billing_plans p
     JOIN billing_plan_versions pv ON pv.plan_id = p.id
     WHERE p.code = ?
       AND p.subject_type = 'company'
       AND p.status = 'active'
       AND pv.status = 'published'
     ORDER BY pv.version DESC
     LIMIT 1`,
    [COMPANY_PLAN_CODE]
  );
  if (!rows[0]) {
    throw new BillingError('装修公司展示套餐未初始化，请先执行 billing migration', 500);
  }
  return rows[0];
}

async function getCompanyDisplayPlanForApp() {
  const plan = await getCompanyDisplayPlan();
  return {
    plan_id: Number(plan.plan_id),
    plan_version_id: Number(plan.plan_version_id),
    code: COMPANY_PLAN_CODE,
    name: plan.name || '装修公司展示套餐',
    price_cents: Number(plan.price_cents || 0),
    currency: plan.currency || 'CNY',
    duration_days: Number(plan.duration_days || 30),
    feature: safeJson(plan.feature_json),
    limit: safeJson(plan.limit_json),
  };
}

async function getMerchantDisplayPlanForApp() {
  const [rows] = await db.query(
    `SELECT p.id AS plan_id,
            pv.id AS plan_version_id,
            pv.name,
            pv.price_cents,
            pv.currency,
            pv.duration_days,
            pv.feature_json,
            pv.limit_json
     FROM billing_plans p
     JOIN billing_plan_versions pv ON pv.plan_id = p.id
     WHERE p.code = ?
       AND p.subject_type = 'merchant'
       AND p.status = 'active'
       AND pv.status = 'published'
     ORDER BY pv.version DESC
     LIMIT 1`,
    [MERCHANT_PLAN_CODE]
  );
  const plan = rows[0];
  if (!plan) return null;
  return {
    plan_id: Number(plan.plan_id),
    plan_version_id: Number(plan.plan_version_id),
    code: MERCHANT_PLAN_CODE,
    name: plan.name || '商家展示套餐',
    price_cents: Number(plan.price_cents || 0),
    currency: plan.currency || 'CNY',
    duration_days: Number(plan.duration_days || 30),
    feature: safeJson(plan.feature_json),
    limit: safeJson(plan.limit_json),
  };
}

async function getMerchantDisplayPlanForAdmin() {
  const [rows] = await db.query(
    `SELECT p.id AS plan_id,
            p.code,
            p.name AS plan_name,
            p.status AS plan_status,
            pv.id AS plan_version_id,
            pv.version,
            pv.name AS version_name,
            pv.price_cents,
            pv.currency,
            pv.duration_days,
            pv.feature_json,
            pv.limit_json,
            pv.status AS version_status,
            pv.published_at,
            pv.created_at
     FROM billing_plans p
     LEFT JOIN billing_plan_versions pv
       ON pv.plan_id = p.id
      AND pv.version = (
        SELECT MAX(version)
        FROM billing_plan_versions
        WHERE plan_id = p.id
      )
     WHERE p.code = ?
     LIMIT 1`,
    [MERCHANT_PLAN_CODE]
  );
  const row = rows[0];
  if (!row) throw new BillingError('商家展示套餐未初始化，请先执行 billing migration', 500);
  const [versionRows] = await db.query(
    `SELECT pv.id AS plan_version_id,
            pv.version,
            pv.name,
            pv.price_cents,
            pv.currency,
            pv.duration_days,
            pv.feature_json,
            pv.limit_json,
            pv.status,
            pv.published_at,
            pv.created_at,
            COUNT(DISTINCT bo.id) AS order_count,
            COUNT(DISTINCT bs.id) AS subscription_count
     FROM billing_plan_versions pv
     LEFT JOIN billing_orders bo ON bo.item_version_id = pv.id
     LEFT JOIN billing_subscriptions bs ON bs.plan_version_id = pv.id
     WHERE pv.plan_id = ?
     GROUP BY pv.id
     ORDER BY pv.version DESC`,
    [row.plan_id]
  );
  return {
    plan_id: Number(row.plan_id),
    plan_version_id: row.plan_version_id ? Number(row.plan_version_id) : null,
    code: row.code,
    plan_name: row.plan_name || '',
    plan_status: row.plan_status || 'inactive',
    version: row.version ? Number(row.version) : 0,
    version_name: row.version_name || row.plan_name || '',
    price_cents: Number(row.price_cents || 0),
    currency: row.currency || 'CNY',
    duration_days: Number(row.duration_days || 30),
    feature: safeJson(row.feature_json),
    limit: safeJson(row.limit_json),
    version_status: row.version_status || '',
    published_at: row.published_at,
    created_at: row.created_at,
    versions: versionRows.map((item) => ({
      plan_version_id: Number(item.plan_version_id),
      version: Number(item.version || 0),
      name: item.name || '',
      price_cents: Number(item.price_cents || 0),
      currency: item.currency || 'CNY',
      duration_days: Number(item.duration_days || 30),
      feature: safeJson(item.feature_json),
      limit: safeJson(item.limit_json),
      status: item.status || '',
      published_at: item.published_at,
      created_at: item.created_at,
      order_count: Number(item.order_count || 0),
      subscription_count: Number(item.subscription_count || 0),
      is_current: Number(item.plan_version_id) === Number(row.plan_version_id),
    })),
  };
}

async function getCompanyDisplayPlanForAdmin() {
  const [rows] = await db.query(
    `SELECT p.id AS plan_id,
            p.code,
            p.name AS plan_name,
            p.status AS plan_status,
            pv.id AS plan_version_id,
            pv.version,
            pv.name AS version_name,
            pv.price_cents,
            pv.currency,
            pv.duration_days,
            pv.feature_json,
            pv.limit_json,
            pv.status AS version_status,
            pv.published_at,
            pv.created_at
     FROM billing_plans p
     LEFT JOIN billing_plan_versions pv
       ON pv.plan_id = p.id
      AND pv.version = (
        SELECT MAX(version)
        FROM billing_plan_versions
        WHERE plan_id = p.id
      )
     WHERE p.code = ?
     LIMIT 1`,
    [COMPANY_PLAN_CODE]
  );
  const row = rows[0];
  if (!row) throw new BillingError('装修公司展示套餐未初始化，请先执行 billing migration', 500);
  const [versionRows] = await db.query(
    `SELECT pv.id AS plan_version_id,
            pv.version,
            pv.name,
            pv.price_cents,
            pv.currency,
            pv.duration_days,
            pv.feature_json,
            pv.limit_json,
            pv.status,
            pv.published_at,
            pv.created_at,
            COUNT(DISTINCT bo.id) AS order_count,
            COUNT(DISTINCT bs.id) AS subscription_count
     FROM billing_plan_versions pv
     LEFT JOIN billing_orders bo ON bo.item_version_id = pv.id
     LEFT JOIN billing_subscriptions bs ON bs.plan_version_id = pv.id
     WHERE pv.plan_id = ?
     GROUP BY pv.id
     ORDER BY pv.version DESC`,
    [row.plan_id]
  );
  return {
    plan_id: Number(row.plan_id),
    plan_version_id: row.plan_version_id ? Number(row.plan_version_id) : null,
    code: row.code,
    plan_name: row.plan_name || '',
    plan_status: row.plan_status || 'inactive',
    version: row.version ? Number(row.version) : 0,
    version_name: row.version_name || row.plan_name || '',
    price_cents: Number(row.price_cents || 0),
    currency: row.currency || 'CNY',
    duration_days: Number(row.duration_days || 30),
    feature: safeJson(row.feature_json),
    limit: safeJson(row.limit_json),
    version_status: row.version_status || '',
    published_at: row.published_at,
    created_at: row.created_at,
    versions: versionRows.map((item) => ({
      plan_version_id: Number(item.plan_version_id),
      version: Number(item.version || 0),
      name: item.name || '',
      price_cents: Number(item.price_cents || 0),
      currency: item.currency || 'CNY',
      duration_days: Number(item.duration_days || 30),
      feature: safeJson(item.feature_json),
      limit: safeJson(item.limit_json),
      status: item.status || '',
      published_at: item.published_at,
      created_at: item.created_at,
      order_count: Number(item.order_count || 0),
      subscription_count: Number(item.subscription_count || 0),
      is_current: Number(item.plan_version_id) === Number(row.plan_version_id),
    })),
  };
}

async function publishMerchantDisplayPlanVersion({
  name,
  priceCents,
  durationDays,
  enabled,
  feature,
  limit,
}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [planRows] = await conn.query(
      `SELECT id, status
       FROM billing_plans
       WHERE code = ?
       LIMIT 1
       FOR UPDATE`,
      [MERCHANT_PLAN_CODE]
    );
    const plan = planRows[0];
    if (!plan) throw new BillingError('商家展示套餐未初始化，请先执行 billing migration', 500);

    await conn.query(
      `UPDATE billing_plans
       SET name = ?, status = ?
       WHERE id = ?`,
      [name, enabled ? 'active' : 'inactive', plan.id]
    );

    const [[versionRow]] = await conn.query(
      `SELECT COALESCE(MAX(version), 0) AS current_version
       FROM billing_plan_versions
       WHERE plan_id = ?`,
      [plan.id]
    );
    const nextVersion = Number(versionRow.current_version || 0) + 1;
    const [result] = await conn.query(
      `INSERT INTO billing_plan_versions (
         plan_id, version, name, price_cents, currency, duration_days,
         feature_json, limit_json, status, published_at
       )
       VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, 'published', NOW())`,
      [
        plan.id,
        nextVersion,
        `${name} v${nextVersion}`,
        priceCents,
        durationDays,
        JSON.stringify(feature),
        JSON.stringify(limit),
      ]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         actor_type, actor_id, action, target_type, target_id,
         after_json, reason
       )
       VALUES ('admin', NULL, 'ADMIN_PUBLISH_MERCHANT_PLAN_VERSION',
               'billing_plan_version', ?, ?, 'merchant_plan_config')`,
      [
        result.insertId,
        JSON.stringify({
          plan_id: plan.id,
          version: nextVersion,
          name,
          price_cents: priceCents,
          duration_days: durationDays,
          enabled,
          feature,
          limit,
        }),
      ]
    );
    await conn.commit();
    return getMerchantDisplayPlanForAdmin();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function publishCompanyDisplayPlanVersion({
  name,
  priceCents,
  durationDays,
  enabled,
  feature,
  limit,
}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [planRows] = await conn.query(
      `SELECT id, status
       FROM billing_plans
       WHERE code = ?
       LIMIT 1
       FOR UPDATE`,
      [COMPANY_PLAN_CODE]
    );
    const plan = planRows[0];
    if (!plan) throw new BillingError('装修公司展示套餐未初始化，请先执行 billing migration', 500);

    await conn.query(
      `UPDATE billing_plans
       SET name = ?, status = ?
       WHERE id = ?`,
      [name, enabled ? 'active' : 'inactive', plan.id]
    );

    const [[versionRow]] = await conn.query(
      `SELECT COALESCE(MAX(version), 0) AS current_version
       FROM billing_plan_versions
       WHERE plan_id = ?`,
      [plan.id]
    );
    const nextVersion = Number(versionRow.current_version || 0) + 1;
    const [result] = await conn.query(
      `INSERT INTO billing_plan_versions (
         plan_id, version, name, price_cents, currency, duration_days,
         feature_json, limit_json, status, published_at
       )
       VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, 'published', NOW())`,
      [
        plan.id,
        nextVersion,
        `${name} v${nextVersion}`,
        priceCents,
        durationDays,
        JSON.stringify(feature),
        JSON.stringify(limit),
      ]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         actor_type, actor_id, action, target_type, target_id,
         after_json, reason
       )
       VALUES ('admin', NULL, 'ADMIN_PUBLISH_COMPANY_PLAN_VERSION',
               'billing_plan_version', ?, ?, 'company_plan_config')`,
      [
        result.insertId,
        JSON.stringify({
          plan_id: plan.id,
          version: nextVersion,
          name,
          price_cents: priceCents,
          duration_days: durationDays,
          enabled,
          feature,
          limit,
        }),
      ]
    );
    await conn.commit();
    return getCompanyDisplayPlanForAdmin();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function createMerchantDisplayOrder({
  merchantUserId,
  operatorUserId,
  actorType = 'user',
  paymentChannel = 'manual',
  idempotencyKey,
}) {
  await ensureMerchantSubject(merchantUserId);
  const plan = await getMerchantDisplayPlan();

  if (idempotencyKey) {
    const [existing] = await db.query(
      `SELECT id, order_no, status, amount_cents, currency, payment_channel, created_at, paid_at
       FROM billing_orders
       WHERE idempotency_key = ?
       LIMIT 1`,
      [idempotencyKey]
    );
    if (existing[0]) return { order: existing[0], reused: true };
  }

  const orderNo = generateNo('BO');
  const [result] = await db.query(
    `INSERT INTO billing_orders (
       order_no, subject_type, subject_id, order_type, item_type, item_id,
       item_version_id, amount_cents, currency, payment_channel, status,
       idempotency_key, metadata_json, created_by
     )
     VALUES (?, 'merchant', ?, 'subscription', 'plan', ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)`,
    [
      orderNo,
      merchantUserId,
      plan.plan_id,
      plan.plan_version_id,
      plan.price_cents,
      plan.currency,
      paymentChannel,
      idempotencyKey || null,
      JSON.stringify({ plan_code: MERCHANT_PLAN_CODE }),
      operatorUserId || merchantUserId,
    ]
  );

  await db.query(
    `INSERT INTO billing_audit_logs (
       subject_type, subject_id, actor_type, actor_id, action,
       target_type, target_id, after_json, reason
     )
     VALUES ('merchant', ?, ?, ?, 'ORDER_CREATED', 'billing_order', ?, ?, 'merchant_display_order')`,
    [
      merchantUserId,
      actorType,
      operatorUserId || merchantUserId,
      result.insertId,
      JSON.stringify({
        order_no: orderNo,
        amount_cents: plan.price_cents,
        payment_channel: paymentChannel,
      }),
    ]
  );

  return {
    order: {
      id: result.insertId,
      order_no: orderNo,
      status: 'pending_payment',
      amount_cents: plan.price_cents,
      currency: plan.currency,
      payment_channel: paymentChannel,
      item_type: 'plan',
      item_id: plan.plan_id,
      item_version_id: plan.plan_version_id,
    },
    reused: false,
  };
}

async function createCompanyDisplayOrder({
  companyId,
  operatorUserId,
  actorType = 'admin',
  paymentChannel = 'manual',
  idempotencyKey,
}) {
  await ensureCompanySubject(companyId);
  const plan = await getCompanyDisplayPlan();

  if (idempotencyKey) {
    const [existing] = await db.query(
      `SELECT id, order_no, status, amount_cents, currency, payment_channel, created_at, paid_at
       FROM billing_orders
       WHERE idempotency_key = ?
       LIMIT 1`,
      [idempotencyKey]
    );
    if (existing[0]) return { order: existing[0], reused: true };
  }

  const orderNo = generateNo('BO');
  const [result] = await db.query(
    `INSERT INTO billing_orders (
       order_no, subject_type, subject_id, order_type, item_type, item_id,
       item_version_id, amount_cents, currency, payment_channel, status,
       idempotency_key, metadata_json, created_by
     )
     VALUES (?, 'company', ?, 'subscription', 'plan', ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)`,
    [
      orderNo,
      companyId,
      plan.plan_id,
      plan.plan_version_id,
      plan.price_cents,
      plan.currency,
      paymentChannel,
      idempotencyKey || null,
      JSON.stringify({ plan_code: COMPANY_PLAN_CODE }),
      operatorUserId || null,
    ]
  );

  await db.query(
    `INSERT INTO billing_audit_logs (
       subject_type, subject_id, actor_type, actor_id, action,
       target_type, target_id, after_json, reason
     )
     VALUES ('company', ?, ?, ?, 'ORDER_CREATED', 'billing_order', ?, ?, 'company_display_order')`,
    [
      companyId,
      actorType,
      operatorUserId || null,
      result.insertId,
      JSON.stringify({
        order_no: orderNo,
        amount_cents: plan.price_cents,
        payment_channel: paymentChannel,
      }),
    ]
  );

  return {
    order: {
      id: result.insertId,
      order_no: orderNo,
      status: 'pending_payment',
      amount_cents: plan.price_cents,
      currency: plan.currency,
      payment_channel: paymentChannel,
      item_type: 'plan',
      item_id: plan.plan_id,
      item_version_id: plan.plan_version_id,
    },
    reused: false,
  };
}

async function insertAudit(conn, payload) {
  await conn.query(
    `INSERT INTO billing_audit_logs (
       subject_type, subject_id, actor_type, actor_id, action,
       target_type, target_id, before_json, after_json, reason, request_id
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.subject_type || null,
      payload.subject_id || null,
      payload.actor_type || 'system',
      payload.actor_id || null,
      payload.action,
      payload.target_type,
      payload.target_id || null,
      payload.before_json ? JSON.stringify(payload.before_json) : null,
      payload.after_json ? JSON.stringify(payload.after_json) : null,
      payload.reason || null,
      payload.request_id || null,
    ]
  );
}

async function insertEvent(conn, payload) {
  await conn.query(
    `INSERT INTO billing_events (
       event_id, event_type, event_version, subject_type, subject_id,
       aggregate_type, aggregate_id, payload_json, status
     )
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'pending')`,
    [
      crypto.randomUUID(),
      payload.event_type,
      payload.subject_type || null,
      payload.subject_id || null,
      payload.aggregate_type,
      payload.aggregate_id || null,
      payload.payload_json ? JSON.stringify(payload.payload_json) : null,
    ]
  );
}

async function getOrderForOwner(orderId, merchantUserId) {
  const [rows] = await db.query(
    `SELECT id, order_no, subject_type, subject_id, status, amount_cents,
            currency, payment_channel, paid_at
     FROM billing_orders
     WHERE id = ? AND subject_type = 'merchant' AND subject_id = ?
     LIMIT 1`,
    [orderId, merchantUserId]
  );
  return rows[0] || null;
}

async function getCompanyOrderForOwner(orderId, companyId) {
  const [rows] = await db.query(
    `SELECT id, order_no, subject_type, subject_id, status, amount_cents,
            currency, payment_channel, paid_at
     FROM billing_orders
     WHERE id = ? AND subject_type = 'company' AND subject_id = ?
     LIMIT 1`,
    [orderId, companyId]
  );
  return rows[0] || null;
}

async function getMerchantOrderStatus(orderId, merchantUserId) {
  const [orderRows] = await db.query(
    `SELECT id, order_no, subject_type, subject_id, status, amount_cents,
            currency, payment_channel, paid_at, closed_at, created_at, updated_at
     FROM billing_orders
     WHERE id = ? AND subject_type = 'merchant' AND subject_id = ?
     LIMIT 1`,
    [orderId, merchantUserId]
  );
  const order = orderRows[0];
  if (!order) return null;
  const [paymentRows] = await db.query(
    `SELECT id, payment_no, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_payments
     WHERE order_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [orderId]
  );
  const [subscriptionRows] = await db.query(
    `SELECT id, subscription_no, status, started_at, expire_at, readonly_mode, reason
     FROM billing_subscriptions
     WHERE source_order_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [orderId]
  );
  const entitlement = await getCurrentEntitlement('merchant', merchantUserId);
  return {
    order,
    payment: paymentRows[0] || null,
    subscription: subscriptionRows[0] || null,
    entitlement,
    shop_visible: entitlement.shop_visible,
  };
}

async function getCompanyOrderStatus(orderId, companyId) {
  const [orderRows] = await db.query(
    `SELECT id, order_no, subject_type, subject_id, status, amount_cents,
            currency, payment_channel, paid_at, closed_at, created_at, updated_at
     FROM billing_orders
     WHERE id = ? AND subject_type = 'company' AND subject_id = ?
     LIMIT 1`,
    [orderId, companyId]
  );
  const order = orderRows[0];
  if (!order) return null;
  const [paymentRows] = await db.query(
    `SELECT id, payment_no, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_payments
     WHERE order_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [orderId]
  );
  const [subscriptionRows] = await db.query(
    `SELECT id, subscription_no, status, started_at, expire_at, readonly_mode, reason
     FROM billing_subscriptions
     WHERE source_order_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [orderId]
  );
  const entitlement = await getCurrentEntitlement('company', companyId);
  return {
    order,
    payment: paymentRows[0] || null,
    subscription: subscriptionRows[0] || null,
    entitlement,
    company_visible: entitlement.company_visible,
  };
}

async function payMerchantOrderManual({
  orderId,
  merchantUserId,
  operatorUserId,
  actorType = 'user',
  idempotencyKey,
}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [orderRows] = await conn.query(
      `SELECT o.*, pv.duration_days, pv.feature_json, pv.limit_json, pv.plan_id
       FROM billing_orders o
       JOIN billing_plan_versions pv ON pv.id = o.item_version_id
       WHERE o.id = ?
         AND o.subject_type = 'merchant'
         AND o.subject_id = ?
       LIMIT 1
       FOR UPDATE`,
      [orderId, merchantUserId]
    );
    const order = orderRows[0];
    if (!order) throw new BillingError('订单不存在或无权操作', 404);
    if (order.status === 'paid') {
      const [entitlementRows] = await conn.query(
        `SELECT *
         FROM billing_entitlements
         WHERE subject_type = 'merchant'
           AND subject_id = ?
           AND status = 'active'
         ORDER BY expire_at DESC, id DESC
         LIMIT 1`,
        [merchantUserId]
      );
      await conn.commit();
      return { order, entitlement: normalizeEntitlement(entitlementRows[0] || null), reused: true };
    }
    if (order.status !== 'pending_payment') {
      throw new BillingError('当前订单状态不允许支付', 409);
    }

    if (idempotencyKey) {
      const [paymentRows] = await conn.query(
        `SELECT id
         FROM billing_payments
         WHERE payment_channel = 'manual'
           AND idempotency_key = ?
         LIMIT 1`,
        [idempotencyKey]
      );
      if (paymentRows[0]) {
        throw new BillingError('该支付请求已处理，请刷新订单状态', 409);
      }
    }

    const paymentNo = generateNo('BP');
    const [paymentResult] = await conn.query(
      `INSERT INTO billing_payments (
         payment_no, order_id, subject_type, subject_id, payment_channel,
         amount_cents, currency, status, provider_transaction_id,
         idempotency_key, paid_at, raw_payload_json
       )
       VALUES (?, ?, 'merchant', ?, 'manual', ?, ?, 'succeeded', ?, ?, NOW(), ?)`,
      [
        paymentNo,
        order.id,
        merchantUserId,
        order.amount_cents,
        order.currency,
        `manual-${paymentNo}`,
        idempotencyKey || null,
        JSON.stringify({ source: 'merchant_mvp_manual_pay' }),
      ]
    );

    await conn.query(
      `UPDATE billing_orders
       SET status = 'paid', paid_at = NOW()
       WHERE id = ?`,
      [order.id]
    );

    await conn.query(
      `UPDATE billing_subscriptions
       SET status = 'expired', readonly_mode = 1, reason = 'replaced'
       WHERE subject_type = 'merchant'
         AND subject_id = ?
         AND status = 'active'
         AND is_primary = 1`,
      [merchantUserId]
    );

    const subscriptionNo = generateNo('BS');
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + Number(order.duration_days || 30));
    const [subscriptionResult] = await conn.query(
      `INSERT INTO billing_subscriptions (
         subscription_no, subject_type, subject_id, plan_id, plan_version_id,
         source_order_id, status, is_primary, started_at, expire_at,
         readonly_mode, reason
       )
       VALUES (?, 'merchant', ?, ?, ?, ?, 'active', 1, NOW(), ?, 0, NULL)`,
      [
        subscriptionNo,
        merchantUserId,
        order.plan_id,
        order.item_version_id,
        order.id,
        expireAt,
      ]
    );

    const featureJson = safeJson(order.feature_json);
    const limitJson = safeJson(order.limit_json);
    await conn.query(
      `UPDATE billing_entitlements
       SET status = 'inactive', readonly_mode = 1, reason = 'recalculated'
       WHERE subject_type = 'merchant'
         AND subject_id = ?
         AND status = 'active'`,
      [merchantUserId]
    );
    const [entitlementResult] = await conn.query(
      `INSERT INTO billing_entitlements (
         subject_type, subject_id, subscription_id, source_type, source_id,
         status, entitlement_version, feature_json, limit_json,
         readonly_mode, reason, expire_at, calculated_at
       )
       VALUES ('merchant', ?, ?, 'subscription', ?, 'active', 1, ?, ?, 0, NULL, ?, NOW())`,
      [
        merchantUserId,
        subscriptionResult.insertId,
        subscriptionResult.insertId,
        JSON.stringify(featureJson),
        JSON.stringify(limitJson),
        expireAt,
      ]
    );

    const after = {
      order_id: order.id,
      payment_id: paymentResult.insertId,
      subscription_id: subscriptionResult.insertId,
      entitlement_id: entitlementResult.insertId,
      expire_at: expireAt,
      feature: featureJson,
      limit: limitJson,
    };

    await insertAudit(conn, {
      subject_type: 'merchant',
      subject_id: merchantUserId,
      actor_type: actorType,
      actor_id: operatorUserId || merchantUserId,
      action: 'PAYMENT_SUCCESS_ACTIVATE_MERCHANT',
      target_type: 'billing_order',
      target_id: order.id,
      after_json: after,
      reason: 'merchant_display_subscription_paid',
      request_id: idempotencyKey || null,
    });

    await insertEvent(conn, {
      event_type: 'PAYMENT_SUCCESS',
      subject_type: 'merchant',
      subject_id: merchantUserId,
      aggregate_type: 'billing_order',
      aggregate_id: order.id,
      payload_json: after,
    });
    await insertEvent(conn, {
      event_type: 'ENTITLEMENT_RECALCULATED',
      subject_type: 'merchant',
      subject_id: merchantUserId,
      aggregate_type: 'billing_entitlement',
      aggregate_id: entitlementResult.insertId,
      payload_json: after,
    });

    await conn.commit();
    return {
      order: { ...order, status: 'paid' },
      payment: { id: paymentResult.insertId, payment_no: paymentNo, status: 'succeeded' },
      subscription: {
        id: subscriptionResult.insertId,
        subscription_no: subscriptionNo,
        status: 'active',
        expire_at: expireAt,
      },
      entitlement: {
        id: entitlementResult.insertId,
        status: 'active',
        feature: featureJson,
        limit: limitJson,
        expire_at: expireAt,
        readonly_mode: false,
      },
      reused: false,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function payCompanyOrderManual({
  orderId,
  companyId,
  operatorUserId,
  actorType = 'admin',
  idempotencyKey,
}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await assertCompanyProfile(companyId, conn);
    const [orderRows] = await conn.query(
      `SELECT o.*, pv.duration_days, pv.feature_json, pv.limit_json, pv.plan_id
       FROM billing_orders o
       JOIN billing_plan_versions pv ON pv.id = o.item_version_id
       WHERE o.id = ?
         AND o.subject_type = 'company'
         AND o.subject_id = ?
       LIMIT 1
       FOR UPDATE`,
      [orderId, companyId]
    );
    const order = orderRows[0];
    if (!order) throw new BillingError('订单不存在或无权操作', 404);
    if (order.status === 'paid') {
      const [entitlementRows] = await conn.query(
        `SELECT *
         FROM billing_entitlements
         WHERE subject_type = 'company'
           AND subject_id = ?
           AND status = 'active'
         ORDER BY expire_at DESC, id DESC
         LIMIT 1`,
        [companyId]
      );
      await conn.commit();
      return { order, entitlement: normalizeEntitlement(entitlementRows[0] || null), reused: true };
    }
    if (order.status !== 'pending_payment') {
      throw new BillingError('当前订单状态不允许支付', 409);
    }

    if (idempotencyKey) {
      const [paymentRows] = await conn.query(
        `SELECT id
         FROM billing_payments
         WHERE payment_channel = 'manual'
           AND idempotency_key = ?
         LIMIT 1`,
        [idempotencyKey]
      );
      if (paymentRows[0]) {
        throw new BillingError('该支付请求已处理，请刷新订单状态', 409);
      }
    }

    const paymentNo = generateNo('BP');
    const [paymentResult] = await conn.query(
      `INSERT INTO billing_payments (
         payment_no, order_id, subject_type, subject_id, payment_channel,
         amount_cents, currency, status, provider_transaction_id,
         idempotency_key, paid_at, raw_payload_json
       )
       VALUES (?, ?, 'company', ?, 'manual', ?, ?, 'succeeded', ?, ?, NOW(), ?)`,
      [
        paymentNo,
        order.id,
        companyId,
        order.amount_cents,
        order.currency,
        `manual-${paymentNo}`,
        idempotencyKey || null,
        JSON.stringify({ source: 'company_mvp_manual_pay' }),
      ]
    );

    await conn.query(
      `UPDATE billing_orders
       SET status = 'paid', paid_at = NOW()
       WHERE id = ?`,
      [order.id]
    );

    await conn.query(
      `UPDATE billing_subscriptions
       SET status = 'expired', readonly_mode = 1, reason = 'replaced'
       WHERE subject_type = 'company'
         AND subject_id = ?
         AND status = 'active'
         AND is_primary = 1`,
      [companyId]
    );

    const subscriptionNo = generateNo('BS');
    const expireAt = new Date();
    expireAt.setDate(expireAt.getDate() + Number(order.duration_days || 30));
    const [subscriptionResult] = await conn.query(
      `INSERT INTO billing_subscriptions (
         subscription_no, subject_type, subject_id, plan_id, plan_version_id,
         source_order_id, status, is_primary, started_at, expire_at,
         readonly_mode, reason
       )
       VALUES (?, 'company', ?, ?, ?, ?, 'active', 1, NOW(), ?, 0, NULL)`,
      [
        subscriptionNo,
        companyId,
        order.plan_id,
        order.item_version_id,
        order.id,
        expireAt,
      ]
    );

    const featureJson = safeJson(order.feature_json);
    const limitJson = safeJson(order.limit_json);
    await conn.query(
      `UPDATE billing_entitlements
       SET status = 'inactive', readonly_mode = 1, reason = 'recalculated'
       WHERE subject_type = 'company'
         AND subject_id = ?
         AND status = 'active'`,
      [companyId]
    );
    const [entitlementResult] = await conn.query(
      `INSERT INTO billing_entitlements (
         subject_type, subject_id, subscription_id, source_type, source_id,
         status, entitlement_version, feature_json, limit_json,
         readonly_mode, reason, expire_at, calculated_at
       )
       VALUES ('company', ?, ?, 'subscription', ?, 'active', 1, ?, ?, 0, NULL, ?, NOW())`,
      [
        companyId,
        subscriptionResult.insertId,
        subscriptionResult.insertId,
        JSON.stringify(featureJson),
        JSON.stringify(limitJson),
        expireAt,
      ]
    );

    await conn.query(
      `UPDATE companies
       SET paid_display_status = 'active',
           paid_display_starts_at = COALESCE(paid_display_starts_at, NOW()),
           paid_display_ends_at = ?
       WHERE id = ?`,
      [expireAt, companyId]
    );

    const after = {
      order_id: order.id,
      payment_id: paymentResult.insertId,
      subscription_id: subscriptionResult.insertId,
      entitlement_id: entitlementResult.insertId,
      expire_at: expireAt,
      feature: featureJson,
      limit: limitJson,
    };

    await insertAudit(conn, {
      subject_type: 'company',
      subject_id: companyId,
      actor_type: actorType,
      actor_id: operatorUserId || null,
      action: 'PAYMENT_SUCCESS_ACTIVATE_COMPANY',
      target_type: 'billing_order',
      target_id: order.id,
      after_json: after,
      reason: 'company_display_subscription_paid',
      request_id: idempotencyKey || null,
    });

    await insertEvent(conn, {
      event_type: 'PAYMENT_SUCCESS',
      subject_type: 'company',
      subject_id: companyId,
      aggregate_type: 'billing_order',
      aggregate_id: order.id,
      payload_json: after,
    });
    await insertEvent(conn, {
      event_type: 'ENTITLEMENT_RECALCULATED',
      subject_type: 'company',
      subject_id: companyId,
      aggregate_type: 'billing_entitlement',
      aggregate_id: entitlementResult.insertId,
      payload_json: after,
    });

    await conn.commit();
    return {
      order: { ...order, status: 'paid' },
      payment: { id: paymentResult.insertId, payment_no: paymentNo, status: 'succeeded' },
      subscription: {
        id: subscriptionResult.insertId,
        subscription_no: subscriptionNo,
        status: 'active',
        expire_at: expireAt,
      },
      entitlement: {
        id: entitlementResult.insertId,
        status: 'active',
        feature: featureJson,
        limit: limitJson,
        expire_at: expireAt,
        readonly_mode: false,
        company_visible: Boolean(featureJson.company_visible),
      },
      reused: false,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function normalizeEntitlement(row) {
  if (!row) {
    return {
      status: 'inactive',
      feature: {},
      limit: {},
      readonly_mode: true,
      reason: null,
      reason_label: null,
      expire_at: null,
      shop_visible: false,
      company_visible: false,
    };
  }
  const feature = safeJson(row.feature_json);
  const expireAt = row.expire_at;
  const expired = expireAt ? new Date(expireAt).getTime() <= Date.now() : false;
  const reason = row.reason || (expired ? 'expired' : row.status !== 'active' ? row.status : null);
  return {
    id: row.id,
    status: row.status,
    feature,
    limit: safeJson(row.limit_json),
    readonly_mode: Boolean(row.readonly_mode),
    reason,
    reason_label: getEntitlementReasonLabel(reason),
    expire_at: expireAt,
    shop_visible:
      row.status === 'active' &&
      !row.readonly_mode &&
      Boolean(feature.shop_visible) &&
      !expired,
    company_visible:
      row.status === 'active' &&
      !row.readonly_mode &&
      Boolean(feature.company_visible) &&
      !expired,
  };
}

function getEntitlementReasonLabel(reason) {
  const labels = {
    manual_suspend: '后台已暂停展示',
    refund_closed: '后台已关闭展示权益',
    expired: '展示权益已到期',
    inactive: '展示权益未生效',
    cancelled: '展示权益已取消',
    refunded: '展示权益已退款关闭',
  };
  return reason ? labels[reason] || '店铺展示暂不可用' : null;
}

function normalizeAppeal(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    appeal_no: row.appeal_no || '',
    subject_type: row.subject_type || 'merchant',
    subject_id: Number(row.subject_id || 0),
    appeal_type: row.appeal_type || 'merchant_display_restore',
    status: row.status || 'pending',
    entitlement_id: row.entitlement_id ? Number(row.entitlement_id) : null,
    reason_code: row.reason_code || null,
    reason_label: row.reason_label || null,
    content: row.content || '',
    result_reason: row.result_reason || null,
    created_by: row.created_by ? Number(row.created_by) : null,
    reviewed_by: row.reviewed_by ? Number(row.reviewed_by) : null,
    reviewed_at: row.reviewed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function assertAppealableEntitlement(entitlement, visibleField = 'shop_visible', visibleMessage = '店铺当前正在展示，无需申诉') {
  if (!entitlement || !entitlement.id) {
    throw new BillingError('当前没有可申诉的关闭记录', 400);
  }
  if (entitlement[visibleField]) {
    throw new BillingError(visibleMessage, 409);
  }
  if (!['manual_suspend', 'refund_closed'].includes(entitlement.reason)) {
    throw new BillingError('当前状态不支持申诉，请按页面提示处理', 400);
  }
}

async function getCurrentEntitlement(subjectType, subjectId) {
  if (!['merchant', 'company'].includes(subjectType)) {
    throw new BillingError('当前 MVP 只支持 merchant/company 主体', 400);
  }
  const [rows] = await db.query(
    `SELECT *
     FROM billing_entitlements
     WHERE subject_type = ?
       AND subject_id = ?
     ORDER BY (status = 'active' AND expire_at > NOW()) DESC,
              updated_at DESC,
              id DESC
     LIMIT 1`,
    [subjectType, subjectId]
  );
  return normalizeEntitlement(rows[0] || null);
}

async function getLatestMerchantAppeal(merchantUserId, status = '') {
  const params = [merchantUserId];
  let statusWhere = '';
  if (status) {
    statusWhere = ' AND status = ?';
    params.push(status);
  }
  const [rows] = await db.query(
    `SELECT *
     FROM billing_appeals
     WHERE subject_type = 'merchant'
       AND subject_id = ?
       AND appeal_type = 'merchant_display_restore'
       ${statusWhere}
     ORDER BY id DESC
     LIMIT 1`,
    params
  );
  return normalizeAppeal(rows[0] || null);
}

async function createMerchantDisplayAppeal({ merchantUserId, content, idempotencyKey }) {
  await ensureMerchantSubject(merchantUserId);
  const normalizedContent = String(content || '').trim().slice(0, 300);
  if (!normalizedContent) throw new BillingError('请填写申诉说明', 400);
  if (normalizedContent.length < 5) throw new BillingError('申诉说明请至少填写 5 个字', 400);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [pendingRows] = await conn.query(
      `SELECT *
       FROM billing_appeals
       WHERE subject_type = 'merchant'
         AND subject_id = ?
         AND appeal_type = 'merchant_display_restore'
         AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [merchantUserId]
    );
    if (pendingRows[0]) {
      await conn.commit();
      return { appeal: normalizeAppeal(pendingRows[0]), reused: true };
    }

    const [entitlementRows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'merchant'
         AND subject_id = ?
       ORDER BY (status = 'active' AND expire_at > NOW()) DESC,
                updated_at DESC,
                id DESC
       LIMIT 1
       FOR UPDATE`,
      [merchantUserId]
    );
    const entitlement = normalizeEntitlement(entitlementRows[0] || null);
    assertAppealableEntitlement(entitlement);

    const appealNo = generateNo('BA');
    const [result] = await conn.query(
      `INSERT INTO billing_appeals (
         appeal_no, subject_type, subject_id, appeal_type, status,
         entitlement_id, reason_code, reason_label, content, created_by
       )
       VALUES (?, 'merchant', ?, 'merchant_display_restore', 'pending',
               ?, ?, ?, ?, ?)`,
      [
        appealNo,
        merchantUserId,
        entitlement.id,
        entitlement.reason,
        entitlement.reason_label,
        normalizedContent,
        merchantUserId,
      ]
    );
    const appeal = {
      id: result.insertId,
      appeal_no: appealNo,
      subject_type: 'merchant',
      subject_id: merchantUserId,
      appeal_type: 'merchant_display_restore',
      status: 'pending',
      entitlement_id: entitlement.id,
      reason_code: entitlement.reason,
      reason_label: entitlement.reason_label,
      content: normalizedContent,
      created_by: merchantUserId,
    };

    await insertAudit(conn, {
      subject_type: 'merchant',
      subject_id: merchantUserId,
      actor_type: 'user',
      actor_id: merchantUserId,
      action: 'MERCHANT_DISPLAY_APPEAL_CREATED',
      target_type: 'billing_appeal',
      target_id: result.insertId,
      after_json: appeal,
      reason: normalizedContent,
      request_id: idempotencyKey || null,
    });
    await insertEvent(conn, {
      event_type: 'MERCHANT_DISPLAY_APPEAL_CREATED',
      subject_type: 'merchant',
      subject_id: merchantUserId,
      aggregate_type: 'billing_appeal',
      aggregate_id: result.insertId,
      payload_json: appeal,
    });

    await conn.commit();
    return { appeal: normalizeAppeal(appeal), reused: false };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function createCompanyDisplayAppeal({ companyId, operatorUserId, content, idempotencyKey }) {
  await ensureCompanySubject(companyId);
  const normalizedContent = String(content || '').trim().slice(0, 300);
  if (!normalizedContent) throw new BillingError('请填写申诉说明', 400);
  if (normalizedContent.length < 5) throw new BillingError('申诉说明请至少填写 5 个字', 400);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [pendingRows] = await conn.query(
      `SELECT *
       FROM billing_appeals
       WHERE subject_type = 'company'
         AND subject_id = ?
         AND appeal_type = 'company_display_restore'
         AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [companyId]
    );
    if (pendingRows[0]) {
      await conn.commit();
      return { appeal: normalizeAppeal(pendingRows[0]), reused: true };
    }

    const [entitlementRows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'company'
         AND subject_id = ?
       ORDER BY (status = 'active' AND expire_at > NOW()) DESC,
                updated_at DESC,
                id DESC
       LIMIT 1
       FOR UPDATE`,
      [companyId]
    );
    const entitlement = normalizeEntitlement(entitlementRows[0] || null);
    assertAppealableEntitlement(entitlement, 'company_visible', '装修公司当前正在展示，无需申诉');

    const appealNo = generateNo('BA');
    const [result] = await conn.query(
      `INSERT INTO billing_appeals (
         appeal_no, subject_type, subject_id, appeal_type, status,
         entitlement_id, reason_code, reason_label, content, created_by
       )
       VALUES (?, 'company', ?, 'company_display_restore', 'pending',
               ?, ?, ?, ?, ?)`,
      [
        appealNo,
        companyId,
        entitlement.id,
        entitlement.reason,
        entitlement.reason_label,
        normalizedContent,
        operatorUserId,
      ]
    );
    const appeal = {
      id: result.insertId,
      appeal_no: appealNo,
      subject_type: 'company',
      subject_id: companyId,
      appeal_type: 'company_display_restore',
      status: 'pending',
      entitlement_id: entitlement.id,
      reason_code: entitlement.reason,
      reason_label: entitlement.reason_label,
      content: normalizedContent,
      created_by: operatorUserId,
    };

    await insertAudit(conn, {
      subject_type: 'company',
      subject_id: companyId,
      actor_type: 'user',
      actor_id: operatorUserId,
      action: 'COMPANY_DISPLAY_APPEAL_CREATED',
      target_type: 'billing_appeal',
      target_id: result.insertId,
      after_json: appeal,
      reason: normalizedContent,
      request_id: idempotencyKey || null,
    });
    await insertEvent(conn, {
      event_type: 'COMPANY_DISPLAY_APPEAL_CREATED',
      subject_type: 'company',
      subject_id: companyId,
      aggregate_type: 'billing_appeal',
      aggregate_id: result.insertId,
      payload_json: appeal,
    });

    await conn.commit();
    return { appeal: normalizeAppeal(appeal), reused: false };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function listMerchantDisplayAppeals({ status = '', keyword = '', page = 1, pageSize = 20 } = {}) {
  const params = [];
  let where = `ba.subject_type = 'merchant' AND ba.appeal_type = 'merchant_display_restore'`;
  const normalizedStatus = String(status || '').trim();
  if (normalizedStatus) {
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(normalizedStatus)) {
      throw new BillingError('申诉状态不正确', 400);
    }
    where += ' AND ba.status = ?';
    params.push(normalizedStatus);
  }
  const normalizedKeyword = String(keyword || '').trim();
  if (normalizedKeyword) {
    where += ` AND (
      ba.appeal_no LIKE ?
      OR u.nickname LIKE ?
      OR u.phone LIKE ?
      OR mp.shop_name LIKE ?
      OR ba.content LIKE ?
    )`;
    const kw = `%${normalizedKeyword}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  const pageNo = Math.max(1, parseInt(page, 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNo - 1) * safePageSize;
  const [rows] = await db.query(
    `SELECT ba.*, u.phone, u.nickname, mp.shop_name,
            be.status AS entitlement_status,
            be.readonly_mode AS entitlement_readonly_mode,
            be.expire_at AS entitlement_expire_at
     FROM billing_appeals ba
     LEFT JOIN users u ON u.id = ba.subject_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = ba.subject_id
     LEFT JOIN billing_entitlements be ON be.id = ba.entitlement_id
     WHERE ${where}
     ORDER BY ba.created_at DESC, ba.id DESC
     LIMIT ? OFFSET ?`,
    [...params, safePageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM billing_appeals ba
     LEFT JOIN users u ON u.id = ba.subject_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = ba.subject_id
     WHERE ${where}`,
    params
  );
  return {
    appeals: rows.map((row) => ({
      ...normalizeAppeal(row),
      merchant: {
        user_id: Number(row.subject_id || 0),
        phone: row.phone || '',
        nickname: row.nickname || '',
        shop_name: row.shop_name || '',
      },
      entitlement: {
        status: row.entitlement_status || '',
        readonly_mode: Boolean(row.entitlement_readonly_mode),
        expire_at: row.entitlement_expire_at || null,
      },
    })),
    total: Number(countRow.total || 0),
    page: pageNo,
    pageSize: safePageSize,
  };
}

async function listCompanyDisplayAppeals({ status = '', keyword = '', page = 1, pageSize = 20 } = {}) {
  const params = [];
  let where = `ba.subject_type = 'company' AND ba.appeal_type = 'company_display_restore'`;
  const normalizedStatus = String(status || '').trim();
  if (normalizedStatus) {
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(normalizedStatus)) {
      throw new BillingError('申诉状态不正确', 400);
    }
    where += ' AND ba.status = ?';
    params.push(normalizedStatus);
  }
  const normalizedKeyword = String(keyword || '').trim();
  if (normalizedKeyword) {
    where += ` AND (
      ba.appeal_no LIKE ?
      OR c.name LIKE ?
      OR c.contact_phone LIKE ?
      OR c.city LIKE ?
      OR ba.content LIKE ?
    )`;
    const kw = `%${normalizedKeyword}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  const pageNo = Math.max(1, parseInt(page, 10) || 1);
  const safePageSize = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNo - 1) * safePageSize;
  const [rows] = await db.query(
    `SELECT ba.*, c.name, c.city, c.contact_phone,
            be.status AS entitlement_status,
            be.readonly_mode AS entitlement_readonly_mode,
            be.expire_at AS entitlement_expire_at
     FROM billing_appeals ba
     LEFT JOIN companies c ON c.id = ba.subject_id
     LEFT JOIN billing_entitlements be ON be.id = ba.entitlement_id
     WHERE ${where}
     ORDER BY ba.created_at DESC, ba.id DESC
     LIMIT ? OFFSET ?`,
    [...params, safePageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM billing_appeals ba
     LEFT JOIN companies c ON c.id = ba.subject_id
     WHERE ${where}`,
    params
  );
  return {
    appeals: rows.map((row) => ({
      ...normalizeAppeal(row),
      company: {
        id: Number(row.subject_id || 0),
        name: row.name || '',
        city: row.city || '',
        contact_phone: row.contact_phone || '',
      },
      entitlement: {
        status: row.entitlement_status || '',
        readonly_mode: Boolean(row.entitlement_readonly_mode),
        expire_at: row.entitlement_expire_at || null,
      },
    })),
    total: Number(countRow.total || 0),
    page: pageNo,
    pageSize: safePageSize,
  };
}

async function approveMerchantDisplayAppeal({ appealId, adminId = null, reason }) {
  const normalizedReason = String(reason || '').trim().slice(0, 300);
  if (!normalizedReason) throw new BillingError('请填写通过原因', 400);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [appealRows] = await conn.query(
      `SELECT *
       FROM billing_appeals
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [appealId]
    );
    const appeal = appealRows[0];
    if (!appeal) throw new BillingError('申诉不存在', 404);
    if (appeal.status !== 'pending') throw new BillingError('该申诉已处理', 409);
    if (appeal.subject_type !== 'merchant' || appeal.appeal_type !== 'merchant_display_restore') {
      throw new BillingError('申诉类型不支持', 400);
    }

    const [entitlementRows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE id = ?
         AND subject_type = 'merchant'
         AND subject_id = ?
       LIMIT 1
       FOR UPDATE`,
      [appeal.entitlement_id, appeal.subject_id]
    );
    const entitlement = entitlementRows[0];
    if (!entitlement) throw new BillingError('申诉关联权益不存在', 404);
    if (new Date(entitlement.expire_at).getTime() <= Date.now()) {
      throw new BillingError('该权益已到期，不能直接恢复', 409);
    }
    await conn.query(
      `UPDATE billing_entitlements
       SET status = 'active',
           readonly_mode = 0,
           reason = NULL
       WHERE id = ?`,
      [entitlement.id]
    );
    if (entitlement.subscription_id) {
      await conn.query(
        `UPDATE billing_subscriptions
         SET status = 'active',
             cancelled_at = NULL,
             readonly_mode = 0,
             reason = NULL
         WHERE id = ?`,
        [entitlement.subscription_id]
      );
    }
    await conn.query(
      `UPDATE billing_appeals
       SET status = 'approved',
           result_reason = ?,
           reviewed_by = ?,
           reviewed_at = NOW()
       WHERE id = ?`,
      [normalizedReason, adminId, appeal.id]
    );

    const after = {
      appeal_id: appeal.id,
      entitlement_id: entitlement.id,
      status: 'approved',
      readonly_mode: false,
      reason: null,
      result_reason: normalizedReason,
    };
    await insertAudit(conn, {
      subject_type: 'merchant',
      subject_id: appeal.subject_id,
      actor_type: 'admin',
      actor_id: adminId,
      action: 'ADMIN_APPROVE_MERCHANT_DISPLAY_APPEAL',
      target_type: 'billing_appeal',
      target_id: appeal.id,
      before_json: {
        appeal_status: appeal.status,
        entitlement_status: entitlement.status,
        entitlement_readonly_mode: Boolean(entitlement.readonly_mode),
        entitlement_reason: entitlement.reason || null,
      },
      after_json: after,
      reason: normalizedReason,
    });
    await insertEvent(conn, {
      event_type: 'MERCHANT_DISPLAY_APPEAL_APPROVED',
      subject_type: 'merchant',
      subject_id: appeal.subject_id,
      aggregate_type: 'billing_appeal',
      aggregate_id: appeal.id,
      payload_json: after,
    });

    await conn.commit();
    return { appeal: normalizeAppeal({ ...appeal, status: 'approved', result_reason: normalizedReason }), resumed: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function approveCompanyDisplayAppeal({ appealId, adminId = null, reason }) {
  const normalizedReason = String(reason || '').trim().slice(0, 300);
  if (!normalizedReason) throw new BillingError('请填写通过原因', 400);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [appealRows] = await conn.query(
      `SELECT *
       FROM billing_appeals
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [appealId]
    );
    const appeal = appealRows[0];
    if (!appeal) throw new BillingError('申诉不存在', 404);
    if (appeal.status !== 'pending') throw new BillingError('该申诉已处理', 409);
    if (appeal.subject_type !== 'company' || appeal.appeal_type !== 'company_display_restore') {
      throw new BillingError('申诉类型不支持', 400);
    }

    const [entitlementRows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE id = ?
         AND subject_type = 'company'
         AND subject_id = ?
       LIMIT 1
       FOR UPDATE`,
      [appeal.entitlement_id, appeal.subject_id]
    );
    const entitlement = entitlementRows[0];
    if (!entitlement) throw new BillingError('申诉关联权益不存在', 404);
    if (new Date(entitlement.expire_at).getTime() <= Date.now()) {
      throw new BillingError('该权益已到期，不能直接恢复', 409);
    }
    const [companyRows] = await conn.query(
      `SELECT verification_status, status
       FROM companies
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [appeal.subject_id]
    );
    const company = companyRows[0];
    if (!company || company.status === 'deleted') {
      throw new BillingError('装修公司不存在', 404);
    }
    if (company.verification_status !== 'verified') {
      throw new BillingError('装修公司必须认证通过后才能恢复展示', 409);
    }

    await conn.query(
      `UPDATE billing_entitlements
       SET status = 'active',
           readonly_mode = 0,
           reason = NULL
       WHERE id = ?`,
      [entitlement.id]
    );
    if (entitlement.subscription_id) {
      await conn.query(
        `UPDATE billing_subscriptions
         SET status = 'active',
             cancelled_at = NULL,
             readonly_mode = 0,
             reason = NULL
         WHERE id = ?`,
        [entitlement.subscription_id]
      );
    }
    await conn.query(
      `UPDATE companies
       SET paid_display_status = 'active',
           paid_display_starts_at = COALESCE(paid_display_starts_at, NOW()),
           paid_display_ends_at = ?
       WHERE id = ?`,
      [entitlement.expire_at, appeal.subject_id]
    );
    await conn.query(
      `UPDATE billing_appeals
       SET status = 'approved',
           result_reason = ?,
           reviewed_by = ?,
           reviewed_at = NOW()
       WHERE id = ?`,
      [normalizedReason, adminId, appeal.id]
    );

    const after = {
      appeal_id: appeal.id,
      entitlement_id: entitlement.id,
      status: 'approved',
      readonly_mode: false,
      reason: null,
      result_reason: normalizedReason,
    };
    await insertAudit(conn, {
      subject_type: 'company',
      subject_id: appeal.subject_id,
      actor_type: 'admin',
      actor_id: adminId,
      action: 'ADMIN_APPROVE_COMPANY_DISPLAY_APPEAL',
      target_type: 'billing_appeal',
      target_id: appeal.id,
      before_json: {
        appeal_status: appeal.status,
        entitlement_status: entitlement.status,
        entitlement_readonly_mode: Boolean(entitlement.readonly_mode),
        entitlement_reason: entitlement.reason || null,
      },
      after_json: after,
      reason: normalizedReason,
    });
    await insertEvent(conn, {
      event_type: 'COMPANY_DISPLAY_APPEAL_APPROVED',
      subject_type: 'company',
      subject_id: appeal.subject_id,
      aggregate_type: 'billing_appeal',
      aggregate_id: appeal.id,
      payload_json: after,
    });

    await conn.commit();
    return { appeal: normalizeAppeal({ ...appeal, status: 'approved', result_reason: normalizedReason }), resumed: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function rejectMerchantDisplayAppeal({ appealId, adminId = null, reason }) {
  const normalizedReason = String(reason || '').trim().slice(0, 300);
  if (!normalizedReason) throw new BillingError('请填写驳回原因', 400);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [appealRows] = await conn.query(
      `SELECT *
       FROM billing_appeals
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [appealId]
    );
    const appeal = appealRows[0];
    if (!appeal) throw new BillingError('申诉不存在', 404);
    if (appeal.status !== 'pending') throw new BillingError('该申诉已处理', 409);

    await conn.query(
      `UPDATE billing_appeals
       SET status = 'rejected',
           result_reason = ?,
           reviewed_by = ?,
           reviewed_at = NOW()
       WHERE id = ?`,
      [normalizedReason, adminId, appeal.id]
    );
    const after = {
      appeal_id: appeal.id,
      status: 'rejected',
      result_reason: normalizedReason,
    };
    await insertAudit(conn, {
      subject_type: 'merchant',
      subject_id: appeal.subject_id,
      actor_type: 'admin',
      actor_id: adminId,
      action: 'ADMIN_REJECT_MERCHANT_DISPLAY_APPEAL',
      target_type: 'billing_appeal',
      target_id: appeal.id,
      before_json: { appeal_status: appeal.status },
      after_json: after,
      reason: normalizedReason,
    });
    await insertEvent(conn, {
      event_type: 'MERCHANT_DISPLAY_APPEAL_REJECTED',
      subject_type: 'merchant',
      subject_id: appeal.subject_id,
      aggregate_type: 'billing_appeal',
      aggregate_id: appeal.id,
      payload_json: after,
    });

    await conn.commit();
    return { appeal: normalizeAppeal({ ...appeal, status: 'rejected', result_reason: normalizedReason }) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function rejectCompanyDisplayAppeal({ appealId, adminId = null, reason }) {
  const normalizedReason = String(reason || '').trim().slice(0, 300);
  if (!normalizedReason) throw new BillingError('请填写驳回原因', 400);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [appealRows] = await conn.query(
      `SELECT *
       FROM billing_appeals
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [appealId]
    );
    const appeal = appealRows[0];
    if (!appeal) throw new BillingError('申诉不存在', 404);
    if (appeal.status !== 'pending') throw new BillingError('该申诉已处理', 409);
    if (appeal.subject_type !== 'company' || appeal.appeal_type !== 'company_display_restore') {
      throw new BillingError('申诉类型不支持', 400);
    }

    await conn.query(
      `UPDATE billing_appeals
       SET status = 'rejected',
           result_reason = ?,
           reviewed_by = ?,
           reviewed_at = NOW()
       WHERE id = ?`,
      [normalizedReason, adminId, appeal.id]
    );
    const after = {
      appeal_id: appeal.id,
      status: 'rejected',
      result_reason: normalizedReason,
    };
    await insertAudit(conn, {
      subject_type: 'company',
      subject_id: appeal.subject_id,
      actor_type: 'admin',
      actor_id: adminId,
      action: 'ADMIN_REJECT_COMPANY_DISPLAY_APPEAL',
      target_type: 'billing_appeal',
      target_id: appeal.id,
      before_json: { appeal_status: appeal.status },
      after_json: after,
      reason: normalizedReason,
    });
    await insertEvent(conn, {
      event_type: 'COMPANY_DISPLAY_APPEAL_REJECTED',
      subject_type: 'company',
      subject_id: appeal.subject_id,
      aggregate_type: 'billing_appeal',
      aggregate_id: appeal.id,
      payload_json: after,
    });

    await conn.commit();
    return { appeal: normalizeAppeal({ ...appeal, status: 'rejected', result_reason: normalizedReason }) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getMerchantBillingSnapshot(merchantUserId) {
  const orderPromise = db.query(
    `SELECT id, order_no, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_orders
     WHERE subject_type = 'merchant' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 5`,
    [merchantUserId]
  );
  const subscriptionPromise = db.query(
    `SELECT id, subscription_no, status, is_primary, started_at, expire_at, readonly_mode, reason
     FROM billing_subscriptions
     WHERE subject_type = 'merchant' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 5`,
    [merchantUserId]
  );
  const paymentPromise = db.query(
    `SELECT id, payment_no, order_id, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_payments
     WHERE subject_type = 'merchant' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 5`,
    [merchantUserId]
  );
  const auditPromise = db.query(
    `SELECT id, action, target_type, target_id, reason, after_json, created_at
     FROM billing_audit_logs
     WHERE subject_type = 'merchant' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 50`,
    [merchantUserId]
  );
  const eventPromise = db.query(
    `SELECT id, event_id, event_type, event_version, aggregate_type, aggregate_id, status, retry_count, created_at
     FROM billing_events
     WHERE subject_type = 'merchant' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 10`,
    [merchantUserId]
  );
  const appealPromise = db.query(
    `SELECT *
     FROM billing_appeals
     WHERE subject_type = 'merchant'
       AND subject_id = ?
       AND appeal_type = 'merchant_display_restore'
     ORDER BY id DESC
     LIMIT 50`,
    [merchantUserId]
  );
  const entitlement = await getCurrentEntitlement('merchant', merchantUserId);
  const [[orders], [subscriptions], [payments], [audit_logs], [events], [appeals]] = await Promise.all([
    orderPromise,
    subscriptionPromise,
    paymentPromise,
    auditPromise,
    eventPromise,
    appealPromise,
  ]);
  const currentAppeal =
    appeals.find((item) => item.status === 'pending') ||
    appeals[0] ||
    null;
  return {
    subject: { type: 'merchant', id: merchantUserId },
    entitlement,
    shop_visible: entitlement.shop_visible,
    current_appeal: normalizeAppeal(currentAppeal),
    appeals: appeals.map(normalizeAppeal),
    orders,
    payments,
    subscriptions,
    audit_logs,
    events,
  };
}

async function getCompanyBillingSnapshot(companyId) {
  const orderPromise = db.query(
    `SELECT id, order_no, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_orders
     WHERE subject_type = 'company' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 5`,
    [companyId]
  );
  const subscriptionPromise = db.query(
    `SELECT id, subscription_no, status, is_primary, started_at, expire_at, readonly_mode, reason
     FROM billing_subscriptions
     WHERE subject_type = 'company' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 5`,
    [companyId]
  );
  const paymentPromise = db.query(
    `SELECT id, payment_no, order_id, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_payments
     WHERE subject_type = 'company' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 5`,
    [companyId]
  );
  const auditPromise = db.query(
    `SELECT id, action, target_type, target_id, reason, after_json, created_at
     FROM billing_audit_logs
     WHERE subject_type = 'company' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 50`,
    [companyId]
  );
  const eventPromise = db.query(
    `SELECT id, event_id, event_type, event_version, aggregate_type, aggregate_id, status, retry_count, created_at
     FROM billing_events
     WHERE subject_type = 'company' AND subject_id = ?
     ORDER BY id DESC
     LIMIT 10`,
    [companyId]
  );
  const appealPromise = db.query(
    `SELECT *
     FROM billing_appeals
     WHERE subject_type = 'company'
       AND subject_id = ?
       AND appeal_type = 'company_display_restore'
     ORDER BY id DESC
     LIMIT 50`,
    [companyId]
  );
  const entitlement = await getCurrentEntitlement('company', companyId);
  const [[orders], [subscriptions], [payments], [audit_logs], [events], [appeals]] = await Promise.all([
    orderPromise,
    subscriptionPromise,
    paymentPromise,
    auditPromise,
    eventPromise,
    appealPromise,
  ]);
  const currentAppeal =
    appeals.find((item) => item.status === 'pending') ||
    appeals[0] ||
    null;
  return {
    subject: { type: 'company', id: companyId },
    entitlement,
    company_visible: entitlement.company_visible,
    current_appeal: normalizeAppeal(currentAppeal),
    appeals: appeals.map(normalizeAppeal),
    orders,
    payments,
    subscriptions,
    audit_logs,
    events,
  };
}

module.exports = {
  BillingError,
  getCompanyDisplayPlan,
  getCompanyDisplayPlanForApp,
  getMerchantDisplayPlanForApp,
  getCompanyDisplayPlanForAdmin,
  getMerchantDisplayPlanForAdmin,
  publishCompanyDisplayPlanVersion,
  publishMerchantDisplayPlanVersion,
  createCompanyDisplayOrder,
  createMerchantDisplayOrder,
  payCompanyOrderManual,
  payMerchantOrderManual,
  getOrderForOwner,
  getCompanyOrderForOwner,
  getMerchantOrderStatus,
  getCompanyOrderStatus,
  getCurrentEntitlement,
  getLatestMerchantAppeal,
  createCompanyDisplayAppeal,
  createMerchantDisplayAppeal,
  listCompanyDisplayAppeals,
  listMerchantDisplayAppeals,
  approveCompanyDisplayAppeal,
  approveMerchantDisplayAppeal,
  rejectCompanyDisplayAppeal,
  rejectMerchantDisplayAppeal,
  getCompanyBillingSnapshot,
  getMerchantBillingSnapshot,
};
