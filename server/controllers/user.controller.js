const db = require('../config/db');
const { success, error } = require('../utils/response');
const bcrypt = require('bcryptjs');
const fs = require('fs/promises');
const path = require('path');
const jwt = require('jsonwebtoken');

const profileSelect = `
  SELECT u.id, u.phone, u.nickname, u.avatar, u.bio, u.city, u.role,
         (SELECT JSON_ARRAYAGG(ur.role) FROM user_roles ur
          WHERE ur.user_id = u.id) AS roles,
         (SELECT COUNT(*) FROM notes n
          WHERE n.user_id = u.id AND n.status = 1) AS notes_count,
         (SELECT COUNT(*) FROM follows f
          WHERE f.following_id = u.id) AS followers_count,
         (SELECT COUNT(*) FROM follows f
          WHERE f.follower_id = u.id) AS following_count,
         COALESCE((SELECT SUM(n.likes_count) FROM notes n
                   WHERE n.user_id = u.id AND n.status = 1), 0) AS likes_received,
         u.created_at
  FROM users u
  WHERE u.id = ?`;

async function verifyPassword(userId, password) {
  const [rows] = await db.query(
    'SELECT password_hash FROM users WHERE id = ?',
    [userId]
  );
  if (!rows[0]) return false;
  if (rows[0].password_hash) {
    return bcrypt.compare(String(password || ''), rows[0].password_hash);
  }
  const testPassword = process.env.TEST_LOGIN_PASSWORD ||
    (process.env.NODE_ENV !== 'production' ? '123456' : '');
  return Boolean(testPassword) && password === testPassword;
}

// 获取用户资料
async function getProfile(req, res) {
  const userId = req.params.id || req.user.id;
  const [rows] = await db.query(profileSelect, [userId]);
  if (rows.length === 0) return error(res, '用户不存在', 404);
  const designerProfile = await getDesignerProfileData(userId);
  const projectManagerProfile = await getProjectManagerProfileData(userId);
  const merchantProfile = await getMerchantProfileData(userId);
  const viewerId = await getViewerId(req);
  const isSelf = viewerId && Number(viewerId) === Number(userId);
  let isFollowing = false;
  if (viewerId && !isSelf) {
    const [followRows] = await db.query(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ? LIMIT 1',
      [viewerId, userId]
    );
    isFollowing = followRows.length > 0;
  }
  return success(res, {
    ...rows[0],
    designer_profile: designerProfile,
    project_manager_profile: projectManagerProfile,
    merchant_profile: merchantProfile,
    is_self: Boolean(isSelf),
    is_following: isFollowing,
  });
}

async function getMerchantProfileData(userId) {
  const [rows] = await db.query(
    `SELECT user_id, service_area, categories, service_types, case_count,
            brand_intro, consultation_enabled, updated_at
     FROM merchant_profiles
     WHERE user_id = ?`,
    [userId]
  );
  if (!rows[0]) return null;
  const profile = rows[0];
  profile.categories = parseJsonArray(profile.categories);
  profile.service_types = parseJsonArray(profile.service_types);
  profile.consultation_enabled = Boolean(profile.consultation_enabled);
  return profile;
}

async function getMerchantProfile(req, res) {
  const profile = await getMerchantProfileData(req.user.id);
  return success(res, profile || defaultMerchantProfile(req.user.id));
}

