const db = require('../config/db');
const { success, error } = require('../utils/response');
const { requireProjectContext } = require('../utils/project-context');
const { activeCompanyVisibleExistsSql } = require('../utils/billing-entitlement');

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return {};
  }
}

function normalizePage(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(query.pageSize, 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function valuesDiffer(nextValue, currentValue) {
  return String(nextValue || '').trim() !== String(currentValue || '').trim();
}

async function listBusinessCatalog(req, res) {
  const [rows] = await db.query(
    `SELECT child.id, child.parent_id, child.code, child.name, child.level,
            child.sort_order, child.status,
            parent.code AS parent_code, parent.name AS parent_name
     FROM business_catalog child
     LEFT JOIN business_catalog parent ON parent.id = child.parent_id
     WHERE child.status = 'active'
     ORDER BY child.level ASC, child.sort_order ASC, child.id ASC`
  );

  const byId = new Map();
  const roots = [];
  for (const row of rows) {
    const node = {
      id: row.id,
      parent_id: row.parent_id,
      parent_code: row.parent_code || '',
      code: row.code,
      name: row.name,
      level: row.level,
      sort_order: row.sort_order,
      children: [],
    };
    byId.set(row.id, node);
  }
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return success(res, roots);
}

async function resolveCatalogFilter(query) {
  const params = [];
  let filterSql = '';
  if (query.business_code) {
    filterSql = 'AND bc.code = ?';
    params.push(String(query.business_code));
  } else if (query.parent_code) {
    filterSql = 'AND parent.code = ?';
    params.push(String(query.parent_code));
  }
  return { filterSql, params };
}

function mapCompanyRow(row) {
  const projectNames = Array.isArray(row.project_names)
    ? row.project_names
    : String(row.project_names || '')
      .split('||')
      .map((item) => item.trim())
      .filter(Boolean);
  const projectIds = Array.isArray(row.project_ids)
    ? row.project_ids
    : String(row.project_ids || '')
      .split('||')
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0);
  const uniqueProjectNames = [...new Set(projectNames)];
  return {
    id: row.id,
    name: row.name,
    logo_url: row.logo_url || '',
    intro: row.intro || '',
    service_area: row.service_area || '',
    city: row.city || '',
    address: row.address || '',
    contact_phone: row.contact_phone || '',
    license_url: row.license_url || '',
    verification_status: row.verification_status || 'unverified',
    paid_display_status: row.paid_display_status || 'none',
    paid_display_starts_at: row.paid_display_starts_at || null,
    paid_display_ends_at: row.paid_display_ends_at || null,
    rating_avg: row.rating_avg === null || row.rating_avg === undefined
      ? 0
      : Number(row.rating_avg),
    review_count: Number(row.review_count || 0),
    case_count: Number(row.case_count || 0),
    member_count: Number(row.member_count || 0),
    status: row.status || 'active',
    source: row.source || 'manual',
    legacy_merchant_user_id: row.legacy_merchant_user_id || null,
    businesses: parseJsonArray(row.businesses).filter(Boolean),
    members: parseJsonArray(row.members).filter(Boolean),
    project_ids: [...new Set(projectIds)],
    project_names: uniqueProjectNames,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapProfessionalRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    display_name: row.display_name,
    avatar_url: row.avatar_url || '',
    bio: row.bio || '',
    city: row.city || '',
    service_area: row.service_area || '',
    status: row.status || 'active',
    independent_enabled: Boolean(row.independent_enabled),
    consultation_enabled: Boolean(row.consultation_enabled),
    source: row.source || 'manual',
    legacy_role: row.legacy_role || '',
    businesses: parseJsonArray(row.businesses).filter(Boolean),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCompanySearchItem(company) {
  return {
    entityType: 'company',
    id: company.id,
    name: company.name,
    avatarUrl: company.logo_url || '',
    city: company.city || '',
    serviceArea: company.service_area || '',
    intro: company.intro || '',
    businesses: company.businesses || [],
    verificationStatus: company.verification_status || 'unverified',
    paidDisplayStatus: company.paid_display_status || 'none',
    ratingAvg: Number(company.rating_avg || 0),
    reviewCount: Number(company.review_count || 0),
    caseCount: Number(company.case_count || 0),
    badges: [
      '装修公司',
      company.verification_status === 'verified' ? '已认证' : '',
    ].filter(Boolean),
    detailPath: `/companies/${company.id}`,
  };
}

function mapProfessionalSearchItem(professional) {
  return {
    entityType: 'professional',
    id: professional.id,
    name: professional.display_name,
    avatarUrl: professional.avatar_url || '',
    city: professional.city || '',
    serviceArea: professional.service_area || '',
    intro: professional.bio || '',
    businesses: professional.businesses || [],
    badges: ['专业人士'],
    detailPath: `/professionals/${professional.id}`,
  };
}

function mergeSearchItems(companyItems, professionalItems) {
  const merged = [];
  const maxLength = Math.max(companyItems.length, professionalItems.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (companyItems[index]) merged.push(companyItems[index]);
    if (professionalItems[index]) merged.push(professionalItems[index]);
  }
  return merged;
}

function companyPayload(body = {}) {
  return {
    name: String(body.name || '').trim().slice(0, 120),
    logo_url: String(body.logo_url || '').trim().slice(0, 500),
    intro: String(body.intro || '').trim().slice(0, 2000),
    service_area: String(body.service_area || '').trim().slice(0, 120),
    city: String(body.city || '').trim().slice(0, 50),
    address: String(body.address || '').trim().slice(0, 255),
    contact_phone: String(body.contact_phone || '').trim().slice(0, 30),
    license_url: String(body.license_url || '').trim().slice(0, 500),
  };
}

function parseBusinessCatalogIds(body = {}) {
  const rawIds = Array.isArray(body.business_catalog_ids)
    ? body.business_catalog_ids
    : [];
  return [
    ...new Set(rawIds.map((item) => Number(item)).filter((item) => item > 0)),
  ].slice(0, 20);
}

async function validateLeafBusinessCatalogIds(ids) {
  if (ids.length === 0) return [];
  const [catalogRows] = await db.query(
    `SELECT id FROM business_catalog
     WHERE id IN (?) AND status = 'active' AND level = 3`,
    [ids]
  );
  const validIds = new Set(catalogRows.map((row) => Number(row.id)));
  const invalid = ids.some((item) => !validIds.has(item));
  if (invalid) return null;
  return ids;
}

async function canManageCompany(companyId, userId) {
  const [rows] = await db.query(
    `SELECT c.id
     FROM companies c
     LEFT JOIN company_members cm
       ON cm.company_id = c.id
      AND cm.user_id = ?
      AND cm.status = 'active'
      AND cm.member_role IN ('owner', 'admin')
     WHERE c.id = ? AND c.status <> 'deleted'
       AND (c.owner_user_id = ? OR cm.id IS NOT NULL)
     LIMIT 1`,
    [userId, companyId, userId]
  );
  return Boolean(rows[0]);
}

async function getCompanyWorkbenchAccess(companyId, userId) {
  const [rows] = await db.query(
    `SELECT c.id, c.owner_user_id, cm.member_role
     FROM companies c
     LEFT JOIN company_members cm
       ON cm.company_id = c.id
      AND cm.user_id = ?
      AND cm.status = 'active'
     WHERE c.id = ? AND c.status <> 'deleted'
       AND (c.owner_user_id = ? OR cm.id IS NOT NULL)
     LIMIT 1`,
    [userId, companyId, userId]
  );
  const row = rows[0];
  if (!row) return { exists: false, canView: false, role: '' };
  const role = Number(row.owner_user_id) === Number(userId)
    ? 'owner'
    : row.member_role || 'staff';
  return {
    exists: true,
    canView: role === 'owner' || role === 'admin',
    role,
  };
}

const companyProjectsCte = `
  WITH company_projects AS (
    SELECT DISTINCT p.id AS project_id
    FROM project_participants_ext ppe
    JOIN renovation_projects p
      ON p.id = ppe.project_id
     AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
    WHERE ppe.status <> 'removed'
      AND (
        ppe.company_id = ?
        OR (ppe.participant_type = 'company' AND ppe.participant_id = ?)
      )
  )
`;

function toNumber(value) {
  return Number(value || 0);
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function nearestDueSummary(value) {
  if (!value) return '暂无明确到期时间';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const diffDays = Math.round((date.getTime() - today.getTime()) / 86400000);
  if (diffDays <= 0) return '今日到期';
  if (diffDays === 1) return '明日到期';
  return `${diffDays}天后到期`;
}

function hoursSince(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 3600000));
}

function daysSince(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
}

function mapCompanyMemberRow(row) {
  return {
    memberId: row.member_id,
    companyId: row.company_id,
    userId: row.user_id,
    professionalId: row.professional_id || null,
    displayName: row.display_name || row.nickname || '团队成员',
    avatarUrl: row.avatar_url || row.avatar || '',
    memberRole: row.member_role || 'staff',
    title: row.title || '',
    status: row.status || 'active',
    professionalBusinesses: parseJsonArray(row.professional_businesses).filter(Boolean),
    joinedAt: row.joined_at || null,
  };
}

function maskPhone(phone) {
  const value = String(phone || '').trim();
  if (value.length < 7) return value;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function mapCompanyMemberCandidateRow(row) {
  return {
    userId: Number(row.user_id || 0),
    nickname: row.nickname || '用户',
    avatarUrl: row.avatar || '',
    city: row.city || '',
    phoneMasked: maskPhone(row.phone),
    existingMember: Boolean(row.member_id),
    memberId: row.member_id || null,
    memberRole: row.member_role || '',
    professionalId: row.professional_id || null,
    professionalName: row.professional_name || '',
    professionalAvatarUrl: row.professional_avatar_url || '',
  };
}

function mapCompanyProjectRow(row) {
  return {
    projectId: row.project_id,
    projectCode: row.project_code || '',
    projectName: row.project_name || '装修项目',
    houseArea: row.house_area === null ? null : Number(row.house_area),
    currentStage: row.current_stage || 1,
    lifecycleStatus: row.lifecycle_status || 'active',
    roleType: row.role_type || 'contractor',
    participantStatus: row.participant_status || 'active',
    source: row.source || 'project_participants_ext',
    responsibleUserId: row.responsible_user_id || null,
    responsibleName: row.responsible_name || '',
    responsibleAvatarUrl: row.responsible_avatar || '',
    joinedAt: row.joined_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapCompanyCaseShareRow(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name || '装修项目',
    designer_id: row.designer_id,
    owner_id: row.owner_id,
    title: row.title || '项目案例',
    style: row.style || '',
    summary: row.summary || '',
    highlights: row.highlights || '',
    image_urls: parseJsonArray(row.image_urls).filter(Boolean),
    visible_fields: parseJsonObject(row.visible_fields),
    designer_name: row.designer_name || '设计师',
    owner_name: row.owner_name || '业主',
    reviewed_at: row.reviewed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function mapCompanyReviewRow(row) {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.project_id || null,
    project_name: row.project_name || '',
    reviewer_user_id: row.reviewer_user_id || null,
    reviewer_name: row.reviewer_name || '装修用户',
    reviewer_avatar: row.reviewer_avatar || '',
    rating: Number(row.rating || 0),
    content: row.content || '',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listCompanyMembersById(companyId, { limit = 100 } = {}) {
  const [rows] = await db.query(
    `SELECT cm.id AS member_id, cm.company_id, cm.user_id, cm.professional_id,
            cm.member_role, cm.title, cm.status, cm.joined_at,
            u.nickname, u.avatar,
            p.display_name, p.avatar_url,
            COALESCE(
              JSON_ARRAYAGG(
                CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                  'id', bc.id,
                  'code', bc.code,
                  'name', bc.name,
                  'parent_code', parent.code,
                  'parent_name', parent.name,
                  'is_primary', pb.is_primary
                ) END
              ),
              JSON_ARRAY()
            ) AS professional_businesses
     FROM company_members cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN professionals p
       ON p.id = cm.professional_id AND p.status <> 'deleted'
     LEFT JOIN professional_businesses pb
       ON pb.professional_id = p.id AND pb.status = 'active'
     LEFT JOIN business_catalog bc
       ON bc.id = pb.business_catalog_id AND bc.status = 'active'
     LEFT JOIN business_catalog parent
       ON parent.id = bc.parent_id AND parent.status = 'active'
     WHERE cm.company_id = ? AND cm.status = 'active'
     GROUP BY cm.id
     ORDER BY FIELD(cm.member_role, 'owner', 'admin', 'designer', 'supervisor',
                    'project_manager', 'customer_service', 'staff'),
              cm.joined_at DESC, cm.id DESC
     LIMIT ?`,
    [companyId, limit]
  );
  return rows.map(mapCompanyMemberRow);
}

async function ownerFallbackMember(company) {
  const ownerUserId = Number(company.owner_user_id || company.legacy_merchant_user_id || 0);
  if (!ownerUserId) return null;
  const [rows] = await db.query(
    `SELECT id AS user_id, nickname, avatar FROM users WHERE id = ? LIMIT 1`,
    [ownerUserId]
  );
  if (!rows[0]) return null;
  return {
    memberId: 0,
    companyId: Number(company.id) || 0,
    userId: rows[0].user_id,
    professionalId: null,
    displayName: rows[0].nickname || '公司负责人',
    avatarUrl: rows[0].avatar || '',
    memberRole: 'owner',
    title: '公司负责人',
    status: 'active',
    professionalBusinesses: [],
    joinedAt: null,
  };
}

async function listCompanyMembersForCompany(company, { limit = 100 } = {}) {
  if (Number(company.id) > 0) {
    const members = await listCompanyMembersById(company.id, { limit });
    if (members.length > 0) return members;
  }
  const fallback = await ownerFallbackMember(company);
  return fallback ? [fallback] : [];
}

async function listCompaniesFromNewTables(req, pageSpec) {
  const publicOnly = req.publicCompanySearch === true;
  const { filterSql, params: filterParams } = await resolveCatalogFilter(req.query);
  const params = [...filterParams];
  let where = `c.status = 'active'`;
  let joins = `
    LEFT JOIN company_businesses cb
      ON cb.company_id = c.id AND cb.status = 'active'
    LEFT JOIN business_catalog bc
      ON bc.id = cb.business_catalog_id AND bc.status = 'active'
    LEFT JOIN business_catalog parent
      ON parent.id = bc.parent_id AND parent.status = 'active'
  `;

  if (filterSql) where += ` ${filterSql}`;
  if (publicOnly) {
    where += ` AND c.verification_status = 'verified'`;
    where += ` AND ${activeCompanyVisibleExistsSql('c.id')}`;
  }
  if (req.query.city) {
    where += ` AND REPLACE(c.city, '市', '') = REPLACE(?, '市', '')`;
    params.push(String(req.query.city));
  }
  if (req.query.keyword) {
    where += ` AND (c.name LIKE ? OR c.intro LIKE ? OR c.service_area LIKE ?)`;
    const keyword = `%${String(req.query.keyword).trim()}%`;
    params.push(keyword, keyword, keyword);
  }

  const [rows] = await db.query(
    `SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
            c.city, c.address, c.contact_phone, c.source, c.legacy_merchant_user_id,
            c.license_url, c.verification_status, c.paid_display_status,
            c.paid_display_starts_at, c.paid_display_ends_at,
            c.rating_avg, c.review_count, c.case_count,
            c.created_at, c.updated_at, c.status,
            COALESCE(
              JSON_ARRAYAGG(
                CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                  'id', bc.id,
                  'code', bc.code,
                  'name', bc.name,
                  'parent_code', parent.code,
                  'parent_name', parent.name,
                  'is_primary', cb.is_primary
                ) END
              ),
              JSON_ARRAY()
            ) AS businesses,
            JSON_ARRAY() AS members
     FROM companies c
     ${joins}
     WHERE ${where}
     GROUP BY c.id
     ORDER BY c.rating_avg DESC, c.review_count DESC, c.case_count DESC,
              c.updated_at DESC, c.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSpec.pageSize, pageSpec.offset]
  );
  return rows.map(mapCompanyRow);
}

async function listProfessionalsFromNewTables(req, pageSpec) {
  const { filterSql, params: filterParams } = await resolveCatalogFilter(req.query);
  const params = [...filterParams];
  let where = `p.status = 'active'`;
  const joins = `
    LEFT JOIN professional_businesses pb
      ON pb.professional_id = p.id AND pb.status = 'active'
    LEFT JOIN business_catalog bc
      ON bc.id = pb.business_catalog_id AND bc.status = 'active'
    LEFT JOIN business_catalog parent
      ON parent.id = bc.parent_id AND parent.status = 'active'
  `;

  if (filterSql) where += ` ${filterSql}`;
  if (req.query.city) {
    where += ` AND REPLACE(p.city, '市', '') = REPLACE(?, '市', '')`;
    params.push(String(req.query.city));
  }
  if (req.query.keyword) {
    where += ` AND (p.display_name LIKE ? OR p.bio LIKE ? OR p.service_area LIKE ?)`;
    const keyword = `%${String(req.query.keyword).trim()}%`;
    params.push(keyword, keyword, keyword);
  }

  const [rows] = await db.query(
    `SELECT p.id, p.user_id, p.display_name, p.avatar_url, p.bio, p.city,
            p.service_area, p.status, p.independent_enabled,
            p.consultation_enabled, p.source, p.legacy_role,
            p.created_at, p.updated_at,
            COALESCE(
              JSON_ARRAYAGG(
                CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                  'id', bc.id,
                  'code', bc.code,
                  'name', bc.name,
                  'parent_code', parent.code,
                  'parent_name', parent.name,
                  'is_primary', pb.is_primary
                ) END
              ),
              JSON_ARRAY()
            ) AS businesses
     FROM professionals p
     ${joins}
     WHERE ${where}
     GROUP BY p.id
     ORDER BY p.updated_at DESC, p.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSpec.pageSize, pageSpec.offset]
  );
  return rows.map(mapProfessionalRow);
}

function businessPayload(item, isPrimary = 1) {
  if (!item) return null;
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    parent_code: item.parent_code,
    parent_name: item.parent_name,
    is_primary: isPrimary,
  };
}

function mapLegacyProfessional(row, businessByCode) {
  const role = row.legacy_role || 'designer';
  const businessCode = role === 'project_supervisor'
    ? 'supervision_service'
    : role === 'project_manager'
    ? 'whole_renovation'
    : 'design_studio';
  const primaryBusiness = businessPayload(businessByCode.get(businessCode), 1);
  const secondaryBusiness = role === 'project_manager'
    ? businessPayload(businessByCode.get('supervision_service'), 0)
    : null;
  return {
    id: -Number(row.user_id) * 10 - (role === 'project_supervisor' ? 3 : role === 'project_manager' ? 2 : 1),
    user_id: row.user_id,
    display_name: row.nickname || '专业人士',
    avatar_url: row.avatar || '',
    bio: row.bio || row.profile_bio || '',
    city: row.city || '',
    service_area: row.service_area || row.city || '',
    status: 'active',
    independent_enabled: true,
    consultation_enabled: Boolean(row.consultation_enabled),
    source: row.source || 'legacy_profile',
    legacy_role: role,
    businesses: [primaryBusiness, secondaryBusiness].filter(Boolean),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listLegacyProfessionals(req, pageSpec) {
  const businessRows = await getBusinessCatalogFlat();
  const byCode = new Map(businessRows.map((item) => [item.code, item]));
  const params = [];
  let userWhere = '1 = 1';
  if (req.query.city) {
    userWhere += ` AND REPLACE(u.city, '市', '') = REPLACE(?, '市', '')`;
    params.push(String(req.query.city));
  }
  if (req.query.keyword) {
    userWhere += ` AND (u.nickname LIKE ? OR u.bio LIKE ?)`;
    const keyword = `%${String(req.query.keyword).trim()}%`;
    params.push(keyword, keyword);
  }

  const [designerRows] = await db.query(
    `SELECT u.id AS user_id, u.nickname, u.avatar, u.bio, u.city,
            dp.service_city AS service_area,
            dp.design_philosophy AS profile_bio,
            dp.consultation_enabled, dp.updated_at,
            'designer' AS legacy_role,
            'legacy_designer_profile' AS source
     FROM designer_profiles dp
     JOIN users u ON u.id = dp.user_id
     WHERE ${userWhere}
     ORDER BY dp.updated_at DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSpec.pageSize, pageSpec.offset]
  );

  const managerParams = [...params];
  const [managerRows] = await db.query(
    `SELECT u.id AS user_id, u.nickname, u.avatar, u.bio, u.city,
            pm.service_area,
            pm.management_philosophy AS profile_bio,
            pm.consultation_enabled, pm.updated_at,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM user_roles ur
                WHERE ur.user_id = u.id AND ur.role = 'project_supervisor'
              ) THEN 'project_supervisor'
              ELSE 'project_manager'
            END AS legacy_role,
            'legacy_project_manager_profile' AS source
     FROM project_manager_profiles pm
     JOIN users u ON u.id = pm.user_id
     WHERE ${userWhere}
     ORDER BY pm.updated_at DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [...managerParams, pageSpec.pageSize, pageSpec.offset]
  );

  const parentCode = req.query.parent_code ? String(req.query.parent_code) : '';
  const businessCode = req.query.business_code ? String(req.query.business_code) : '';
  return [...designerRows, ...managerRows]
    .map((row) => mapLegacyProfessional(row, byCode))
    .filter((professional) => {
      if (businessCode) {
        return professional.businesses.some((item) => item.code === businessCode);
      }
      if (parentCode) {
        return professional.businesses.some((item) => item.parent_code === parentCode);
      }
      return true;
    })
    .slice(0, pageSpec.pageSize);
}

let businessCatalogCache = null;
async function getBusinessCatalogFlat() {
  if (businessCatalogCache) return businessCatalogCache;
  const [rows] = await db.query(
    `SELECT bc.id, bc.code, bc.name, parent.code AS parent_code,
            parent.name AS parent_name
     FROM business_catalog bc
     LEFT JOIN business_catalog parent ON parent.id = bc.parent_id
     WHERE bc.status = 'active'`
  );
  businessCatalogCache = rows;
  return rows;
}

async function listCompanies(req, res) {
  const pageSpec = normalizePage(req.query);
  req.publicCompanySearch = true;
  const items = await listCompaniesFromNewTables(req, pageSpec);
  if (items.length > 0) {
    return success(res, {
      items,
      page: pageSpec.page,
      pageSize: pageSpec.pageSize,
      source: 'companies',
    });
  }

  return success(res, {
    items: [],
    page: pageSpec.page,
    pageSize: pageSpec.pageSize,
    source: 'companies',
  });
}

async function searchPublicCompanies(req, res) {
  const pageSpec = normalizePage(req.query);
  req.publicCompanySearch = true;
  const items = await listCompaniesFromNewTables(req, pageSpec);
  return success(res, {
    items,
    page: pageSpec.page,
    pageSize: pageSpec.pageSize,
    source: 'companies_public',
  });
}

async function listMyCompanies(req, res) {
  const [rows] = await db.query(
    `SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
            c.city, c.address, c.contact_phone, c.status, c.source,
            c.license_url, c.verification_status, c.paid_display_status,
            c.paid_display_starts_at, c.paid_display_ends_at,
            c.rating_avg,
            (
              SELECT COUNT(*)
              FROM company_reviews review_count_review
              WHERE review_count_review.company_id = c.id
                AND review_count_review.status = 1
            ) AS review_count,
            (
              SELECT COUNT(DISTINCT case_count_share.project_id)
              FROM project_case_shares case_count_share
              WHERE case_count_share.status = 1
                AND (
                  EXISTS (
                    SELECT 1
                    FROM project_participants_ext case_count_ppe
                    JOIN renovation_projects case_count_project
                      ON case_count_project.id = case_count_ppe.project_id
                     AND COALESCE(case_count_project.lifecycle_status, 'active') <> 'deleted'
                    WHERE case_count_ppe.project_id = case_count_share.project_id
                      AND case_count_ppe.status <> 'removed'
                      AND (
                        case_count_ppe.company_id = c.id
                        OR (
                          case_count_ppe.participant_type = 'company'
                          AND case_count_ppe.participant_id = c.id
                        )
                      )
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM company_members case_count_cm
                    JOIN project_members case_count_pm
                      ON case_count_pm.user_id = case_count_cm.user_id
                     AND case_count_pm.status = 1
                    JOIN renovation_projects case_count_project
                      ON case_count_project.id = case_count_pm.project_id
                     AND COALESCE(case_count_project.lifecycle_status, 'active') <> 'deleted'
                    WHERE case_count_cm.company_id = c.id
                      AND case_count_cm.status = 'active'
                      AND case_count_pm.project_id = case_count_share.project_id
                  )
                )
            ) AS case_count,
            (
              SELECT COUNT(*)
              FROM company_members member_count_cm
              WHERE member_count_cm.company_id = c.id
                AND member_count_cm.status = 'active'
            ) AS member_count,
            c.legacy_merchant_user_id, c.created_at, c.updated_at,
            cm.member_role,
            COALESCE(
              JSON_ARRAYAGG(
                CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                  'id', bc.id,
                  'code', bc.code,
                  'name', bc.name,
                  'parent_code', parent.code,
                  'parent_name', parent.name,
                  'is_primary', cb.is_primary
                ) END
              ),
              JSON_ARRAY()
            ) AS businesses,
            JSON_ARRAY() AS members
     FROM companies c
     LEFT JOIN company_members cm
       ON cm.company_id = c.id AND cm.user_id = ? AND cm.status = 'active'
     LEFT JOIN company_businesses cb
       ON cb.company_id = c.id AND cb.status = 'active'
     LEFT JOIN business_catalog bc
       ON bc.id = cb.business_catalog_id AND bc.status = 'active'
     LEFT JOIN business_catalog parent
       ON parent.id = bc.parent_id AND parent.status = 'active'
     WHERE c.status <> 'deleted'
       AND (c.owner_user_id = ? OR cm.id IS NOT NULL)
     GROUP BY c.id, cm.member_role
     ORDER BY FIELD(COALESCE(cm.member_role, 'owner'), 'owner', 'admin',
                    'designer', 'supervisor', 'project_manager',
                    'customer_service', 'staff'),
              c.updated_at DESC, c.id DESC`,
    [req.user.id, req.user.id]
  );

  return success(res, rows.map((row) => ({
    ...mapCompanyRow(row),
    memberRole: row.owner_user_id === req.user.id
      ? 'owner'
      : row.member_role || 'staff',
    canManage: row.owner_user_id === req.user.id ||
      ['owner', 'admin'].includes(row.member_role),
  })));
}

async function listMyProjectCompanies(req, res) {
  const [rows] = await db.query(
    `WITH accessible_projects AS (
       SELECT p.id, p.project_name, p.updated_at
       FROM renovation_projects p
       LEFT JOIN project_members pm
         ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
       WHERE COALESCE(p.lifecycle_status, 'active') <> 'deleted'
         AND (p.user_id = ? OR pm.id IS NOT NULL)
     ),
     linked_companies AS (
       SELECT company_id,
              MAX(project_updated_at) AS latest_project_updated_at,
              GROUP_CONCAT(
                project_id ORDER BY project_updated_at DESC
                SEPARATOR '||'
              ) AS project_ids,
              GROUP_CONCAT(
                project_name ORDER BY project_updated_at DESC
                SEPARATOR '||'
              ) AS project_names
       FROM (
         SELECT COALESCE(ppe.company_id, ppe.participant_id) AS company_id,
                ap.id AS project_id,
                COALESCE(NULLIF(ap.project_name, ''), '装修项目') AS project_name,
                ap.updated_at AS project_updated_at
         FROM accessible_projects ap
         JOIN project_participants_ext ppe
           ON ppe.project_id = ap.id
          AND ppe.participant_type = 'company'
          AND ppe.status <> 'removed'
         WHERE COALESCE(ppe.company_id, ppe.participant_id) IS NOT NULL

         UNION ALL

         SELECT cm.company_id AS company_id,
                ap.id AS project_id,
                COALESCE(NULLIF(ap.project_name, ''), '装修项目') AS project_name,
                ap.updated_at AS project_updated_at
         FROM accessible_projects ap
         JOIN project_members project_pm
           ON project_pm.project_id = ap.id
          AND project_pm.status = 1
          AND project_pm.role <> 'merchant'
         JOIN company_members cm
           ON cm.user_id = project_pm.user_id
          AND cm.status = 'active'
       ) sources
       WHERE company_id IS NOT NULL
       GROUP BY company_id
     )
     SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
            c.city, c.address, c.contact_phone, c.status, c.source,
            c.license_url, c.verification_status, c.paid_display_status,
            c.paid_display_starts_at, c.paid_display_ends_at,
            c.rating_avg, c.review_count, c.case_count,
            c.legacy_merchant_user_id, c.created_at, c.updated_at,
            COALESCE(
              JSON_ARRAYAGG(
                CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                  'id', bc.id,
                  'code', bc.code,
                  'name', bc.name,
                  'parent_code', parent.code,
                  'parent_name', parent.name,
                  'is_primary', cb.is_primary
                ) END
              ),
              JSON_ARRAY()
            ) AS businesses,
            JSON_ARRAY() AS members,
            linked.latest_project_updated_at,
            linked.project_ids,
            linked.project_names
     FROM linked_companies linked
     JOIN companies c
       ON c.id = linked.company_id AND c.status <> 'deleted'
     LEFT JOIN company_businesses cb
       ON cb.company_id = c.id AND cb.status = 'active'
     LEFT JOIN business_catalog bc
       ON bc.id = cb.business_catalog_id AND bc.status = 'active'
     LEFT JOIN business_catalog parent
       ON parent.id = bc.parent_id AND parent.status = 'active'
     GROUP BY c.id, linked.latest_project_updated_at
     ORDER BY latest_project_updated_at DESC, c.updated_at DESC, c.id DESC`,
    [req.user.id, req.user.id]
  );

  return success(res, rows.map((row) => ({
    ...mapCompanyRow(row),
    memberRole: 'client',
    canManage: false,
  })));
}

async function createCompany(req, res) {
  const payload = companyPayload(req.body);
  if (!payload.name) return error(res, '请填写公司名称');

  const businessIds = parseBusinessCatalogIds(req.body);
  const validBusinessIds = await validateLeafBusinessCatalogIds(businessIds);
  if (validBusinessIds === null) return error(res, '业务分类不正确');

  const conn = await db.getConnection();
  let companyId;
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO companies
       (owner_user_id, name, logo_url, intro, service_area, city, address,
        contact_phone, license_url, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'manual')`,
      [
        req.user.id,
        payload.name,
        payload.logo_url,
        payload.intro,
        payload.service_area,
        payload.city,
        payload.address,
        payload.contact_phone,
        payload.license_url,
      ]
    );
    companyId = result.insertId;

    await conn.query(
      `INSERT INTO company_members
       (company_id, user_id, member_role, title, status, joined_at)
       VALUES (?, ?, 'owner', '公司负责人', 'active', NOW())
       ON DUPLICATE KEY UPDATE
         status = 'active',
         title = VALUES(title),
         updated_at = CURRENT_TIMESTAMP`,
      [companyId, req.user.id]
    );

    for (let index = 0; index < validBusinessIds.length; index += 1) {
      await conn.query(
        `INSERT INTO company_businesses
         (company_id, business_catalog_id, is_primary, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
           is_primary = VALUES(is_primary),
           status = 'active',
           updated_at = CURRENT_TIMESTAMP`,
        [companyId, validBusinessIds[index], index === 0 ? 1 : 0]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  req.params.id = String(companyId);
  return getCompany(req, res);
}

async function updateCompany(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 0) return error(res, '公司不存在', 404);
  if (!(await canManageCompany(id, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }
  const payload = companyPayload(req.body);
  if (!payload.name) return error(res, '请填写公司名称');

  const [companyRows] = await db.query(
    'SELECT logo_url, license_url FROM companies WHERE id = ? AND status <> \'deleted\' LIMIT 1',
    [id]
  );
  if (!companyRows[0]) return error(res, '公司不存在', 404);
  const imageFieldsChanged =
    valuesDiffer(payload.logo_url, companyRows[0].logo_url) ||
    valuesDiffer(payload.license_url, companyRows[0].license_url);

  await db.query(
    `UPDATE companies
     SET name = ?, logo_url = ?, intro = ?, service_area = ?, city = ?,
         address = ?, contact_phone = ?, license_url = ?,
         verification_status = CASE
           WHEN ? THEN 'pending'
           ELSE verification_status
         END
     WHERE id = ? AND status <> 'deleted'`,
    [
      payload.name,
      payload.logo_url,
      payload.intro,
      payload.service_area,
      payload.city,
      payload.address,
      payload.contact_phone,
      payload.license_url,
      imageFieldsChanged ? 1 : 0,
      id,
    ]
  );

  return getCompany(req, res);
}

async function uploadCompanyImage(req, res) {
  if (!req.file) return error(res, '请选择公司图片');
  const imageUrl = `${req.protocol}://${req.get('host')}/api/uploads/company-profiles/${req.file.filename}`;
  return success(res, { url: imageUrl }, '图片上传成功');
}

async function listCompanyBusinesses(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 0) return error(res, '公司不存在', 404);
  if (!(await canManageCompany(id, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }
  const [rows] = await db.query(
    `SELECT bc.id, bc.code, bc.name, parent.code AS parent_code,
            parent.name AS parent_name, cb.is_primary
     FROM company_businesses cb
     JOIN business_catalog bc ON bc.id = cb.business_catalog_id
     LEFT JOIN business_catalog parent ON parent.id = bc.parent_id
     WHERE cb.company_id = ? AND cb.status = 'active'
       AND bc.status = 'active'
     ORDER BY cb.is_primary DESC, parent.sort_order ASC, bc.sort_order ASC, bc.id ASC`,
    [id]
  );
  return success(res, rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    parent_code: row.parent_code || '',
    parent_name: row.parent_name || '',
    is_primary: row.is_primary,
  })));
}

async function updateCompanyBusinesses(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 0) return error(res, '公司不存在', 404);
  if (!(await canManageCompany(id, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }

  const businessIds = parseBusinessCatalogIds(req.body);
  if (businessIds.length === 0) return error(res, '请选择主营业务');

  const validBusinessIds = await validateLeafBusinessCatalogIds(businessIds);
  if (validBusinessIds === null) return error(res, '业务分类不正确');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE company_businesses
       SET status = 'inactive', is_primary = 0
       WHERE company_id = ?`,
      [id]
    );
    for (let index = 0; index < validBusinessIds.length; index += 1) {
      await conn.query(
        `INSERT INTO company_businesses
         (company_id, business_catalog_id, is_primary, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
           is_primary = VALUES(is_primary),
           status = 'active',
           updated_at = CURRENT_TIMESTAMP`,
        [id, validBusinessIds[index], index === 0 ? 1 : 0]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  req.params.id = String(id);
  return getCompany(req, res);
}

async function listProfessionals(req, res) {
  const pageSpec = normalizePage(req.query);
  const items = await listProfessionalsFromNewTables(req, pageSpec);
  if (items.length > 0) {
    return success(res, {
      items,
      page: pageSpec.page,
      pageSize: pageSpec.pageSize,
      source: 'professionals',
    });
  }

  const legacyItems = await listLegacyProfessionals(req, pageSpec);
  return success(res, {
    items: legacyItems,
    page: pageSpec.page,
    pageSize: pageSpec.pageSize,
    source: 'legacy_profiles',
  });
}

async function listMarketplaceSearch(req, res) {
  const pageSpec = normalizePage(req.query);
  const entityType = ['all', 'company', 'professional'].includes(req.query.entity_type)
    ? req.query.entity_type
    : 'all';
  const businessCode = req.query.business_code ? String(req.query.business_code) : '';
  const parentCode = req.query.parent_code ? String(req.query.parent_code) : '';
  const canShowProfessionals = entityType === 'professional'
    || (
      entityType === 'all'
      && (
        businessCode === 'design_studio'
        || businessCode === 'supervision_service'
        || (!businessCode && !parentCode)
      )
    );
  const canShowCompanies = entityType === 'company' || entityType === 'all';

  let companies = [];
  let professionals = [];
  let companySource = '';
  let professionalSource = '';

  if (canShowCompanies) {
    req.publicCompanySearch = true;
    companies = await listCompaniesFromNewTables(req, pageSpec);
    companySource = 'companies';
  }

  if (canShowProfessionals) {
    professionals = await listProfessionalsFromNewTables(req, pageSpec);
    professionalSource = 'professionals';
    if (professionals.length === 0) {
      professionals = await listLegacyProfessionals(req, pageSpec);
      professionalSource = 'legacy_profiles';
    }
  }

  const companyItems = companies.map(mapCompanySearchItem);
  const professionalItems = professionals.map(mapProfessionalSearchItem);
  const mergedItems = companyItems.length > 0 && professionalItems.length > 0
    ? mergeSearchItems(companyItems, professionalItems)
    : [...companyItems, ...professionalItems];
  const items = mergedItems.slice(0, pageSpec.pageSize);

  return success(res, {
    items,
    pagination: {
      page: pageSpec.page,
      pageSize: pageSpec.pageSize,
      hasMore: items.length >= pageSpec.pageSize,
    },
    source: entityType === 'company'
      ? companySource
      : entityType === 'professional'
      ? professionalSource
      : 'companies_professionals',
  });
}

async function getCompany(req, res) {
  const id = Number(req.params.id);
  if (!id) return error(res, '公司不存在', 404);

  if (id > 0) {
    const [rows] = await db.query(
      `SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
              c.city, c.address, c.contact_phone, c.status, c.source,
              c.license_url, c.verification_status, c.paid_display_status,
              c.paid_display_starts_at, c.paid_display_ends_at,
              c.rating_avg, c.review_count, c.case_count,
              c.legacy_merchant_user_id, c.created_at, c.updated_at,
              COALESCE(
                JSON_ARRAYAGG(
                  CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                    'id', bc.id,
                    'code', bc.code,
                    'name', bc.name,
                    'parent_code', parent.code,
                    'parent_name', parent.name,
                    'is_primary', cb.is_primary
                  ) END
                ),
                JSON_ARRAY()
              ) AS businesses,
              JSON_ARRAY() AS members
       FROM companies c
       LEFT JOIN company_businesses cb
         ON cb.company_id = c.id AND cb.status = 'active'
       LEFT JOIN business_catalog bc
         ON bc.id = cb.business_catalog_id AND bc.status = 'active'
       LEFT JOIN business_catalog parent
         ON parent.id = bc.parent_id AND parent.status = 'active'
       WHERE c.id = ? AND c.status <> 'deleted'
       GROUP BY c.id`,
      [id]
    );
    if (!rows[0]) return error(res, '公司不存在', 404);
    const company = mapCompanyRow(rows[0]);
    company.owner_user_id = rows[0].owner_user_id || null;
    company.members = await listCompanyMembersForCompany(company, { limit: 5 });
    return success(res, company);
  }

  return error(res, '公司不存在', 404);
}

async function getPublicCompany(req, res) {
  const id = Number(req.params.id);
  if (!id || id < 0) return error(res, '公司不存在', 404);

  const [rows] = await db.query(
    `SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
            c.city, c.address, c.contact_phone, c.status, c.source,
            c.license_url, c.verification_status, c.paid_display_status,
            c.paid_display_starts_at, c.paid_display_ends_at,
            c.rating_avg, c.review_count, c.case_count,
            c.legacy_merchant_user_id, c.created_at, c.updated_at,
            COALESCE(
              JSON_ARRAYAGG(
                CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                  'id', bc.id,
                  'code', bc.code,
                  'name', bc.name,
                  'parent_code', parent.code,
                  'parent_name', parent.name,
                  'is_primary', cb.is_primary
                ) END
              ),
              JSON_ARRAY()
            ) AS businesses,
            JSON_ARRAY() AS members
     FROM companies c
     LEFT JOIN company_businesses cb
       ON cb.company_id = c.id AND cb.status = 'active'
     LEFT JOIN business_catalog bc
       ON bc.id = cb.business_catalog_id AND bc.status = 'active'
     LEFT JOIN business_catalog parent
       ON parent.id = bc.parent_id AND parent.status = 'active'
     WHERE c.id = ?
       AND c.status = 'active'
       AND c.verification_status = 'verified'
       AND ${activeCompanyVisibleExistsSql('c.id')}
     GROUP BY c.id`,
    [id]
  );
  if (!rows[0]) return error(res, '公司不存在', 404);
  const company = mapCompanyRow(rows[0]);
  company.owner_user_id = rows[0].owner_user_id || null;
  company.members = await listCompanyMembersForCompany(company, { limit: 6 });
  return success(res, company);
}

async function listPublicCompanyCaseShares(req, res) {
  const companyId = Number(req.params.id);
  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);

  const [companyRows] = await db.query(
    `SELECT id FROM companies
     WHERE id = ?
       AND status = 'active'
       AND verification_status = 'verified'
     LIMIT 1`,
    [companyId]
  );
  if (!companyRows[0]) return error(res, '公司不存在', 404);

  const companyProjectsCte = `WITH company_projects AS (
    SELECT DISTINCT ppe.project_id
    FROM project_participants_ext ppe
    JOIN renovation_projects p
      ON p.id = ppe.project_id
     AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
    WHERE ppe.status <> 'removed'
      AND (
        ppe.company_id = ?
        OR (ppe.participant_type = 'company' AND ppe.participant_id = ?)
      )

    UNION

    SELECT DISTINCT pm.project_id
    FROM company_members cm
    JOIN project_members pm
      ON pm.user_id = cm.user_id AND pm.status = 1
    JOIN renovation_projects p
      ON p.id = pm.project_id
     AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
    WHERE cm.company_id = ? AND cm.status = 'active'
  )`;

  const [[participatedRow]] = await db.query(
    `${companyProjectsCte}
     SELECT COUNT(*) AS total FROM company_projects`,
    [companyId, companyId, companyId]
  );

  const [[authorizedRow]] = await db.query(
    `${companyProjectsCte}
     SELECT COUNT(DISTINCT share.project_id) AS total
     FROM project_case_shares share
     JOIN company_projects cp ON cp.project_id = share.project_id
     WHERE share.status = 1`,
    [companyId, companyId, companyId]
  );

  const [rows] = await db.query(
    `${companyProjectsCte}
     SELECT share.id, share.project_id, p.project_name,
            share.designer_id, share.owner_id, share.title, share.style,
            share.summary, share.highlights, share.image_urls,
            share.visible_fields, share.reviewed_at, share.created_at,
            share.updated_at,
            designer.nickname AS designer_name,
            owner.nickname AS owner_name
     FROM project_case_shares share
     JOIN company_projects cp ON cp.project_id = share.project_id
     JOIN renovation_projects p ON p.id = share.project_id
     JOIN users designer ON designer.id = share.designer_id
     JOIN users owner ON owner.id = share.owner_id
     WHERE share.status = 1
     ORDER BY COALESCE(share.reviewed_at, share.updated_at) DESC,
              share.id DESC
     LIMIT 50`,
    [companyId, companyId, companyId]
  );

  return success(res, {
    participated_project_count: Number(participatedRow?.total || 0),
    authorized_project_count: Number(authorizedRow?.total || 0),
    items: rows.map(mapCompanyCaseShareRow),
  });
}

async function listPublicCompanyReviews(req, res) {
  const companyId = Number(req.params.id);
  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);

  const [companyRows] = await db.query(
    `SELECT id FROM companies
     WHERE id = ?
       AND status = 'active'
       AND verification_status = 'verified'
     LIMIT 1`,
    [companyId]
  );
  if (!companyRows[0]) return error(res, '公司不存在', 404);

  const [rows] = await db.query(
    `SELECT review.id, review.company_id, review.project_id,
            review.reviewer_user_id, review.rating, review.content,
            review.created_at, review.updated_at,
            reviewer.nickname AS reviewer_name,
            reviewer.avatar AS reviewer_avatar,
            project.project_name
     FROM company_reviews review
     LEFT JOIN users reviewer ON reviewer.id = review.reviewer_user_id
     LEFT JOIN renovation_projects project ON project.id = review.project_id
     WHERE review.company_id = ? AND review.status = 1
     ORDER BY review.created_at DESC, review.id DESC
     LIMIT 100`,
    [companyId]
  );

  return success(res, rows.map(mapCompanyReviewRow));
}

async function isCompanyLinkedToProject(companyId, projectId) {
  const [participantRows] = await db.query(
    `SELECT id
     FROM project_participants_ext
     WHERE project_id = ?
       AND status <> 'removed'
       AND (
         company_id = ?
         OR (participant_type = 'company' AND participant_id = ?)
       )
     LIMIT 1`,
    [projectId, companyId, companyId]
  );
  if (participantRows[0]) return true;

  const [memberRows] = await db.query(
    `SELECT pm.id
     FROM company_members cm
     JOIN project_members pm
       ON pm.user_id = cm.user_id AND pm.status = 1
     WHERE cm.company_id = ?
       AND cm.status = 'active'
       AND pm.project_id = ?
     LIMIT 1`,
    [companyId, projectId]
  );
  return Boolean(memberRows[0]);
}

async function refreshCompanyReviewStats(companyId) {
  const [[stats]] = await db.query(
    `SELECT COUNT(*) AS review_count, AVG(rating) AS rating_avg
     FROM company_reviews
     WHERE company_id = ? AND status = 1`,
    [companyId]
  );
  await db.query(
    `UPDATE companies
     SET review_count = ?, rating_avg = ?
     WHERE id = ?`,
    [
      Number(stats?.review_count || 0),
      Number(stats?.rating_avg || 0).toFixed(2),
      companyId,
    ]
  );
}

async function submitCompanyReview(req, res) {
  return error(res, '公司评价体系已升级，请使用四维评价入口', 410);
}

const evaluationDimensions = {
  communication: { label: '沟通体验', source: '用户评价 + 系统行为数据' },
  materials: { label: '材料管理', source: '用户评价 + 系统行为数据' },
  progress: { label: '项目推进', source: '用户评价 + 系统行为数据' },
  problem_handling: { label: '问题处理', source: '用户评价 + 系统行为数据' },
};

function boundedScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Math.max(1, Math.min(5, Number(value)));
}

function scoreFromRatio(ratio) {
  if (ratio === null || ratio === undefined || Number.isNaN(Number(ratio))) return null;
  return boundedScore(1 + Number(ratio) * 4);
}

function combineScores(systemScore, userScore) {
  const system = boundedScore(systemScore);
  const user = boundedScore(userScore);
  if (system !== null && user !== null) return Number((system * 0.7 + user * 0.3).toFixed(2));
  if (system !== null) return Number(system.toFixed(2));
  if (user !== null) return Number(user.toFixed(2));
  return null;
}

function percent(numerator, denominator) {
  const total = Number(denominator || 0);
  if (total <= 0) return null;
  return Number(numerator || 0) / total;
}

async function linkedProjectIdsForCompany(companyId, projectId = null) {
  const params = [companyId, companyId];
  let projectFilter = '';
  if (projectId) {
    projectFilter = 'AND p.id = ?';
    params.push(projectId);
  }
  const [rows] = await db.query(
    `SELECT DISTINCT p.id
     FROM renovation_projects p
     JOIN project_participants_ext ppe
       ON ppe.project_id = p.id
      AND ppe.status <> 'removed'
      AND (
        ppe.company_id = ?
        OR (ppe.participant_type = 'company' AND ppe.participant_id = ?)
      )
     WHERE COALESCE(p.lifecycle_status, 'active') <> 'deleted'
       ${projectFilter}`,
    params
  );
  return rows.map((row) => Number(row.id)).filter(Boolean);
}

async function companyMemberUserIds(companyId) {
  const [rows] = await db.query(
    `SELECT user_id FROM company_members
     WHERE company_id = ? AND status = 'active'`,
    [companyId]
  );
  return rows.map((row) => Number(row.user_id)).filter(Boolean);
}

async function calculateProblemHandlingSystemScore(companyId, projectId = null) {
  const projectIds = await linkedProjectIdsForCompany(companyId, projectId);
  const memberIds = await companyMemberUserIds(companyId);
  if (!projectIds.length || !memberIds.length) {
    return { score: null, metrics: { total_items: 0 } };
  }
  const [rows] = await db.query(
    `SELECT COUNT(DISTINCT item.id) AS total_items,
            COUNT(DISTINCT CASE WHEN item.status = 'completed' THEN item.id END) AS completed_items,
            COUNT(DISTINCT CASE WHEN item.status = 'pending' AND item.due_date < CURDATE() THEN item.id END) AS overdue_items,
            AVG(
              CASE WHEN completed_feedback.created_at IS NOT NULL
                   THEN TIMESTAMPDIFF(HOUR, item.created_at, completed_feedback.created_at)
                   ELSE NULL
              END
            ) AS avg_resolution_hours,
            COUNT(DISTINCT CASE
              WHEN item.status = 'completed'
               AND completed_feedback.created_at IS NOT NULL
               AND DATE(completed_feedback.created_at) <= item.due_date
              THEN item.id END
            ) AS on_time_items
     FROM project_action_items item
     JOIN project_action_item_assignees assignee
       ON assignee.item_id = item.id AND assignee.user_id IN (?)
     LEFT JOIN (
       SELECT item_id, MIN(created_at) AS created_at
       FROM project_action_item_feedback
       WHERE result = 'completed'
       GROUP BY item_id
     ) completed_feedback ON completed_feedback.item_id = item.id
     WHERE item.project_id IN (?)`,
    [memberIds, projectIds]
  );
  const stats = rows[0] || {};
  const total = Number(stats.total_items || 0);
  if (!total) return { score: null, metrics: { total_items: 0 } };
  const completionRate = percent(stats.completed_items, total);
  const onTimeRate = percent(stats.on_time_items, total);
  const overdueRate = percent(stats.overdue_items, total);
  const avgHours = Number(stats.avg_resolution_hours || 0);
  const avgTimeScore = avgHours > 0 ? Math.max(0, Math.min(1, 1 - avgHours / 168)) : null;
  const weighted =
    (completionRate ?? 0) * 0.35 +
    (onTimeRate ?? 0) * 0.35 +
    (1 - (overdueRate ?? 0)) * 0.2 +
    (avgTimeScore ?? 0.6) * 0.1;
  return {
    score: scoreFromRatio(weighted),
    metrics: {
      total_items: total,
      completion_rate: completionRate,
      on_time_rate: onTimeRate,
      overdue_rate: overdueRate,
      avg_resolution_hours: avgHours || null,
    },
  };
}

async function calculateMaterialsSystemScore(companyId, projectId = null) {
  const projectIds = await linkedProjectIdsForCompany(companyId, projectId);
  if (!projectIds.length) return { score: null, metrics: { total_items: 0 } };
  const [rows] = await db.query(
    `SELECT COUNT(*) AS total_items,
            SUM(CASE WHEN confirm_status IN ('confirmed', 'approved') THEN 1 ELSE 0 END) AS confirmed_items,
            SUM(CASE WHEN arrival_status IN ('arrived', 'completed', 'delivered') THEN 1 ELSE 0 END) AS arrived_items,
            SUM(CASE
              WHEN name <> ''
               AND category <> ''
               AND (brand_model IS NOT NULL AND brand_model <> '')
               AND quantity IS NOT NULL
              THEN 1 ELSE 0 END
            ) AS complete_items,
            AVG(CASE
              WHEN budget_unit_price IS NOT NULL AND budget_unit_price > 0
               AND actual_unit_price IS NOT NULL
              THEN ABS(actual_unit_price - budget_unit_price) / budget_unit_price
              ELSE NULL END
            ) AS avg_price_variance
     FROM project_material_items
     WHERE project_id IN (?)`,
    [projectIds]
  );
  const stats = rows[0] || {};
  const total = Number(stats.total_items || 0);
  if (!total) return { score: null, metrics: { total_items: 0 } };
  const confirmedRate = percent(stats.confirmed_items, total);
  const arrivedRate = percent(stats.arrived_items, total);
  const completeRate = percent(stats.complete_items, total);
  const variance = stats.avg_price_variance === null ? null : Number(stats.avg_price_variance);
  const priceScore = variance === null ? 0.7 : Math.max(0, Math.min(1, 1 - variance));
  const weighted =
    (completeRate ?? 0) * 0.35 +
    (confirmedRate ?? 0) * 0.25 +
    (arrivedRate ?? 0) * 0.25 +
    priceScore * 0.15;
  return {
    score: scoreFromRatio(weighted),
    metrics: {
      total_items: total,
      complete_rate: completeRate,
      confirmed_rate: confirmedRate,
      arrived_rate: arrivedRate,
      avg_price_variance: variance,
    },
  };
}

async function calculateProgressSystemScore(companyId, projectId = null) {
  const projectIds = await linkedProjectIdsForCompany(companyId, projectId);
  if (!projectIds.length) return { score: null, metrics: { total_items: 0 } };
  const [[progressStats]] = await db.query(
    `SELECT COUNT(*) AS total_items,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_items,
            SUM(CASE
              WHEN status = 'completed'
               AND actual_finish IS NOT NULL
               AND planned_end IS NOT NULL
               AND actual_finish <= planned_end
              THEN 1 ELSE 0 END
            ) AS on_time_items,
            SUM(CASE WHEN status = 'delayed' THEN 1 ELSE 0 END) AS delayed_items
     FROM project_progress_items
     WHERE project_id IN (?)`,
    [projectIds]
  );
  const [[taskStats]] = await db.query(
    `SELECT COUNT(*) AS total_items,
            SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS completed_items,
            SUM(CASE
              WHEN status = 2
               AND actual_end IS NOT NULL
               AND planned_end IS NOT NULL
               AND actual_end <= planned_end
              THEN 1 ELSE 0 END
            ) AS on_time_items,
            SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) AS delayed_items
     FROM renovation_tasks
     WHERE project_id IN (?)`,
    [projectIds]
  );
  const total = Number(progressStats?.total_items || 0) + Number(taskStats?.total_items || 0);
  if (!total) return { score: null, metrics: { total_items: 0 } };
  const completedItems = Number(progressStats?.completed_items || 0) + Number(taskStats?.completed_items || 0);
  const onTimeItems = Number(progressStats?.on_time_items || 0) + Number(taskStats?.on_time_items || 0);
  const delayedItems = Number(progressStats?.delayed_items || 0) + Number(taskStats?.delayed_items || 0);
  const completionRate = percent(completedItems, total);
  const onTimeRate = percent(onTimeItems, total);
  const delayedRate = percent(delayedItems, total);
  const weighted =
    (completionRate ?? 0) * 0.45 +
    (onTimeRate ?? 0) * 0.35 +
    (1 - (delayedRate ?? 0)) * 0.2;
  return {
    score: scoreFromRatio(weighted),
    metrics: {
      total_items: total,
      completion_rate: completionRate,
      on_time_rate: onTimeRate,
      delayed_rate: delayedRate,
    },
  };
}

async function calculateCommunicationSystemScore(companyId, projectId = null) {
  const params = [companyId];
  let projectJoin = '';
  if (projectId) {
    projectJoin = `
      JOIN entity_relations relation
        ON relation.source_type = 'consultation'
       AND relation.source_id = c.id
       AND relation.target_type = 'project'
       AND relation.target_id = ?`;
    params.unshift(projectId);
  }
  const [rows] = await db.query(
    `SELECT COUNT(DISTINCT c.id) AS consultation_count,
            COUNT(m.id) AS message_count
     FROM consultation_targets target
     LEFT JOIN designer_consultations c
       ON c.id = target.consultation_id
     ${projectJoin}
     LEFT JOIN consultation_messages m
       ON m.consultation_id = c.id
     WHERE target.target_type = 'company'
       AND target.target_id = ?`,
    params
  );
  const stats = rows[0] || {};
  const consultationCount = Number(stats.consultation_count || 0);
  const messageCount = Number(stats.message_count || 0);
  if (!consultationCount && !messageCount) {
    return { score: null, metrics: { consultation_count: 0, message_count: 0 } };
  }
  const activityRatio = Math.min(1, messageCount / Math.max(consultationCount * 4, 1));
  return {
    score: scoreFromRatio(activityRatio),
    metrics: {
      consultation_count: consultationCount,
      message_count: messageCount,
    },
  };
}

async function userFeedbackAverage(companyId, dimension, projectId = null) {
  const params = [companyId, dimension];
  let projectFilter = '';
  if (projectId) {
    projectFilter = 'AND project_id = ?';
    params.push(projectId);
  }
  const [[row]] = await db.query(
    `SELECT AVG(score) AS avg_score, COUNT(*) AS feedback_count
     FROM company_evaluation_feedback
     WHERE company_id = ?
       AND dimension = ?
       AND status = 1
       ${projectFilter}`,
    params
  );
  return {
    score: row?.avg_score === null || row?.avg_score === undefined
      ? null
      : Number(row.avg_score),
    count: Number(row?.feedback_count || 0),
  };
}

async function calculateDimension(companyId, dimension, projectId = null) {
  const calculators = {
    communication: calculateCommunicationSystemScore,
    materials: calculateMaterialsSystemScore,
    progress: calculateProgressSystemScore,
    problem_handling: calculateProblemHandlingSystemScore,
  };
  const [system, user] = await Promise.all([
    calculators[dimension](companyId, projectId),
    userFeedbackAverage(companyId, dimension, projectId),
  ]);
  return {
    key: dimension,
    label: evaluationDimensions[dimension].label,
    source: evaluationDimensions[dimension].source,
    score: combineScores(system.score, user.score),
    system_score: system.score === null ? null : Number(system.score.toFixed(2)),
    user_score: user.score === null ? null : Number(user.score.toFixed(2)),
    feedback_count: user.count,
    metrics: system.metrics,
  };
}

async function buildCompanyEvaluationSummary(companyId, projectId = null) {
  const entries = await Promise.all(
    Object.keys(evaluationDimensions).map((dimension) =>
      calculateDimension(companyId, dimension, projectId)
    )
  );
  return {
    company_id: companyId,
    project_id: projectId || null,
    dimensions: entries,
  };
}

async function getCompanyEvaluationSummary(req, res) {
  const companyId = Number(req.params.id);
  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);
  const [companyRows] = await db.query(
    `SELECT id FROM companies
     WHERE id = ?
       AND status = 'active'
       AND verification_status = 'verified'
     LIMIT 1`,
    [companyId]
  );
  if (!companyRows[0]) return error(res, '公司不存在', 404);
  return success(res, await buildCompanyEvaluationSummary(companyId));
}

async function getProjectCompanyEvaluation(req, res) {
  const projectId = Number(req.params.projectId);
  const companyId = Number(req.params.companyId);
  if (!projectId || !companyId) return error(res, '项目或公司不存在', 404);
  const projectContext = await requireProjectContext(req, res, {
    missingMessage: '项目评价必须携带有效 project_id',
  });
  if (!projectContext.ok) return projectContext.response;
  if (Number(projectContext.projectId) !== projectId) return error(res, '项目上下文不一致', 403);
  const linked = await isCompanyLinkedToProject(companyId, projectId);
  if (!linked) return error(res, '该项目未关联这家装修公司', 403);
  return success(res, await buildCompanyEvaluationSummary(companyId, projectId));
}

async function submitCompanyEvaluationFeedback(req, res) {
  const projectId = Number(req.params.projectId);
  const companyId = Number(req.params.companyId);
  const dimension = String(req.body?.dimension || '').trim();
  const score = Number(req.body?.score);
  const comment = String(req.body?.comment_private || '').trim().slice(0, 300);
  if (!projectId || !companyId) return error(res, '项目或公司不存在', 404);
  if (!evaluationDimensions[dimension]) return error(res, '评价维度不正确', 400);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return error(res, '请选择 1-5 分评价', 400);
  }
  const projectContext = await requireProjectContext(req, res, {
    missingMessage: '项目评价必须携带有效 project_id',
  });
  if (!projectContext.ok) return projectContext.response;
  if (Number(projectContext.projectId) !== projectId) return error(res, '项目上下文不一致', 403);
  if (!(await isCompanyLinkedToProject(companyId, projectId))) {
    return error(res, '该项目未关联这家装修公司，不能评价', 403);
  }
  await db.query(
    `INSERT INTO company_evaluation_feedback
       (company_id, project_id, reviewer_user_id, dimension, score,
        comment_private, source_scene, status)
     VALUES (?, ?, ?, ?, ?, ?, 'project', 1)
     ON DUPLICATE KEY UPDATE
       score = VALUES(score),
       comment_private = VALUES(comment_private),
       status = 1,
       updated_at = CURRENT_TIMESTAMP`,
    [companyId, projectId, req.user.id, dimension, score, comment || null]
  );
  return success(res, await buildCompanyEvaluationSummary(companyId, projectId), '评价已提交');
}

async function submitConsultationEvaluationFeedback(req, res) {
  const consultationId = Number(req.params.id);
  const dimension = 'communication';
  const score = Number(req.body?.score);
  const comment = String(req.body?.comment_private || '').trim().slice(0, 300);
  if (!consultationId) return error(res, '咨询不存在', 404);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return error(res, '请选择 1-5 分评价', 400);
  }
  const [rows] = await db.query(
    `SELECT target.target_id AS company_id,
            relation.target_id AS project_id,
            c.user_id,
            c.designer_id
     FROM consultation_targets target
     LEFT JOIN designer_consultations c ON c.id = target.consultation_id
     LEFT JOIN entity_relations relation
       ON relation.source_type = 'consultation'
      AND relation.source_id = c.id
      AND relation.target_type = 'project'
     WHERE (target.consultation_id = ? OR target.id = ?)
       AND target.target_type = 'company'
     LIMIT 1`,
    [consultationId, consultationId]
  );
  const row = rows[0];
  if (!row) return error(res, '咨询不存在或未关联装修公司', 404);
  if (
    row.user_id &&
    row.designer_id &&
    Number(req.user.id) !== Number(row.user_id) &&
    Number(req.user.id) !== Number(row.designer_id)
  ) {
    return error(res, '无权限评价该咨询', 403);
  }
  await db.query(
    `INSERT INTO company_evaluation_feedback
       (company_id, project_id, consultation_id, reviewer_user_id, dimension,
        score, comment_private, source_scene, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'consultation', 1)
     ON DUPLICATE KEY UPDATE
       score = VALUES(score),
       comment_private = VALUES(comment_private),
       status = 1,
       updated_at = CURRENT_TIMESTAMP`,
    [
      Number(row.company_id),
      row.project_id || null,
      consultationId,
      req.user.id,
      dimension,
      score,
      comment || null,
    ]
  );
  return success(res, await buildCompanyEvaluationSummary(Number(row.company_id)), '评价已提交');
}

async function submitCompanyReviewLegacyDisabled(req, res) {
  const companyId = Number(req.params.id);
  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);

  const projectId = req.projectContext?.projectId;
  if (!projectId) return error(res, '请选择装修项目后再评价', 400);

  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return error(res, '请选择 1-5 星评分', 400);
  }

  const content = String(req.body?.content || '').trim();
  if (content.length < 2) return error(res, '评价内容至少填写 2 个字', 400);
  if (content.length > 300) return error(res, '评价内容最多 300 字', 400);

  const [companyRows] = await db.query(
    `SELECT id FROM companies
     WHERE id = ? AND status <> 'deleted'
     LIMIT 1`,
    [companyId]
  );
  if (!companyRows[0]) return error(res, '公司不存在', 404);

  const linked = await isCompanyLinkedToProject(companyId, projectId);
  if (!linked) return error(res, '该项目未关联这家装修公司，不能评价', 403);

  const [existingRows] = await db.query(
    `SELECT id
     FROM company_reviews
     WHERE company_id = ?
       AND project_id = ?
       AND reviewer_user_id = ?
     LIMIT 1`,
    [companyId, projectId, req.user.id]
  );

  if (existingRows[0]) {
    await db.query(
      `UPDATE company_reviews
       SET rating = ?, content = ?, status = 1, updated_at = NOW()
       WHERE id = ?`,
      [rating, content, existingRows[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO company_reviews
         (company_id, project_id, reviewer_user_id, rating, content, status)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [companyId, projectId, req.user.id, rating, content]
    );
  }

  await refreshCompanyReviewStats(companyId);
  return success(res, null, '评价已提交');
}

async function listCompanyMembers(req, res) {
  const id = Number(req.params.id);
  if (!id) return error(res, '公司不存在', 404);

  if (id > 0) {
    const [rows] = await db.query(
      `SELECT id, owner_user_id, legacy_merchant_user_id
       FROM companies
       WHERE id = ? AND status <> 'deleted'
       LIMIT 1`,
      [id]
    );
    if (!rows[0]) return error(res, '公司不存在', 404);
    const members = await listCompanyMembersForCompany(rows[0]);
    return success(res, members);
  }

  return error(res, '公司不存在', 404);
}

async function searchCompanyMemberCandidates(req, res) {
  const companyId = Number(req.params.id);
  const phone = String(req.query.phone || req.query.keyword || '').trim();

  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return error(res, '请输入完整手机号');
  }

  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.phone, u.nickname, u.avatar, u.city,
            cm.id AS member_id, cm.member_role,
            prof.id AS professional_id,
            prof.display_name AS professional_name,
            prof.avatar_url AS professional_avatar_url
     FROM users u
     LEFT JOIN company_members cm
       ON cm.company_id = ? AND cm.user_id = u.id AND cm.status = 'active'
     LEFT JOIN professionals prof
       ON prof.user_id = u.id AND prof.status <> 'deleted'
     WHERE u.phone = ?
     ORDER BY
       CASE WHEN cm.id IS NULL THEN 1 ELSE 0 END ASC,
       prof.id DESC
     LIMIT 5`,
    [companyId, phone]
  );

  const byUser = new Map();
  for (const row of rows) {
    const candidate = mapCompanyMemberCandidateRow(row);
    const existing = byUser.get(candidate.userId);
    if (!existing || (!existing.professionalId && candidate.professionalId)) {
      byUser.set(candidate.userId, candidate);
    }
  }

  return success(res, [...byUser.values()]);
}

async function listCompanyProjects(req, res) {
  const companyId = Number(req.params.id);
  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限查看该公司项目', 403);
  }

  const [extRows] = await db.query(
    `SELECT p.id AS project_id, p.project_code, p.project_name, p.house_area,
            p.current_stage, p.lifecycle_status,
            ppe.role_type, ppe.status AS participant_status,
            'project_participants_ext' AS source,
            COALESCE(ppe.user_id, prof.user_id) AS responsible_user_id,
            COALESCE(u.nickname, prof.display_name) AS responsible_name,
            COALESCE(u.avatar, prof.avatar_url) AS responsible_avatar,
            ppe.created_at AS joined_at, p.updated_at
     FROM project_participants_ext ppe
     JOIN renovation_projects p
       ON p.id = ppe.project_id
      AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
     LEFT JOIN professionals prof ON prof.id = ppe.professional_id
     LEFT JOIN users u ON u.id = COALESCE(ppe.user_id, prof.user_id)
     WHERE ppe.status <> 'removed'
       AND (
         ppe.company_id = ?
         OR (ppe.participant_type = 'company' AND ppe.participant_id = ?)
       )
     ORDER BY p.updated_at DESC, p.id DESC`,
    [companyId, companyId]
  );

  const [inferredRows] = await db.query(
    `SELECT DISTINCT p.id AS project_id, p.project_code, p.project_name,
            p.house_area, p.current_stage, p.lifecycle_status,
            CASE cm.member_role
              WHEN 'designer' THEN 'designer'
              WHEN 'supervisor' THEN 'supervisor'
              WHEN 'project_manager' THEN 'pm'
              ELSE 'contractor'
            END AS role_type,
            'active' AS participant_status,
            'inferred_company_member' AS source,
            cm.user_id AS responsible_user_id,
            u.nickname AS responsible_name,
            u.avatar AS responsible_avatar,
            pm.joined_at, p.updated_at
     FROM company_members cm
     JOIN project_members pm
       ON pm.user_id = cm.user_id AND pm.status = 1
     JOIN renovation_projects p
       ON p.id = pm.project_id
      AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
     JOIN users u ON u.id = cm.user_id
     WHERE cm.company_id = ? AND cm.status = 'active'
     ORDER BY p.updated_at DESC, p.id DESC`,
    [companyId]
  );

  const byProject = new Map();
  for (const row of inferredRows.map(mapCompanyProjectRow)) {
    byProject.set(row.projectId, row);
  }
  for (const row of extRows.map(mapCompanyProjectRow)) {
    byProject.set(row.projectId, row);
  }

  const items = [...byProject.values()].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.joinedAt || '') || 0;
    const bTime = Date.parse(b.updatedAt || b.joinedAt || '') || 0;
    return bTime - aTime || b.projectId - a.projectId;
  });

  return success(res, {
    items,
    source: 'project_participants_ext_with_legacy_inference',
  });
}

