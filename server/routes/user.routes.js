const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const auth = require('../middleware/auth');
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

router.get('/profile', asyncHandler(auth), asyncHandler(userController.getProfile));
router.get('/profile/:id', asyncHandler(userController.getProfile));
router.get('/designer-profile', asyncHandler(auth), asyncHandler(userController.getDesignerProfile));
router.put('/designer-profile', asyncHandler(auth), asyncHandler(userController.upsertDesignerProfile));
router.get('/project-manager-profile', asyncHandler(auth), asyncHandler(userController.getProjectManagerProfile));
router.put('/project-manager-profile', asyncHandler(auth), asyncHandler(userController.upsertProjectManagerProfile));
router.get('/merchant-profile', asyncHandler(auth), asyncHandler(userController.getMerchantProfile));
router.put('/merchant-profile', asyncHandler(auth), asyncHandler(userController.upsertMerchantProfile));
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
