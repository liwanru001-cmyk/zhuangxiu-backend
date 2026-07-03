const db = require('../config/db');
const { error } = require('./response');

function normalizeProjectId(value) {
  if (value === undefined || value === null || value === '') return null;
  const projectId = Number(value);
  return Number.isInteger(projectId) && projectId > 0 ? projectId : null;
}

function extractProjectId(req) {
  const pathLooksProjectScoped = String(req.originalUrl || req.url || '').includes('/projects/');
  return (
    normalizeProjectId(req.params?.projectId) ||
    normalizeProjectId(req.body?.project_id) ||
    normalizeProjectId(req.body?.projectId) ||
    normalizeProjectId(req.query?.project_id) ||
    normalizeProjectId(req.query?.projectId) ||
    normalizeProjectId(pathLooksProjectScoped ? req.params?.id : null)
  );
}

function isProjectSource(req) {
  return String(req.body?.source_page || req.query?.source_page || '').trim() === 'project';
}

async function findProjectAccess(projectId, userId) {
  const [rows] = await db.query(
    `SELECT p.id, p.user_id, p.lifecycle_status, pm.role
     FROM renovation_projects p
     LEFT JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
     WHERE p.id = ?
       AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
       AND (p.user_id = ? OR pm.id IS NOT NULL)
     LIMIT 1`,
    [userId, projectId, userId]
  );
  return rows[0] || null;
}

async function resolveProjectContext(req, res, options = {}) {
  const required = Boolean(options.required || isProjectSource(req));
  const projectId = extractProjectId(req);

  if (!projectId) {
    if (!required) return { ok: true, required: false, projectId: null };
    return {
      ok: false,
      response: error(res, options.missingMessage || '缺少项目上下文，请选择装修项目后再操作', 400),
    };
  }

  if (!req.user?.id) {
    return {
      ok: false,
      response: error(res, '请先登录', 401),
    };
  }

  const project = await findProjectAccess(projectId, req.user.id);
  if (!project) {
    return {
      ok: false,
      response: error(res, '项目不存在或无权限', 404),
    };
  }

  const context = {
    projectId,
    role: project.role || (Number(project.user_id) === Number(req.user.id) ? 'owner' : null),
    lifecycleStatus: project.lifecycle_status || 'active',
    source: projectId === normalizeProjectId(req.params?.id) ? 'path' : 'payload',
  };
  req.projectContext = context;
  return { ok: true, ...context };
}

async function requireProjectContext(req, res, options = {}) {
  return resolveProjectContext(req, res, { ...options, required: true });
}

async function linkConsultationToProject(consultationId, projectId) {
  if (!consultationId || !projectId) return;
  await db.query(
    `INSERT IGNORE INTO entity_relations
       (source_type, source_id, target_type, target_id, relation_type, role_label)
     VALUES ('consultation', ?, 'project', ?, 'participant', 'project_context')`,
    [consultationId, projectId]
  );
}

async function getConsultationProjectContext(consultationId) {
  const [rows] = await db.query(
    `SELECT target_id AS project_id
     FROM entity_relations
     WHERE source_type = 'consultation'
       AND source_id = ?
       AND target_type = 'project'
       AND relation_type = 'participant'
     ORDER BY id ASC
     LIMIT 1`,
    [consultationId]
  );
  return normalizeProjectId(rows[0]?.project_id);
}

module.exports = {
  resolveProjectContext,
  requireProjectContext,
  linkConsultationToProject,
  getConsultationProjectContext,
};
