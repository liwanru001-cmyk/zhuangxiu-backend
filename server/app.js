const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const db = require('./config/db');
const authRoutes = require('./routes/auth.routes');
const noteRoutes = require('./routes/note.routes');
const userRoutes = require('./routes/user.routes');
const renovationRoutes = require('./routes/renovation.routes');

const app = express();
const PORT = process.env.PORT || 3001;
const path = require('path');
const jwt = require('jsonwebtoken');
const { success, error } = require('./utils/response');
const INSPECTION_KB_ENABLED = process.env.FEATURE_INSPECTION_KB === 'true';

// 信任 Nginx 反向代理
app.set('trust proxy', 1);

// 全局中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "script-src-attr": ["'unsafe-inline'"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 全局限流
app.use(
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 1000,
    message: { code: 429, message: '请求过于频繁，请稍后再试' },
  })
);

// 短信发送额外限流
app.use('/api/auth/send-code', rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: parseInt(process.env.SMS_RATE_LIMIT_MAX) || 5,
  message: { code: 429, message: '今日发送次数已达上限' },
}));

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/users', userRoutes);
app.use('/api/renovation', renovationRoutes);

// ===================== Admin =====================
const ADMIN_CREDENTIALS = { username: 'admin', password: 'admin123' };
const adminProgressStages = [
  { id: 1, name: '设计准备' },
  { id: 2, name: '主体拆改' },
  { id: 3, name: '水电改造' },
  { id: 4, name: '泥瓦防水' },
  { id: 5, name: '木工施工' },
  { id: 6, name: '油漆施工' },
  { id: 7, name: '安装阶段' },
  { id: 8, name: '竣工验收' },
];

// admin 登录
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_CREDENTIALS.username || password !== ADMIN_CREDENTIALS.password) {
    return error(res, '用户名或密码错误', 401);
  }
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return success(res, { token, user: { username: 'admin' } });
});

// admin 鉴权中间件
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return error(res, '未登录', 401);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return error(res, '无权限', 403);
    req.admin = decoded;
    next();
  } catch {
    return error(res, '登录已过期', 401);
  }
}

function requireInspectionKb(req, res, next) {
  if (!INSPECTION_KB_ENABLED) return error(res, '验收标准库功能未启用', 404);
  next();
}

function parseAdminJsonList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      return value
        .split(/[\n,，]/)
        .map(item => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function adminJsonList(value) {
  return JSON.stringify(parseAdminJsonList(value));
}

function adminBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function adminTemplatePayload(body = {}, existing = {}) {
  return {
    code: body.code !== undefined ? String(body.code).trim() : existing.code,
    title: body.title !== undefined ? String(body.title).trim() : existing.title,
    stage_id: body.stage_id === '' || body.stage_id === undefined ? existing.stage_id ?? null : Number(body.stage_id),
    node_type: body.node_type !== undefined ? String(body.node_type || 'stage') : existing.node_type || 'stage',
    description: body.description !== undefined ? String(body.description || '') : existing.description || '',
    standard_basis: body.standard_basis !== undefined ? String(body.standard_basis || '') : existing.standard_basis || '',
    recommended_tools: body.recommended_tools !== undefined ? adminJsonList(body.recommended_tools) : adminJsonList(existing.recommended_tools),
    applicable_project_types: body.applicable_project_types !== undefined ? adminJsonList(body.applicable_project_types) : adminJsonList(existing.applicable_project_types),
    applicable_methods: body.applicable_methods !== undefined ? adminJsonList(body.applicable_methods) : adminJsonList(existing.applicable_methods),
    sort_order: body.sort_order === undefined ? Number(existing.sort_order || 0) : Number(body.sort_order || 0),
    is_active: body.is_active === undefined ? Number(existing.is_active ?? 1) : Number(adminBool(body.is_active)),
  };
}

function adminItemPayload(body = {}, existing = {}) {
  return {
    code: body.code !== undefined ? String(body.code).trim() : existing.code,
    title: body.title !== undefined ? String(body.title).trim() : existing.title,
    standard_text: body.standard_text !== undefined ? String(body.standard_text || '') : existing.standard_text || '',
    check_method: body.check_method !== undefined ? String(body.check_method || '') : existing.check_method || '',
    required_tools: body.required_tools !== undefined ? adminJsonList(body.required_tools) : adminJsonList(existing.required_tools),
    risk_level: body.risk_level !== undefined ? String(body.risk_level || 'normal') : existing.risk_level || 'normal',
    failure_action: body.failure_action !== undefined ? String(body.failure_action || '') : existing.failure_action || '',
    require_photo: body.require_photo === undefined ? Number(existing.require_photo || 0) : Number(adminBool(body.require_photo)),
    sort_order: body.sort_order === undefined ? Number(existing.sort_order || 0) : Number(body.sort_order || 0),
    is_active: body.is_active === undefined ? Number(existing.is_active ?? 1) : Number(adminBool(body.is_active)),
  };
}

function adminProgressBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

function adminProgressNullableBool(value, fallback = 0) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return 0;
  return adminProgressBool(value) ? 1 : 0;
}

