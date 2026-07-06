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

async function getEntitlement(req, res) {
  try {
    const subjectType = String(req.params.subjectType || '').trim();
    const subjectId = Number(req.params.subjectId);
    if (subjectType !== 'merchant') {
      return error(res, '当前 MVP 只支持 merchant 主体', 400);
    }
    if (subjectId !== Number(req.user.id)) {
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
  createMerchantDisplayOrder,
  manualPayMerchantOrder,
  getMerchantOrder,
  getMyMerchantBilling,
  getEntitlement,
};
