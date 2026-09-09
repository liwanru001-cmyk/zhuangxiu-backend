'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { requireProjectContext } = require('../utils/project-context');
const { success, error } = require('../utils/response');
const jobs = require('../services/presentation-jobs');
const presentationService = require('../services/project-presentation.service');
const { generateFromPlan, safeFileName } = require('../scripts/generate-ppt-from-plan');

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function featureEnabled() {
  return process.env.FEATURE_PROJECT_PRESENTATIONS !== 'false';
}

async function authorize(req, res) {
  if (!featureEnabled()) {
    error(res, '方案汇报功能尚未开放', 404);
    return null;
  }
  const context = await requireProjectContext(req, res);
  if (!context.ok) return null;
  if (!['designer', 'owner'].includes(context.role)) {
    error(res, '仅项目设计师或业主可以生成方案汇报', 403);
    return null;
  }
  return context;
}

async function source(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  const data = await presentationService.loadPresentationSource(context.projectId, { baseUrl: requestBaseUrl(req) });
  const model = presentationService.modelConfiguration();
  return success(res, {
    ...data,
    capabilities: {
      presentation_enabled: true,
      model_configured: model.configured,
      model_provider: model.provider,
      model_name: model.model,
    },
  });
}

async function outline(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  try {
    const data = await presentationService.loadPresentationSource(context.projectId, { baseUrl: requestBaseUrl(req) });
    const result = await presentationService.generateOutline(data, req.body || {});
    return success(res, result.outline);
  } catch (modelError) {
    if (modelError.code === 'PRESENTATION_MODEL_NOT_CONFIGURED') {
      return error(res, modelError.message, 503, {
        reason: modelError.code,
        missing: modelError.missing,
      });
    }
    if (modelError.status) {
      return error(res, modelError.message, modelError.status, { reason: modelError.code });
    }
    throw modelError;
  }
}

async function exportPptx(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!body.outline) return error(res, '请先生成并确认汇报目录');
  const data = await presentationService.loadPresentationSource(context.projectId, { baseUrl: requestBaseUrl(req) });
  let plan;
  try {
    plan = presentationService.buildRenderPlan(data, body.settings || body, body.outline);
  } catch (validationError) {
    return error(res, validationError.message || '汇报数据不正确');
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-presentation-export-'));
  const filename = `${safeFileName(plan.presentation.title)}.pptx`;
  const outputPath = path.join(directory, filename);
  try {
    await generateFromPlan(plan, outputPath);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.download(outputPath, filename, async downloadError => {
      await fs.rm(directory, { recursive: true, force: true });
      if (downloadError && !res.headersSent) res.status(500).end();
    });
  } catch (renderError) {
    await fs.rm(directory, { recursive: true, force: true });
    throw renderError;
  }
}

async function listJobs(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  return success(res, await jobs.list(context.projectId));
}
async function createJob(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  const body = req.body || {};
  if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) return error(res, '请填写汇报设置');
  if (!/^[0-9a-f-]{36}$/i.test(body.request_key || '')) return error(res, '任务标识不正确');
  const result = await jobs.submit(context.projectId, req.user.id, { ...body.settings, project_id: context.projectId, _asset_base_url: requestBaseUrl(req) }, body.request_key);
  return success(res, result, '已加入生成队列');
}
async function retryJob(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  const result = await jobs.retry(context.projectId, req.params.jobId);
  if (!result) return error(res, '方案不存在', 404);
  return success(res, jobs.publicJob(result));
}
async function downloadJob(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  const job = await jobs.find(context.projectId, req.params.jobId);
  if (!job) return error(res, '方案不存在', 404);
  if (job.status !== 'completed' || !job.result_file) return error(res, '方案尚未生成完成', 409);
  const filename = path.basename(job.result_file);
  const output = path.join(jobs.resultsDirectory, filename);
  try { await fs.access(output); } catch (_) { return error(res, '生成文件不存在，请重新生成方案', 410); }
  res.setHeader('Cache-Control', 'no-store');
  return res.download(output, `${safeFileName(job.title)}.pptx`);
}
module.exports = { source, outline, exportPptx, listJobs, createJob, retryJob, downloadJob };