async function getCompanyWorkbenchSummary(req, res) {
  const companyId = Number(req.params.id);
  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);

  const access = await getCompanyWorkbenchAccess(companyId, req.user.id);
  if (!access.exists) return error(res, '公司不存在', 404);
  if (!access.canView) return error(res, '当前成员不能查看公司工作台', 403);

  const [todayTodoRows] = await db.query(
    `${companyProjectsCte}
     SELECT
       COUNT(DISTINCT item_key) AS total,
       COUNT(DISTINCT project_id) AS project_count,
       COUNT(DISTINCT company_member_user_id) AS member_count,
       COUNT(DISTINCT CASE WHEN owner_item = 1 THEN item_key ELSE NULL END) AS owner_count
     FROM (
       SELECT CONCAT('task:', task.id) AS item_key,
              task.project_id,
              NULL AS company_member_user_id,
              0 AS owner_item
       FROM renovation_tasks task
       JOIN company_projects cp ON cp.project_id = task.project_id
       WHERE task.status <> 2
         AND task.planned_start <= CURDATE()
         AND task.planned_end >= CURDATE()

       UNION ALL

       SELECT CONCAT('action:', item.id) AS item_key,
              item.project_id,
              CASE WHEN cm.user_id IS NULL THEN NULL ELSE assigned.user_id END AS company_member_user_id,
              CASE WHEN pm.role IN ('owner', 'owner_member') THEN 1 ELSE 0 END AS owner_item
       FROM project_action_items item
       JOIN company_projects cp ON cp.project_id = item.project_id
       LEFT JOIN project_action_item_assignees assigned ON assigned.item_id = item.id
       LEFT JOIN company_members cm
         ON cm.company_id = ?
        AND cm.user_id = assigned.user_id
        AND cm.status = 'active'
       LEFT JOIN project_members pm
         ON pm.project_id = item.project_id
        AND pm.user_id = assigned.user_id
        AND pm.status = 1
       WHERE item.status = 'pending'
         AND item.due_date = CURDATE()
     ) todo_items`,
    [companyId, companyId, companyId]
  );

  const [pendingConsultationRows] = await db.query(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT c.id) AS conversation_count,
            MIN(COALESCE(last_msg.created_at, c.created_at)) AS oldest_waiting_at
     FROM consultation_targets target
     JOIN designer_consultations c ON c.id = target.consultation_id
     LEFT JOIN consultation_messages last_msg
       ON last_msg.id = (
         SELECT msg.id
         FROM consultation_messages msg
         WHERE msg.consultation_id = c.id
         ORDER BY msg.created_at DESC, msg.id DESC
         LIMIT 1
       )
     LEFT JOIN company_members sender_member
       ON sender_member.company_id = ?
      AND sender_member.user_id = last_msg.sender_id
      AND sender_member.status = 'active'
     WHERE target.target_type = 'company'
       AND target.target_id = ?
       AND COALESCE(c.status, 'pending') NOT IN ('closed', 'cancelled', 'archived')
       AND (
         last_msg.id IS NULL
         OR sender_member.id IS NULL
       )`,
    [companyId, companyId]
  );

  const [upcomingDeadlineRows] = await db.query(
    `${companyProjectsCte}
     SELECT COUNT(*) AS total,
            COUNT(DISTINCT project_id) AS project_count,
            MIN(due_at) AS nearest_due_at
     FROM (
       SELECT task.id, task.project_id, task.planned_end AS due_at
       FROM renovation_tasks task
       JOIN company_projects cp ON cp.project_id = task.project_id
       WHERE task.status <> 2
         AND task.planned_end >= CURDATE()
         AND task.planned_end <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)

       UNION ALL

       SELECT item.id, item.project_id, item.planned_end AS due_at
       FROM project_progress_items item
       JOIN company_projects cp ON cp.project_id = item.project_id
       WHERE item.status NOT IN (2, 3)
         AND item.planned_end IS NOT NULL
         AND item.planned_end >= CURDATE()
         AND item.planned_end <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)

       UNION ALL

       SELECT action.id, action.project_id, action.due_date AS due_at
       FROM project_action_items action
       JOIN company_projects cp ON cp.project_id = action.project_id
       WHERE action.status = 'pending'
         AND action.due_date >= CURDATE()
         AND action.due_date <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)
     ) deadline_items`,
    [companyId, companyId]
  );

  const [pendingHandoverRows] = await db.query(
    `${companyProjectsCte}
     SELECT COUNT(*) AS total,
            COUNT(DISTINCT handover.project_id) AS project_count,
            MIN(handover.created_at) AS oldest_submitted_at
     FROM project_handovers handover
     JOIN company_projects cp ON cp.project_id = handover.project_id
     WHERE handover.status = 'pending_confirm'`,
    [companyId, companyId]
  );

  const todo = todayTodoRows[0] || {};
  const pendingConsultation = pendingConsultationRows[0] || {};
  const deadline = upcomingDeadlineRows[0] || {};
  const handover = pendingHandoverRows[0] || {};
  const generatedAt = new Date().toISOString();
  const todayTodoTotal = toNumber(todo.total);
  const todayTodoProjects = toNumber(todo.project_count);
  const todayTodoMembers = toNumber(todo.member_count);
  const todayTodoOwners = toNumber(todo.owner_count);
  const pendingConsultationTotal = toNumber(pendingConsultation.total);
  const oldestWaitingHours = hoursSince(pendingConsultation.oldest_waiting_at);
  const deadlineTotal = toNumber(deadline.total);
  const deadlineProjects = toNumber(deadline.project_count);
  const handoverTotal = toNumber(handover.total);
  const handoverProjects = toNumber(handover.project_count);
  const oldestSubmittedDays = daysSince(handover.oldest_submitted_at);

  return success(res, {
    companyId,
    generatedAt,
    todayTodos: {
      total: todayTodoTotal,
      projectCount: todayTodoProjects,
      memberCount: todayTodoMembers,
      ownerCount: todayTodoOwners,
      summary: todayTodoTotal > 0
        ? `今日共${todayTodoTotal}项待办，涉及${todayTodoProjects}个项目、${todayTodoMembers}名公司成员，业主待确认${todayTodoOwners}项`
        : '今日暂无待办事项',
    },
    pendingConsultations: {
      total: pendingConsultationTotal,
      conversationCount: toNumber(pendingConsultation.conversation_count),
      oldestWaitingHours,
      summary: pendingConsultationTotal > 0
        ? `当前有${pendingConsultationTotal}条咨询待回复，最早已等待${oldestWaitingHours}小时`
        : '当前暂无待回复咨询',
    },
    upcomingDeadlines: {
      total: deadlineTotal,
      projectCount: deadlineProjects,
      nearestDueAt: isoOrNull(deadline.nearest_due_at),
      summary: deadlineTotal > 0
        ? `未来3天有${deadlineTotal}项事项到期，涉及${deadlineProjects}个项目，最近一项${nearestDueSummary(deadline.nearest_due_at)}`
        : '未来3天暂无即将到期事项',
    },
    pendingHandovers: {
      total: handoverTotal,
      projectCount: handoverProjects,
      oldestSubmittedAt: isoOrNull(handover.oldest_submitted_at),
      summary: handoverTotal > 0
        ? `当前有${handoverTotal}份设计交底待确认，涉及${handoverProjects}个项目，最早提交于${oldestSubmittedDays}天前`
        : '当前暂无待确认交底',
    },
  });
}

async function attachCompanyProject(req, res) {
  const projectContext = await requireProjectContext(req, res, {
    missingMessage: '公司项目关联操作必须携带有效 project_id',
  });
  if (!projectContext.ok) return projectContext.response;

  const companyId = Number(req.params.id);
  const projectId = Number(req.body.project_id);
  const roleType = ['designer', 'supervisor', 'contractor', 'client', 'pm']
    .includes(req.body.role_type)
    ? req.body.role_type
    : 'contractor';
  const responsibleUserId = Number(req.body.responsible_user_id || req.user.id);

  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);
  if (!projectId) return error(res, '请选择项目');
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }

  const [projectRows] = await db.query(
    `SELECT p.id
     FROM renovation_projects p
     LEFT JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
     WHERE p.id = ?
       AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
       AND (p.user_id = ? OR pm.id IS NOT NULL)
     LIMIT 1`,
    [req.user.id, projectId, req.user.id]
  );
  if (!projectRows[0]) return error(res, '项目不存在或无权限', 404);

  const [memberRows] = await db.query(
    `SELECT user_id FROM company_members
     WHERE company_id = ? AND user_id = ? AND status = 'active'
     LIMIT 1`,
    [companyId, responsibleUserId]
  );
  if (!memberRows[0]) return error(res, '负责人必须是公司成员');

  await db.query(
    `INSERT INTO project_participants_ext
     (project_id, participant_type, participant_id, role_type,
      company_id, user_id, assigned_by_user_id, status)
     VALUES (?, 'company', ?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE
       company_id = VALUES(company_id),
       user_id = VALUES(user_id),
       assigned_by_user_id = VALUES(assigned_by_user_id),
       status = 'active',
       updated_at = CURRENT_TIMESTAMP`,
    [projectId, companyId, roleType, companyId, responsibleUserId, req.user.id]
  );

  req.params.id = String(companyId);
  return listCompanyProjects(req, res);
}

async function updateCompanyProject(req, res) {
  const projectContext = await requireProjectContext(req, res, {
    missingMessage: '公司项目关联操作必须携带有效 project_id',
  });
  if (!projectContext.ok) return projectContext.response;

  const companyId = Number(req.params.id);
  const projectId = Number(req.params.projectId);
  const roleType = ['designer', 'supervisor', 'contractor', 'client', 'pm']
    .includes(req.body.role_type)
    ? req.body.role_type
    : 'contractor';
  const responsibleUserId = Number(req.body.responsible_user_id || req.user.id);

  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);
  if (!projectId) return error(res, '项目不存在', 404);
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }

  const [participantRows] = await db.query(
    `SELECT id FROM project_participants_ext
     WHERE project_id = ?
       AND participant_type = 'company'
       AND participant_id = ?
       AND company_id = ?
       AND status <> 'removed'
     LIMIT 1`,
    [projectId, companyId, companyId]
  );
  if (!participantRows[0]) return error(res, '公司项目关联不存在', 404);

  const [memberRows] = await db.query(
    `SELECT user_id FROM company_members
     WHERE company_id = ? AND user_id = ? AND status = 'active'
     LIMIT 1`,
    [companyId, responsibleUserId]
  );
  if (!memberRows[0]) return error(res, '负责人必须是公司成员');

  await db.query(
    `UPDATE project_participants_ext
     SET role_type = ?,
         user_id = ?,
         assigned_by_user_id = ?,
         status = 'active',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [roleType, responsibleUserId, req.user.id, participantRows[0].id]
  );

  req.params.id = String(companyId);
  return listCompanyProjects(req, res);
}