async function upsertMerchantProfile(req, res) {
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'merchant' LIMIT 1`,
    [req.user.id]
  );
  if (!roleRows.length && req.user.role !== 'merchant') {
    return error(res, '只有商家身份可以编辑商家资料', 403);
  }

  const serviceArea = String(req.body.service_area || '').trim().slice(0, 80);
  const categories = normalizeStringList(req.body.categories, 12);
  const serviceTypes = normalizeStringList(req.body.service_types, 12);
  const caseCount = Math.max(
    0,
    Math.min(9999, parseInt(req.body.case_count) || 0)
  );
  const brandIntro = String(req.body.brand_intro || '').trim().slice(0, 500);
  const consultationEnabled =
    req.body.consultation_enabled === undefined ||
    req.body.consultation_enabled === true ||
    req.body.consultation_enabled === 'true' ||
    req.body.consultation_enabled === '1' ||
    req.body.consultation_enabled === 1;

  await db.query(
    `INSERT INTO merchant_profiles
     (user_id, service_area, categories, service_types, case_count,
      brand_intro, consultation_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       service_area = VALUES(service_area),
       categories = VALUES(categories),
       service_types = VALUES(service_types),
       case_count = VALUES(case_count),
       brand_intro = VALUES(brand_intro),
       consultation_enabled = VALUES(consultation_enabled)`,
    [
      req.user.id,
      serviceArea || null,
      JSON.stringify(categories),
      JSON.stringify(serviceTypes),
      caseCount,
      brandIntro || null,
      consultationEnabled ? 1 : 0,
    ]
  );
  const profile = await getMerchantProfileData(req.user.id);
  return success(res, profile, '商家资料已保存');
}

function defaultMerchantProfile(userId) {
  return {
    user_id: userId,
    service_area: '',
    categories: [],
    service_types: [],
    case_count: 0,
    brand_intro: '',
    consultation_enabled: true,
  };
}

async function getProjectManagerProfileData(userId) {
  const [rows] = await db.query(
    `SELECT user_id, service_area, project_types, management_skills,
            experience_years, managed_project_count, management_philosophy,
            consultation_enabled, updated_at
     FROM project_manager_profiles
     WHERE user_id = ?`,
    [userId]
  );
  if (!rows[0]) return null;
  const profile = rows[0];
  const [projectRows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM project_members
     WHERE user_id = ?
       AND role IN ('project_manager', 'project_supervisor')
       AND status = 1`,
    [userId]
  );
  profile.project_types = parseJsonArray(profile.project_types);
  profile.management_skills = parseJsonArray(profile.management_skills);
  profile.managed_project_count = Math.max(
    Number(profile.managed_project_count) || 0,
    Number(projectRows[0]?.total) || 0
  );
  profile.consultation_enabled = Boolean(profile.consultation_enabled);
  return profile;
}

async function getProjectManagerProfile(req, res) {
  const profile = await getProjectManagerProfileData(req.user.id);
  return success(res, profile || defaultProjectManagerProfile(req.user.id));
}