function normalizeTemplateKey(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w-]/g, '_')
    .slice(0, 80);
}

function adminProgressItemPayload(body = {}, existing = {}) {
  const stageId = body.stage_id === undefined ? Number(existing.stage_id || 0) : Number(body.stage_id);
  const stage = adminProgressStages.find(item => Number(item.id) === stageId);
  if (!stage) return { error: '所属阶段不正确' };

  const title = body.title !== undefined ? String(body.title || '').trim() : existing.title || '';
  if (!title) return { error: '事项名称不能为空' };
  if (title.length > 120) return { error: '事项名称不能超过 120 个字' };

  const requiredLevel = body.required_level !== undefined
    ? String(body.required_level || '').trim()
    : existing.required_level || '';
  if (!['', 'core', 'recommended', 'optional'].includes(requiredLevel)) {
    return { error: '推荐等级不正确' };
  }

  const source = body.source !== undefined
    ? String(body.source || 'recommendation').trim()
    : existing.source || 'recommendation';
  if (!['default', 'recommendation'].includes(source)) return { error: '事项来源不正确' };

  let templateKey = body.template_key !== undefined
    ? normalizeTemplateKey(body.template_key)
    : existing.template_key || '';
  if (!templateKey) {
    templateKey = `admin_stage_${stageId}_${Date.now()}`;
  }

  const parentTemplateKey = body.parent_template_key !== undefined
    ? normalizeTemplateKey(body.parent_template_key) || null
    : existing.parent_template_key || null;
  if (parentTemplateKey && parentTemplateKey === templateKey) {
    return { error: '父级事项不能选择自己' };
  }

  const isKeyNode = body.is_key_node === undefined
    ? Number(existing.is_key_node || 0)
    : Number(adminProgressBool(body.is_key_node));

  return {
    template_key: templateKey,
    stage_id: stageId,
    parent_template_key: parentTemplateKey,
    title,
    required_level: requiredLevel,
    source,
    default_join: body.default_join === undefined
      ? Number(existing.default_join || 0)
      : Number(adminProgressBool(body.default_join)),
    requires_inspection: adminProgressNullableBool(body.requires_inspection, Number(existing.requires_inspection || 0)),
    inspection_template_key: body.inspection_template_key !== undefined
      ? String(body.inspection_template_key || '').trim().slice(0, 64) || null
      : existing.inspection_template_key || null,
    default_responsible_role: body.default_responsible_role !== undefined
      ? String(body.default_responsible_role || '').trim().slice(0, 32) || null
      : existing.default_responsible_role || null,
    suggested_timing: body.suggested_timing !== undefined
      ? String(body.suggested_timing || '').trim().slice(0, 120) || null
      : existing.suggested_timing || null,
    description: body.description !== undefined
      ? String(body.description || '').trim()
      : existing.description || '',
    applicable_project_types: body.applicable_project_types !== undefined
      ? String(body.applicable_project_types || '').trim().slice(0, 300) || null
      : existing.applicable_project_types || null,
    not_applicable_note: body.not_applicable_note !== undefined
      ? String(body.not_applicable_note || '').trim().slice(0, 300) || null
      : existing.not_applicable_note || null,
    merge_status: body.merge_status !== undefined
      ? String(body.merge_status || '').trim().slice(0, 32) || null
      : existing.merge_status || null,
    is_key_node: isKeyNode,
    sort_order: body.sort_order === undefined ? Number(existing.sort_order || 0) : Number(body.sort_order || 0),
    is_active: body.is_active === undefined ? Number(existing.is_active ?? 1) : Number(adminProgressBool(body.is_active)),
  };
}

