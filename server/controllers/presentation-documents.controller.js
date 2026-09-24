'use strict';

const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { requireProjectContext } = require('../utils/project-context');
const { success, error } = require('../utils/response');
const documents = require('../services/presentation-document.service');
const storage = require('../services/storage.service');

const previewPage = path.join(__dirname, '../services/presentation-document/web/index.html');
const previewContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data: blob: https:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

function setPreviewHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', previewContentSecurityPolicy);
}

async function authorize(req, res, editing = false) {
  const context = await requireProjectContext(req, res);
  if (!context.ok) return null;
  if (editing && !['owner', 'designer'].includes(context.role)) {
    error(res, '仅项目设计师或业主可以保存汇报方案', 403);
    return null;
  }
  return context;
}

function previewUrl(req, projectId, documentId, userId) {
  const ticket = jwt.sign(
    { scope: 'presentation_document_preview', projectId, documentId, userId: Number(userId) },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  return `${req.protocol}://${req.get('host')}/api/renovation/projects/${projectId}/presentation-documents/${documentId}/preview?ticket=${encodeURIComponent(ticket)}`;
}

async function save(req, res) {
  const context = await authorize(req, res, true);
  if (!context) return;
  const settings = req.body?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return error(res, '请填写汇报设置');
  }
  const result = await documents.save(context.projectId, req.user.id, settings, {
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
  return success(res, {
    id: result.id,
    title: result.document.presentation.title,
    slide_count: result.document.slides.length,
    page_count: result.page_plan.pages.length,
    preview_url: previewUrl(req, context.projectId, result.id, req.user.id),
  }, '汇报方案已保存');
}

async function list(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  return success(res, await documents.list(context.projectId));
}

async function link(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  const document = await documents.find(context.projectId, req.params.documentId);
  if (!document) return error(res, '汇报方案不存在', 404);
  return success(res, {
    preview_url: previewUrl(req, context.projectId, document.id, req.user.id),
  });
}

async function pagePlan(req, res) {
  const context = await authorize(req, res);
  if (!context) return;
  const document = await documents.find(context.projectId, req.params.documentId);
  if (!document) return error(res, '汇报方案不存在', 404);
  return success(res, {
    page_plan: document.page_plan,
    page_plan_version: document.page_plan_version,
  });
}

async function updatePagePlan(req, res) {
  const context = await authorize(req, res, true);
  if (!context) return;
  try {
    const result = await documents.updatePagePlan(
      context.projectId,
      req.params.documentId,
      req.user.id,
      req.body?.page_plan || req.body
    );
    if (!result) return error(res, '汇报方案不存在', 404);
    return success(res, result, '页面编排已保存');
  } catch (validationError) {
    return error(res, validationError.message || '页面编排格式不正确');
  }
}

async function remove(req, res) {
  const context = await authorize(req, res, true);
  if (!context) return;
  const deleted = await documents.remove(
    context.projectId,
    String(req.params.documentId || '')
  );
  if (!deleted) return error(res, '汇报方案不存在', 404);
  return success(res, { id: req.params.documentId, deleted: true }, '汇报方案已删除');
}

async function authorizeTicket(req, res) {
  const projectId = Number(req.params.id);
  const documentId = String(req.params.documentId || '');
  let ticket;
  try {
    ticket = jwt.verify(String(req.query.ticket || ''), process.env.JWT_SECRET);
  } catch (_) {
    error(res, '预览链接已失效，请从项目重新打开', 401);
    return null;
  }
  if (ticket.scope !== 'presentation_document_preview' ||
      ticket.projectId !== projectId || ticket.documentId !== documentId ||
      !Number.isSafeInteger(ticket.userId)) {
    error(res, '预览链接不正确', 403);
    return null;
  }
  const [access] = await db.query(
    `SELECT p.id FROM renovation_projects p
     LEFT JOIN project_members pm ON pm.project_id = p.id
       AND pm.user_id = ? AND pm.status = 1
     WHERE p.id = ? AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
       AND (p.user_id = ? OR pm.id IS NOT NULL) LIMIT 1`,
    [ticket.userId, projectId, ticket.userId]
  );
  if (!access.length) {
    error(res, '项目不存在或无权限', 404);
    return null;
  }
  return { projectId, documentId };
}

async function preview(req, res) {
  const ticket = await authorizeTicket(req, res);
  if (!ticket) return;
  const document = await documents.find(ticket.projectId, ticket.documentId);
  if (!document) return error(res, '汇报方案不存在', 404);
  setPreviewHeaders(res);
  return res.sendFile(previewPage);
}

async function data(req, res) {
  const ticket = await authorizeTicket(req, res);
  if (!ticket) return;
  const document = await documents.find(ticket.projectId, ticket.documentId);
  if (!document) return error(res, '汇报方案不存在', 404);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return success(res, {
    ...document,
    document: {
      ...document.document,
      asset_manifest: (document.document.asset_manifest || []).map(asset => ({
        ...asset,
        url: storage.signedUrlForStorageUri(asset.url, 7200),
      })),
    },
  });
}

module.exports = {
  save,
  list,
  link,
  pagePlan,
  updatePagePlan,
  remove,
  preview,
  data,
  previewContentSecurityPolicy,
  setPreviewHeaders,
};
