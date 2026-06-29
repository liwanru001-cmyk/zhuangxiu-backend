const express = require('express');
const controller = require('../controllers/project-participants.controller');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/async-handler');

const router = express.Router();

router.get('/:id/participants', asyncHandler(auth), asyncHandler(controller.listProjectParticipants));
router.post('/:id/participants', asyncHandler(auth), asyncHandler(controller.createProjectParticipant));

module.exports = router;
