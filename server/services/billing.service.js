const crypto = require('crypto');
const db = require('../config/db');

const MERCHANT_PLAN_CODE = 'merchant_display_monthly';

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

async function ensureMerchantSubject(userId, executor = db) {
  await assertMerchantProfile(userId, executor);
  await executor.query(
    `INSERT INTO billing_subjects (subject_type, subject_id, status)
     VALUES ('merchant', ?, 'active')
     ON DUPLICATE KEY UPDATE status = 'active'`,
    [userId]
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

function normalizeEntitlement(row) {
  if (!row) {
    return {
      status: 'inactive',
      feature: {},
      limit: {},
      readonly_mode: true,
      expire_at: null,
      shop_visible: false,
    };
  }
  const feature = safeJson(row.feature_json);
  return {
    id: row.id,
    status: row.status,
    feature,
    limit: safeJson(row.limit_json),
    readonly_mode: Boolean(row.readonly_mode),
    expire_at: row.expire_at,
    shop_visible:
      row.status === 'active' &&
      !row.readonly_mode &&
      Boolean(feature.shop_visible) &&
      new Date(row.expire_at).getTime() > Date.now(),
  };
}

async function getCurrentEntitlement(subjectType, subjectId) {
  if (subjectType !== 'merchant') {
    throw new BillingError('当前 MVP 只支持 merchant 主体', 400);
  }
  const [rows] = await db.query(
    `SELECT *
     FROM billing_entitlements
     WHERE subject_type = 'merchant'
       AND subject_id = ?
       AND status = 'active'
     ORDER BY expire_at DESC, id DESC
     LIMIT 1`,
    [subjectId]
  );
  return normalizeEntitlement(rows[0] || null);
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
     LIMIT 10`,
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
  const entitlement = await getCurrentEntitlement('merchant', merchantUserId);
  const [[orders], [subscriptions], [payments], [audit_logs], [events]] = await Promise.all([
    orderPromise,
    subscriptionPromise,
    paymentPromise,
    auditPromise,
    eventPromise,
  ]);
  return {
    subject: { type: 'merchant', id: merchantUserId },
    entitlement,
    shop_visible: entitlement.shop_visible,
    orders,
    payments,
    subscriptions,
    audit_logs,
    events,
  };
}

module.exports = {
  BillingError,
  getMerchantDisplayPlanForApp,
  getMerchantDisplayPlanForAdmin,
  publishMerchantDisplayPlanVersion,
  createMerchantDisplayOrder,
  payMerchantOrderManual,
  getOrderForOwner,
  getMerchantOrderStatus,
  getCurrentEntitlement,
  getMerchantBillingSnapshot,
};
