const express = require('express');
const controller = require('../controllers/marketplace.controller');
const asyncHandler = require('../utils/async-handler');
const auth = require('../middleware/auth');
const {
  ensureUploadDir,
  setUploadedFilePermissions,
} = require('../utils/upload-permissions');
const multer = require('multer');
const path = require('path');

const router = express.Router();

const companyProfileDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'company-profiles')
);

const companyImageUpload = multer({
  storage: multer.diskStorage({
    destination: companyProfileDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      const type = String(req.body?.type || req.query?.type || 'image')
        .replace(/[^a-z0-9_-]/gi, '')
        .slice(0, 24) || 'image';
      callback(null, `company-${req.user.id}-${type}-${Date.now()}${extension}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = new Set([
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.gif',
      '.heic',
      '.heif',
    ]);
    callback(
      null,
      file.mimetype.startsWith('image/') || allowedExtensions.has(extension)
    );
  },
});

router.get('/business-catalog', asyncHandler(controller.listBusinessCatalog));
router.get('/marketplace/search', asyncHandler(controller.listMarketplaceSearch));
router.get('/companies/mine', asyncHandler(auth), asyncHandler(controller.listMyCompanies));
router.get('/companies/my-project-companies', asyncHandler(auth), asyncHandler(controller.listMyProjectCompanies));
router.post(
  '/companies/upload-image',
  asyncHandler(auth),
  companyImageUpload.single('image'),
  setUploadedFilePermissions,
  asyncHandler(controller.uploadCompanyImage)
);
router.post('/companies', asyncHandler(auth), asyncHandler(controller.createCompany));
router.get('/companies/search', asyncHandler(controller.searchPublicCompanies));
router.get('/companies', asyncHandler(controller.listCompanies));
router.get('/companies/:id/public', asyncHandler(controller.getPublicCompany));
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
