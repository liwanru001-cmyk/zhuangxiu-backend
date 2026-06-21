const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const asyncHandler = require('../utils/async-handler');

// 公开接口
router.post('/send-code', asyncHandler(authController.sendSmsCode));
router.post('/sms', asyncHandler(authController.sendSmsCode)); // App 兼容别名
router.post('/login', asyncHandler(authController.login));
router.post('/register', asyncHandler(authController.login)); // 验证码登录即注册
router.post('/register-password', asyncHandler(authController.registerPasswordAccount));
router.post('/password-register', asyncHandler(authController.registerPasswordAccount));
router.post('/password-login', asyncHandler(authController.passwordLogin));
router.post('/login-password', asyncHandler(authController.passwordLogin));

module.exports = router;
