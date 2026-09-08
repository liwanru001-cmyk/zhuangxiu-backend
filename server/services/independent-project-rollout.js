const { error } = require('../utils/response');

// Protocol capability only. Authentication and project permissions still apply.
const CAPABILITY_HEADER = 'x-zxw-projects';
const CAPABILITY_VERSION = 'independent-desktop-v1';
function supportsIndependentProjects(req) {
  return req?.headers?.[CAPABILITY_HEADER] === CAPABILITY_VERSION;
}
function enabled() {
  return process.env.FEATURE_INDEPENDENT_PROJECTS === 'true';
}
function legacyProjectFilter(req, alias = 'p') {
  return supportsIndependentProjects(req) ? '' : `AND COALESCE(${alias ? alias + '.' : ''}creation_source, 'owner') <> 'designer'`;
}
function featureGate(req, res, next) {
  if (!enabled()) return error(res, '独立项目功能尚未开放', 403);
  if (!supportsIndependentProjects(req)) return error(res, '请使用支持独立项目的新版桌面客户端', 409);
  return next();
}
function features(req, res) {
  return res.json({ code: 200, message: 'success', data: {
    independent_projects: enabled() && supportsIndependentProjects(req),
    independent_projects_protocol: CAPABILITY_VERSION,
  } });
}
// A kill switch stops new writes; compatible clients retain access to existing work.
async function legacyProjectGate(req, res, next) {
  if (supportsIndependentProjects(req)) return next();
  const { extractProjectId } = require('../utils/project-context');
  const projectId = extractProjectId(req);
  if (!projectId) return next();
  const db = require('../config/db');
  const [rows] = await db.query('SELECT creation_source FROM renovation_projects WHERE id = ? LIMIT 1', [projectId]);
  if (rows[0]?.creation_source === 'designer') {
    return error(res, '此项目需要使用新版桌面客户端打开', 409);
  }
  return next();
}
module.exports = { supportsIndependentProjects, enabled, legacyProjectFilter, featureGate, features, legacyProjectGate };
