const express = require('express');
const controller = require('../controllers/entity-relations.controller');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/async-handler');

const router = express.Router();

router.get('/', asyncHandler(auth), asyncHandler(controller.listEntityRelations));
router.post('/', asyncHandler(auth), asyncHandler(controller.createEntityRelation));

module.exports = router;