async function detachCompanyProject(req, res) {
  const projectContext = await requireProjectContext(req, res, {
    missingMessage: '公司项目关联操作必须携带有效 project_id',
  });
  if (!projectContext.ok) return projectContext.response;

  const companyId = Number(req.params.id);
  const projectId = Number(req.params.projectId);

  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);
  if (!projectId) return error(res, '项目不存在', 404);
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }

  const [result] = await db.query(
    `UPDATE project_participants_ext
     SET status = 'removed',
         assigned_by_user_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ?
       AND participant_type = 'company'
       AND participant_id = ?
       AND company_id = ?
       AND status <> 'removed'`,
    [req.user.id, projectId, companyId, companyId]
  );
  if (result.affectedRows === 0) return error(res, '公司项目关联不存在', 404);

  req.params.id = String(companyId);
  return listCompanyProjects(req, res);
}

const validCompanyMemberRoles = new Set([
  'owner',
  'admin',
  'designer',
  'supervisor',
  'project_manager',
  'staff',
  'customer_service',
]);

function normalizeCompanyMemberRole(role) {
  if (role === 'merchant_staff') return 'staff';
  return validCompanyMemberRoles.has(role) ? role : 'staff';
}

async function addCompanyMember(req, res) {
  const companyId = Number(req.params.id);
  const userId = Number(req.body.user_id);
  const professionalId = Number(req.body.professional_id || 0) || null;
  const memberRole = normalizeCompanyMemberRole(req.body.member_role);
  const title = String(req.body.title || '').trim().slice(0, 80);

  if (!companyId || companyId < 0) return error(res, '公司不存在', 404);
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }
  if (!userId) return error(res, '请填写成员用户 ID');

  const [userRows] = await db.query(
    `SELECT id FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (!userRows[0]) return error(res, '用户不存在', 404);

  if (professionalId) {
    const [professionalRows] = await db.query(
      `SELECT id FROM professionals
       WHERE id = ? AND user_id = ? AND status <> 'deleted'
       LIMIT 1`,
      [professionalId, userId]
    );
    if (!professionalRows[0]) return error(res, '专业身份不存在或不属于该用户', 404);
  }

  await db.query(
    `INSERT INTO company_members
     (company_id, user_id, professional_id, member_role, title, status, joined_at)
     VALUES (?, ?, ?, ?, ?, 'active', NOW())
     ON DUPLICATE KEY UPDATE
       professional_id = VALUES(professional_id),
       title = VALUES(title),
       status = 'active',
       updated_at = CURRENT_TIMESTAMP`,
    [companyId, userId, professionalId, memberRole, title]
  );

  const members = await listCompanyMembersById(companyId);
  return success(res, members, '成员已添加');
}

async function updateCompanyMember(req, res) {
  const companyId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  const professionalId = Number(req.body.professional_id || 0) || null;
  const memberRole = req.body.member_role === undefined
    ? null
    : normalizeCompanyMemberRole(req.body.member_role);
  const title = String(req.body.title || '').trim().slice(0, 80);

  if (!companyId || !memberId) return error(res, '成员不存在', 404);
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }

  const [memberRows] = await db.query(
    `SELECT id, user_id, member_role FROM company_members
     WHERE id = ? AND company_id = ? AND status = 'active'
     LIMIT 1`,
    [memberId, companyId]
  );
  const member = memberRows[0];
  if (!member) return error(res, '成员不存在', 404);

  const nextRole = memberRole || member.member_role;
  if (member.member_role === 'owner' && nextRole !== 'owner') {
    const [ownerRows] = await db.query(
      `SELECT COUNT(*) AS count FROM company_members
       WHERE company_id = ? AND member_role = 'owner' AND status = 'active'`,
      [companyId]
    );
    if (Number(ownerRows[0].count) <= 1) return error(res, '至少保留一位负责人');
  }

  if (professionalId) {
    const [professionalRows] = await db.query(
      `SELECT id FROM professionals
       WHERE id = ? AND user_id = ? AND status <> 'deleted'
       LIMIT 1`,
      [professionalId, member.user_id]
    );
    if (!professionalRows[0]) return error(res, '专业身份不存在或不属于该用户', 404);
  }

  await db.query(
    `UPDATE company_members
     SET professional_id = ?, member_role = ?, title = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [professionalId, nextRole, title, memberId, companyId]
  );

  const members = await listCompanyMembersById(companyId);
  return success(res, members, '成员已更新');
}

