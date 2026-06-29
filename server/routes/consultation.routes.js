const express = require('express');
const controller = require('../controllers/consultation.controller');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/async-handler');

const router = express.Router();

router.post('/unified', asyncHandler(auth), asyncHandler(controller.createUnifiedConsultation));

module.exports = router;
