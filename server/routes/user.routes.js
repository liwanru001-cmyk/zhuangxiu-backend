const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const merchantProductsController = require('../controllers/merchant-products.controller');
const auth = require('../middleware/auth');
const requireActiveVerifiedMerchant = require('../middleware/verified-merchant');
const asyncHandler = require('../utils/async-handler');
const {
  ensureUploadDir,
  setUploadedFilePermissions,
} = require('../utils/upload-permissions');
const multer = require('multer');
const path = require('path');

const avatarDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'avatars')
);
const merchantProfileDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'merchant-profiles')
);
const merchantProductsDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'merchant-products')
);

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: avatarDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(null, `user-${req.user.id}-${Date.now()}${extension}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
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

const merchantProfileImageUpload = multer({
  storage: multer.diskStorage({
    destination: merchantProfileDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      const type = String(req.body?.type || req.query?.type || 'image')
        .replace(/[^a-z0-9_-]/gi, '')
        .slice(0, 24) || 'image';
      callback(null, `merchant-${req.user.id}-${type}-${Date.now()}${extension}`);
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

const merchantProductImageUpload = multer({
  storage: multer.diskStorage({
    destination: merchantProductsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase() || '.jpg';
      callback(null, `merchant-product-${req.user.id}-${Date.now()}${extension}`);
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

router.get('/profile', asyncHandler(auth), asyncHandler(userController.getProfile));
router.get('/profile/:id', asyncHandler(userController.getProfile));
router.get('/designer-profile', asyncHandler(auth), asyncHandler(userController.getDesignerProfile));
router.put('/designer-profile', asyncHandler(auth), asyncHandler(userController.upsertDesignerProfile));
router.get('/project-manager-profile', asyncHandler(auth), asyncHandler(userController.getProjectManagerProfile));
router.put('/project-manager-profile', asyncHandler(auth), asyncHandler(userController.upsertProjectManagerProfile));
router.get('/merchants', asyncHandler(userController.listPublicMerchants));
router.get('/merchant-profile', asyncHandler(auth), asyncHandler(userController.getMerchantProfile));
router.put('/merchant-profile', asyncHandler(auth), asyncHandler(userController.upsertMerchantProfile));
router.post(
  '/merchant-profile/image',
  asyncHandler(auth),
  asyncHandler(requireActiveVerifiedMerchant),
  merchantProfileImageUpload.single('image'),
  setUploadedFilePermissions,
  asyncHandler(userController.uploadMerchantProfileImage)
);
router.get('/merchant-product-categories', asyncHandler(auth), asyncHandler(merchantProductsController.listMyCategories));
router.post('/merchant-product-categories', asyncHandler(auth), asyncHandler(merchantProductsController.createCategory));
router.put('/merchant-product-categories/:id', asyncHandler(auth), asyncHandler(merchantProductsController.updateCategory));
router.delete('/merchant-product-categories/:id', asyncHandler(auth), asyncHandler(merchantProductsController.deleteCategory));
router.get('/merchant-products', asyncHandler(auth), asyncHandler(merchantProductsController.listMyProducts));
router.post('/merchant-products', asyncHandler(auth), asyncHandler(merchantProductsController.createProduct));
router.put('/merchant-products/:id', asyncHandler(auth), asyncHandler(merchantProductsController.updateProduct));
router.delete('/merchant-products/:id', asyncHandler(auth), asyncHandler(merchantProductsController.deleteProduct));
router.post(
  '/merchant-products/image',
  asyncHandler(auth),
  asyncHandler(requireActiveVerifiedMerchant),
  merchantProductImageUpload.single('image'),
  setUploadedFilePermissions,
  asyncHandler(merchantProductsController.uploadProductImage)
);
router.get('/:userId/merchant-products', asyncHandler(merchantProductsController.listPublicProducts));
router.get('/designer-consultations', asyncHandler(auth), asyncHandler(userController.getDesignerConsultations));
router.get('/my-consultations', asyncHandler(auth), asyncHandler(userController.getMyConsultations));
router.get('/consultation-conversations', asyncHandler(auth), asyncHandler(userController.getConsultationConversations));
router.get('/notifications', asyncHandler(auth), asyncHandler(userController.getNotifications));
router.post('/notifications/:id/read', asyncHandler(auth), asyncHandler(userController.markNotificationRead));
router.get('/help/faqs', asyncHandler(auth), asyncHandler(userController.getHelpFaqs));
router.post('/help/feedback', asyncHandler(auth), asyncHandler(userController.submitFeedback));
router.get('/consultations/:id/messages', asyncHandler(auth), asyncHandler(userController.getConsultationMessages));
router.post('/consultations/:id/messages', asyncHandler(auth), asyncHandler(userController.sendConsultationMessage));
router.put('/profile', asyncHandler(auth), asyncHandler(userController.updateProfile));
router.put('/role', asyncHandler(auth), asyncHandler(userController.updateRole));
router.post(
  '/avatar',
  asyncHandler(auth),
  avatarUpload.single('avatar'),
  setUploadedFilePermissions,
  asyncHandler(userController.uploadAvatar)
);
router.put('/security/password', asyncHandler(auth), asyncHandler(userController.changePassword));
router.put('/security/phone', asyncHandler(auth), asyncHandler(userController.changePhone));
router.delete('/account', asyncHandler(auth), asyncHandler(userController.deleteAccount));
router.post('/follow/:id', asyncHandler(auth), asyncHandler(userController.toggleFollow));
router.post('/consult/:id', asyncHandler(auth), asyncHandler(userController.createDesignerConsultation));
router.post('/consult-designer/:id', asyncHandler(auth), asyncHandler(userController.createDesignerConsultation));
router.get('/content/:type', asyncHandler(auth), asyncHandler(userController.getUserContent));
router.put('/content/notes/:id/visibility', asyncHandler(auth), asyncHandler(userController.updateMyNoteVisibility));
router.delete('/content/notes/:id', asyncHandler(auth), asyncHandler(userController.deleteMyNote));
router.get('/notes/:id', asyncHandler(userController.getUserNotes));
router.get('/:id', asyncHandler(userController.getProfile)); // App 兼容别名

module.exports = router;
