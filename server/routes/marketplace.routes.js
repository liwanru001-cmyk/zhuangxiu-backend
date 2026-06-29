const express = require('express');
const controller = require('../controllers/marketplace.controller');
const asyncHandler = require('../utils/async-handler');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/business-catalog', asyncHandler(controller.listBusinessCatalog));
router.get('/marketplace/search', asyncHandler(controller.listMarketplaceSearch));
router.get('/companies/mine', asyncHandler(auth), asyncHandler(controller.listMyCompanies));
router.post('/companies', asyncHandler(auth), asyncHandler(controller.createCompany));
router.get('/companies', asyncHandler(controller.listCompanies));
router.get('/companies/:id/projects', asyncHandler(auth), asyncHandler(controller.listCompanyProjects));
router.post('/companies/:id/projects', asyncHandler(auth), asyncHandler(controller.attachCompanyProject));
router.put('/companies/:id/projects/:projectId', asyncHandler(auth), asyncHandler(controller.updateCompanyProject));
router.delete('/companies/:id/projects/:projectId', asyncHandler(auth), asyncHandler(controller.detachCompanyProject));
router.get('/companies/:id/members', asyncHandler(controller.listCompanyMembers));
router.post('/companies/:id/members', asyncHandler(auth), asyncHandler(controller.addCompanyMember));
router.put('/companies/:id/members/:memberId', asyncHandler(auth), asyncHandler(controller.updateCompanyMember));
router.delete('/companies/:id/members/:memberId', asyncHandler(auth), asyncHandler(controller.removeCompanyMember));
router.get('/companies/:id/businesses', asyncHandler(auth), asyncHandler(controller.listCompanyBusinesses));
router.put('/companies/:id/businesses', asyncHandler(auth), asyncHandler(controller.updateCompanyBusinesses));
router.put('/companies/:id', asyncHandler(auth), asyncHandler(controller.updateCompany));
router.get('/companies/:id', asyncHandler(controller.getCompany));
router.get('/professionals', asyncHandler(controller.listProfessionals));
router.get('/professionals/:id', asyncHandler(controller.getProfessional));

module.exports = router;
