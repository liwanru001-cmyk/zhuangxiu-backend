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
const marketplaceRoutes = require('./routes/marketplace.routes');
const consultationRoutes = require('./routes/consultation.routes');
const projectParticipantsRoutes = require('./routes/project-participants.routes');
const entityRelationsRoutes = require('./routes/entity-relations.routes');
const billingRoutes = require('./routes/billing.routes');
const billingService = require('./services/billing.service');

const app = express();
const PORT = process.env.PORT || 3001;
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { success, error } = require('./utils/response');
const INSPECTION_KB_ENABLED = process.env.FEATURE_INSPECTION_KB === 'true';

// 信任 Nginx 反向代理
app.set('trust proxy', 1);

// 全局中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "data:", "blob:"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "script-src-attr": ["'unsafe-inline'"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/storage', express.static(path.join(__dirname, 'storage')));

// 全局限流
app.use(
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 1000,
    message: { code: 429, message: '请求过于频繁，请稍后再试' },
  })
);

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/users', userRoutes);
app.use('/api/renovation', renovationRoutes);
app.use('/api', marketplaceRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/projects', projectParticipantsRoutes);
app.use('/api/entity-relations', entityRelationsRoutes);
app.use('/api/billing', billingRoutes);

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

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return values.map(csvCell).join(',');
}

function adminDateTimeText(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildBillingOrderWhere(query = {}) {
  const params = [];
  let where = `bo.subject_type = 'merchant'`;

  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where += ` AND (
      bo.order_no LIKE ?
      OR u.phone LIKE ?
      OR u.nickname LIKE ?
      OR mp.shop_name LIKE ?
    )`;
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw, kw);
  }

  const status = String(query.status || '').trim();
  if (status) {
    if (!['pending_payment', 'paid', 'closed', 'refunded'].includes(status)) {
      return { error: '订单状态不正确' };
    }
    where += ` AND bo.status = ?`;
    params.push(status);
  }

  const paymentChannel = String(query.payment_channel || '').trim();
  if (paymentChannel) {
    if (!['manual', 'wechat_pay', 'alipay', 'apple_iap', 'google_play', 'stripe'].includes(paymentChannel)) {
      return { error: '支付渠道不正确' };
    }
    where += ` AND bo.payment_channel = ?`;
    params.push(paymentChannel);
  }

  const dateFrom = String(query.date_from || '').trim();
  if (dateFrom) {
    where += ` AND bo.created_at >= ?`;
    params.push(`${dateFrom.slice(0, 10)} 00:00:00`);
  }
  const dateTo = String(query.date_to || '').trim();
  if (dateTo) {
    where += ` AND bo.created_at <= ?`;
    params.push(`${dateTo.slice(0, 10)} 23:59:59`);
  }

  return { where, params };
}

function buildCompanyBillingOrderWhere(query = {}) {
  const params = [];
  let where = `bo.subject_type = 'company'`;

  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where += ` AND (
      bo.order_no LIKE ?
      OR c.name LIKE ?
      OR c.contact_phone LIKE ?
      OR c.city LIKE ?
    )`;
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw, kw);
  }

  const status = String(query.status || '').trim();
  if (status) {
    if (!['pending_payment', 'paid', 'closed', 'refunded'].includes(status)) {
      return { error: '订单状态不正确' };
    }
    where += ` AND bo.status = ?`;
    params.push(status);
  }

  const paymentChannel = String(query.payment_channel || '').trim();
  if (paymentChannel) {
    if (!['manual', 'wechat_pay', 'alipay', 'apple_iap', 'google_play', 'stripe'].includes(paymentChannel)) {
      return { error: '支付渠道不正确' };
    }
    where += ` AND bo.payment_channel = ?`;
    params.push(paymentChannel);
  }

  const dateFrom = String(query.date_from || '').trim();
  if (dateFrom) {
    where += ` AND bo.created_at >= ?`;
    params.push(`${dateFrom.slice(0, 10)} 00:00:00`);
  }
  const dateTo = String(query.date_to || '').trim();
  if (dateTo) {
    where += ` AND bo.created_at <= ?`;
    params.push(`${dateTo.slice(0, 10)} 23:59:59`);
  }

  return { where, params };
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
            (SELECT ur.verified_status FROM user_roles ur
             WHERE ur.user_id = users.id AND ur.role = 'merchant'
             LIMIT 1) AS verified_merchant_status,
            (SELECT ur.verified_until FROM user_roles ur
             WHERE ur.user_id = users.id AND ur.role = 'merchant'
             LIMIT 1) AS verified_merchant_until,
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

const ADMIN_COMPANY_STATUSES = ['draft', 'active', 'suspended', 'deleted'];
const ADMIN_COMPANY_VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'];

function adminCompanyStatusLabel(status) {
  return {
    draft: '待审核',
    active: '正常',
    suspended: '停用',
    deleted: '已删除',
  }[status] || status || '-';
}

function adminCompanyVerificationLabel(status) {
  return {
    unverified: '未认证',
    pending: '待审核',
    verified: '已认证',
    rejected: '已拒绝',
  }[status] || status || '-';
}

function parseAdminCompanyBusinesses(value) {
  if (!value) return [];
  return String(value)
    .split('||')
    .map((item) => {
      const [id, code, name, parentCode, parentName, isPrimary] = item.split('::');
      if (!id || !name) return null;
      return {
        id: Number(id),
        code: code || '',
        name: name || '',
        parent_code: parentCode || '',
        parent_name: parentName || '',
        is_primary: Number(isPrimary) === 1,
      };
    })
    .filter(Boolean);
}