function adminTipPayload(body = {}, existing = {}) {
  const type = body.type !== undefined ? String(body.type || 'general') : existing.type || 'general';
  if (!['general', 'function_intro', 'stage'].includes(type)) return { error: '日志信息分类不正确' };
  const title = body.title !== undefined ? String(body.title || '').trim() : existing.title || '';
  const content = body.content !== undefined ? String(body.content || '').trim() : existing.content || '';
  if (!title) return { error: '日志信息标题不能为空' };
  if (!content) return { error: '日志信息内容不能为空' };
  if (title.length > 80) return { error: '日志信息标题不能超过 80 个字' };
  if (content.length > 2000) return { error: '日志信息内容不能超过 2000 个字' };
  return {
    type,
    title,
    content,
    sort_order: body.sort_order === undefined ? Number(existing.sort_order || 0) : Number(body.sort_order || 0),
    is_active: body.is_active === undefined ? Number(existing.is_active ?? 1) : Number(adminBool(body.is_active)),
  };
}

function adminFaqPayload(body = {}, existing = {}) {
  const question = body.question !== undefined ? String(body.question || '').trim() : existing.question || '';
  const answer = body.answer !== undefined ? String(body.answer || '').trim() : existing.answer || '';
  if (!question) return { error: '常见问题不能为空' };
  if (!answer) return { error: '常见问题答案不能为空' };
  if (question.length > 120) return { error: '问题不能超过 120 个字' };
  if (answer.length > 2000) return { error: '答案不能超过 2000 个字' };
  return {
    question,
    answer,
    sort_order: body.sort_order === undefined ? Number(existing.sort_order || 0) : Number(body.sort_order || 0),
    is_active: body.is_active === undefined ? Number(existing.is_active ?? 1) : Number(adminBool(body.is_active)),
  };
}

