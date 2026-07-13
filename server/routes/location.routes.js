const express = require('express');
const controller = require('../controllers/location.controller');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/async-handler');

const router = express.Router();

router.post('/geocode', asyncHandler(auth), asyncHandler(controller.geocode));
router.post('/search', asyncHandler(auth), asyncHandler(controller.search));

module.exports = router;
