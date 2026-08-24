const express = require('express');
const asyncHandler = require('../utils/async-handler');
const publicHelpController = require('../controllers/public-help.controller');

const router = express.Router();

// Public and read-only so App Store reviewers and signed-out users can load it.
router.get('/help-faqs', asyncHandler(publicHelpController.listHelpFaqs));

module.exports = router;
