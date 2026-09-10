'use strict';
const express = require('express');
const { success, error } = require('../utils/response');
const { createMonitor } = require('../services/presentation-monitor');
module.exports = function routes(db) {
  const router = express.Router(), monitor = createMonitor(db);
  const handle = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return success(res, await fn(req)); }
    catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') return error(res, 'PPT 任务日志表尚未初始化，请先完成 PPT 服务部署', 503);
      if (err.status) return error(res, err.message, err.status);
      console.error('PPT monitor:', err.code || err.name);
      return error(res, '读取 PPT 诊断失败，请稍后重试', 500);
    }
  };
  router.get('/summary', handle(req => monitor.summary(req.query)));
  router.get('/jobs', handle(req => monitor.jobs(req.query)));
  router.get('/jobs/:id/diagnosis', handle(req => monitor.diagnosis(req.params.id)));
  return router;
};