async function upsertProjectManagerProfile(req, res) {
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles
     WHERE user_id = ?
       AND role IN ('project_manager', 'project_supervisor')
     LIMIT 1`,
    [req.user.id]
  );
  if (
    !roleRows.length &&
    !['project_manager', 'project_supervisor'].includes(req.user.role)
  ) {
    return error(res, '只有项目经理或项目监理身份可以编辑资料', 403);
  }

  const serviceArea = String(req.body.service_area || '').trim().slice(0, 80);
  const projectTypes = normalizeStringList(req.body.project_types, 8);
  const managementSkills = normalizeStringList(req.body.management_skills, 12);
  const experienceYears = Math.max(
    0,
    Math.min(80, parseInt(req.body.experience_years) || 0)
  );
  const managedProjectCount = Math.max(
    0,
    Math.min(9999, parseInt(req.body.managed_project_count) || 0)
  );
  const managementPhilosophy = String(req.body.management_philosophy || '')
    .trim()
    .slice(0, 500);
  const consultationEnabled =
    req.body.consultation_enabled === undefined ||
    req.body.consultation_enabled === true ||
    req.body.consultation_enabled === 'true' ||
    req.body.consultation_enabled === '1' ||
    req.body.consultation_enabled === 1;

  await db.query(
    `INSERT INTO project_manager_profiles
     (user_id, service_area, project_types, management_skills,
      experience_years, managed_project_count, management_philosophy,
      consultation_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       service_area = VALUES(service_area),
       project_types = VALUES(project_types),
       management_skills = VALUES(management_skills),
       experience_years = VALUES(experience_years),
       managed_project_count = VALUES(managed_project_count),
       management_philosophy = VALUES(management_philosophy),
       consultation_enabled = VALUES(consultation_enabled)`,
    [
      req.user.id,
      serviceArea || null,
      JSON.stringify(projectTypes),
      JSON.stringify(managementSkills),
      experienceYears,
      managedProjectCount,
      managementPhilosophy || null,
      consultationEnabled ? 1 : 0,
    ]
  );
  const profile = await getProjectManagerProfileData(req.user.id);
  return success(res, profile, '项目经理资料已保存');
}

function defaultProjectManagerProfile(userId) {
  return {
    user_id: userId,
    service_area: '',
    project_types: [],
    management_skills: [],
    experience_years: 0,
    managed_project_count: 0,
    management_philosophy: '',
    consultation_enabled: true,
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeStringList(input, maxLength) {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
    ? input.split(',')
    : [];
  return values
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, maxLength);
}

async function getDesignerProfileData(userId) {
  const [rows] = await db.query(
    `SELECT user_id, service_city, styles, experience_years, case_count,
            design_philosophy, verified_status, consultation_enabled,
            updated_at
     FROM designer_profiles
     WHERE user_id = ?`,
    [userId]
  );
  if (!rows[0]) return null;
  const profile = rows[0];
  if (typeof profile.styles === 'string') {
    try {
      profile.styles = JSON.parse(profile.styles);
    } catch {
      profile.styles = [];
    }
  }
  if (!Array.isArray(profile.styles)) profile.styles = [];
  profile.verified_status = Boolean(profile.verified_status);
  profile.consultation_enabled = Boolean(profile.consultation_enabled);
  return profile;
}

async function getDesignerProfile(req, res) {
  const profile = await getDesignerProfileData(req.user.id);
  return success(res, profile || defaultDesignerProfile(req.user.id));
}

async function upsertDesignerProfile(req, res) {
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'designer' LIMIT 1`,
    [req.user.id]
  );
  if (!roleRows.length && req.user.role !== 'designer') {
    return error(res, '只有设计师身份可以编辑设计师资料', 403);
  }

  const serviceCity = String(req.body.service_city || '').trim().slice(0, 80);
  const styles = normalizeDesignerStyles(req.body.styles);
  const experienceYears = Math.max(
    0,
    Math.min(80, parseInt(req.body.experience_years) || 0)
  );
  const caseCount = Math.max(
    0,
    Math.min(9999, parseInt(req.body.case_count) || 0)
  );
  const designPhilosophy = String(req.body.design_philosophy || '')
    .trim()
    .slice(0, 500);
  const consultationEnabled =
    req.body.consultation_enabled === undefined ||
    req.body.consultation_enabled === true ||
    req.body.consultation_enabled === 'true' ||
    req.body.consultation_enabled === '1' ||
    req.body.consultation_enabled === 1;

  await db.query(
    `INSERT INTO designer_profiles
     (user_id, service_city, styles, experience_years, case_count,
      design_philosophy, consultation_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       service_city = VALUES(service_city),
       styles = VALUES(styles),
       experience_years = VALUES(experience_years),
       case_count = VALUES(case_count),
       design_philosophy = VALUES(design_philosophy),
       consultation_enabled = VALUES(consultation_enabled)`,
    [
      req.user.id,
      serviceCity || null,
      JSON.stringify(styles),
      experienceYears,
      caseCount,
      designPhilosophy || null,
      consultationEnabled ? 1 : 0,
    ]
  );
  const profile = await getDesignerProfileData(req.user.id);
  return success(res, profile, '设计师资料已保存');
}

function defaultDesignerProfile(userId) {
  return {
    user_id: userId,
    service_city: '',
    styles: [],
    experience_years: 0,
    case_count: 0,
    design_philosophy: '',
    verified_status: false,
    consultation_enabled: true,
  };
}

function normalizeDesignerStyles(input) {
  return normalizeStringList(input, 12);
}

const consultationRoleConfig = {
  designer: {
    table: 'designer_profiles',
    missingMessage: '设计师不存在',
    closedMessage: '该设计师暂未开放咨询',
  },
  project_manager: {
    table: 'project_manager_profiles',
    missingMessage: '项目经理不存在',
    closedMessage: '该项目经理暂未开放咨询',
  },
  project_supervisor: {
    table: 'project_manager_profiles',
    missingMessage: '项目监理不存在',
    closedMessage: '该项目监理暂未开放咨询',
  },
  merchant: {
    table: 'merchant_profiles',
    missingMessage: '商家不存在',
    closedMessage: '该商家暂未开放咨询',
  },
};

