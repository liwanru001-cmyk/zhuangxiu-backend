const express = require('express');
const asyncHandler = require('../utils/async-handler');
const service = require('../services/admin-project-directory');
const { success, error } = require('../utils/response');
module.exports = db => {
  const router = express.Router();
  const handle = fn => asyncHandler(async (req, res) => {
    try { return success(res, await fn(req)); }
    catch (err) { if (err.status) return error(res, err.message, err.status); throw err; }
  });
  router.get('/', handle(req => service.list(db, req.query)));
  router.get('/:id', handle(req => service.detail(db, req.params.id)));
  return router;
};