async function ensureAdminHelpTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS help_faqs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      question VARCHAR(120) NOT NULL,
      answer TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_help_faq_active_sort (is_active, sort_order, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED DEFAULT NULL,
      content TEXT NOT NULL,
      contact VARCHAR(80) DEFAULT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user_feedback_status_time (status, created_at),
      KEY idx_user_feedback_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [[row]] = await db.query('SELECT COUNT(*) AS total FROM help_faqs');
  if (Number(row.total) === 0) {
    await db.query(
      `INSERT INTO help_faqs (question, answer, sort_order, is_active)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        '如何修改装修阶段？',
        '进入装修日志后，在项目进度或阶段相关入口中查看当前阶段。阶段变更涉及项目进度，建议由业主和项目成员确认后操作。',
        10,
        1,
        '工地打卡会公开吗？',
        '默认不会自动公开到装修圈。只有你主动发布或选择分享的内容，才会作为公开内容展示。',
        20,
        1,
        '如何更换绑定的设计师？',
        '进入我的工地或项目成员管理，先解除原设计师关系，再邀请新的设计师加入项目。',
        30,
        1,
      ]
    );
  }
}

// admin 用户列表
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const params = [];
  let where = '1=1';
  if (req.query.keyword) {
    where += ' AND (nickname LIKE ? OR phone LIKE ?)';
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw);
  }
  if (req.query.role) {
    where += ` AND EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = users.id AND ur.role = ?
    )`;
    params.push(req.query.role);
  }
  if (req.query.adminStatus) {
    if (!['pending', 'approved', 'rejected'].includes(String(req.query.adminStatus))) {
      return error(res, '审核状态不正确');
    }
    where += ' AND admin_status = ?';
    params.push(String(req.query.adminStatus));
  }
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT id, phone, nickname, avatar, bio, city, role, admin_status,
            (SELECT JSON_ARRAYAGG(ur.role) FROM user_roles ur
             WHERE ur.user_id = users.id) AS roles,
            followers_count, following_count,
            likes_received, created_at, updated_at
     FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [countRows] = await db.query(`SELECT COUNT(*) AS total FROM users WHERE ${where}`, params);
  return success(res, { users: rows, total: countRows[0].total, page, pageSize });
});

// admin 概览
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [[userStats]] = await db.query(
    `SELECT
       COUNT(*) AS total_users,
       SUM(admin_status = 'pending') AS pending_users,
       SUM(DATE(created_at) = CURDATE()) AS today_users
     FROM users`
  );
  const [[noteStats]] = await db.query(
    `SELECT COUNT(*) AS total_notes FROM notes`
  );
  const [[projectStats]] = await db.query(
    `SELECT COUNT(*) AS total_projects FROM renovation_projects`
  );
  return success(res, {
    total_users: Number(userStats.total_users) || 0,
    pending_users: Number(userStats.pending_users) || 0,
    today_users: Number(userStats.today_users) || 0,
    total_notes: Number(noteStats.total_notes) || 0,
    total_projects: Number(projectStats.total_projects) || 0,
  });
});

app.get('/api/admin/features', adminAuth, (req, res) => {
  return success(res, {
    inspectionKb: INSPECTION_KB_ENABLED,
  });
});

app.get('/api/admin/progress-item-library', adminAuth, async (req, res) => {
  const [templates] = await db.query(
    `SELECT item.id, item.template_key, item.stage_id, item.parent_template_key,
            parent.title AS parent_title, item.title, item.required_level,
            item.source, item.default_join, item.is_key_node,
            item.requires_inspection, item.inspection_template_key,
            item.default_responsible_role, item.suggested_timing,
            item.description, item.applicable_project_types,
            item.not_applicable_note, item.merge_status,
            item.sort_order, item.is_active, item.updated_at
     FROM renovation_work_item_templates
     item
     LEFT JOIN renovation_work_item_templates parent
            ON parent.template_key = item.parent_template_key
     ORDER BY item.stage_id, COALESCE(parent.sort_order, item.sort_order), item.parent_template_key IS NOT NULL, item.sort_order, item.id`
  );
  const stageMap = new Map(adminProgressStages.map(stage => [stage.id, stage.name]));
  const items = templates.map(item => ({
    id: Number(item.id),
    source: item.source || 'recommendation',
    template_key: item.template_key,
    stage_id: Number(item.stage_id),
    stage_name: stageMap.get(Number(item.stage_id)) || `阶段${item.stage_id}`,
    parent_template_key: item.parent_template_key || '',
    parent_title: item.parent_title || '',
    title: item.title,
    required_level: item.required_level || '',
    default_join: Boolean(item.default_join),
    is_key_node: Boolean(item.is_key_node),
    requires_inspection: Boolean(item.requires_inspection),
    inspection_template_key: item.inspection_template_key || '',
    default_responsible_role: item.default_responsible_role || '',
    suggested_timing: item.suggested_timing || '',
    description: item.description || '',
    applicable_project_types: item.applicable_project_types || '',
    not_applicable_note: item.not_applicable_note || '',
    sort_order: Number(item.sort_order || 0),
    is_active: Number(item.is_active ?? 1),
    merge_status: item.merge_status || '',
    updated_at: item.updated_at,
  }));
  return success(res, {
    stages: adminProgressStages,
    items,
  });
});

app.post('/api/admin/progress-item-library', adminAuth, async (req, res) => {
  const payload = adminProgressItemPayload(req.body || {});
  if (payload.error) return error(res, payload.error);
  try {
    await db.query(
      `INSERT INTO renovation_work_item_templates
       (template_key, stage_id, parent_template_key, title, required_level,
        source, default_join, requires_inspection, inspection_template_key,
        default_responsible_role, suggested_timing, description,
        applicable_project_types, not_applicable_note, merge_status,
        is_key_node, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.template_key,
        payload.stage_id,
        payload.parent_template_key,
        payload.title,
        payload.required_level,
        payload.source,
        payload.default_join,
        payload.requires_inspection,
        payload.inspection_template_key,
        payload.default_responsible_role,
        payload.suggested_timing,
        payload.description,
        payload.applicable_project_types,
        payload.not_applicable_note,
        payload.merge_status,
        payload.is_key_node,
        payload.sort_order,
        payload.is_active,
      ]
    );
    return success(res, { template_key: payload.template_key }, '事项已新增');
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return error(res, '事项编码已存在');
    throw e;
  }
});

app.put('/api/admin/progress-item-library/:templateKey', adminAuth, async (req, res) => {
  const templateKey = String(req.params.templateKey || '').trim();
  const [rows] = await db.query(
    'SELECT * FROM renovation_work_item_templates WHERE template_key = ? LIMIT 1',
    [templateKey]
  );
  if (!rows[0]) return error(res, '事项不存在', 404);
  const payload = adminProgressItemPayload(req.body || {}, rows[0]);
  if (payload.error) return error(res, payload.error);
  try {
    await db.query(
      `UPDATE renovation_work_item_templates
       SET template_key = ?, stage_id = ?, parent_template_key = ?, title = ?,
           required_level = ?, source = ?, default_join = ?,
           requires_inspection = ?, inspection_template_key = ?,
           default_responsible_role = ?, suggested_timing = ?, description = ?,
           applicable_project_types = ?, not_applicable_note = ?,
           merge_status = ?, is_key_node = ?, sort_order = ?, is_active = ?
       WHERE template_key = ?`,
      [
        payload.template_key,
        payload.stage_id,
        payload.parent_template_key,
        payload.title,
        payload.required_level,
        payload.source,
        payload.default_join,
        payload.requires_inspection,
        payload.inspection_template_key,
        payload.default_responsible_role,
        payload.suggested_timing,
        payload.description,
        payload.applicable_project_types,
        payload.not_applicable_note,
        payload.merge_status,
        payload.is_key_node,
        payload.sort_order,
        payload.is_active,
        templateKey,
      ]
    );
    return success(res, { template_key: payload.template_key }, '事项已保存');
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return error(res, '事项编码已存在');
    throw e;
  }
});

