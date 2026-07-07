const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const asyncHandler = require('../utils/async-handler');
const auth = require('../middleware/auth');

// 公开接口
router.post('/send-sms', asyncHandler(authController.sendSmsCode));
router.post('/send-code', asyncHandler(authController.sendSmsCode));
router.post('/sms', asyncHandler(authController.sendSmsCode)); // App 兼容别名
router.post('/verify-sms', asyncHandler(authController.verifySms));
router.post('/set-password', auth, asyncHandler(authController.setPassword));
router.post('/reset-password', asyncHandler(authController.resetPassword));
router.post('/login', asyncHandler(authController.login));
router.post('/register', asyncHandler(authController.login)); // 验证码登录即注册
router.post('/register-password', asyncHandler(authController.registerPasswordAccount));
router.post('/password-register', asyncHandler(authController.registerPasswordAccount));
router.post('/password-login', asyncHandler(authController.passwordLogin));
router.post('/login-password', asyncHandler(authController.passwordLogin));
router.post('/test-login', asyncHandler(authController.testLogin));

module.exports = router;