// admin 公司列表
app.get('/api/admin/companies', adminAuth, async (req, res) => {
  const params = [];
  let where = '1=1';

  if (req.query.keyword) {
    where += ' AND (c.name LIKE ? OR c.intro LIKE ? OR u.nickname LIKE ? OR u.phone LIKE ?)';
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw, kw, kw);
  }
  if (req.query.status) {
    const status = String(req.query.status);
    if (!ADMIN_COMPANY_STATUSES.includes(status)) return error(res, '公司状态不正确');
    where += ' AND c.status = ?';
    params.push(status);
  }
  if (req.query.verificationStatus) {
    const verificationStatus = String(req.query.verificationStatus);
    if (!ADMIN_COMPANY_VERIFICATION_STATUSES.includes(verificationStatus)) {
      return error(res, '公司认证状态不正确');
    }
    where += ' AND c.verification_status = ?';
    params.push(verificationStatus);
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
            c.city, c.address, c.contact_phone, c.status, c.source,
            c.verification_status, c.license_url,
            c.legacy_merchant_user_id, c.created_at, c.updated_at,
            u.nickname AS owner_name, u.phone AS owner_phone,
            (
              SELECT GROUP_CONCAT(
                CONCAT_WS('::', bc.id, bc.code, bc.name, COALESCE(parent.code, ''),
                          COALESCE(parent.name, ''), cb.is_primary)
                ORDER BY cb.is_primary DESC, parent.sort_order ASC, bc.sort_order ASC
                SEPARATOR '||'
              )
              FROM company_businesses cb
              JOIN business_catalog bc ON bc.id = cb.business_catalog_id
              LEFT JOIN business_catalog parent ON parent.id = bc.parent_id
              WHERE cb.company_id = c.id AND cb.status = 'active'
            ) AS business_text,
            (
              SELECT COUNT(*) FROM company_members cm
              WHERE cm.company_id = c.id AND cm.status = 'active'
            ) AS member_count,
            (
              SELECT COUNT(*) FROM project_participants_ext ppe
              WHERE ppe.company_id = c.id AND ppe.status <> 'removed'
            ) AS project_count
     FROM companies c
     LEFT JOIN users u ON u.id = COALESCE(c.owner_user_id, c.legacy_merchant_user_id)
     WHERE ${where}
     ORDER BY c.updated_at DESC, c.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM companies c
     LEFT JOIN users u ON u.id = COALESCE(c.owner_user_id, c.legacy_merchant_user_id)
     WHERE ${where}`,
    params
  );

  return success(res, {
    companies: rows.map((row) => ({
      id: row.id,
      owner_user_id: row.owner_user_id,
      name: row.name,
      logo_url: row.logo_url || '',
      intro: row.intro || '',
      service_area: row.service_area || '',
      city: row.city || '',
      address: row.address || '',
      contact_phone: row.contact_phone || '',
      status: row.status,
      status_label: adminCompanyStatusLabel(row.status),
      verification_status: row.verification_status || 'unverified',
      verification_status_label: adminCompanyVerificationLabel(row.verification_status || 'unverified'),
      license_url: row.license_url || '',
      source: row.source,
      legacy_merchant_user_id: row.legacy_merchant_user_id,
      owner_name: row.owner_name || '',
      owner_phone: row.owner_phone || '',
      businesses: parseAdminCompanyBusinesses(row.business_text),
      member_count: Number(row.member_count) || 0,
      project_count: Number(row.project_count) || 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    total: countRows[0].total,
    page,
    pageSize,
  });
});

// admin 公司详情
app.get('/api/admin/companies/:id', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) return error(res, '公司不存在', 404);

  const [[company]] = await db.query(
    `SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
            c.city, c.address, c.contact_phone, c.status, c.source,
            c.verification_status, c.license_url,
            c.legacy_merchant_user_id, c.created_at, c.updated_at,
            u.nickname AS owner_name, u.phone AS owner_phone
     FROM companies c
     LEFT JOIN users u ON u.id = COALESCE(c.owner_user_id, c.legacy_merchant_user_id)
     WHERE c.id = ?`,
    [companyId]
  );
  if (!company) return error(res, '公司不存在', 404);

  const [businesses] = await db.query(
    `SELECT bc.id, bc.code, bc.name, parent.code AS parent_code,
            parent.name AS parent_name, cb.is_primary, cb.status
     FROM company_businesses cb
     JOIN business_catalog bc ON bc.id = cb.business_catalog_id
     LEFT JOIN business_catalog parent ON parent.id = bc.parent_id
     WHERE cb.company_id = ? AND cb.status = 'active'
     ORDER BY cb.is_primary DESC, parent.sort_order ASC, bc.sort_order ASC`,
    [companyId]
  );
  const [members] = await db.query(
    `SELECT cm.id AS member_id, cm.user_id, cm.professional_id, cm.member_role,
            cm.title, cm.status, cm.joined_at, cm.created_at,
            u.nickname AS display_name, u.avatar AS avatar_url, u.phone,
            p.display_name AS professional_name
     FROM company_members cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN professionals p ON p.id = cm.professional_id
     WHERE cm.company_id = ?
     ORDER BY FIELD(cm.status, 'active', 'pending', 'rejected', 'removed'),
              FIELD(cm.member_role, 'owner', 'admin', 'designer', 'supervisor',
                    'project_manager', 'customer_service', 'merchant_staff'),
              cm.id DESC
     LIMIT 50`,
    [companyId]
  );
  const [projects] = await db.query(
    `SELECT ppe.id, ppe.project_id, ppe.participant_type, ppe.role_type,
            ppe.status, ppe.created_at, p.project_code, p.project_name
     FROM project_participants_ext ppe
     LEFT JOIN renovation_projects p ON p.id = ppe.project_id
     WHERE ppe.company_id = ? AND ppe.status <> 'removed'
     ORDER BY ppe.updated_at DESC, ppe.id DESC
     LIMIT 20`,
    [companyId]
  );

  return success(res, {
    company: {
      ...company,
      logo_url: company.logo_url || '',
      intro: company.intro || '',
      service_area: company.service_area || '',
      city: company.city || '',
      address: company.address || '',
      contact_phone: company.contact_phone || '',
      verification_status: company.verification_status || 'unverified',
      verification_status_label: adminCompanyVerificationLabel(company.verification_status || 'unverified'),
      license_url: company.license_url || '',
      owner_name: company.owner_name || '',
      owner_phone: company.owner_phone || '',
      status_label: adminCompanyStatusLabel(company.status),
    },
    businesses: businesses.map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      parent_code: item.parent_code || '',
      parent_name: item.parent_name || '',
      is_primary: Number(item.is_primary) === 1,
      status: item.status,
    })),
    members,
    projects,
  });
});

// admin 更新公司状态
app.put('/api/admin/companies/:id/status', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!companyId) return error(res, '公司不存在', 404);
  if (!ADMIN_COMPANY_STATUSES.includes(status)) return error(res, '公司状态不正确');

  const [result] = await db.query(
    'UPDATE companies SET status = ? WHERE id = ?',
    [status, companyId]
  );
  if (result.affectedRows === 0) return error(res, '公司不存在', 404);
  return success(res, { id: companyId, status, status_label: adminCompanyStatusLabel(status) });
});

// admin 更新公司认证状态
app.put('/api/admin/companies/:id/verification-status', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  const verificationStatus = String(req.body?.verification_status || '');
  if (!companyId) return error(res, '公司不存在', 404);
  if (!ADMIN_COMPANY_VERIFICATION_STATUSES.includes(verificationStatus)) {
    return error(res, '公司认证状态不正确');
  }

  const [result] = await db.query(
    'UPDATE companies SET verification_status = ? WHERE id = ?',
    [verificationStatus, companyId]
  );
  if (result.affectedRows === 0) return error(res, '公司不存在', 404);
  return success(res, {
    id: companyId,
    verification_status: verificationStatus,
    verification_status_label: adminCompanyVerificationLabel(verificationStatus),
  });
});

// admin 商家管理列表
app.get('/api/admin/merchants', adminAuth, async (req, res) => {
  const params = [];
  let where = `ur.role = 'merchant' AND ur.verified_applied_at IS NOT NULL`;

  if (req.query.keyword) {
    where += ` AND (
      u.nickname LIKE ? OR u.phone LIKE ? OR mp.shop_name LIKE ?
      OR mp.contact_phone LIKE ? OR mp.brand_intro LIKE ?
    )`;
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  if (req.query.status) {
    const status = String(req.query.status);
    if (!['pending', 'approved', 'rejected', 'suspended'].includes(status)) {
      return error(res, '入驻商家状态不正确');
    }
    where += ' AND ur.verified_status = ?';
    params.push(status);
  }
  if (req.query.category_group) {
    const categoryGroup = String(req.query.category_group);
    if (!['建材', '家居'].includes(categoryGroup)) return error(res, '商家分类不正确');
    where += ' AND mp.category_group = ?';
    params.push(categoryGroup);
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.phone, u.nickname, u.avatar, u.city, u.role AS user_role,
            ur.verified_status, ur.verified_at, ur.verified_until, ur.review_note,
            ur.verified_applied_at,
            mp.shop_name, mp.logo_url, mp.cover_url, mp.service_area, mp.address,
            mp.contact_phone, mp.business_hours, mp.category_group, mp.categories,
            mp.brand_intro, mp.consultation_enabled, mp.updated_at AS profile_updated_at,
            (
              SELECT COUNT(*)
              FROM merchant_products p
              WHERE p.merchant_user_id = u.id AND p.status = 'active'
            ) AS product_count
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'merchant'
     LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
     WHERE ${where}
     ORDER BY COALESCE(mp.updated_at, u.updated_at, u.created_at) DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'merchant'
     LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
     WHERE ${where}`,
    params
  );

  return success(res, {
    merchants: rows.map((row) => ({
      user_id: Number(row.user_id),
      phone: row.phone || '',
      nickname: row.nickname || '',
      avatar: row.avatar || '',
      city: row.city || '',
      user_role: row.user_role || '',
      verified_status: row.verified_status || 'none',
      verified_at: row.verified_at,
      verified_until: row.verified_until,
      verified_applied_at: row.verified_applied_at,
      review_note: row.review_note || '',
      shop_name: row.shop_name || '',
      logo_url: row.logo_url || '',
      cover_url: row.cover_url || '',
      service_area: row.service_area || '',
      address: row.address || '',
      contact_phone: row.contact_phone || '',
      business_hours: row.business_hours || '',
      category_group: row.category_group || '',
      categories: parseAdminJsonList(row.categories),
      brand_intro: row.brand_intro || '',
      consultation_enabled: Boolean(row.consultation_enabled),
      product_count: Number(row.product_count) || 0,
      profile_updated_at: row.profile_updated_at,
    })),
    total: countRows[0].total,
    page,
    pageSize,
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

// admin 审核入驻商家状态
app.put('/api/admin/merchants/:id/verified-status', adminAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const status = String(req.body?.status || '').trim();
  if (!['pending', 'approved', 'rejected', 'suspended'].includes(status)) {
    return error(res, '入驻商家状态不正确');
  }

  const verifiedUntil = req.body?.verified_until
    ? String(req.body.verified_until).trim().slice(0, 19)
    : null;
  const reviewNote = req.body?.review_note
    ? String(req.body.review_note).trim().slice(0, 255)
    : null;

  const [userRows] = await db.query('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!userRows.length) return error(res, '用户不存在', 404);

  await db.query(
    `INSERT INTO user_roles
     (user_id, role, is_default, verified_status, verified_at, verified_until, verified_applied_at, review_note)
     VALUES (?, 'merchant', 0, ?, IF(? = 'approved', NOW(), NULL), ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       verified_status = VALUES(verified_status),
       verified_at = IF(VALUES(verified_status) = 'approved', COALESCE(verified_at, NOW()), verified_at),
       verified_until = VALUES(verified_until),
       verified_applied_at = COALESCE(verified_applied_at, NOW()),
       review_note = VALUES(review_note)`,
    [userId, status, status, verifiedUntil || null, reviewNote || null]
  );

  return success(res, {
    id: userId,
    role: 'merchant',
    verified_status: status,
    verified_until: verifiedUntil,
  });
});

// admin Billing: merchant-only MVP list
app.get('/api/admin/billing/merchant-plan', adminAuth, async (req, res) => {
  try {
    return success(res, await billingService.getMerchantDisplayPlanForAdmin());
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/merchant-plan', adminAuth, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) return error(res, '套餐名称不能为空');

  const priceCents = Math.max(0, Math.round(Number(body.price_cents || 0)));
  if (!Number.isFinite(priceCents)) return error(res, '套餐价格不正确');

  const durationDays = Math.max(1, Math.min(3650, Math.round(Number(body.duration_days || 30))));
  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true';
  const feature = {
    shop_visible: body.shop_visible !== false && body.shop_visible !== 'false' && body.shop_visible !== 0 && body.shop_visible !== '0',
    search_visible: body.search_visible !== false && body.search_visible !== 'false' && body.search_visible !== 0 && body.search_visible !== '0',
    map_visible: body.map_visible !== false && body.map_visible !== 'false' && body.map_visible !== 0 && body.map_visible !== '0',
    product_showcase: body.product_showcase !== false && body.product_showcase !== 'false' && body.product_showcase !== 0 && body.product_showcase !== '0',
    case_showcase: body.case_showcase !== false && body.case_showcase !== 'false' && body.case_showcase !== 0 && body.case_showcase !== '0',
  };
  const limit = {
    product_limit: Math.max(0, Math.round(Number(body.product_limit || 0))),
    case_limit: Math.max(0, Math.round(Number(body.case_limit || 0))),
  };

  try {
    const plan = await billingService.publishMerchantDisplayPlanVersion({
      name,
      priceCents,
      durationDays,
      enabled,
      feature,
      limit,
    });
    return success(res, plan, '商户套餐已发布新版本');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.get('/api/admin/billing/company-plan', adminAuth, async (req, res) => {
  try {
    return success(res, await billingService.getCompanyDisplayPlanForAdmin());
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/company-plan', adminAuth, async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) return error(res, '套餐名称不能为空');

  const priceCents = Math.max(0, Math.round(Number(body.price_cents || 0)));
  if (!Number.isFinite(priceCents)) return error(res, '套餐价格不正确');

  const durationDays = Math.max(1, Math.min(3650, Math.round(Number(body.duration_days || 30))));
  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true';
  const feature = {
    company_visible: body.company_visible !== false && body.company_visible !== 'false' && body.company_visible !== 0 && body.company_visible !== '0',
    search_visible: body.search_visible !== false && body.search_visible !== 'false' && body.search_visible !== 0 && body.search_visible !== '0',
    case_showcase: body.case_showcase !== false && body.case_showcase !== 'false' && body.case_showcase !== 0 && body.case_showcase !== '0',
    review_showcase: body.review_showcase !== false && body.review_showcase !== 'false' && body.review_showcase !== 0 && body.review_showcase !== '0',
  };
  const limit = {
    case_limit: Math.max(0, Math.round(Number(body.case_limit || 0))),
    review_limit: Math.max(0, Math.round(Number(body.review_limit || 0))),
  };

  try {
    const plan = await billingService.publishCompanyDisplayPlanVersion({
      name,
      priceCents,
      durationDays,
      enabled,
      feature,
      limit,
    });
    return success(res, plan, '装修公司套餐已发布新版本');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.get('/api/admin/billing/appeals', adminAuth, async (req, res) => {
  try {
    const result = await billingService.listMerchantDisplayAppeals({
      status: req.query.status,
      keyword: req.query.keyword,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return success(res, result);
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/appeals/:id/approve', adminAuth, async (req, res) => {
  const appealId = Number(req.params.id);
  if (!appealId) return error(res, '申诉不存在', 404);
  try {
    const result = await billingService.approveMerchantDisplayAppeal({
      appealId,
      adminId: req.admin?.id || null,
      reason: req.body?.reason,
    });
    return success(res, result, '申诉已通过，商户展示已恢复');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/appeals/:id/reject', adminAuth, async (req, res) => {
  const appealId = Number(req.params.id);
  if (!appealId) return error(res, '申诉不存在', 404);
  try {
    const result = await billingService.rejectMerchantDisplayAppeal({
      appealId,
      adminId: req.admin?.id || null,
      reason: req.body?.reason,
    });
    return success(res, result, '申诉已驳回');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.get('/api/admin/billing/merchants', adminAuth, async (req, res) => {
  const params = [];
  let where = `EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = u.id AND ur.role = 'merchant'
  )`;

  if (req.query.keyword) {
    where += ` AND (
      u.nickname LIKE ? OR u.phone LIKE ? OR mp.shop_name LIKE ?
      OR mp.contact_phone LIKE ?
    )`;
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw, kw, kw);
  }

  const billingStatus = String(req.query.billing_status || '').trim();
  if (billingStatus) {
    if (!['visible', 'not_visible', 'expired'].includes(billingStatus)) {
      return error(res, 'Billing 状态不正确');
    }
    if (billingStatus === 'visible') {
      where += ` AND EXISTS (
        SELECT 1 FROM billing_entitlements be
        WHERE be.subject_type = 'merchant'
          AND be.subject_id = u.id
          AND be.status = 'active'
          AND be.readonly_mode = 0
          AND be.expire_at > NOW()
          AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.shop_visible')) = 'true'
      )`;
    } else if (billingStatus === 'expired') {
      where += ` AND EXISTS (
        SELECT 1 FROM billing_entitlements be
        WHERE be.subject_type = 'merchant'
          AND be.subject_id = u.id
          AND be.expire_at <= NOW()
      )`;
    } else {
      where += ` AND NOT EXISTS (
        SELECT 1 FROM billing_entitlements be
        WHERE be.subject_type = 'merchant'
          AND be.subject_id = u.id
          AND be.status = 'active'
          AND be.readonly_mode = 0
          AND be.expire_at > NOW()
          AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.shop_visible')) = 'true'
      )`;
    }
  }

  const pageNo = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (pageNo - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.phone, u.nickname, u.city,
            mp.shop_name, mp.contact_phone, mp.category_group,
            (
              SELECT bo.status
              FROM billing_orders bo
              WHERE bo.subject_type = 'merchant' AND bo.subject_id = u.id
              ORDER BY bo.id DESC
              LIMIT 1
            ) AS latest_order_status,
            (
              SELECT bo.created_at
              FROM billing_orders bo
              WHERE bo.subject_type = 'merchant' AND bo.subject_id = u.id
              ORDER BY bo.id DESC
              LIMIT 1
            ) AS latest_order_at,
            (
              SELECT bs.status
              FROM billing_subscriptions bs
              WHERE bs.subject_type = 'merchant' AND bs.subject_id = u.id
              ORDER BY bs.id DESC
              LIMIT 1
            ) AS subscription_status,
            (
              SELECT bs.expire_at
              FROM billing_subscriptions bs
              WHERE bs.subject_type = 'merchant' AND bs.subject_id = u.id
              ORDER BY bs.id DESC
              LIMIT 1
            ) AS subscription_expire_at,
            EXISTS (
              SELECT 1 FROM billing_entitlements be
              WHERE be.subject_type = 'merchant'
                AND be.subject_id = u.id
                AND be.status = 'active'
                AND be.readonly_mode = 0
                AND be.expire_at > NOW()
                AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.shop_visible')) = 'true'
            ) AS shop_visible
     FROM users u
     LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
     WHERE ${where}
     ORDER BY COALESCE(latest_order_at, mp.updated_at, u.updated_at, u.created_at) DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM users u
     LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
     WHERE ${where}`,
    params
  );

  return success(res, {
    merchants: rows.map((row) => ({
      user_id: Number(row.user_id),
      phone: row.phone || '',
      nickname: row.nickname || '',
      city: row.city || '',
      shop_name: row.shop_name || '',
      contact_phone: row.contact_phone || '',
      category_group: row.category_group || '',
      shop_visible: Boolean(row.shop_visible),
      latest_order_status: row.latest_order_status || '',
      latest_order_at: row.latest_order_at,
      subscription_status: row.subscription_status || '',
      subscription_expire_at: row.subscription_expire_at,
    })),
    total: Number(countRow.total || 0),
    page: pageNo,
    pageSize,
  });
});

// admin Billing: merchant-only MVP detail
app.get('/api/admin/billing/merchants/:id', adminAuth, async (req, res) => {
  const merchantUserId = Number(req.params.id);
  if (!merchantUserId) return error(res, '商家不存在', 404);

  const [merchantRows] = await db.query(
    `SELECT u.id AS user_id, u.phone, u.nickname, u.city,
            mp.shop_name, mp.contact_phone, mp.category_group
     FROM users u
     LEFT JOIN merchant_profiles mp ON mp.user_id = u.id
     WHERE u.id = ?
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = u.id AND ur.role = 'merchant'
       )
     LIMIT 1`,
    [merchantUserId]
  );
  if (!merchantRows[0]) return error(res, '商家不存在', 404);

  const snapshot = await billingService.getMerchantBillingSnapshot(merchantUserId);
  return success(res, {
    merchant: {
      user_id: Number(merchantRows[0].user_id),
      phone: merchantRows[0].phone || '',
      nickname: merchantRows[0].nickname || '',
      city: merchantRows[0].city || '',
      shop_name: merchantRows[0].shop_name || '',
      contact_phone: merchantRows[0].contact_phone || '',
      category_group: merchantRows[0].category_group || '',
    },
    billing: snapshot,
  });
});

// admin Billing: manual compensation / activation for merchant display
app.post('/api/admin/billing/merchants/:id/manual-activate', adminAuth, async (req, res) => {
  const merchantUserId = Number(req.params.id);
  if (!merchantUserId) return error(res, '商家不存在', 404);

  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写手动开通原因');
  const amountCents = Math.round(Number(req.body?.amount_cents || 0));
  if (!Number.isFinite(amountCents) || amountCents < 0) return error(res, '补单金额不正确');
  const voucherNote = String(req.body?.voucher_note || '').trim().slice(0, 300);
  if (!voucherNote) return error(res, '请填写线下收款凭证说明');

  const idempotencyBase = `admin-manual-merchant-${merchantUserId}-${Date.now()}`;
  try {
    const created = await billingService.createMerchantDisplayOrder({
      merchantUserId,
      operatorUserId: 0,
      actorType: 'admin',
      paymentChannel: 'manual',
      idempotencyKey: `${idempotencyBase}-order`,
    });
    const activated = await billingService.payMerchantOrderManual({
      orderId: created.order.id,
      merchantUserId,
      operatorUserId: 0,
      actorType: 'admin',
      idempotencyKey: `${idempotencyBase}-payment`,
    });
    await db.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, after_json, reason
       )
       VALUES ('merchant', ?, 'admin', NULL, 'ADMIN_MANUAL_ACTIVATE_MERCHANT',
               'billing_order', ?, ?, ?)`,
      [
        merchantUserId,
        created.order.id,
        JSON.stringify({
          order_id: created.order.id,
          subscription_id: activated.subscription?.id || null,
          entitlement_id: activated.entitlement?.id || null,
          manual_compensation: {
            amount_cents: amountCents,
            currency: 'CNY',
            voucher_note: voucherNote,
          },
        }),
        reason,
      ]
    );
    return success(res, activated, '商家展示已手动开通');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/merchants/:id/suspend', adminAuth, async (req, res) => {
  const merchantUserId = Number(req.params.id);
  if (!merchantUserId) return error(res, '商家不存在', 404);

  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写暂停原因');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'merchant'
         AND subject_id = ?
         AND status = 'active'
         AND expire_at > NOW()
       ORDER BY expire_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [merchantUserId]
    );
    const entitlement = rows[0];
    if (!entitlement) {
      await conn.rollback();
      return error(res, '没有可暂停的有效展示权益', 404);
    }
    if (Number(entitlement.readonly_mode) === 1 && entitlement.reason === 'manual_suspend') {
      await conn.commit();
      return success(res, { suspended: true }, '该商户已暂停展示');
    }
    await conn.query(
      `UPDATE billing_entitlements
       SET readonly_mode = 1,
           reason = 'manual_suspend'
       WHERE id = ?`,
      [entitlement.id]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES ('merchant', ?, 'admin', NULL, 'ADMIN_SUSPEND_MERCHANT_DISPLAY',
               'billing_entitlement', ?, ?, ?, ?)`,
      [
        merchantUserId,
        entitlement.id,
        JSON.stringify({
          readonly_mode: Boolean(entitlement.readonly_mode),
          reason: entitlement.reason || null,
        }),
        JSON.stringify({ readonly_mode: true, reason: 'manual_suspend' }),
        reason,
      ]
    );
    await conn.query(
      `INSERT INTO billing_events (
         event_id, event_type, event_version, subject_type, subject_id,
         aggregate_type, aggregate_id, payload_json, status
       )
       VALUES (?, 'MERCHANT_DISPLAY_SUSPENDED', 1, 'merchant', ?,
               'billing_entitlement', ?, ?, 'pending')`,
      [
        crypto.randomUUID(),
        merchantUserId,
        entitlement.id,
        JSON.stringify({ reason }),
      ]
    );
    await conn.commit();
    return success(res, { suspended: true }, '商户展示已暂停');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.post('/api/admin/billing/merchants/:id/resume', adminAuth, async (req, res) => {
  const merchantUserId = Number(req.params.id);
  if (!merchantUserId) return error(res, '商家不存在', 404);

  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写恢复原因');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'merchant'
         AND subject_id = ?
         AND status = 'active'
         AND expire_at > NOW()
       ORDER BY expire_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [merchantUserId]
    );
    const entitlement = rows[0];
    if (!entitlement) {
      await conn.rollback();
      return error(res, '没有可恢复的有效展示权益', 404);
    }
    await conn.query(
      `UPDATE billing_entitlements
       SET readonly_mode = 0,
           reason = NULL
       WHERE id = ?`,
      [entitlement.id]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES ('merchant', ?, 'admin', NULL, 'ADMIN_RESUME_MERCHANT_DISPLAY',
               'billing_entitlement', ?, ?, ?, ?)`,
      [
        merchantUserId,
        entitlement.id,
        JSON.stringify({
          readonly_mode: Boolean(entitlement.readonly_mode),
          reason: entitlement.reason || null,
        }),
        JSON.stringify({ readonly_mode: false, reason: null }),
        reason,
      ]
    );
    await conn.query(
      `INSERT INTO billing_events (
         event_id, event_type, event_version, subject_type, subject_id,
         aggregate_type, aggregate_id, payload_json, status
       )
       VALUES (?, 'MERCHANT_DISPLAY_RESUMED', 1, 'merchant', ?,
               'billing_entitlement', ?, ?, 'pending')`,
      [
        crypto.randomUUID(),
        merchantUserId,
        entitlement.id,
        JSON.stringify({ reason }),
      ]
    );
    await conn.commit();
    return success(res, { resumed: true }, '商户展示已恢复');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.post('/api/admin/billing/merchants/:id/close', adminAuth, async (req, res) => {
  const merchantUserId = Number(req.params.id);
  if (!merchantUserId) return error(res, '商家不存在', 404);

  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写关闭原因');
  const refundAmountCents = Math.round(Number(req.body?.refund_amount_cents || 0));
  if (!Number.isFinite(refundAmountCents) || refundAmountCents < 0) return error(res, '退款金额不正确');
  const voucherNote = String(req.body?.voucher_note || '').trim().slice(0, 300);
  if (!voucherNote) return error(res, '请填写退款或关闭凭证说明');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [entitlementRows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'merchant'
         AND subject_id = ?
         AND status = 'active'
         AND expire_at > NOW()
       ORDER BY expire_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [merchantUserId]
    );
    const entitlement = entitlementRows[0];
    if (!entitlement) {
      await conn.rollback();
      return error(res, '没有可关闭的有效展示权益', 404);
    }

    let subscription = null;
    if (entitlement.subscription_id) {
      const [subscriptionRows] = await conn.query(
        `SELECT *
         FROM billing_subscriptions
         WHERE id = ?
           AND subject_type = 'merchant'
           AND subject_id = ?
         LIMIT 1
         FOR UPDATE`,
        [entitlement.subscription_id, merchantUserId]
      );
      subscription = subscriptionRows[0] || null;
    }

    const sourceOrderId = subscription?.source_order_id || null;
    let payment = null;
    if (sourceOrderId) {
      const [paymentRows] = await conn.query(
        `SELECT *
         FROM billing_payments
         WHERE order_id = ?
           AND subject_type = 'merchant'
           AND subject_id = ?
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [sourceOrderId, merchantUserId]
      );
      payment = paymentRows[0] || null;
    }

    await conn.query(
      `UPDATE billing_entitlements
       SET status = 'inactive',
           readonly_mode = 1,
           reason = 'refund_closed'
       WHERE id = ?`,
      [entitlement.id]
    );
    if (subscription) {
      await conn.query(
        `UPDATE billing_subscriptions
         SET status = 'cancelled',
             cancelled_at = NOW(),
             readonly_mode = 1,
             reason = 'refund_closed'
         WHERE id = ?`,
        [subscription.id]
      );
    }
    if (sourceOrderId) {
      await conn.query(
        `UPDATE billing_orders
         SET status = 'refunded',
             closed_at = NOW()
         WHERE id = ?
           AND status = 'paid'`,
        [sourceOrderId]
      );
    }
    if (payment) {
      await conn.query(
        `UPDATE billing_payments
         SET status = 'refunded'
         WHERE id = ?`,
        [payment.id]
      );
    }

    const after = {
      entitlement_id: entitlement.id,
      subscription_id: subscription?.id || null,
      order_id: sourceOrderId,
      payment_id: payment?.id || null,
      refund_processing: {
        amount_cents: refundAmountCents,
        currency: payment?.currency || 'CNY',
        voucher_note: voucherNote,
      },
      entitlement: { status: 'inactive', readonly_mode: true, reason: 'refund_closed' },
      subscription: subscription ? { status: 'cancelled', readonly_mode: true, reason: 'refund_closed' } : null,
    };

    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES ('merchant', ?, 'admin', NULL, 'ADMIN_CLOSE_MERCHANT_DISPLAY',
               'billing_entitlement', ?, ?, ?, ?)`,
      [
        merchantUserId,
        entitlement.id,
        JSON.stringify({
          entitlement: {
            status: entitlement.status,
            readonly_mode: Boolean(entitlement.readonly_mode),
            reason: entitlement.reason || null,
          },
          subscription: subscription
            ? {
                id: subscription.id,
                status: subscription.status,
                readonly_mode: Boolean(subscription.readonly_mode),
                reason: subscription.reason || null,
              }
            : null,
          order_id: sourceOrderId,
          payment_id: payment?.id || null,
        }),
        JSON.stringify(after),
        reason,
      ]
    );
    await conn.query(
      `INSERT INTO billing_events (
         event_id, event_type, event_version, subject_type, subject_id,
         aggregate_type, aggregate_id, payload_json, status
       )
       VALUES (?, 'MERCHANT_DISPLAY_CLOSED', 1, 'merchant', ?,
               'billing_entitlement', ?, ?, 'pending')`,
      [
        crypto.randomUUID(),
        merchantUserId,
        entitlement.id,
        JSON.stringify(after),
      ]
    );
    if (refundAmountCents > 0) {
      await conn.query(
        `INSERT INTO billing_events (
           event_id, event_type, event_version, subject_type, subject_id,
           aggregate_type, aggregate_id, payload_json, status
         )
         VALUES (?, 'REFUND_MANUAL_PROCESSED', 1, 'merchant', ?,
                 'billing_order', ?, ?, 'pending')`,
        [
          crypto.randomUUID(),
          merchantUserId,
          sourceOrderId || entitlement.id,
          JSON.stringify(after),
        ]
      );
    }

    await conn.commit();
    return success(res, { closed: true, refund_amount_cents: refundAmountCents }, '商户展示权益已关闭');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.get('/api/admin/billing/companies', adminAuth, async (req, res) => {
  const params = [];
  let where = `c.status <> 'deleted'`;

  if (req.query.keyword) {
    where += ` AND (c.name LIKE ? OR c.contact_phone LIKE ? OR c.city LIKE ?)`;
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw, kw);
  }

  const verificationStatus = String(req.query.verification_status || '').trim();
  if (verificationStatus) {
    if (!['unverified', 'pending', 'verified', 'rejected'].includes(verificationStatus)) {
      return error(res, '认证状态不正确');
    }
    where += ` AND c.verification_status = ?`;
    params.push(verificationStatus);
  }

  const billingStatus = String(req.query.billing_status || '').trim();
  if (billingStatus) {
    if (!['visible', 'not_visible', 'expired'].includes(billingStatus)) {
      return error(res, 'Billing 状态不正确');
    }
    const visibleExists = `EXISTS (
      SELECT 1 FROM billing_entitlements be
      WHERE be.subject_type = 'company'
        AND be.subject_id = c.id
        AND be.status = 'active'
        AND be.readonly_mode = 0
        AND be.expire_at > NOW()
        AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.company_visible')) = 'true'
    )`;
    if (billingStatus === 'visible') {
      where += ` AND ${visibleExists}`;
    } else if (billingStatus === 'expired') {
      where += ` AND EXISTS (
        SELECT 1 FROM billing_entitlements be
        WHERE be.subject_type = 'company'
          AND be.subject_id = c.id
          AND be.expire_at <= NOW()
      )`;
    } else {
      where += ` AND NOT ${visibleExists}`;
    }
  }

  const pageNo = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (pageNo - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT c.id, c.name, c.city, c.contact_phone, c.status,
            c.verification_status, c.paid_display_status,
            c.paid_display_starts_at, c.paid_display_ends_at,
            (
              SELECT bo.status
              FROM billing_orders bo
              WHERE bo.subject_type = 'company' AND bo.subject_id = c.id
              ORDER BY bo.id DESC
              LIMIT 1
            ) AS latest_order_status,
            (
              SELECT bo.created_at
              FROM billing_orders bo
              WHERE bo.subject_type = 'company' AND bo.subject_id = c.id
              ORDER BY bo.id DESC
              LIMIT 1
            ) AS latest_order_at,
            (
              SELECT bs.status
              FROM billing_subscriptions bs
              WHERE bs.subject_type = 'company' AND bs.subject_id = c.id
              ORDER BY bs.id DESC
              LIMIT 1
            ) AS subscription_status,
            (
              SELECT bs.expire_at
              FROM billing_subscriptions bs
              WHERE bs.subject_type = 'company' AND bs.subject_id = c.id
              ORDER BY bs.id DESC
              LIMIT 1
            ) AS subscription_expire_at,
            EXISTS (
              SELECT 1 FROM billing_entitlements be
              WHERE be.subject_type = 'company'
                AND be.subject_id = c.id
                AND be.status = 'active'
                AND be.readonly_mode = 0
                AND be.expire_at > NOW()
                AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.company_visible')) = 'true'
            ) AS company_visible
     FROM companies c
     WHERE ${where}
     ORDER BY COALESCE(latest_order_at, c.updated_at, c.created_at) DESC, c.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM companies c
     WHERE ${where}`,
    params
  );

  return success(res, {
    companies: rows.map((row) => ({
      id: Number(row.id),
      name: row.name || '',
      city: row.city || '',
      contact_phone: row.contact_phone || '',
      status: row.status || '',
      verification_status: row.verification_status || 'unverified',
      paid_display_status: row.paid_display_status || 'none',
      paid_display_starts_at: row.paid_display_starts_at,
      paid_display_ends_at: row.paid_display_ends_at,
      company_visible: Boolean(row.company_visible),
      latest_order_status: row.latest_order_status || '',
      latest_order_at: row.latest_order_at,
      subscription_status: row.subscription_status || '',
      subscription_expire_at: row.subscription_expire_at,
    })),
    total: Number(countRow.total || 0),
    page: pageNo,
    pageSize,
  });
});

app.get('/api/admin/billing/companies/:id', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) return error(res, '装修公司不存在', 404);

  const [companyRows] = await db.query(
    `SELECT id, owner_user_id, name, city, contact_phone, status,
            verification_status, paid_display_status,
            paid_display_starts_at, paid_display_ends_at
     FROM companies
     WHERE id = ?
       AND status <> 'deleted'
     LIMIT 1`,
    [companyId]
  );
  const company = companyRows[0];
  if (!company) return error(res, '装修公司不存在', 404);

  const snapshot = await billingService.getCompanyBillingSnapshot(companyId);
  return success(res, {
    company: {
      id: Number(company.id),
      owner_user_id: company.owner_user_id ? Number(company.owner_user_id) : null,
      name: company.name || '',
      city: company.city || '',
      contact_phone: company.contact_phone || '',
      status: company.status || '',
      verification_status: company.verification_status || 'unverified',
      paid_display_status: company.paid_display_status || 'none',
      paid_display_starts_at: company.paid_display_starts_at,
      paid_display_ends_at: company.paid_display_ends_at,
    },
    billing: snapshot,
  });
});

app.post('/api/admin/billing/companies/:id/manual-activate', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) return error(res, '装修公司不存在', 404);

  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写手动开通原因');
  const amountCents = Math.round(Number(req.body?.amount_cents || 0));
  if (!Number.isFinite(amountCents) || amountCents < 0) return error(res, '补单金额不正确');
  const voucherNote = String(req.body?.voucher_note || '').trim().slice(0, 300);
  if (!voucherNote) return error(res, '请填写线下收款凭证说明');

  const idempotencyBase = `admin-manual-company-${companyId}-${Date.now()}`;
  try {
    const created = await billingService.createCompanyDisplayOrder({
      companyId,
      operatorUserId: 0,
      actorType: 'admin',
      paymentChannel: 'manual',
      idempotencyKey: `${idempotencyBase}-order`,
    });
    const activated = await billingService.payCompanyOrderManual({
      orderId: created.order.id,
      companyId,
      operatorUserId: 0,
      actorType: 'admin',
      idempotencyKey: `${idempotencyBase}-payment`,
    });
    await db.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, after_json, reason
       )
       VALUES ('company', ?, 'admin', NULL, 'ADMIN_MANUAL_ACTIVATE_COMPANY',
               'billing_order', ?, ?, ?)`,
      [
        companyId,
        created.order.id,
        JSON.stringify({
          order_id: created.order.id,
          subscription_id: activated.subscription?.id || null,
          entitlement_id: activated.entitlement?.id || null,
          manual_compensation: {
            amount_cents: amountCents,
            currency: 'CNY',
            voucher_note: voucherNote,
          },
        }),
        reason,
      ]
    );
    return success(res, activated, '装修公司展示已手动开通');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/companies/:id/suspend', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) return error(res, '装修公司不存在', 404);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写暂停原因');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'company'
         AND subject_id = ?
         AND status = 'active'
         AND expire_at > NOW()
       ORDER BY expire_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [companyId]
    );
    const entitlement = rows[0];
    if (!entitlement) {
      await conn.rollback();
      return error(res, '没有可暂停的有效展示权益', 404);
    }
    await conn.query(
      `UPDATE billing_entitlements
       SET readonly_mode = 1,
           reason = 'manual_suspend'
       WHERE id = ?`,
      [entitlement.id]
    );
    await conn.query(
      `UPDATE companies
       SET paid_display_status = 'suspended'
       WHERE id = ?`,
      [companyId]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES ('company', ?, 'admin', NULL, 'ADMIN_SUSPEND_COMPANY_DISPLAY',
               'billing_entitlement', ?, ?, ?, ?)`,
      [
        companyId,
        entitlement.id,
        JSON.stringify({ readonly_mode: Boolean(entitlement.readonly_mode), reason: entitlement.reason || null }),
        JSON.stringify({ readonly_mode: true, reason: 'manual_suspend' }),
        reason,
      ]
    );
    await conn.query(
      `INSERT INTO billing_events (
         event_id, event_type, event_version, subject_type, subject_id,
         aggregate_type, aggregate_id, payload_json, status
       )
       VALUES (?, 'COMPANY_DISPLAY_SUSPENDED', 1, 'company', ?,
               'billing_entitlement', ?, ?, 'pending')`,
      [
        crypto.randomUUID(),
        companyId,
        entitlement.id,
        JSON.stringify({ reason }),
      ]
    );
    await conn.commit();
    return success(res, { suspended: true }, '装修公司展示已暂停');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.post('/api/admin/billing/companies/:id/resume', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) return error(res, '装修公司不存在', 404);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写恢复原因');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'company'
         AND subject_id = ?
         AND status = 'active'
         AND expire_at > NOW()
       ORDER BY expire_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [companyId]
    );
    const entitlement = rows[0];
    if (!entitlement) {
      await conn.rollback();
      return error(res, '没有可恢复的有效展示权益', 404);
    }
    const [companyRows] = await conn.query(
      `SELECT verification_status, status
       FROM companies
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [companyId]
    );
    const company = companyRows[0];
    if (!company || company.status === 'deleted') {
      await conn.rollback();
      return error(res, '装修公司不存在', 404);
    }
    if (company.verification_status !== 'verified') {
      await conn.rollback();
      return error(res, '装修公司必须认证通过后才能恢复展示', 409);
    }
    await conn.query(
      `UPDATE billing_entitlements
       SET readonly_mode = 0,
           reason = NULL
       WHERE id = ?`,
      [entitlement.id]
    );
    await conn.query(
      `UPDATE companies
       SET paid_display_status = 'active'
       WHERE id = ?`,
      [companyId]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES ('company', ?, 'admin', NULL, 'ADMIN_RESUME_COMPANY_DISPLAY',
               'billing_entitlement', ?, ?, ?, ?)`,
      [
        companyId,
        entitlement.id,
        JSON.stringify({ readonly_mode: Boolean(entitlement.readonly_mode), reason: entitlement.reason || null }),
        JSON.stringify({ readonly_mode: false, reason: null }),
        reason,
      ]
    );
    await conn.query(
      `INSERT INTO billing_events (
         event_id, event_type, event_version, subject_type, subject_id,
         aggregate_type, aggregate_id, payload_json, status
       )
       VALUES (?, 'COMPANY_DISPLAY_RESUMED', 1, 'company', ?,
               'billing_entitlement', ?, ?, 'pending')`,
      [
        crypto.randomUUID(),
        companyId,
        entitlement.id,
        JSON.stringify({ reason }),
      ]
    );
    await conn.commit();
    return success(res, { resumed: true }, '装修公司展示已恢复');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.post('/api/admin/billing/companies/:id/close', adminAuth, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) return error(res, '装修公司不存在', 404);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写关闭原因');
  const refundAmountCents = Math.round(Number(req.body?.refund_amount_cents || 0));
  if (!Number.isFinite(refundAmountCents) || refundAmountCents < 0) return error(res, '退款金额不正确');
  const voucherNote = String(req.body?.voucher_note || '').trim().slice(0, 300);
  if (!voucherNote) return error(res, '请填写退款或关闭凭证说明');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [entitlementRows] = await conn.query(
      `SELECT *
       FROM billing_entitlements
       WHERE subject_type = 'company'
         AND subject_id = ?
         AND status = 'active'
         AND expire_at > NOW()
       ORDER BY expire_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [companyId]
    );
    const entitlement = entitlementRows[0];
    if (!entitlement) {
      await conn.rollback();
      return error(res, '没有可关闭的有效展示权益', 404);
    }

    let subscription = null;
    if (entitlement.subscription_id) {
      const [subscriptionRows] = await conn.query(
        `SELECT *
         FROM billing_subscriptions
         WHERE id = ?
           AND subject_type = 'company'
           AND subject_id = ?
         LIMIT 1
         FOR UPDATE`,
        [entitlement.subscription_id, companyId]
      );
      subscription = subscriptionRows[0] || null;
    }

    const sourceOrderId = subscription?.source_order_id || null;
    let payment = null;
    if (sourceOrderId) {
      const [paymentRows] = await conn.query(
        `SELECT *
         FROM billing_payments
         WHERE order_id = ?
           AND subject_type = 'company'
           AND subject_id = ?
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [sourceOrderId, companyId]
      );
      payment = paymentRows[0] || null;
    }

    await conn.query(
      `UPDATE billing_entitlements
       SET status = 'inactive',
           readonly_mode = 1,
           reason = 'refund_closed'
      WHERE id = ?`,
      [entitlement.id]
    );
    if (subscription) {
      await conn.query(
        `UPDATE billing_subscriptions
         SET status = 'cancelled',
             cancelled_at = NOW(),
             readonly_mode = 1,
             reason = 'refund_closed'
         WHERE id = ?`,
        [subscription.id]
      );
    }
    if (sourceOrderId) {
      await conn.query(
        `UPDATE billing_orders
         SET status = 'refunded',
             closed_at = NOW()
         WHERE id = ?
           AND status = 'paid'`,
        [sourceOrderId]
      );
    }
    if (payment) {
      await conn.query(
        `UPDATE billing_payments
         SET status = 'refunded'
         WHERE id = ?`,
        [payment.id]
      );
    }

    await conn.query(
      `UPDATE companies
       SET paid_display_status = 'none',
           paid_display_ends_at = NOW()
       WHERE id = ?`,
      [companyId]
    );

    const after = {
      entitlement_id: entitlement.id,
      subscription_id: subscription?.id || null,
      order_id: sourceOrderId,
      payment_id: payment?.id || null,
      refund_processing: {
        amount_cents: refundAmountCents,
        currency: payment?.currency || 'CNY',
        voucher_note: voucherNote,
      },
      entitlement: { status: 'inactive', readonly_mode: true, reason: 'refund_closed' },
      subscription: subscription ? { status: 'cancelled', readonly_mode: true, reason: 'refund_closed' } : null,
      company: { paid_display_status: 'none' },
    };

    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES ('company', ?, 'admin', NULL, 'ADMIN_CLOSE_COMPANY_DISPLAY',
               'billing_entitlement', ?, ?, ?, ?)`,
      [
        companyId,
        entitlement.id,
        JSON.stringify({
          entitlement: {
            status: entitlement.status,
            readonly_mode: Boolean(entitlement.readonly_mode),
            reason: entitlement.reason || null,
          },
          subscription: subscription
            ? {
                id: subscription.id,
                status: subscription.status,
                readonly_mode: Boolean(subscription.readonly_mode),
                reason: subscription.reason || null,
              }
            : null,
          order_id: sourceOrderId,
          payment_id: payment?.id || null,
        }),
        JSON.stringify(after),
        reason,
      ]
    );
    await conn.query(
      `INSERT INTO billing_events (
         event_id, event_type, event_version, subject_type, subject_id,
         aggregate_type, aggregate_id, payload_json, status
       )
       VALUES (?, 'COMPANY_DISPLAY_CLOSED', 1, 'company', ?,
               'billing_entitlement', ?, ?, 'pending')`,
      [
        crypto.randomUUID(),
        companyId,
        entitlement.id,
        JSON.stringify(after),
      ]
    );
    if (refundAmountCents > 0) {
      await conn.query(
        `INSERT INTO billing_events (
           event_id, event_type, event_version, subject_type, subject_id,
           aggregate_type, aggregate_id, payload_json, status
         )
         VALUES (?, 'REFUND_MANUAL_PROCESSED', 1, 'company', ?,
                 'billing_order', ?, ?, 'pending')`,
        [
          crypto.randomUUID(),
          companyId,
          sourceOrderId || entitlement.id,
          JSON.stringify(after),
        ]
      );
    }

    await conn.commit();
    return success(res, { closed: true, refund_amount_cents: refundAmountCents }, '装修公司展示权益已关闭');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.get('/api/admin/billing/company-appeals', adminAuth, async (req, res) => {
  try {
    const result = await billingService.listCompanyDisplayAppeals({
      status: req.query.status,
      keyword: req.query.keyword,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return success(res, result);
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/company-appeals/:id/approve', adminAuth, async (req, res) => {
  const appealId = Number(req.params.id);
  if (!appealId) return error(res, '申诉不存在', 404);
  try {
    const result = await billingService.approveCompanyDisplayAppeal({
      appealId,
      adminId: req.admin?.id || null,
      reason: req.body?.reason,
    });
    return success(res, result, '申诉已通过，装修公司展示已恢复');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.post('/api/admin/billing/company-appeals/:id/reject', adminAuth, async (req, res) => {
  const appealId = Number(req.params.id);
  if (!appealId) return error(res, '申诉不存在', 404);
  try {
    const result = await billingService.rejectCompanyDisplayAppeal({
      appealId,
      adminId: req.admin?.id || null,
      reason: req.body?.reason,
    });
    return success(res, result, '申诉已驳回');
  } catch (err) {
    if (err instanceof billingService.BillingError) {
      return error(res, err.message, err.statusCode || 400);
    }
    throw err;
  }
});

app.get('/api/admin/billing/company-summary', adminAuth, async (req, res) => {
  const range = String(req.query.range || 'today').trim();
  const today = new Date();
  const yyyyMmDd = (date) => date.toISOString().slice(0, 10);
  let dateFrom = String(req.query.date_from || '').trim().slice(0, 10);
  let dateTo = String(req.query.date_to || '').trim().slice(0, 10);
  if (!dateFrom || !dateTo) {
    if (range === 'yesterday') {
      const day = new Date(today);
      day.setDate(day.getDate() - 1);
      dateFrom = yyyyMmDd(day);
      dateTo = yyyyMmDd(day);
    } else if (range === 'last7') {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      dateFrom = yyyyMmDd(start);
      dateTo = yyyyMmDd(today);
    } else {
      dateFrom = yyyyMmDd(today);
      dateTo = yyyyMmDd(today);
    }
  }
  const startAt = `${dateFrom} 00:00:00`;
  const endAt = `${dateTo} 23:59:59`;

  const [[orderRow]] = await db.query(
    `SELECT COUNT(*) AS total_orders,
            SUM(status = 'pending_payment') AS pending_orders,
            SUM(status = 'paid') AS paid_orders,
            SUM(status = 'refunded') AS refunded_orders,
            SUM(status = 'closed') AS closed_orders,
            COALESCE(SUM(amount_cents), 0) AS order_amount_cents
     FROM billing_orders
     WHERE subject_type = 'company'
       AND created_at BETWEEN ? AND ?`,
    [startAt, endAt]
  );
  const [[paymentRow]] = await db.query(
    `SELECT COUNT(*) AS successful_payments,
            COALESCE(SUM(amount_cents), 0) AS successful_payment_amount_cents
     FROM billing_payments
     WHERE subject_type = 'company'
       AND status = 'succeeded'
       AND paid_at BETWEEN ? AND ?`,
    [startAt, endAt]
  );
  const [[refundRow]] = await db.query(
    `SELECT COUNT(*) AS refunded_payments,
            COALESCE(SUM(amount_cents), 0) AS refunded_payment_amount_cents
     FROM billing_payments
     WHERE subject_type = 'company'
       AND status = 'refunded'
       AND updated_at BETWEEN ? AND ?`,
    [startAt, endAt]
  );
  const [[activeRow]] = await db.query(
    `SELECT
       (SELECT COUNT(*)
        FROM billing_subscriptions
        WHERE subject_type = 'company'
          AND status = 'active'
          AND expire_at > NOW()) AS active_subscriptions,
       (SELECT COUNT(*)
        FROM billing_entitlements
        WHERE subject_type = 'company'
          AND status = 'active'
          AND readonly_mode = 0
          AND expire_at > NOW()
          AND JSON_UNQUOTE(JSON_EXTRACT(feature_json, '$.company_visible')) = 'true') AS visible_companies`
  );
  const [[exceptionRow]] = await db.query(
    `SELECT
       (SELECT COUNT(*)
        FROM billing_payments bp
        JOIN billing_orders bo ON bo.id = bp.order_id
        WHERE bp.subject_type = 'company'
          AND bp.status = 'succeeded'
          AND bo.status = 'paid'
          AND NOT EXISTS (
            SELECT 1
            FROM billing_entitlements be
            WHERE be.subject_type = 'company'
              AND be.subject_id = bp.subject_id
              AND be.status = 'active'
              AND be.expire_at > NOW()
          )) AS payment_not_activated,
       (SELECT COUNT(*)
        FROM billing_events
        WHERE subject_type = 'company'
          AND status IN ('failed', 'dead_letter')) AS event_failures`
  );

  return success(res, {
    range: { date_from: dateFrom, date_to: dateTo },
    orders: {
      total: Number(orderRow.total_orders || 0),
      pending_payment: Number(orderRow.pending_orders || 0),
      paid: Number(orderRow.paid_orders || 0),
      refunded: Number(orderRow.refunded_orders || 0),
      closed: Number(orderRow.closed_orders || 0),
      amount_cents: Number(orderRow.order_amount_cents || 0),
    },
    payments: {
      successful_count: Number(paymentRow.successful_payments || 0),
      successful_amount_cents: Number(paymentRow.successful_payment_amount_cents || 0),
    },
    refunds: {
      count: Number(refundRow.refunded_payments || 0),
      amount_cents: Number(refundRow.refunded_payment_amount_cents || 0),
    },
    active: {
      subscriptions: Number(activeRow.active_subscriptions || 0),
      visible_companies: Number(activeRow.visible_companies || 0),
    },
    exceptions: {
      payment_not_activated: Number(exceptionRow.payment_not_activated || 0),
      event_failures: Number(exceptionRow.event_failures || 0),
    },
  });
});

app.get('/api/admin/billing/company-orders', adminAuth, async (req, res) => {
  const filter = buildCompanyBillingOrderWhere(req.query);
  if (filter.error) return error(res, filter.error);
  const { where, params } = filter;

  const pageNo = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (pageNo - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT bo.id, bo.order_no, bo.subject_id, bo.status, bo.amount_cents,
            bo.currency, bo.payment_channel, bo.paid_at, bo.closed_at, bo.created_at,
            c.name, c.city, c.contact_phone, c.owner_user_id,
            bp.id AS payment_id, bp.payment_no, bp.status AS payment_status,
            bs.id AS subscription_id, bs.status AS subscription_status, bs.expire_at
     FROM billing_orders bo
     LEFT JOIN companies c ON c.id = bo.subject_id
     LEFT JOIN billing_payments bp ON bp.id = (
       SELECT bp2.id
       FROM billing_payments bp2
       WHERE bp2.order_id = bo.id
       ORDER BY bp2.id DESC
       LIMIT 1
     )
     LEFT JOIN billing_subscriptions bs ON bs.id = (
       SELECT bs2.id
       FROM billing_subscriptions bs2
       WHERE bs2.source_order_id = bo.id
       ORDER BY bs2.id DESC
       LIMIT 1
     )
     WHERE ${where}
     ORDER BY bo.created_at DESC, bo.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM billing_orders bo
     LEFT JOIN companies c ON c.id = bo.subject_id
     WHERE ${where}`,
    params
  );

  return success(res, {
    orders: rows.map((row) => ({
      id: Number(row.id),
      order_no: row.order_no || '',
      company_id: Number(row.subject_id),
      company_name: row.name || '',
      city: row.city || '',
      contact_phone: row.contact_phone || '',
      owner_user_id: row.owner_user_id ? Number(row.owner_user_id) : null,
      status: row.status || '',
      amount_cents: Number(row.amount_cents || 0),
      currency: row.currency || 'CNY',
      payment_channel: row.payment_channel || '',
      paid_at: row.paid_at,
      closed_at: row.closed_at,
      created_at: row.created_at,
      payment_id: row.payment_id ? Number(row.payment_id) : null,
      payment_no: row.payment_no || '',
      payment_status: row.payment_status || '',
      subscription_id: row.subscription_id ? Number(row.subscription_id) : null,
      subscription_status: row.subscription_status || '',
      subscription_expire_at: row.expire_at,
    })),
    total: Number(countRow.total || 0),
    page: pageNo,
    pageSize,
  });
});

app.get('/api/admin/billing/company-orders/export', adminAuth, async (req, res) => {
  const filter = buildCompanyBillingOrderWhere(req.query);
  if (filter.error) return error(res, filter.error);
  const { where, params } = filter;

  const [rows] = await db.query(
    `SELECT bo.id, bo.order_no, bo.subject_id, bo.status, bo.amount_cents,
            bo.currency, bo.payment_channel, bo.paid_at, bo.closed_at, bo.created_at,
            c.name, c.city, c.contact_phone,
            bp.payment_no, bp.status AS payment_status,
            bs.status AS subscription_status, bs.expire_at
     FROM billing_orders bo
     LEFT JOIN companies c ON c.id = bo.subject_id
     LEFT JOIN billing_payments bp ON bp.id = (
       SELECT bp2.id
       FROM billing_payments bp2
       WHERE bp2.order_id = bo.id
       ORDER BY bp2.id DESC
       LIMIT 1
     )
     LEFT JOIN billing_subscriptions bs ON bs.id = (
       SELECT bs2.id
       FROM billing_subscriptions bs2
       WHERE bs2.source_order_id = bo.id
       ORDER BY bs2.id DESC
       LIMIT 1
     )
     WHERE ${where}
     ORDER BY bo.created_at DESC, bo.id DESC
     LIMIT 5000`,
    params
  );

  const headers = [
    '订单号',
    '装修公司ID',
    '装修公司名称',
    '城市',
    '联系电话',
    '订单状态',
    '订单金额',
    '支付渠道',
    '支付号',
    '支付状态',
    '订阅状态',
    '订阅到期时间',
    '创建时间',
    '支付时间',
    '关闭/退款时间',
  ];
  const lines = [
    csvLine(headers),
    ...rows.map((row) => csvLine([
      row.order_no || '',
      row.subject_id || '',
      row.name || '',
      row.city || '',
      row.contact_phone || '',
      row.status || '',
      (Number(row.amount_cents || 0) / 100).toFixed(2),
      row.payment_channel || '',
      row.payment_no || '',
      row.payment_status || '',
      row.subscription_status || '',
      adminDateTimeText(row.expire_at),
      adminDateTimeText(row.created_at),
      adminDateTimeText(row.paid_at),
      adminDateTimeText(row.closed_at),
    ])),
  ];
  const filename = `company-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(`\uFEFF${lines.join('\n')}`);
});

app.get('/api/admin/billing/company-orders/:id', adminAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!orderId) return error(res, '订单不存在', 404);

  const [orderRows] = await db.query(
    `SELECT bo.*, c.name, c.city, c.contact_phone, c.owner_user_id
     FROM billing_orders bo
     LEFT JOIN companies c ON bo.subject_type = 'company' AND c.id = bo.subject_id
     WHERE bo.id = ?
       AND bo.subject_type = 'company'
     LIMIT 1`,
    [orderId]
  );
  const order = orderRows[0];
  if (!order) return error(res, '订单不存在', 404);

  const [payments] = await db.query(
    `SELECT id, payment_no, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_payments
     WHERE order_id = ?
     ORDER BY id DESC`,
    [orderId]
  );
  const [subscriptions] = await db.query(
    `SELECT id, subscription_no, status, is_primary, started_at, expire_at, readonly_mode, reason, created_at
     FROM billing_subscriptions
     WHERE source_order_id = ?
     ORDER BY id DESC`,
    [orderId]
  );
  const subscriptionIds = subscriptions.map((item) => Number(item.id)).filter(Boolean);
  let entitlements = [];
  if (subscriptionIds.length) {
    const [rows] = await db.query(
      `SELECT id, subscription_id, status, source_type, source_id, readonly_mode, reason, expire_at, calculated_at
       FROM billing_entitlements
       WHERE subscription_id IN (?)
       ORDER BY id DESC`,
      [subscriptionIds]
    );
    entitlements = rows;
  }
  const [audits] = await db.query(
    `SELECT id, action, target_type, target_id, reason, after_json, created_at
     FROM billing_audit_logs
     WHERE (target_type = 'billing_order' AND target_id = ?)
        OR (subject_type = ? AND subject_id = ?)
     ORDER BY id DESC
     LIMIT 20`,
    [orderId, order.subject_type, order.subject_id]
  );
  const [events] = await db.query(
    `SELECT id, event_id, event_type, event_version, aggregate_type, aggregate_id,
            status, retry_count, created_at, updated_at
     FROM billing_events
     WHERE (aggregate_type = 'billing_order' AND aggregate_id = ?)
        OR (subject_type = ? AND subject_id = ?)
     ORDER BY id DESC
     LIMIT 20`,
    [orderId, order.subject_type, order.subject_id]
  );

  return success(res, {
    order: {
      id: Number(order.id),
      order_no: order.order_no || '',
      subject_type: order.subject_type || '',
      subject_id: Number(order.subject_id),
      company_name: order.name || '',
      city: order.city || '',
      contact_phone: order.contact_phone || '',
      owner_user_id: order.owner_user_id ? Number(order.owner_user_id) : null,
      status: order.status || '',
      amount_cents: Number(order.amount_cents || 0),
      currency: order.currency || 'CNY',
      payment_channel: order.payment_channel || '',
      paid_at: order.paid_at,
      created_at: order.created_at,
      updated_at: order.updated_at,
    },
    payments,
    subscriptions,
    entitlements,
    audits,
    events,
  });
});

app.get('/api/admin/billing/company-exceptions', adminAuth, async (req, res) => {
  const [paymentRows] = await db.query(
    `SELECT bp.id AS payment_id, bp.payment_no, bp.order_id, bp.subject_id AS company_id,
            bp.amount_cents, bp.currency, bp.paid_at, bp.created_at,
            bo.order_no, bo.status AS order_status,
            be_current.id AS entitlement_id, be_current.status AS entitlement_status,
            be_current.readonly_mode AS entitlement_readonly_mode,
            be_current.expire_at AS entitlement_expire_at,
            c.name, c.city, c.contact_phone
     FROM billing_payments bp
     LEFT JOIN billing_orders bo ON bo.id = bp.order_id
     JOIN companies c ON c.id = bp.subject_id
     LEFT JOIN billing_entitlements be_current ON be_current.id = (
       SELECT be2.id
       FROM billing_entitlements be2
       WHERE be2.subject_type = 'company'
         AND be2.subject_id = bp.subject_id
       ORDER BY be2.id DESC
       LIMIT 1
     )
     WHERE bp.subject_type = 'company'
       AND bp.status = 'succeeded'
       AND NOT EXISTS (
         SELECT 1 FROM billing_entitlements be
         WHERE be.subject_type = 'company'
           AND be.subject_id = bp.subject_id
           AND be.status = 'active'
           AND be.readonly_mode = 0
           AND be.expire_at > NOW()
           AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.company_visible')) = 'true'
       )
     ORDER BY bp.paid_at DESC, bp.id DESC
     LIMIT 50`
  );
  const [eventRows] = await db.query(
    `SELECT be.id, be.event_id, be.event_type, be.event_version,
            be.subject_type, be.subject_id, be.aggregate_type, be.aggregate_id,
            be.status, be.retry_count, be.created_at, be.updated_at,
            c.name, c.city, c.contact_phone
     FROM billing_events be
     LEFT JOIN companies c ON be.subject_type = 'company' AND c.id = be.subject_id
     WHERE be.subject_type = 'company'
       AND be.status IN ('failed', 'dead_letter')
     ORDER BY be.updated_at DESC, be.id DESC
     LIMIT 50`
  );

  return success(res, {
    payment_not_activated: paymentRows.map((row) => ({
      payment_id: Number(row.payment_id),
      payment_no: row.payment_no || '',
      order_id: row.order_id ? Number(row.order_id) : null,
      order_no: row.order_no || '',
      order_status: row.order_status || '',
      company_id: Number(row.company_id),
      company_name: row.name || '',
      city: row.city || '',
      contact_phone: row.contact_phone || '',
      amount_cents: Number(row.amount_cents || 0),
      currency: row.currency || 'CNY',
      paid_at: row.paid_at,
      created_at: row.created_at,
      entitlement_id: row.entitlement_id ? Number(row.entitlement_id) : null,
      entitlement_status: row.entitlement_status || '',
      entitlement_readonly_mode: Boolean(row.entitlement_readonly_mode),
      entitlement_expire_at: row.entitlement_expire_at,
    })),
    event_failures: eventRows.map((row) => ({
      id: Number(row.id),
      event_id: row.event_id || '',
      event_type: row.event_type || '',
      event_version: Number(row.event_version || 1),
      subject_type: row.subject_type || '',
      subject_id: row.subject_id ? Number(row.subject_id) : null,
      company_name: row.name || '',
      city: row.city || '',
      contact_phone: row.contact_phone || '',
      aggregate_type: row.aggregate_type || '',
      aggregate_id: row.aggregate_id ? Number(row.aggregate_id) : null,
      status: row.status || '',
      retry_count: Number(row.retry_count || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  });
});

app.get('/api/admin/billing/summary', adminAuth, async (req, res) => {
  const range = String(req.query.range || 'today').trim();
  const today = new Date();
  const yyyyMmDd = (date) => date.toISOString().slice(0, 10);
  let dateFrom = String(req.query.date_from || '').trim().slice(0, 10);
  let dateTo = String(req.query.date_to || '').trim().slice(0, 10);
  if (!dateFrom || !dateTo) {
    if (range === 'yesterday') {
      const day = new Date(today);
      day.setDate(day.getDate() - 1);
      dateFrom = yyyyMmDd(day);
      dateTo = yyyyMmDd(day);
    } else if (range === 'last7') {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      dateFrom = yyyyMmDd(start);
      dateTo = yyyyMmDd(today);
    } else {
      dateFrom = yyyyMmDd(today);
      dateTo = yyyyMmDd(today);
    }
  }
  const startAt = `${dateFrom} 00:00:00`;
  const endAt = `${dateTo} 23:59:59`;

  const [[orderRow]] = await db.query(
    `SELECT COUNT(*) AS total_orders,
            SUM(status = 'pending_payment') AS pending_orders,
            SUM(status = 'paid') AS paid_orders,
            SUM(status = 'refunded') AS refunded_orders,
            SUM(status = 'closed') AS closed_orders,
            COALESCE(SUM(amount_cents), 0) AS order_amount_cents
     FROM billing_orders
     WHERE subject_type = 'merchant'
       AND created_at BETWEEN ? AND ?`,
    [startAt, endAt]
  );
  const [[paymentRow]] = await db.query(
    `SELECT COUNT(*) AS successful_payments,
            COALESCE(SUM(amount_cents), 0) AS successful_payment_amount_cents
     FROM billing_payments
     WHERE subject_type = 'merchant'
       AND status = 'succeeded'
       AND paid_at BETWEEN ? AND ?`,
    [startAt, endAt]
  );
  const [[refundRow]] = await db.query(
    `SELECT COUNT(*) AS refunded_payments,
            COALESCE(SUM(amount_cents), 0) AS refunded_payment_amount_cents
     FROM billing_payments
     WHERE subject_type = 'merchant'
       AND status = 'refunded'
       AND updated_at BETWEEN ? AND ?`,
    [startAt, endAt]
  );
  const [[activeRow]] = await db.query(
    `SELECT
       (SELECT COUNT(*)
        FROM billing_subscriptions
        WHERE subject_type = 'merchant'
          AND status = 'active'
          AND expire_at > NOW()) AS active_subscriptions,
       (SELECT COUNT(*)
        FROM billing_entitlements
        WHERE subject_type = 'merchant'
          AND status = 'active'
          AND readonly_mode = 0
          AND expire_at > NOW()
          AND JSON_UNQUOTE(JSON_EXTRACT(feature_json, '$.shop_visible')) = 'true') AS visible_merchants`
  );
  const [[exceptionRow]] = await db.query(
    `SELECT
       (SELECT COUNT(*)
        FROM billing_payments bp
        JOIN billing_orders bo ON bo.id = bp.order_id
        WHERE bp.subject_type = 'merchant'
          AND bp.status = 'succeeded'
          AND bo.status = 'paid'
          AND NOT EXISTS (
            SELECT 1
            FROM billing_entitlements be
            WHERE be.subject_type = 'merchant'
              AND be.subject_id = bp.subject_id
              AND be.status = 'active'
              AND be.expire_at > NOW()
          )) AS payment_not_activated,
       (SELECT COUNT(*)
        FROM billing_events
        WHERE status IN ('failed', 'dead_letter')) AS event_failures`
  );

  return success(res, {
    range: { date_from: dateFrom, date_to: dateTo },
    orders: {
      total: Number(orderRow.total_orders || 0),
      pending_payment: Number(orderRow.pending_orders || 0),
      paid: Number(orderRow.paid_orders || 0),
      refunded: Number(orderRow.refunded_orders || 0),
      closed: Number(orderRow.closed_orders || 0),
      amount_cents: Number(orderRow.order_amount_cents || 0),
    },
    payments: {
      successful_count: Number(paymentRow.successful_payments || 0),
      successful_amount_cents: Number(paymentRow.successful_payment_amount_cents || 0),
    },
    refunds: {
      count: Number(refundRow.refunded_payments || 0),
      amount_cents: Number(refundRow.refunded_payment_amount_cents || 0),
    },
    active: {
      subscriptions: Number(activeRow.active_subscriptions || 0),
      visible_merchants: Number(activeRow.visible_merchants || 0),
    },
    exceptions: {
      payment_not_activated: Number(exceptionRow.payment_not_activated || 0),
      event_failures: Number(exceptionRow.event_failures || 0),
    },
  });
});

app.get('/api/admin/billing/orders', adminAuth, async (req, res) => {
  const filter = buildBillingOrderWhere(req.query);
  if (filter.error) return error(res, filter.error);
  const { where, params } = filter;

  const pageNo = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (pageNo - 1) * pageSize;

  const [rows] = await db.query(
    `SELECT bo.id, bo.order_no, bo.subject_id, bo.status, bo.amount_cents,
            bo.currency, bo.payment_channel, bo.paid_at, bo.closed_at, bo.created_at,
            u.phone, u.nickname, mp.shop_name,
            bp.id AS payment_id, bp.payment_no, bp.status AS payment_status,
            bs.id AS subscription_id, bs.status AS subscription_status, bs.expire_at
     FROM billing_orders bo
     LEFT JOIN users u ON u.id = bo.subject_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = bo.subject_id
     LEFT JOIN billing_payments bp ON bp.id = (
       SELECT bp2.id
       FROM billing_payments bp2
       WHERE bp2.order_id = bo.id
       ORDER BY bp2.id DESC
       LIMIT 1
     )
     LEFT JOIN billing_subscriptions bs ON bs.id = (
       SELECT bs2.id
       FROM billing_subscriptions bs2
       WHERE bs2.source_order_id = bo.id
       ORDER BY bs2.id DESC
       LIMIT 1
     )
     WHERE ${where}
     ORDER BY bo.created_at DESC, bo.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM billing_orders bo
     LEFT JOIN users u ON u.id = bo.subject_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = bo.subject_id
     WHERE ${where}`,
    params
  );

  return success(res, {
    orders: rows.map((row) => ({
      id: Number(row.id),
      order_no: row.order_no || '',
      merchant_user_id: Number(row.subject_id),
      merchant_name: row.shop_name || row.nickname || '',
      phone: row.phone || '',
      status: row.status || '',
      amount_cents: Number(row.amount_cents || 0),
      currency: row.currency || 'CNY',
      payment_channel: row.payment_channel || '',
      paid_at: row.paid_at,
      closed_at: row.closed_at,
      created_at: row.created_at,
      payment_id: row.payment_id ? Number(row.payment_id) : null,
      payment_no: row.payment_no || '',
      payment_status: row.payment_status || '',
      subscription_id: row.subscription_id ? Number(row.subscription_id) : null,
      subscription_status: row.subscription_status || '',
      subscription_expire_at: row.expire_at,
    })),
    total: Number(countRow.total || 0),
    page: pageNo,
    pageSize,
  });
});

app.get('/api/admin/billing/orders/export', adminAuth, async (req, res) => {
  const filter = buildBillingOrderWhere(req.query);
  if (filter.error) return error(res, filter.error);
  const { where, params } = filter;

  const [rows] = await db.query(
    `SELECT bo.id, bo.order_no, bo.subject_id, bo.status, bo.amount_cents,
            bo.currency, bo.payment_channel, bo.paid_at, bo.closed_at, bo.created_at,
            u.phone, u.nickname, mp.shop_name,
            bp.payment_no, bp.status AS payment_status,
            bs.status AS subscription_status, bs.expire_at
     FROM billing_orders bo
     LEFT JOIN users u ON u.id = bo.subject_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = bo.subject_id
     LEFT JOIN billing_payments bp ON bp.id = (
       SELECT bp2.id
       FROM billing_payments bp2
       WHERE bp2.order_id = bo.id
       ORDER BY bp2.id DESC
       LIMIT 1
     )
     LEFT JOIN billing_subscriptions bs ON bs.id = (
       SELECT bs2.id
       FROM billing_subscriptions bs2
       WHERE bs2.source_order_id = bo.id
       ORDER BY bs2.id DESC
       LIMIT 1
     )
     WHERE ${where}
     ORDER BY bo.created_at DESC, bo.id DESC
     LIMIT 5000`,
    params
  );

  const headers = [
    '订单号',
    '商户ID',
    '商户名称',
    '手机号',
    '订单状态',
    '订单金额',
    '支付渠道',
    '支付号',
    '支付状态',
    '订阅状态',
    '订阅到期时间',
    '创建时间',
    '支付时间',
    '关闭/退款时间',
  ];
  const lines = [
    csvLine(headers),
    ...rows.map((row) => csvLine([
      row.order_no || '',
      row.subject_id || '',
      row.shop_name || row.nickname || '',
      row.phone || '',
      row.status || '',
      (Number(row.amount_cents || 0) / 100).toFixed(2),
      row.payment_channel || '',
      row.payment_no || '',
      row.payment_status || '',
      row.subscription_status || '',
      adminDateTimeText(row.expire_at),
      adminDateTimeText(row.created_at),
      adminDateTimeText(row.paid_at),
      adminDateTimeText(row.closed_at),
    ])),
  ];
  const filename = `merchant-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(`\uFEFF${lines.join('\n')}`);
});

app.get('/api/admin/billing/orders/:id', adminAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!orderId) return error(res, '订单不存在', 404);

  const [orderRows] = await db.query(
    `SELECT bo.*, u.phone, u.nickname, mp.shop_name
     FROM billing_orders bo
     LEFT JOIN users u ON bo.subject_type = 'merchant' AND u.id = bo.subject_id
     LEFT JOIN merchant_profiles mp ON bo.subject_type = 'merchant' AND mp.user_id = bo.subject_id
     WHERE bo.id = ?
     LIMIT 1`,
    [orderId]
  );
  const order = orderRows[0];
  if (!order) return error(res, '订单不存在', 404);

  const [payments] = await db.query(
    `SELECT id, payment_no, status, amount_cents, currency, payment_channel, paid_at, created_at
     FROM billing_payments
     WHERE order_id = ?
     ORDER BY id DESC`,
    [orderId]
  );
  const [subscriptions] = await db.query(
    `SELECT id, subscription_no, status, is_primary, started_at, expire_at, readonly_mode, reason, created_at
     FROM billing_subscriptions
     WHERE source_order_id = ?
     ORDER BY id DESC`,
    [orderId]
  );
  const subscriptionIds = subscriptions.map((item) => Number(item.id)).filter(Boolean);
  let entitlements = [];
  if (subscriptionIds.length) {
    const [rows] = await db.query(
      `SELECT id, subscription_id, status, source_type, source_id, readonly_mode, reason, expire_at, calculated_at
       FROM billing_entitlements
       WHERE subscription_id IN (?)
       ORDER BY id DESC`,
      [subscriptionIds]
    );
    entitlements = rows;
  }
  const [audits] = await db.query(
    `SELECT id, action, target_type, target_id, reason, after_json, created_at
     FROM billing_audit_logs
     WHERE (target_type = 'billing_order' AND target_id = ?)
        OR (subject_type = ? AND subject_id = ?)
     ORDER BY id DESC
     LIMIT 20`,
    [orderId, order.subject_type, order.subject_id]
  );
  const [events] = await db.query(
    `SELECT id, event_id, event_type, event_version, aggregate_type, aggregate_id,
            status, retry_count, created_at, updated_at
     FROM billing_events
     WHERE (aggregate_type = 'billing_order' AND aggregate_id = ?)
        OR (subject_type = ? AND subject_id = ?)
     ORDER BY id DESC
     LIMIT 20`,
    [orderId, order.subject_type, order.subject_id]
  );

  return success(res, {
    order: {
      id: Number(order.id),
      order_no: order.order_no || '',
      subject_type: order.subject_type || '',
      subject_id: Number(order.subject_id),
      merchant_name: order.shop_name || order.nickname || '',
      phone: order.phone || '',
      status: order.status || '',
      amount_cents: Number(order.amount_cents || 0),
      currency: order.currency || 'CNY',
      payment_channel: order.payment_channel || '',
      paid_at: order.paid_at,
      created_at: order.created_at,
      updated_at: order.updated_at,
    },
    payments,
    subscriptions,
    entitlements,
    audits,
    events,
  });
});

app.get('/api/admin/billing/exceptions', adminAuth, async (req, res) => {
  const [paymentRows] = await db.query(
    `SELECT bp.id AS payment_id, bp.payment_no, bp.order_id, bp.subject_id AS merchant_user_id,
            bp.amount_cents, bp.currency, bp.paid_at, bp.created_at,
            bo.order_no, bo.status AS order_status,
            be_current.id AS entitlement_id, be_current.status AS entitlement_status,
            be_current.readonly_mode AS entitlement_readonly_mode,
            be_current.expire_at AS entitlement_expire_at,
            u.phone, u.nickname, mp.shop_name
     FROM billing_payments bp
     LEFT JOIN billing_orders bo ON bo.id = bp.order_id
     JOIN users u ON u.id = bp.subject_id
     LEFT JOIN merchant_profiles mp ON mp.user_id = bp.subject_id
     LEFT JOIN billing_entitlements be_current ON be_current.id = (
       SELECT be2.id
       FROM billing_entitlements be2
       WHERE be2.subject_type = 'merchant'
         AND be2.subject_id = bp.subject_id
       ORDER BY be2.id DESC
       LIMIT 1
     )
     WHERE bp.subject_type = 'merchant'
       AND bp.status = 'succeeded'
       AND NOT EXISTS (
         SELECT 1 FROM billing_entitlements be
         WHERE be.subject_type = 'merchant'
           AND be.subject_id = bp.subject_id
           AND be.status = 'active'
           AND be.readonly_mode = 0
           AND be.expire_at > NOW()
           AND JSON_UNQUOTE(JSON_EXTRACT(be.feature_json, '$.shop_visible')) = 'true'
       )
     ORDER BY bp.paid_at DESC, bp.id DESC
     LIMIT 50`
  );
  const [eventRows] = await db.query(
    `SELECT be.id, be.event_id, be.event_type, be.event_version,
            be.subject_type, be.subject_id, be.aggregate_type, be.aggregate_id,
            be.status, be.retry_count, be.created_at, be.updated_at,
            u.phone, u.nickname, mp.shop_name
     FROM billing_events be
     LEFT JOIN users u ON be.subject_type = 'merchant' AND u.id = be.subject_id
     LEFT JOIN merchant_profiles mp ON be.subject_type = 'merchant' AND mp.user_id = be.subject_id
     WHERE be.status IN ('failed', 'dead_letter')
     ORDER BY be.updated_at DESC, be.id DESC
     LIMIT 100`
  );

  return success(res, {
    payment_not_activated: paymentRows.map((row) => ({
      payment_id: Number(row.payment_id),
      payment_no: row.payment_no || '',
      order_id: Number(row.order_id),
      order_no: row.order_no || '',
      order_status: row.order_status || '',
      merchant_user_id: Number(row.merchant_user_id),
      merchant_name: row.shop_name || row.nickname || '',
      phone: row.phone || '',
      amount_cents: Number(row.amount_cents || 0),
      currency: row.currency || 'CNY',
      entitlement_id: row.entitlement_id ? Number(row.entitlement_id) : null,
      entitlement_status: row.entitlement_status || '',
      entitlement_readonly_mode: row.entitlement_readonly_mode === null ? null : Boolean(row.entitlement_readonly_mode),
      entitlement_expire_at: row.entitlement_expire_at,
      paid_at: row.paid_at || row.created_at,
    })),
    event_failures: eventRows.map((row) => ({
      id: Number(row.id),
      event_id: row.event_id || '',
      event_type: row.event_type || '',
      event_version: Number(row.event_version || 1),
      subject_type: row.subject_type || '',
      subject_id: row.subject_id ? Number(row.subject_id) : null,
      merchant_name: row.shop_name || row.nickname || '',
      phone: row.phone || '',
      aggregate_type: row.aggregate_type || '',
      aggregate_id: row.aggregate_id ? Number(row.aggregate_id) : null,
      status: row.status || '',
      retry_count: Number(row.retry_count || 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
  });
});

app.post('/api/admin/billing/events/:id/retry', adminAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  if (!eventId) return error(res, '事件不存在', 404);

  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, '请填写重跑原因');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT *
       FROM billing_events
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [eventId]
    );
    const event = rows[0];
    if (!event) {
      await conn.rollback();
      return error(res, '事件不存在', 404);
    }
    if (!['failed', 'dead_letter'].includes(event.status)) {
      await conn.rollback();
      return error(res, '只有失败或死信事件可以重跑');
    }
    await conn.query(
      `UPDATE billing_events
       SET status = 'pending',
           retry_count = retry_count + 1,
           next_retry_at = NOW(),
           dead_letter_at = NULL
       WHERE id = ?`,
      [eventId]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES (?, ?, 'admin', NULL, 'ADMIN_RETRY_BILLING_EVENT',
               'billing_event', ?, ?, ?, ?)`,
      [
        event.subject_type || null,
        event.subject_id || null,
        eventId,
        JSON.stringify({ status: event.status, retry_count: event.retry_count || 0 }),
        JSON.stringify({ status: 'pending', retry_count: Number(event.retry_count || 0) + 1 }),
        reason,
      ]
    );
    await conn.commit();
    return success(res, { retried: true, event_id: eventId }, '事件已重新加入待处理');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.post('/api/admin/billing/events/:id/resolve', adminAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  if (!eventId) return error(res, '事件不存在', 404);

  const status = String(req.body?.status || '').trim();
  if (!['processed', 'ignored'].includes(status)) return error(res, '处理状态不正确');
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  if (!reason) return error(res, status === 'processed' ? '请填写处理说明' : '请填写忽略原因');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT *
       FROM billing_events
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [eventId]
    );
    const event = rows[0];
    if (!event) {
      await conn.rollback();
      return error(res, '事件不存在', 404);
    }
    if (!['failed', 'dead_letter'].includes(event.status)) {
      await conn.rollback();
      return error(res, '只有失败或死信事件可以人工处理');
    }

    await conn.query(
      `UPDATE billing_events
       SET status = ?,
           next_retry_at = NULL,
           dead_letter_at = IF(? = 'ignored', COALESCE(dead_letter_at, NOW()), dead_letter_at)
       WHERE id = ?`,
      [status, status, eventId]
    );
    await conn.query(
      `INSERT INTO billing_audit_logs (
         subject_type, subject_id, actor_type, actor_id, action,
         target_type, target_id, before_json, after_json, reason
       )
       VALUES (?, ?, 'admin', NULL, ?,
               'billing_event', ?, ?, ?, ?)`,
      [
        event.subject_type || null,
        event.subject_id || null,
        status === 'processed' ? 'ADMIN_MARK_BILLING_EVENT_PROCESSED' : 'ADMIN_IGNORE_BILLING_EVENT',
        eventId,
        JSON.stringify({ status: event.status, retry_count: event.retry_count || 0 }),
        JSON.stringify({ status }),
        reason,
      ]
    );
    await conn.commit();
    return success(
      res,
      { resolved: true, event_id: eventId, status },
      status === 'processed' ? '事件已标记为已处理' : '事件已标记为忽略'
    );
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

const PUBLIC_SHARE_SOURCE_TYPES = [
  'site_photos',
  'complaint',
  'site_check_in',
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
app.get('/admin/billing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// 官网静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
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
