const express = require('express');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/async-handler');
const billingController = require('../controllers/billing.controller');

const router = express.Router();

router.get(
  '/merchant/plans',
  asyncHandler(auth),
  asyncHandler(billingController.listMerchantPlans)
);

router.post(
  '/merchant/orders',
  asyncHandler(auth),
  asyncHandler(billingController.createMerchantDisplayOrder)
);

router.post(
  '/merchant/orders/:id/manual-pay',
  asyncHandler(auth),
  asyncHandler(billingController.manualPayMerchantOrder)
);

router.get(
  '/merchant/orders/:id',
  asyncHandler(auth),
  asyncHandler(billingController.getMerchantOrder)
);

router.get(
  '/merchant/me',
  asyncHandler(auth),
  asyncHandler(billingController.getMyMerchantBilling)
);

router.get(
  '/company/plans',
  asyncHandler(auth),
  asyncHandler(billingController.listCompanyPlans)
);

router.get(
  '/company/:companyId/me',
  asyncHandler(auth),
  asyncHandler(billingController.getMyCompanyBilling)
);

router.post(
  '/company/:companyId/orders',
  asyncHandler(auth),
  asyncHandler(billingController.createCompanyDisplayOrder)
);

router.post(
  '/company/:companyId/orders/:id/manual-pay',
  asyncHandler(auth),
  asyncHandler(billingController.manualPayCompanyOrder)
);

router.get(
  '/company/:companyId/orders/:id',
  asyncHandler(auth),
  asyncHandler(billingController.getCompanyOrder)
);

router.post(
  '/merchant/appeals',
  asyncHandler(auth),
  asyncHandler(billingController.createMerchantDisplayAppeal)
);

router.get(
  '/entitlements/:subjectType/:subjectId',
  asyncHandler(auth),
  asyncHandler(billingController.getEntitlement)
);

module.exports = router;