// admin 更新用户
app.put('/api/admin/users/:id', adminAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const { nickname, role, admin_status: adminStatus } = req.body || {};
  const updates = [];
  const vals = [];
  if (nickname !== undefined) { updates.push('nickname = ?'); vals.push(String(nickname)); }
  if (role !== undefined) {
    if (
      ![
        'owner',
        'designer',
        'merchant',
        'project_manager',
        'project_supervisor',
      ].includes(String(role))
    ) {
      return error(res, '身份类型不正确');
    }
    updates.push('role = ?');
    vals.push(String(role));
  }
  if (adminStatus !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(String(adminStatus))) {
      return error(res, '审核状态不正确');
    }
    updates.push('admin_status = ?');
    vals.push(String(adminStatus));
  }
  if (updates.length === 0) return error(res, '没有可更新的内容');
  vals.push(userId);
  const [result] = await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);
  if (result.affectedRows === 0) return error(res, '用户不存在', 404);
  if (role !== undefined) {
    await db.query(
      'INSERT IGNORE INTO user_roles (user_id, role, is_default) VALUES (?, ?, 0)',
      [userId, String(role)]
    );
  }
  return success(res, { updated: true });
});

// admin 审核用户
app.put('/api/admin/users/:id/review', adminAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const action = String(req.body?.action || '');
  if (!['approve', 'reject'].includes(action)) {
    return error(res, '操作必须是 approve 或 reject');
  }
  const adminStatus = action === 'approve' ? 'approved' : 'rejected';
  const [result] = await db.query(
    'UPDATE users SET admin_status = ? WHERE id = ?',
    [adminStatus, userId]
  );
  if (result.affectedRows === 0) return error(res, '用户不存在', 404);
  return success(res, { id: userId, admin_status: adminStatus });
});

const PUBLIC_SHARE_SOURCE_TYPES = [
  'site_photos',
  'complaint',
  'question',
  'good_item',
  'inspiration',
  'legacy',
];

