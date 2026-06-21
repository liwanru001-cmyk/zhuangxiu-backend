const express = require('express');
const router = express.Router();
const noteController = require('../controllers/note.controller');
const auth = require('../middleware/auth');
const optionalAuth = require('../middleware/optional-auth');
const asyncHandler = require('../utils/async-handler');
const {
  ensureUploadDir,
  setUploadedFilePermissions,
} = require('../utils/upload-permissions');
const multer = require('multer');
const path = require('path');

const noteMediaDir = ensureUploadDir(
  path.join(__dirname, '..', 'uploads', 'notes')
);
const noteMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, noteMediaDir);
    },
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(
        null,
        `note-user-${req.user.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
    const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm']);
    callback(
      null,
      file.mimetype.startsWith('image/') ||
        file.mimetype.startsWith('video/') ||
        imageExtensions.has(extension) ||
        videoExtensions.has(extension)
    );
  },
});

// 公开接口
router.get('/', asyncHandler(noteController.list));
router.get('/feed-options', asyncHandler(noteController.feedOptions));
router.get('/search', asyncHandler(noteController.search));
router.get('/:id', asyncHandler(optionalAuth), asyncHandler(noteController.detail));

// 需要登录
router.post(
  '/media',
  asyncHandler(auth),
  (req, res, next) => {
    noteMediaUpload.array('media', 10)(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? '单个文件不能超过 10MB'
          : err.code === 'LIMIT_FILE_COUNT'
          ? '最多上传 10 个文件'
          : '媒体上传失败';
        return res.status(400).json({ code: 400, message });
      }
      return next(err);
    });
  },
  setUploadedFilePermissions,
  asyncHandler(noteController.uploadMedia)
);
router.post('/', asyncHandler(auth), asyncHandler(noteController.create));
router.post('/:id/like', asyncHandler(auth), asyncHandler(noteController.toggleLike));
router.post('/:id/collect', asyncHandler(auth), asyncHandler(noteController.toggleCollect));
router.post('/:id/view', asyncHandler(auth), asyncHandler(noteController.recordView));
router.get('/:id/comments', asyncHandler(noteController.listComments));
router.post('/:id/comments', asyncHandler(auth), asyncHandler(noteController.createComment));

module.exports = router;
