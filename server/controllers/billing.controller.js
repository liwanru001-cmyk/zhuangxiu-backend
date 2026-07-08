const billingService = require('../services/billing.service');
const { success, error } = require('../utils/response');

function getIdempotencyKey(req, fallbackPrefix) {
  return (
    String(req.headers['idempotency-key'] || '').trim() ||
    String(req.body?.idempotency_key || '').trim() ||
    `${fallbackPrefix}-${req.user.id}-${Date.now()}`
  );
}

function handleBillingError(res, err) {
  if (err instanceof billingService.BillingError) {
    return error(res, err.message, err.statusCode || 400);
  }
  throw err;
}

async function canManageCompany(companyId, userId) {
  const db = require('../config/db');
  const [rows] = await db.query(
    `SELECT c.id
     FROM companies c
     LEFT JOIN company_members cm
       ON cm.company_id = c.id
      AND cm.user_id = ?
      AND cm.status = 'active'
      AND cm.member_role IN ('owner', 'admin')
     WHERE c.id = ?
       AND c.status <> 'deleted'
       AND (c.owner_user_id = ? OR cm.id IS NOT NULL)
     LIMIT 1`,
    [userId, companyId, userId]
  );
  return Boolean(rows[0]);
}

async function requireCompanyManager(req, res) {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    error(res, '装修公司不存在', 404);
    return null;
  }
  if (!(await canManageCompany(companyId, req.user.id))) {
    error(res, '无权限管理该装修公司', 403);
    return null;
  }
  return companyId;
}

async function createMerchantDisplayOrder(req, res) {
  try {
    const paymentChannel = String(req.body?.payment_channel || 'manual').trim();
    if (paymentChannel !== 'manual') {
      return error(res, '当前 merchant MVP 仅支持 manual 支付模拟', 400);
    }
    const result = await billingService.createMerchantDisplayOrder({
      merchantUserId: req.user.id,
      operatorUserId: req.user.id,
      paymentChannel,
      idempotencyKey: String(req.headers['idempotency-key'] || req.body?.idempotency_key || '').trim() || null,
    });
    return success(res, result, result.reused ? '订单已存在' : '订单已创建');
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function listCompanyPlans(req, res) {
  try {
    const plan = await billingService.getCompanyDisplayPlanForApp();
    return success(res, { plans: plan ? [plan] : [] });
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function getMyCompanyBilling(req, res) {
  try {
    const companyId = await requireCompanyManager(req, res);
    if (!companyId) return null;
    const snapshot = await billingService.getCompanyBillingSnapshot(companyId);
    return success(res, snapshot);
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function createCompanyDisplayOrder(req, res) {
  try {
    const companyId = await requireCompanyManager(req, res);
    if (!companyId) return null;
    const paymentChannel = String(req.body?.payment_channel || 'manual').trim();
    if (paymentChannel !== 'manual') {
      return error(res, '当前 company MVP 仅支持 manual 支付模拟', 400);
    }
    const result = await billingService.createCompanyDisplayOrder({
      companyId,
      operatorUserId: req.user.id,
      actorType: 'user',
      paymentChannel,
      idempotencyKey: String(req.headers['idempotency-key'] || req.body?.idempotency_key || '').trim() || null,
    });
    return success(res, result, result.reused ? '订单已存在' : '订单已创建');
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function manualPayCompanyOrder(req, res) {
  try {
    const companyId = await requireCompanyManager(req, res);
    if (!companyId) return null;
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, '订单不存在', 404);
    }
    const order = await billingService.getCompanyOrderForOwner(orderId, companyId);
    if (!order) return error(res, '订单不存在或无权操作', 404);
    if (order.payment_channel !== 'manual') {
      return error(res, '当前订单不是手动支付订单，不能使用 MVP 支付模拟', 400);
    }
    const result = await billingService.payCompanyOrderManual({
      orderId,
      companyId,
      operatorUserId: req.user.id,
      actorType: 'user',
      idempotencyKey: getIdempotencyKey(req, `manual-pay-company-${companyId}-${orderId}`),
    });
    return success(res, result, result.reused ? '订单已支付' : '支付成功，装修公司展示权益已开通');
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function getCompanyOrder(req, res) {
  try {
    const companyId = await requireCompanyManager(req, res);
    if (!companyId) return null;
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, '订单不存在', 404);
    }
    const result = await billingService.getCompanyOrderStatus(orderId, companyId);
    if (!result) return error(res, '订单不存在或无权查看', 404);
    return success(res, result);
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function listMerchantPlans(req, res) {
  try {
    const plan = await billingService.getMerchantDisplayPlanForApp();
    return success(res, { plans: plan ? [plan] : [] });
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function manualPayMerchantOrder(req, res) {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, '订单不存在', 404);
    }
    const order = await billingService.getOrderForOwner(orderId, req.user.id);
    if (!order) return error(res, '订单不存在或无权操作', 404);
    if (order.payment_channel !== 'manual') {
      return error(res, '当前订单不是手动支付订单，不能使用 MVP 支付模拟', 400);
    }
    const result = await billingService.payMerchantOrderManual({
      orderId,
      merchantUserId: req.user.id,
      operatorUserId: req.user.id,
      idempotencyKey: getIdempotencyKey(req, `manual-pay-${orderId}`),
    });
    return success(res, result, result.reused ? '订单已支付' : '支付成功，店铺展示权益已开通');
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function getMerchantOrder(req, res) {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return error(res, '订单不存在', 404);
    }
    const result = await billingService.getMerchantOrderStatus(orderId, req.user.id);
    if (!result) return error(res, '订单不存在或无权查看', 404);
    return success(res, result);
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function getMyMerchantBilling(req, res) {
  try {
    const snapshot = await billingService.getMerchantBillingSnapshot(req.user.id);
    return success(res, snapshot);
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function createMerchantDisplayAppeal(req, res) {
  try {
    const result = await billingService.createMerchantDisplayAppeal({
      merchantUserId: req.user.id,
      content: req.body?.content,
      idempotencyKey: getIdempotencyKey(req, `merchant-appeal-${req.user.id}`),
    });
    return success(res, result, result.reused ? '申诉已提交，请等待平台处理' : '申诉已提交');
  } catch (err) {
    return handleBillingError(res, err);
  }
}

async function getEntitlement(req, res) {
  try {
    const subjectType = String(req.params.subjectType || '').trim();
    const subjectId = Number(req.params.subjectId);
    if (!['merchant', 'company'].includes(subjectType)) {
      return error(res, '当前 MVP 只支持 merchant/company 主体', 400);
    }
    if (subjectType === 'merchant' && subjectId !== Number(req.user.id)) {
      return error(res, '无权查看该主体权益', 403);
    }
    if (subjectType === 'company' && !(await canManageCompany(subjectId, req.user.id))) {
      return error(res, '无权查看该主体权益', 403);
    }
    const entitlement = await billingService.getCurrentEntitlement(subjectType, subjectId);
    return success(res, {
      subject: { type: subjectType, id: subjectId },
      entitlement,
    });
  } catch (err) {
    return handleBillingError(res, err);
  }
}

module.exports = {
  listMerchantPlans,
  listCompanyPlans,
  createMerchantDisplayOrder,
  createCompanyDisplayOrder,
  manualPayMerchantOrder,
  manualPayCompanyOrder,
  getMerchantOrder,
  getCompanyOrder,
  getMyMerchantBilling,
  getMyCompanyBilling,
  createMerchantDisplayAppeal,
  getEntitlement,
};