// admin 分享内容列表
app.get('/api/admin/shares', adminAuth, async (req, res) => {
  const params = [];
  let where = `n.status <> 4 AND n.source_type IN (${PUBLIC_SHARE_SOURCE_TYPES.map(() => '?').join(', ')})`;
  params.push(...PUBLIC_SHARE_SOURCE_TYPES);

  if (req.query.keyword) {
    where += ' AND (n.title LIKE ? OR n.content LIKE ? OR u.nickname LIKE ? OR u.phone LIKE ?)';
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw, kw, kw);
  }
  if (req.query.sourceType) {
    const sourceType = String(req.query.sourceType);
    if (!PUBLIC_SHARE_SOURCE_TYPES.includes(sourceType)) {
      return error(res, '分享来源不正确');
    }
    where += ' AND n.source_type = ?';
    params.push(sourceType);
  }
  if (req.query.status !== undefined && req.query.status !== '') {
    const status = Number(req.query.status);
    if (![0, 1, 2].includes(status)) return error(res, '内容状态不正确');
    where += ' AND n.status = ?';
    params.push(status);
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT n.id, n.title, n.content, n.source_type, n.stage_id,
            n.publish_role, n.question_audience, n.category,
            n.decoration_style, n.location, n.city, n.status,
            n.likes_count, n.comments_count, n.collections_count,
            n.views_count, n.created_at, n.updated_at,
            u.id AS user_id, u.phone, u.nickname AS author_name,
            u.avatar AS author_avatar,
            (SELECT url FROM note_images WHERE note_id = n.id ORDER BY sort_order ASC LIMIT 1) AS cover_image,
            (SELECT url FROM note_videos WHERE note_id = n.id ORDER BY id ASC LIMIT 1) AS video_url,
            (SELECT cover_url FROM note_videos WHERE note_id = n.id ORDER BY id ASC LIMIT 1) AS video_cover_url
     FROM notes n
     JOIN users u ON u.id = n.user_id
     WHERE ${where}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM notes n
     JOIN users u ON u.id = n.user_id
     WHERE ${where}`,
    params
  );
  return success(res, { shares: rows, total: countRows[0].total, page, pageSize });
});

// admin 审核分享内容
app.put('/api/admin/shares/:id/review', adminAuth, async (req, res) => {
  const noteId = Number(req.params.id);
  const action = String(req.body?.action || '');
  const statusMap = { approve: 1, reject: 2, hide: 2, pending: 0 };
  if (!Object.prototype.hasOwnProperty.call(statusMap, action)) {
    return error(res, '操作必须是 approve、reject、hide 或 pending');
  }

  const [result] = await db.query(
    'UPDATE notes SET status = ? WHERE id = ?',
    [statusMap[action], noteId]
  );
  if (result.affectedRows === 0) return error(res, '内容不存在', 404);
  return success(res, { id: noteId, status: statusMap[action] });
});

// admin 装修贴士
app.get('/api/admin/project-tips', adminAuth, async (req, res) => {
  const params = [];
  let where = '1=1';
  if (req.query.type) {
    const type = String(req.query.type);
    if (!['general', 'function_intro', 'stage'].includes(type)) return error(res, '日志信息分类不正确');
    where += ' AND type = ?';
    params.push(type);
  }
  if (req.query.active !== undefined && req.query.active !== '') {
    where += ' AND is_active = ?';
    params.push(adminBool(req.query.active) ? 1 : 0);
  }
  const [rows] = await db.query(
    `SELECT id, type, title, content, sort_order, is_active, created_at, updated_at
     FROM project_tips
     WHERE ${where}
     ORDER BY sort_order ASC, id ASC`,
    params
  );
  return success(res, { tips: rows });
});

app.post('/api/admin/project-tips', adminAuth, async (req, res) => {
  const payload = adminTipPayload(req.body || {});
  if (payload.error) return error(res, payload.error);
  const [result] = await db.query(
    `INSERT INTO project_tips (type, title, content, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    [payload.type, payload.title, payload.content, payload.sort_order, payload.is_active]
  );
  return success(res, { id: result.insertId });
});

app.put('/api/admin/project-tips/:id', adminAuth, async (req, res) => {
  const tipId = Number(req.params.id);
  const [[existing]] = await db.query('SELECT * FROM project_tips WHERE id = ?', [tipId]);
  if (!existing) return error(res, '贴士不存在', 404);
  const payload = adminTipPayload(req.body || {}, existing);
  if (payload.error) return error(res, payload.error);
  await db.query(
    `UPDATE project_tips
     SET type = ?, title = ?, content = ?, sort_order = ?, is_active = ?
     WHERE id = ?`,
    [payload.type, payload.title, payload.content, payload.sort_order, payload.is_active, tipId]
  );
  return success(res, { id: tipId, updated: true });
});

app.delete('/api/admin/project-tips/:id', adminAuth, async (req, res) => {
  const tipId = Number(req.params.id);
  const [result] = await db.query('DELETE FROM project_tips WHERE id = ?', [tipId]);
  if (result.affectedRows === 0) return error(res, '贴士不存在', 404);
  return success(res, { id: tipId, deleted: true });
});

app.get('/api/admin/help-faqs', adminAuth, async (req, res) => {
  await ensureAdminHelpTables();
  const [rows] = await db.query(
    `SELECT id, question, answer, sort_order, is_active, created_at, updated_at
     FROM help_faqs
     ORDER BY sort_order ASC, id ASC`
  );
  return success(res, { faqs: rows, max: 10 });
});

app.post('/api/admin/help-faqs', adminAuth, async (req, res) => {
  await ensureAdminHelpTables();
  const [[countRow]] = await db.query('SELECT COUNT(*) AS total FROM help_faqs');
  if (Number(countRow.total) >= 10) return error(res, '常见问题最多只能添加 10 条');
  const payload = adminFaqPayload(req.body || {});
  if (payload.error) return error(res, payload.error);
  const [result] = await db.query(
    `INSERT INTO help_faqs (question, answer, sort_order, is_active)
     VALUES (?, ?, ?, ?)`,
    [payload.question, payload.answer, payload.sort_order, payload.is_active]
  );
  return success(res, { id: result.insertId });
});

