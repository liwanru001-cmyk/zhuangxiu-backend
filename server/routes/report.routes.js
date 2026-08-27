const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/async-handler');
const controller = require('../controllers/report.controller');
const { ensureUploadDir, setUploadedFilePermissions } = require('../utils/upload-permissions');
const persistUploadedFiles = require('../middleware/persist-uploaded-files');

const router = express.Router();
const reportDir = ensureUploadDir(path.join(__dirname, '..', 'uploads', 'reports'));
const upload = multer({
  storage: multer.diskStorage({ destination: reportDir, filename: (req, file, cb) => cb(null, `report-user-${req.user.id}-${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`) }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

router.get('/context', asyncHandler(auth), asyncHandler(controller.getContext));
router.post('/evidence', asyncHandler(auth), upload.single('image'), setUploadedFilePermissions, persistUploadedFiles('uploads/reports'), asyncHandler(controller.uploadEvidence));
router.post('/', asyncHandler(auth), asyncHandler(controller.submitReport));
router.post('/users/:id/block', asyncHandler(auth), asyncHandler(controller.blockUser));
router.delete('/users/:id/block', asyncHandler(auth), asyncHandler(controller.unblockUser));
router.put('/consultations/:id/preferences', asyncHandler(auth), asyncHandler(controller.updateConversationPreference));

module.exports = router;