async function removeCompanyMember(req, res) {
  const companyId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  if (!companyId || !memberId) return error(res, '成员不存在', 404);
  if (!(await canManageCompany(companyId, req.user.id))) {
    return error(res, '无权限管理该公司', 403);
  }

  const [memberRows] = await db.query(
    `SELECT id, member_role FROM company_members
     WHERE id = ? AND company_id = ? AND status = 'active'
     LIMIT 1`,
    [memberId, companyId]
  );
  const member = memberRows[0];
  if (!member) return error(res, '成员不存在', 404);
  if (member.member_role === 'owner') {
    const [ownerRows] = await db.query(
      `SELECT COUNT(*) AS count FROM company_members
       WHERE company_id = ? AND member_role = 'owner' AND status = 'active'`,
      [companyId]
    );
    if (Number(ownerRows[0].count) <= 1) return error(res, '至少保留一位负责人');
  }

  await db.query(
    `UPDATE company_members
     SET status = 'removed', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND company_id = ?`,
    [memberId, companyId]
  );

  const members = await listCompanyMembersById(companyId);
  return success(res, members, '成员已移除');
}

async function getProfessional(req, res) {
  const id = Number(req.params.id);
  if (!id) return error(res, '专业人士不存在', 404);

  if (id > 0) {
    const [rows] = await db.query(
      `SELECT p.id, p.user_id, p.display_name, p.avatar_url, p.bio, p.city,
              p.service_area, p.status, p.independent_enabled,
              p.consultation_enabled, p.source, p.legacy_role,
              p.created_at, p.updated_at,
              COALESCE(
                JSON_ARRAYAGG(
                  CASE WHEN bc.id IS NULL THEN NULL ELSE JSON_OBJECT(
                    'id', bc.id,
                    'code', bc.code,
                    'name', bc.name,
                    'parent_code', parent.code,
                    'parent_name', parent.name,
                    'is_primary', pb.is_primary
                  ) END
                ),
                JSON_ARRAY()
              ) AS businesses
       FROM professionals p
       LEFT JOIN professional_businesses pb
         ON pb.professional_id = p.id AND pb.status = 'active'
       LEFT JOIN business_catalog bc
         ON bc.id = pb.business_catalog_id AND bc.status = 'active'
       LEFT JOIN business_catalog parent
         ON parent.id = bc.parent_id AND parent.status = 'active'
       WHERE p.id = ? AND p.status <> 'deleted'
       GROUP BY p.id`,
      [id]
    );
    if (!rows[0]) return error(res, '专业人士不存在', 404);
    return success(res, mapProfessionalRow(rows[0]));
  }

  const encoded = Math.abs(id);
  const roleCode = encoded % 10;
  const userId = Math.floor(encoded / 10);
  const legacyRole = roleCode === 3
    ? 'project_supervisor'
    : roleCode === 2
    ? 'project_manager'
    : 'designer';
  const businessRows = await getBusinessCatalogFlat();
  const byCode = new Map(businessRows.map((item) => [item.code, item]));

  if (legacyRole === 'designer') {
    const [rows] = await db.query(
      `SELECT u.id AS user_id, u.nickname, u.avatar, u.bio, u.city,
              dp.service_city AS service_area,
              dp.design_philosophy AS profile_bio,
              dp.consultation_enabled, dp.updated_at,
              'designer' AS legacy_role,
              'legacy_designer_profile' AS source
       FROM designer_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE u.id = ?`,
      [userId]
    );
    if (!rows[0]) return error(res, '专业人士不存在', 404);
    return success(res, mapLegacyProfessional(rows[0], byCode));
  }

  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.nickname, u.avatar, u.bio, u.city,
            pm.service_area,
            pm.management_philosophy AS profile_bio,
            pm.consultation_enabled, pm.updated_at,
            ? AS legacy_role,
            'legacy_project_manager_profile' AS source
     FROM project_manager_profiles pm
     JOIN users u ON u.id = pm.user_id
     WHERE u.id = ?`,
    [legacyRole, userId]
  );
  if (!rows[0]) return error(res, '专业人士不存在', 404);
  return success(res, mapLegacyProfessional(rows[0], byCode));
}

module.exports = {
  listBusinessCatalog,
  listMarketplaceSearch,
  searchPublicCompanies,
  listCompanies,
  listMyCompanies,
  listMyProjectCompanies,
  createCompany,
  updateCompany,
  uploadCompanyImage,
  listCompanyBusinesses,
  updateCompanyBusinesses,
  getCompany,
  getPublicCompany,
  listPublicCompanyCaseShares,
  listPublicCompanyReviews,
  submitCompanyReview,
  getCompanyEvaluationSummary,
  getProjectCompanyEvaluation,
  submitCompanyEvaluationFeedback,
  submitConsultationEvaluationFeedback,
  listProfessionals,
  getProfessional,
  listCompanyMembers,
  searchCompanyMemberCandidates,
  getCompanyWorkbenchSummary,
  listCompanyProjects,
  attachCompanyProject,
  updateCompanyProject,
  detachCompanyProject,
  addCompanyMember,
  updateCompanyMember,
  removeCompanyMember,
};
