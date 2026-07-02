const { error } = require('../utils/response');
const { hasActiveVerifiedMerchant } = require('../utils/verified-merchant');

async function requireActiveVerifiedMerchant(req, res, next) {
  if (await hasActiveVerifiedMerchant(req.user.id)) return next();
  return error(res, '未成为入驻商家，暂不能发布商家信息', 403);
}

module.exports = requireActiveVerifiedMerchant;