async function createDesignerConsultation(req, res) {
  const targetId = Number(req.params.id);
  const targetRole = consultationRoleConfig[req.body.target_role]
    ? req.body.target_role
    : 'designer';
  if (!targetId || targetId === req.user.id) {
    return error(res, '咨询对象不正确');
  }
  const config = consultationRoleConfig[targetRole];
  const [targetRows] = await db.query(
    `SELECT u.id, COALESCE(profile.consultation_enabled, 1) AS consultation_enabled
     FROM users u
     LEFT JOIN ${config.table} profile ON profile.user_id = u.id
     WHERE u.id = ?
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = u.id AND ur.role = ?
       )`,
    [targetId, targetRole]
  );
  if (!targetRows[0]) return error(res, config.missingMessage, 404);
  if (!targetRows[0].consultation_enabled) {
    return error(res, config.closedMessage);
  }

  const content = String(req.body.content || '').trim().slice(0, 1000);
  const projectCity = String(req.body.project_city || '').trim().slice(0, 80);
  const renovationStage = String(req.body.renovation_stage || '')
    .trim()
    .slice(0, 80);
  const hasProject =
    req.body.has_project === true ||
    req.body.has_project === 'true' ||
    req.body.has_project === '1' ||
    req.body.has_project === 1;
  if (!content) return error(res, '请填写咨询内容');

  const [result] = await db.query(
    `INSERT INTO designer_consultations
     (designer_id, target_role, user_id, content, project_city, renovation_stage, has_project)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      targetId,
      targetRole,
      req.user.id,
      content,
      projectCity || null,
      renovationStage || null,
      hasProject ? 1 : 0,
    ]
  );
  return success(res, { id: result.insertId }, '咨询已发送');
}

async function getDesignerConsultations(req, res) {
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles
     WHERE user_id = ?
       AND role IN ('designer', 'project_manager', 'project_supervisor', 'merchant')
     LIMIT 1`,
    [req.user.id]
  );
  if (
    !roleRows.length &&
    !['designer', 'project_manager', 'project_supervisor', 'merchant'].includes(req.user.role)
  ) {
    return error(res, '当前身份不能查看咨询线索', 403);
  }
  const [rows] = await db.query(
    `SELECT c.id, c.designer_id, c.target_role, c.user_id, c.content, c.project_city,
            c.renovation_stage, c.has_project, c.status,
            c.created_at, c.updated_at,
            u.nickname AS user_nickname, u.avatar AS user_avatar,
            u.city AS user_city
     FROM designer_consultations c
     JOIN users u ON u.id = c.user_id
     WHERE c.designer_id = ?
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT 100`,
    [req.user.id]
  );
  return success(
    res,
    rows.map((item) => ({
      ...item,
      has_project: Boolean(item.has_project),
    }))
  );
}

async function getMyConsultations(req, res) {
  const [rows] = await db.query(
    `SELECT c.id, c.designer_id, c.target_role, c.user_id, c.content, c.project_city,
            c.renovation_stage, c.has_project, c.status,
            c.created_at, c.updated_at,
            designer.nickname AS designer_nickname,
            designer.avatar AS designer_avatar,
            designer.city AS designer_city
     FROM designer_consultations c
     JOIN users designer ON designer.id = c.designer_id
     WHERE c.user_id = ?
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT 100`,
    [req.user.id]
  );
  return success(
    res,
    rows.map((item) => ({
      ...item,
      has_project: Boolean(item.has_project),
    }))
  );
}

async function getConsultationForUser(consultationId, userId) {
  const [rows] = await db.query(
    `SELECT c.id, c.designer_id, c.target_role, c.user_id, c.content, c.status,
            designer.nickname AS designer_nickname,
            designer.avatar AS designer_avatar,
            owner.nickname AS user_nickname,
            owner.avatar AS user_avatar
     FROM designer_consultations c
     JOIN users designer ON designer.id = c.designer_id
     JOIN users owner ON owner.id = c.user_id
     WHERE c.id = ?
       AND (c.designer_id = ? OR c.user_id = ?)
     LIMIT 1`,
    [consultationId, userId, userId]
  );
  return rows[0] || null;
}

async function getConsultationMessages(req, res) {
  const consultationId = Number(req.params.id);
  const consultation = await getConsultationForUser(consultationId, req.user.id);
  if (!consultation) return error(res, '咨询不存在或无权限', 404);

  await db.query(
    `INSERT IGNORE INTO consultation_message_reads (message_id, user_id)
     SELECT id, ? FROM consultation_messages
     WHERE consultation_id = ? AND sender_id != ?`,
    [req.user.id, consultationId, req.user.id]
  );

  const [rows] = await db.query(
    `SELECT m.id, m.consultation_id, m.sender_id, m.content, m.created_at,
            u.nickname AS sender_name, u.avatar AS sender_avatar
     FROM consultation_messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.consultation_id = ?
     ORDER BY m.created_at ASC, m.id ASC`,
    [consultationId]
  );
  return success(res, {
    consultation,
    messages: rows,
  });
}

