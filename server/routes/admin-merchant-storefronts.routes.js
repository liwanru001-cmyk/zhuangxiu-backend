const express = require('express');
const asyncHandler = require('../utils/async-handler');
const service = require('../services/admin-merchant-storefronts');
const { success, error } = require('../utils/response');

module.exports = db => {
  const router = express.Router();
  router.get('/', asyncHandler(async (req, res) => {
    try {
      return success(res, await service.list(db, req.query));
    } catch (err) {
      if (err.status) return error(res, err.message, err.status);
      throw err;
    }
  }));
  return router;
};