app.put('/api/admin/help-faqs/:id', adminAuth, async (req, res) => {
  await ensureAdminHelpTables();
  const faqId = Number(req.params.id);
  const [[existing]] = await db.query('SELECT * FROM help_faqs WHERE id = ?', [faqId]);
  if (!existing) return error(res, '常见问题不存在', 404);
  const payload = adminFaqPayload(req.body || {}, existing);
  if (payload.error) return error(res, payload.error);
  await db.query(
    `UPDATE help_faqs
     SET question = ?, answer = ?, sort_order = ?, is_active = ?
     WHERE id = ?`,
    [payload.question, payload.answer, payload.sort_order, payload.is_active, faqId]
  );
  return success(res, { id: faqId, updated: true });
});

app.delete('/api/admin/help-faqs/:id', adminAuth, async (req, res) => {
  await ensureAdminHelpTables();
  const faqId = Number(req.params.id);
  const [result] = await db.query('DELETE FROM help_faqs WHERE id = ?', [faqId]);
  if (result.affectedRows === 0) return error(res, '常见问题不存在', 404);
  return success(res, { id: faqId, deleted: true });
});

app.get('/api/admin/user-feedback', adminAuth, async (req, res) => {
  await ensureAdminHelpTables();
  const pageNo = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (pageNo - 1) * pageSize;
  const status = String(req.query.status || '').trim();
  const params = [];
  let where = '1=1';
  if (status) {
    if (!['pending', 'reviewed', 'ignored'].includes(status)) return error(res, '反馈状态不正确');
    where += ' AND f.status = ?';
    params.push(status);
  }
  const [rows] = await db.query(
    `SELECT f.id, f.user_id, f.content, f.contact, f.status, f.created_at, f.updated_at,
            u.nickname, u.phone
     FROM user_feedback f
     LEFT JOIN users u ON u.id = f.user_id
     WHERE ${where}
     ORDER BY f.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total FROM user_feedback f WHERE ${where}`,
    params
  );
  return success(res, {
    feedback: rows,
    total: countRow.total,
    page: pageNo,
    pageSize,
  });
});

app.put('/api/admin/user-feedback/:id', adminAuth, async (req, res) => {
  await ensureAdminHelpTables();
  const feedbackId = Number(req.params.id);
  const status = String(req.body?.status || '').trim();
  if (!['pending', 'reviewed', 'ignored'].includes(status)) return error(res, '反馈状态不正确');
  const [result] = await db.query(
    'UPDATE user_feedback SET status = ? WHERE id = ?',
    [status, feedbackId]
  );
  if (result.affectedRows === 0) return error(res, '反馈不存在', 404);
  return success(res, { id: feedbackId, status });
});

// admin 验收标准库
app.get('/api/admin/inspection-templates', adminAuth, requireInspectionKb, async (req, res) => {
  const params = [];
  let where = '1=1';
  if (req.query.stageId) {
    where += ' AND t.stage_id = ?';
    params.push(Number(req.query.stageId));
  }
  if (req.query.active !== undefined && req.query.active !== '') {
    where += ' AND t.is_active = ?';
    params.push(adminBool(req.query.active) ? 1 : 0);
  }

  const [rows] = await db.query(
    `SELECT t.*,
            COUNT(i.id) AS item_count,
            SUM(i.risk_level = 'must' AND i.is_active = 1) AS must_count,
            SUM(i.risk_level = 'important' AND i.is_active = 1) AS important_count
     FROM inspection_templates t
     LEFT JOIN inspection_template_items i ON i.template_id = t.id
     WHERE ${where}
     GROUP BY t.id
     ORDER BY t.sort_order ASC, t.id ASC`,
    params
  );

  return success(res, {
    templates: rows.map(row => ({
      ...row,
      recommended_tools: parseAdminJsonList(row.recommended_tools),
      applicable_project_types: parseAdminJsonList(row.applicable_project_types),
      applicable_methods: parseAdminJsonList(row.applicable_methods),
      item_count: Number(row.item_count || 0),
      must_count: Number(row.must_count || 0),
      important_count: Number(row.important_count || 0),
    })),
  });
});