async function sendConsultationMessage(req, res) {
  const consultationId = Number(req.params.id);
  const consultation = await getConsultationForUser(consultationId, req.user.id);
  if (!consultation) return error(res, '咨询不存在或无权限', 404);

  const content = String(req.body.content || '').trim().slice(0, 1000);
  if (!content) return error(res, '请填写消息内容');

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO consultation_messages
       (consultation_id, sender_id, content)
       VALUES (?, ?, ?)`,
      [consultationId, req.user.id, content]
    );
    await connection.query(
      `INSERT IGNORE INTO consultation_message_reads (message_id, user_id)
       VALUES (?, ?)`,
      [result.insertId, req.user.id]
    );
    if (Number(req.user.id) === Number(consultation.designer_id)) {
      await connection.query(
        `UPDATE designer_consultations
         SET status = 'replied'
         WHERE id = ? AND status = 'pending'`,
        [consultationId]
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '消息已发送');
  } catch (messageError) {
    await connection.rollback();
    throw messageError;
  } finally {
    connection.release();
  }
}

async function getConsultationConversations(req, res) {
  const [rows] = await db.query(
    `SELECT c.id AS consultation_id, c.designer_id, c.target_role, c.user_id, c.status,
            c.content AS consultation_content,
            COALESCE(last_msg.content, c.content) AS last_message,
            COALESCE(last_msg.created_at, c.created_at) AS last_message_at,
            CASE
              WHEN c.designer_id = ? THEN owner.id
              ELSE designer.id
            END AS peer_id,
            CASE
              WHEN c.designer_id = ? THEN owner.nickname
              ELSE designer.nickname
            END AS peer_nickname,
            CASE
              WHEN c.designer_id = ? THEN owner.avatar
              ELSE designer.avatar
            END AS peer_avatar,
            (
              SELECT COUNT(*) FROM consultation_messages unread_msg
              LEFT JOIN consultation_message_reads read_state
                ON read_state.message_id = unread_msg.id
               AND read_state.user_id = ?
              WHERE unread_msg.consultation_id = c.id
                AND unread_msg.sender_id != ?
                AND read_state.message_id IS NULL
            ) AS unread_count
     FROM designer_consultations c
     JOIN users designer ON designer.id = c.designer_id
     JOIN users owner ON owner.id = c.user_id
     LEFT JOIN consultation_messages last_msg
       ON last_msg.id = (
         SELECT m.id FROM consultation_messages m
         WHERE m.consultation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1
       )
     WHERE c.designer_id = ? OR c.user_id = ?
     ORDER BY last_message_at DESC, c.id DESC
     LIMIT 100`,
    [
      req.user.id,
      req.user.id,
      req.user.id,
      req.user.id,
      req.user.id,
      req.user.id,
      req.user.id,
    ]
  );
  return success(res, rows);
}

function parseNotificationPayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(payload);
  } catch (_) {
    return {};
  }
}

function buildNotificationText(row) {
  const payload = parseNotificationPayload(row.payload);
  if (row.event_type === 'project_event' || payload.source === 'project_event') {
    return {
      type: payload.projectEventType || 'project_event',
      title: payload.title || '项目协同提醒',
      content: payload.content || '项目有新的协同动态',
    };
  }
  if (row.event_type === 'case_share_request' || payload.source === 'case_share_request') {
    return {
      type: 'project_case_share',
      title: '案例分享申请',
      content: `${row.case_share_creator_name || '项目成员'}申请将项目公开为案例：${row.case_share_title || '项目案例'}`,
    };
  }
  const content = String(row.content || '').replace(/\s+/g, ' ').trim();
  const shortContent = content.length > 36 ? `${content.slice(0, 36)}...` : content;
  if (row.event_type === 'feedback') {
    return {
      type: 'action_feedback',
      title: '事项反馈',
      content: `${row.creator_name || '项目成员'}收到了处理反馈：${shortContent}`,
    };
  }
  if (payload.source === 'inspection_rework') {
    return {
      type: 'inspection_rework',
      title: '验收整改',
      content: `你有一条整改事项：${shortContent}`,
    };
  }
  return {
    type: 'action_assigned',
    title: '待处理事项',
    content: `${row.creator_name || '项目成员'}安排了事项：${shortContent}`,
  };
}

const defaultProjectName = '装修项目';
const legacyInvalidProjectNames = new Set([
  'è£…ä¿®é¡¹ç›®',
]);

function normalizeProjectName(value) {
  const name = String(value || '').trim();
  if (!name || legacyInvalidProjectNames.has(name)) return defaultProjectName;
  return name;
}

async function getNotifications(req, res) {
  const [rows] = await db.query(
    `SELECT n.id, n.item_id, n.event_type, n.delivery_status, n.payload,
            n.read_at, n.created_at,
            COALESCE(
              item.project_id,
              case_share.project_id,
              CAST(JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.projectId')) AS UNSIGNED),
              CAST(JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.project_id')) AS UNSIGNED)
            ) AS project_id,
            item.content,
            COALESCE(item.status, CAST(case_share.status AS CHAR)) AS item_status,
            item.created_by, creator.nickname AS creator_name,
            case_share.title AS case_share_title,
            case_creator.nickname AS case_share_creator_name,
            p.project_name
     FROM project_action_notifications n
     LEFT JOIN project_action_items item
       ON item.id = n.item_id AND n.event_type NOT IN ('case_share_request', 'project_event')
     LEFT JOIN project_case_shares case_share
       ON case_share.id = n.item_id AND n.event_type = 'case_share_request'
     JOIN renovation_projects p ON p.id = COALESCE(
       item.project_id,
       case_share.project_id,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.projectId')) AS UNSIGNED),
       CAST(JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.project_id')) AS UNSIGNED)
     )
     LEFT JOIN users creator ON creator.id = item.created_by
     LEFT JOIN users case_creator ON case_creator.id = case_share.designer_id
     WHERE n.recipient_id = ?
       AND (
         n.event_type <> 'assigned'
         OR EXISTS (
           SELECT 1 FROM project_action_item_assignees assigned
           WHERE assigned.item_id = n.item_id
             AND assigned.user_id = n.recipient_id
         )
       )
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT 80`,
    [req.user.id]
  );
  return success(res, rows.map((row) => {
    const text = buildNotificationText(row);
    const payload = parseNotificationPayload(row.payload);
    return {
      id: row.id,
      type: text.type,
      title: text.title,
      content: text.content,
      project_id: row.project_id,
      project_name: normalizeProjectName(row.project_name),
      action_item_id: row.item_id,
      event_type: row.event_type,
      item_status: row.item_status,
      route: row.event_type === 'project_event' ? payload.route || null : null,
      deep_link: row.event_type === 'project_event' ? payload.deepLink || null : null,
      entity_type: row.event_type === 'project_event' ? payload.entityType || null : null,
      entity_id: row.event_type === 'project_event' ? payload.entityId || null : null,
      is_read: Boolean(row.read_at),
      created_at: row.created_at,
    };
  }));
}

async function markNotificationRead(req, res) {
  const notificationId = Number(req.params.id);
  if (!notificationId) return error(res, '通知不存在', 404);
  const [result] = await db.query(
    `UPDATE project_action_notifications
     SET read_at = COALESCE(read_at, NOW()), delivery_status = 'read'
     WHERE id = ? AND recipient_id = ?`,
    [notificationId, req.user.id]
  );
  if (result.affectedRows === 0) return error(res, '通知不存在', 404);
  return success(res, { id: notificationId, is_read: true });
}

async function getViewerId(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.userId || null;
  } catch {
    return null;
  }
}

// 更新用户资料
async function updateProfile(req, res) {
  const { nickname, avatar, bio, city } = req.body;
  const normalizedNickname = String(nickname || '').trim();
  if (!normalizedNickname) return error(res, '昵称不能为空');

  await db.query(
    'UPDATE users SET nickname = ?, avatar = ?, bio = ?, city = ? WHERE id = ?',
    [
      normalizedNickname.slice(0, 50),
      String(avatar || '').trim().slice(0, 255),
      String(bio || '').trim().slice(0, 200),
      String(city || '').trim().slice(0, 50),
      req.user.id
    ]
  );
  const [rows] = await db.query(profileSelect, [req.user.id]);
  return success(res, rows[0], '更新成功');
}

async function updateRole(req, res) {
  const role = String(req.body.role || '');
  if (
    ![
      'owner',
      'designer',
      'merchant',
      'project_manager',
      'project_supervisor',
    ].includes(role)
  ) {
    return error(res, '身份类型不正确');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT IGNORE INTO user_roles (user_id, role, is_default)
       VALUES (?, ?, 0)`,
      [req.user.id, role]
    );
    await connection.query('UPDATE users SET role = ? WHERE id = ?', [
      role,
      req.user.id,
    ]);
    await connection.commit();
  } catch (updateError) {
    await connection.rollback();
    throw updateError;
  } finally {
    connection.release();
  }
  const [rows] = await db.query(
    `SELECT u.id, u.phone, u.nickname, u.avatar, u.bio, u.city, u.role,
            (SELECT JSON_ARRAYAGG(ur.role) FROM user_roles ur
             WHERE ur.user_id = u.id) AS roles
     FROM users u WHERE u.id = ?`,
    [req.user.id]
  );
  return success(res, rows[0], '身份切换成功');
}

async function uploadAvatar(req, res) {
  if (!req.file) return error(res, '请选择头像图片');
  const avatarUrl = `${req.protocol}://${req.get('host')}/uploads/avatars/${req.file.filename}`;
  const [rows] = await db.query('SELECT avatar FROM users WHERE id = ?', [req.user.id]);
  const oldAvatar = rows[0]?.avatar || '';

  await db.query('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, req.user.id]);

  if (oldAvatar.includes('/uploads/avatars/')) {
    const oldName = path.basename(oldAvatar);
    if (oldName !== req.file.filename) {
      await fs.unlink(path.join(__dirname, '..', 'uploads', 'avatars', oldName)).catch(() => {});
    }
  }

  return success(res, { avatar: avatarUrl }, '头像上传成功');
}

async function changePassword(req, res) {
  const { current_password: currentPassword, new_password: newPassword } = req.body;
  if (String(newPassword || '').length < 6) return error(res, '新密码至少 6 位');
  if (!await verifyPassword(req.user.id, currentPassword)) return error(res, '当前密码错误');

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id]);
  return success(res, null, '密码修改成功');
}

