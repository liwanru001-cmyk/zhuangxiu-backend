const db = require('../config/db');
const { success, error } = require('../utils/response');

const validParticipantTypes = new Set(['company', 'professional', 'user']);
const validRoleTypes = new Set(['designer', 'supervisor', 'contractor', 'client', 'pm']);
const validStatuses = new Set(['invited', 'active', 'rejected', 'removed']);

function mapLegacyRole(role) {
  return {
    owner: 'client',
    owner_member: 'client',
    designer: 'designer',
    project_manager: 'pm',
    project_supervisor: 'supervisor',
    merchant: 'contractor',
  }[role] || 'client';
}

function mapLegacyMember(row) {
  return {
    id: row.id,
    source: 'legacy_project_member',
    projectId: row.project_id,
    participantType: 'user',
    participantId: row.user_id,
    roleType: mapLegacyRole(row.role),
    legacyRole: row.role,
    companyId: null,
    professionalId: null,
    userId: row.user_id,
    assignedByUserId: null,
    status: row.status === 1 ? 'active' : 'removed',
    displayName: row.nickname || '项目成员',
    avatarUrl: row.avatar || '',
    city: row.city || '',
    createdAt: row.joined_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapLegacyDesigner(row) {
  return {
    id: 0,
    source: 'legacy_project_designer',
    projectId: row.project_id,
    participantType: 'professional',
    participantId: -Number(row.designer_id) * 10 - 1,
    roleType: 'designer',
    legacyRole: 'designer',
    companyId: null,
    professionalId: null,
    userId: row.designer_id,
    assignedByUserId: null,
    status: 'active',
    displayName: row.nickname || '设计师',
    avatarUrl: row.avatar || '',
    city: row.city || '',
    createdAt: null,
    updatedAt: null,
  };
}

function mapInferredCompany(row) {
  return {
    id: 0,
    source: 'inferred_company_member',
    projectId: row.project_id,
    participantType: 'company',
    participantId: row.company_id,
    roleType: {
      owner: 'contractor',
      admin: 'contractor',
      designer: 'designer',
      supervisor: 'supervisor',
      project_manager: 'pm',
      merchant_staff: 'contractor',
      customer_service: 'contractor',
    }[row.member_role] || 'contractor',
    legacyRole: row.member_role || null,
    companyId: row.company_id,
    professionalId: row.professional_id || null,
    userId: row.user_id || null,
    assignedByUserId: null,
    status: 'active',
    displayName: row.company_name || '公司',
    avatarUrl: row.company_logo || '',
    city: row.company_city || '',
    createdAt: row.joined_at || null,
    updatedAt: null,
  };
}

function mapExtParticipant(row) {
  return {
    id: row.id,
    source: 'project_participants_ext',
    projectId: row.project_id,
    participantType: row.participant_type,
    participantId: row.participant_id,
    roleType: row.role_type,
    legacyRole: null,
    companyId: row.company_id || null,
    professionalId: row.professional_id || null,
    userId: row.user_id || null,
    assignedByUserId: row.assigned_by_user_id || null,
    status: row.status,
    displayName: row.display_name || row.company_name || row.professional_name || row.user_name || '参与方',
    avatarUrl: row.avatar_url || row.company_logo || row.professional_avatar || row.user_avatar || '',
    city: row.city || row.company_city || row.professional_city || row.user_city || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function canAccessProject(projectId, userId) {
  const [rows] = await db.query(
    `SELECT p.id
     FROM renovation_projects p
     LEFT JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
     WHERE p.id = ?
       AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
       AND (p.user_id = ? OR pm.id IS NOT NULL)
     LIMIT 1`,
    [userId, projectId, userId]
  );
  return Boolean(rows[0]);
}

async function projectExists(projectId) {
  const [rows] = await db.query(
    `SELECT id FROM renovation_projects
     WHERE id = ? AND COALESCE(lifecycle_status, 'active') <> 'deleted'
     LIMIT 1`,
    [projectId]
  );
  return Boolean(rows[0]);
}

async function targetExists(participantType, participantId) {
  if (participantType === 'company') {
    const [rows] = await db.query(
      `SELECT 1 FROM companies WHERE id = ? AND status <> 'deleted' LIMIT 1`,
      [participantId]
    );
    return Boolean(rows[0]);
  }
  if (participantType === 'professional') {
    const [rows] = await db.query(
      `SELECT 1 FROM professionals WHERE id = ? AND status <> 'deleted' LIMIT 1`,
      [participantId]
    );
    return Boolean(rows[0]);
  }
  const [rows] = await db.query(
    `SELECT 1 FROM users WHERE id = ? LIMIT 1`,
    [participantId]
  );
  return Boolean(rows[0]);
}

async function optionalEntityExists(table, id) {
  if (!id) return true;
  const [rows] = await db.query(
    `SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`,
    [id]
  );
  return Boolean(rows[0]);
}

async function listProjectParticipants(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }

  const [legacyRows] = await db.query(
    `SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.status,
            pm.joined_at, pm.updated_at,
            u.nickname, u.avatar, u.city
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ? AND pm.status = 1
     ORDER BY FIELD(pm.role, 'owner', 'owner_member', 'project_manager',
                    'project_supervisor', 'designer', 'merchant'),
              pm.joined_at, pm.id`,
    [projectId]
  );

  const [legacyDesignerRows] = await db.query(
    `SELECT p.id AS project_id, p.designer_id,
            u.nickname, u.avatar, u.city
     FROM renovation_projects p
     JOIN users u ON u.id = p.designer_id
     LEFT JOIN project_members pm
       ON pm.project_id = p.id
      AND pm.user_id = p.designer_id
      AND pm.role = 'designer'
      AND pm.status = 1
     WHERE p.id = ? AND p.designer_id IS NOT NULL AND pm.id IS NULL`,
    [projectId]
  );

  const [inferredCompanyRows] = await db.query(
    `SELECT DISTINCT pm.project_id, cm.company_id, cm.user_id, cm.professional_id,
            cm.member_role, cm.joined_at,
            c.name AS company_name, c.logo_url AS company_logo, c.city AS company_city
     FROM project_members pm
     JOIN company_members cm
       ON cm.user_id = pm.user_id AND cm.status = 'active'
     JOIN companies c
       ON c.id = cm.company_id AND c.status <> 'deleted'
     WHERE pm.project_id = ? AND pm.status = 1`,
    [projectId]
  );

  const [extRows] = await db.query(
    `SELECT ppe.id, ppe.project_id, ppe.participant_type, ppe.participant_id,
            ppe.role_type, ppe.company_id, ppe.professional_id, ppe.user_id,
            ppe.assigned_by_user_id, ppe.status, ppe.created_at, ppe.updated_at,
            c.name AS company_name, c.logo_url AS company_logo, c.city AS company_city,
            prof.display_name AS professional_name,
            prof.avatar_url AS professional_avatar,
            prof.city AS professional_city,
            u.nickname AS user_name, u.avatar AS user_avatar, u.city AS user_city,
            CASE ppe.participant_type
              WHEN 'company' THEN c.name
              WHEN 'professional' THEN prof.display_name
              ELSE u.nickname
            END AS display_name,
            CASE ppe.participant_type
              WHEN 'company' THEN c.logo_url
              WHEN 'professional' THEN prof.avatar_url
              ELSE u.avatar
            END AS avatar_url,
            CASE ppe.participant_type
              WHEN 'company' THEN c.city
              WHEN 'professional' THEN prof.city
              ELSE u.city
            END AS city
     FROM project_participants_ext ppe
     LEFT JOIN companies c ON c.id = ppe.company_id
     LEFT JOIN professionals prof ON prof.id = ppe.professional_id
     LEFT JOIN users u ON u.id = ppe.user_id
     WHERE ppe.project_id = ? AND ppe.status <> 'removed'
     ORDER BY FIELD(ppe.status, 'active', 'invited', 'rejected'),
              FIELD(ppe.role_type, 'client', 'pm', 'supervisor', 'designer', 'contractor'),
              ppe.created_at DESC, ppe.id DESC`,
    [projectId]
  );

  return success(res, {
    items: [
      ...legacyRows.map(mapLegacyMember),
      ...legacyDesignerRows.map(mapLegacyDesigner),
      ...inferredCompanyRows.map(mapInferredCompany),
      ...extRows.map(mapExtParticipant),
    ],
    legacyProjectMembers: legacyRows.map(mapLegacyMember),
    inferredParticipants: [
      ...legacyDesignerRows.map(mapLegacyDesigner),
      ...inferredCompanyRows.map(mapInferredCompany),
    ],
    extendedParticipants: extRows.map(mapExtParticipant),
  });
}

async function createProjectParticipant(req, res) {
  const projectId = Number(req.params.id);
  const participantType = String(req.body.participant_type || '').trim();
  const participantId = Number(req.body.participant_id);
  const roleType = String(req.body.role_type || '').trim();
  const status = validStatuses.has(req.body.status) ? req.body.status : 'invited';
  const assignedByUserId = Number(req.body.assigned_by_user_id || req.user.id);
  const explicitCompanyId = Number(req.body.company_id || 0) || null;
  const explicitProfessionalId = Number(req.body.professional_id || 0) || null;
  const explicitUserId = Number(req.body.user_id || 0) || null;

  if (!projectId || !(await projectExists(projectId))) return error(res, '项目不存在', 404);
  if (!(await canAccessProject(projectId, req.user.id))) return error(res, '项目不存在或无权限', 404);
  if (!validParticipantTypes.has(participantType)) return error(res, '参与方类型不正确');
  if (!participantId) return error(res, '参与方不正确');
  if (!validRoleTypes.has(roleType)) return error(res, '项目角色不正确');
  if (!(await targetExists(participantType, participantId))) {
    return error(res, '参与方不存在', 404);
  }

  const companyId = participantType === 'company' ? participantId : explicitCompanyId;
  const professionalId = participantType === 'professional'
    ? participantId
    : explicitProfessionalId;
  const userId = participantType === 'user' ? participantId : explicitUserId;
  if (!(await optionalEntityExists('companies', companyId))) {
    return error(res, '公司不存在', 404);
  }
  if (!(await optionalEntityExists('professionals', professionalId))) {
    return error(res, '专业人士不存在', 404);
  }
  if (!(await optionalEntityExists('users', userId))) {
    return error(res, '用户不存在', 404);
  }

  const [assignedByRows] = await db.query(
    `SELECT 1 FROM users WHERE id = ? LIMIT 1`,
    [assignedByUserId]
  );
  if (!assignedByRows[0]) return error(res, '分配人不存在', 404);

  const [result] = await db.query(
    `INSERT INTO project_participants_ext
     (project_id, participant_type, participant_id, role_type,
      company_id, professional_id, user_id, assigned_by_user_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       company_id = VALUES(company_id),
       professional_id = VALUES(professional_id),
       user_id = VALUES(user_id),
       assigned_by_user_id = VALUES(assigned_by_user_id),
       status = VALUES(status),
       updated_at = CURRENT_TIMESTAMP`,
    [
      projectId,
      participantType,
      participantId,
      roleType,
      companyId,
      professionalId,
      userId,
      assignedByUserId,
      status,
    ]
  );

  return success(res, {
    id: result.insertId || null,
    project_id: projectId,
    participant_type: participantType,
    participant_id: participantId,
    role_type: roleType,
    company_id: companyId,
    professional_id: professionalId,
    user_id: userId,
    assigned_by_user_id: assignedByUserId,
    status,
  }, '参与方已添加');
}

module.exports = {
  listProjectParticipants,
  createProjectParticipant,
};
