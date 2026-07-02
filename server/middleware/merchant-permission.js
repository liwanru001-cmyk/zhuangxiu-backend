const { error } = require('../utils/response');
const { hasActiveMerchantPermission } = require('../utils/merchant-permission');

async function requireActiveMerchantPermission(req, res, next) {
  if (await hasActiveMerchantPermission(req.user.id)) return next();
  return error(res, '商家权限未审核通过', 403);
}

module.exports = requireActiveMerchantPermission;