app.post('/api/admin/inspection-templates', adminAuth, requireInspectionKb, async (req, res) => {
  const payload = adminTemplatePayload(req.body || {});
  if (!payload.code || !payload.title) return error(res, '模板编码和名称不能为空');
  if (payload.stage_id !== null && (!Number.isInteger(payload.stage_id) || payload.stage_id < 1 || payload.stage_id > 8)) {
    return error(res, '项目阶段不正确');
  }

  const [result] = await db.query(
    `INSERT INTO inspection_templates
       (code, title, stage_id, node_type, description, standard_basis,
        recommended_tools, applicable_project_types, applicable_methods,
        sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.code, payload.title, payload.stage_id, payload.node_type,
      payload.description, payload.standard_basis, payload.recommended_tools,
      payload.applicable_project_types, payload.applicable_methods,
      payload.sort_order, payload.is_active,
    ]
  );
  return success(res, { id: result.insertId });
});

app.put('/api/admin/inspection-templates/:id', adminAuth, requireInspectionKb, async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await db.query('SELECT * FROM inspection_templates WHERE id = ?', [id]);
  if (!existing) return error(res, '验收模板不存在', 404);
  const payload = adminTemplatePayload(req.body || {}, existing);
  if (!payload.code || !payload.title) return error(res, '模板编码和名称不能为空');
  if (payload.stage_id !== null && (!Number.isInteger(payload.stage_id) || payload.stage_id < 1 || payload.stage_id > 8)) {
    return error(res, '项目阶段不正确');
  }

  await db.query(
    `UPDATE inspection_templates
     SET code = ?, title = ?, stage_id = ?, node_type = ?, description = ?,
         standard_basis = ?, recommended_tools = ?, applicable_project_types = ?,
         applicable_methods = ?, sort_order = ?, is_active = ?
     WHERE id = ?`,
    [
      payload.code, payload.title, payload.stage_id, payload.node_type,
      payload.description, payload.standard_basis, payload.recommended_tools,
      payload.applicable_project_types, payload.applicable_methods,
      payload.sort_order, payload.is_active, id,
    ]
  );
  return success(res, { id, updated: true });
});

app.get('/api/admin/inspection-templates/:id/items', adminAuth, requireInspectionKb, async (req, res) => {
  const templateId = Number(req.params.id);
  const [[template]] = await db.query('SELECT id, title FROM inspection_templates WHERE id = ?', [templateId]);
  if (!template) return error(res, '验收模板不存在', 404);
  const [rows] = await db.query(
    `SELECT * FROM inspection_template_items
     WHERE template_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [templateId]
  );
  return success(res, {
    template,
    items: rows.map(row => ({
      ...row,
      required_tools: parseAdminJsonList(row.required_tools),
    })),
  });
});

app.post('/api/admin/inspection-templates/:id/items', adminAuth, requireInspectionKb, async (req, res) => {
  const templateId = Number(req.params.id);
  const [[template]] = await db.query('SELECT id FROM inspection_templates WHERE id = ?', [templateId]);
  if (!template) return error(res, '验收模板不存在', 404);
  const payload = adminItemPayload(req.body || {});
  if (!payload.code || !payload.title) return error(res, '检查项编码和名称不能为空');
  if (!['must', 'important', 'normal'].includes(payload.risk_level)) return error(res, '风险等级不正确');

  const [result] = await db.query(
    `INSERT INTO inspection_template_items
       (template_id, code, title, standard_text, check_method, required_tools,
        risk_level, failure_action, require_photo, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      templateId, payload.code, payload.title, payload.standard_text,
      payload.check_method, payload.required_tools, payload.risk_level,
      payload.failure_action, payload.require_photo, payload.sort_order,
      payload.is_active,
    ]
  );
  return success(res, { id: result.insertId });
});

app.put('/api/admin/inspection-template-items/:id', adminAuth, requireInspectionKb, async (req, res) => {
  const id = Number(req.params.id);
  const [[existing]] = await db.query('SELECT * FROM inspection_template_items WHERE id = ?', [id]);
  if (!existing) return error(res, '检查项不存在', 404);
  const payload = adminItemPayload(req.body || {}, existing);
  if (!payload.code || !payload.title) return error(res, '检查项编码和名称不能为空');
  if (!['must', 'important', 'normal'].includes(payload.risk_level)) return error(res, '风险等级不正确');

  await db.query(
    `UPDATE inspection_template_items
     SET code = ?, title = ?, standard_text = ?, check_method = ?,
         required_tools = ?, risk_level = ?, failure_action = ?,
         require_photo = ?, sort_order = ?, is_active = ?
     WHERE id = ?`,
    [
      payload.code, payload.title, payload.standard_text, payload.check_method,
      payload.required_tools, payload.risk_level, payload.failure_action,
      payload.require_photo, payload.sort_order, payload.is_active, id,
    ]
  );
  return success(res, { id, updated: true });
});

// admin 静态文件
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({ code: 500, message: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`🚀 装修不凡后端启动: http://localhost:${PORT}`);
  console.log(`📋 管理后台: http://localhost:${PORT}/admin/`);
});

module.exports = app;