async function changePhone(req, res) {
  const { phone, password } = req.body;
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) return error(res, '手机号格式不正确');
  if (!await verifyPassword(req.user.id, password)) return error(res, '密码错误');

  const [existing] = await db.query('SELECT id FROM users WHERE phone = ? AND id != ?', [phone, req.user.id]);
  if (existing.length > 0) return error(res, '该手机号已被其他账号使用');

  await db.query('UPDATE users SET phone = ? WHERE id = ?', [phone, req.user.id]);
  const [rows] = await db.query(
    `SELECT u.id, u.phone, u.nickname, u.avatar, u.bio, u.city, u.role,
            (SELECT JSON_ARRAYAGG(ur.role) FROM user_roles ur
             WHERE ur.user_id = u.id) AS roles
     FROM users u WHERE u.id = ?`,
    [req.user.id]
  );
  return success(res, rows[0], '手机号修改成功');
}

async function deleteAccount(req, res) {
  if (!await verifyPassword(req.user.id, req.body.password)) return error(res, '密码错误');
  await db.query('DELETE FROM users WHERE id = ?', [req.user.id]);
  return success(res, null, '账号已注销');
}

// 关注
async function toggleFollow(req, res) {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) return error(res, '不能关注自己');

  const [existing] = await db.query('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, targetId]);
  if (existing.length > 0) {
    await db.query('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, targetId]);
    await db.query('UPDATE users SET followers_count = GREATEST(followers_count - 1, 0) WHERE id = ?', [targetId]);
    await db.query('UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id = ?', [req.user.id]);
    return success(res, { followed: false });
  } else {
    await db.query('INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)', [req.user.id, targetId]);
    await db.query('UPDATE users SET followers_count = followers_count + 1 WHERE id = ?', [targetId]);
    await db.query('UPDATE users SET following_count = following_count + 1 WHERE id = ?', [req.user.id]);
    return success(res, { followed: true });
  }
}

// 获取用户笔记
async function getUserNotes(req, res) {
  const userId = req.params.id || req.user.id;
  const { page = 1, pageSize = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(pageSize);

  const [notes] = await db.query(
    `SELECT n.id, n.title, n.content, n.source_type, n.publish_role,
            n.decoration_style, n.likes_count, n.comments_count, n.created_at,
            u.id AS user_id, u.nickname AS author_name, u.avatar AS author_avatar,
            (SELECT url FROM note_images WHERE note_id = n.id ORDER BY sort_order ASC LIMIT 1) AS cover_image
     FROM notes n
     JOIN users u ON u.id = n.user_id
     WHERE n.user_id = ? AND n.status = 1
     ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
    [userId, parseInt(pageSize), offset]
  );

  return success(res, notes);
}

async function getUserContent(req, res) {
  const type = String(req.params.type || '');
  if (!['notes', 'collections', 'history', 'questions'].includes(type)) {
    return error(res, '内容类型不正确');
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const params = [];
  let joins = '';
  let where = 'n.status = 1';
  let orderBy = 'n.created_at DESC';

  if (type === 'collections') {
    joins = 'JOIN collections c ON c.note_id = n.id';
    where += ' AND c.user_id = ?';
    params.push(req.user.id);
    orderBy = 'c.created_at DESC';
  } else if (type === 'history') {
    joins = 'JOIN note_view_history h ON h.note_id = n.id';
    where += ' AND h.user_id = ?';
    params.push(req.user.id);
    orderBy = 'h.viewed_at DESC';
  } else {
    where = 'n.status IN (1, 3) AND n.user_id = ?';
    params.push(req.user.id);
    if (type === 'questions') where += ` AND n.source_type = 'question'`;
  }

  const [notes] = await db.query(
    `SELECT n.id, n.title, n.content, n.source_type, n.decoration_style,
            n.status, n.likes_count, n.comments_count, n.created_at,
            n.collections_count, n.views_count,
            n.publish_role, n.city, n.location,
            u.id AS user_id,
            u.nickname AS author_name, u.avatar AS author_avatar,
            (SELECT url FROM note_images
             WHERE note_id = n.id ORDER BY sort_order ASC LIMIT 1) AS cover_image
     FROM notes n
     ${joins}
     JOIN users u ON u.id = n.user_id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  const [countRows] = await db.query(
    `SELECT COUNT(DISTINCT n.id) AS total
     FROM notes n
     ${joins}
     WHERE ${where}`,
    params
  );
  return success(res, {
    notes,
    total: countRows[0].total,
    page,
    pageSize,
  });
}

async function updateMyNoteVisibility(req, res) {
  const noteId = Number(req.params.id);
  const visibility = String(req.body?.visibility || '');
  const statusMap = { public: 1, private: 3 };
  if (!Object.prototype.hasOwnProperty.call(statusMap, visibility)) {
    return error(res, '可见性必须是 public 或 private');
  }

  const [result] = await db.query(
    'UPDATE notes SET status = ? WHERE id = ? AND user_id = ? AND status IN (1, 3)',
    [statusMap[visibility], noteId, req.user.id]
  );
  if (result.affectedRows === 0) return error(res, '笔记不存在或无权操作', 404);
  return success(res, { id: noteId, status: statusMap[visibility] });
}

async function deleteMyNote(req, res) {
  const noteId = Number(req.params.id);
  const [result] = await db.query(
    'UPDATE notes SET status = 4 WHERE id = ? AND user_id = ? AND status IN (1, 3)',
    [noteId, req.user.id]
  );
  if (result.affectedRows === 0) return error(res, '笔记不存在或无权操作', 404);
  return success(res, { id: noteId, deleted: true });
}

async function getHelpFaqs(req, res) {
  const [rows] = await db.query(
    `SELECT id, question, answer, sort_order, updated_at
     FROM help_faqs
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC
     LIMIT 10`
  );
  return success(res, { faqs: rows });
}

async function submitFeedback(req, res) {
  const content = String(req.body?.content || '').trim().slice(0, 500);
  const contact = req.body?.contact
    ? String(req.body.contact).trim().slice(0, 80)
    : null;
  if (!content) return error(res, '请先填写反馈内容');
  await db.query(
    `INSERT INTO user_feedback (user_id, content, contact)
     VALUES (?, ?, ?)`,
    [req.user.id, content, contact]
  );
  return success(res, null, '反馈已记录，感谢你的建议');
}

module.exports = {
  getProfile,
  updateProfile,
  updateRole,
  uploadAvatar,
  changePassword,
  changePhone,
  deleteAccount,
  toggleFollow,
  getUserNotes,
  getUserContent,
  updateMyNoteVisibility,
  deleteMyNote,
  getDesignerProfile,
  upsertDesignerProfile,
  getProjectManagerProfile,
  upsertProjectManagerProfile,
  getMerchantProfile,
  upsertMerchantProfile,
  createDesignerConsultation,
  getDesignerConsultations,
  getMyConsultations,
  getConsultationMessages,
  sendConsultationMessage,
  getConsultationConversations,
  getNotifications,
  markNotificationRead,
  getHelpFaqs,
  submitFeedback,
};
