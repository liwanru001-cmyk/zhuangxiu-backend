const db = require('../config/db');
const { success, error } = require('../utils/response');

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

function normalizePage(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(query.pageSize, 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
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
  return {
    id: row.id,
    name: row.name,
    logo_url: row.logo_url || '',
    intro: row.intro || '',
    service_area: row.service_area || '',
    city: row.city || '',
    address: row.address || '',
    contact_phone: row.contact_phone || '',
    status: row.status || 'active',
    source: row.source || 'manual',
    legacy_merchant_user_id: row.legacy_merchant_user_id || null,
    businesses: parseJsonArray(row.businesses).filter(Boolean),
    members: parseJsonArray(row.members).filter(Boolean),
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
    badges: ['公司'],
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

function mapCompanyMemberRow(row) {
  return {
    memberId: row.member_id,
    companyId: row.company_id,
    userId: row.user_id,
    professionalId: row.professional_id || null,
    displayName: row.display_name || row.nickname || '团队成员',
    avatarUrl: row.avatar_url || row.avatar || '',
    memberRole: row.member_role || 'merchant_staff',
    title: row.title || '',
    status: row.status || 'active',
    professionalBusinesses: parseJsonArray(row.professional_businesses).filter(Boolean),
    joinedAt: row.joined_at || null,
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
                    'project_manager', 'customer_service', 'merchant_staff'),
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
     ORDER BY c.updated_at DESC, c.id DESC
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

function legacyBusinessCodes(categories) {
  const map = new Map([
    ['整装公司', 'whole_renovation'],
    ['设计师工作室', 'design_studio'],
    ['监理服务', 'supervision_service'],
    ['瓷砖地板', 'tile_floor'],
    ['瓷砖', 'tile_floor'],
    ['地板', 'tile_floor'],
    ['涂料墙面', 'paint_wall'],
    ['吊顶门窗', 'ceiling_door_window'],
    ['门窗', 'ceiling_door_window'],
    ['水电防水', 'water_electric_waterproof'],
    ['全屋定制', 'whole_house_custom'],
    ['灯具照明', 'lighting'],
    ['灯具', 'lighting'],
    ['智能家居', 'smart_home'],
    ['家具', 'furniture'],
    ['软装', 'soft_decoration'],
    ['家电', 'appliance'],
    ['电器', 'appliance'],
    ['建材', 'tile_floor'],
  ]);
  return categories.map((item) => map.get(item) || '').filter(Boolean);
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

async function listLegacyMerchantCompanies(req, pageSpec) {
  const params = [];
  let where = `EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = u.id AND ur.role = 'merchant'
  )`;
  if (req.query.city) {
    where += ` AND REPLACE(u.city, '市', '') = REPLACE(?, '市', '')`;
    params.push(String(req.query.city));
  }
  if (req.query.keyword) {
    where += ` AND (u.nickname LIKE ? OR m.brand_intro LIKE ? OR m.service_area LIKE ?)`;
    const keyword = `%${String(req.query.keyword).trim()}%`;
    params.push(keyword, keyword, keyword);
  }
  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.nickname, u.avatar, u.city, m.service_area,
            m.categories, m.service_types, m.case_count, m.brand_intro,
            m.updated_at
     FROM users u
     JOIN merchant_profiles m ON m.user_id = u.id
     WHERE ${where}
     ORDER BY m.updated_at DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSpec.pageSize, pageSpec.offset]
  );

  const businessRows = await getBusinessCatalogFlat();
  const byCode = new Map(businessRows.map((item) => [item.code, item]));
  const parentCode = req.query.parent_code ? String(req.query.parent_code) : '';
  const businessCode = req.query.business_code ? String(req.query.business_code) : '';

  return rows
    .map((row) => mapLegacyMerchantCompany(row, byCode))
    .filter((company) => {
      if (businessCode) {
        return company.businesses.some((item) => item.code === businessCode);
      }
      if (parentCode) {
        return company.businesses.some((item) => item.parent_code === parentCode);
      }
      return true;
    });
}

function mapLegacyMerchantCompany(row, businessByCode) {
  const categories = parseJsonArray(row.categories);
  const codes = legacyBusinessCodes(categories);
  let businesses = codes
    .map((code) => businessByCode.get(code))
    .filter(Boolean)
    .map((item, index) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      parent_code: item.parent_code,
      parent_name: item.parent_name,
      is_primary: index === 0 ? 1 : 0,
    }));
  if (businesses.length === 0) {
    const fallback = businessByCode.get('tile_floor');
    if (fallback) {
      businesses = [{
        id: fallback.id,
        code: fallback.code,
        name: fallback.name,
        parent_code: fallback.parent_code,
        parent_name: fallback.parent_name,
        is_primary: 1,
      }];
    }
  }
  return {
    id: -Number(row.user_id),
    name: row.nickname || '商家公司',
    logo_url: row.avatar || '',
    intro: row.brand_intro || '商家资料待完善',
    service_area: row.service_area || row.city || '全国',
    city: row.city || '',
    address: '',
    contact_phone: '',
    source: 'legacy_merchant_profile',
    owner_user_id: row.user_id,
    legacy_merchant_user_id: row.user_id,
    businesses,
    members: [],
    case_count: Number(row.case_count) || 0,
    service_types: parseJsonArray(row.service_types),
    updated_at: row.updated_at,
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
  const items = await listCompaniesFromNewTables(req, pageSpec);
  if (items.length > 0) {
    return success(res, {
      items,
      page: pageSpec.page,
      pageSize: pageSpec.pageSize,
      source: 'companies',
    });
  }

  const legacyItems = await listLegacyMerchantCompanies(req, pageSpec);
  return success(res, {
    items: legacyItems,
    page: pageSpec.page,
    pageSize: pageSpec.pageSize,
    source: 'legacy_merchant_profiles',
  });
}

async function listMyCompanies(req, res) {
  const [rows] = await db.query(
    `SELECT c.id, c.owner_user_id, c.name, c.logo_url, c.intro, c.service_area,
            c.city, c.address, c.contact_phone, c.status, c.source,
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
                    'customer_service', 'merchant_staff'),
              c.updated_at DESC, c.id DESC`,
    [req.user.id, req.user.id]
  );

  return success(res, rows.map((row) => ({
    ...mapCompanyRow(row),
    memberRole: row.owner_user_id === req.user.id
      ? 'owner'
      : row.member_role || 'merchant_staff',
    canManage: row.owner_user_id === req.user.id ||
      ['owner', 'admin'].includes(row.member_role),
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
        contact_phone, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'manual')`,
      [
        req.user.id,
        payload.name,
        payload.logo_url,
        payload.intro,
        payload.service_area,
        payload.city,
        payload.address,
        payload.contact_phone,
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

  await db.query(
    `UPDATE companies
     SET name = ?, logo_url = ?, intro = ?, service_area = ?, city = ?,
         address = ?, contact_phone = ?
     WHERE id = ? AND status <> 'deleted'`,
    [
      payload.name,
      payload.logo_url,
      payload.intro,
      payload.service_area,
      payload.city,
      payload.address,
      payload.contact_phone,
      id,
    ]
  );

  return getCompany(req, res);
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
        || (!businessCode && parentCode === 'find_renovation')
        || (!businessCode && !parentCode)
      )
    );
  const canShowCompanies = entityType === 'company' || entityType === 'all';

  let companies = [];
  let professionals = [];
  let companySource = '';
  let professionalSource = '';

  if (canShowCompanies) {
    companies = await listCompaniesFromNewTables(req, pageSpec);
    companySource = 'companies';
    if (companies.length === 0) {
      companies = await listLegacyMerchantCompanies(req, pageSpec);
      companySource = 'legacy_merchant_profiles';
    }
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

  const legacyUserId = Math.abs(id);
  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.nickname, u.avatar, u.city, m.service_area,
            m.categories, m.service_types, m.case_count, m.brand_intro,
            m.updated_at
     FROM users u
     JOIN merchant_profiles m ON m.user_id = u.id
     WHERE u.id = ?`,
    [legacyUserId]
  );
  if (!rows[0]) return error(res, '公司不存在', 404);
  const businessRows = await getBusinessCatalogFlat();
  const byCode = new Map(businessRows.map((item) => [item.code, item]));
  const company = mapLegacyMerchantCompany(rows[0], byCode);
  company.members = await listCompanyMembersForCompany(company, { limit: 5 });
  return success(res, company);
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

  const legacyUserId = Math.abs(id);
  const [rows] = await db.query(
    `SELECT u.id AS user_id, u.nickname, u.avatar
     FROM users u
     JOIN merchant_profiles m ON m.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [legacyUserId]
  );
  if (!rows[0]) return error(res, '公司不存在', 404);
  return success(res, [{
    memberId: 0,
    companyId: id,
    userId: rows[0].user_id,
    professionalId: null,
    displayName: rows[0].nickname || '公司负责人',
    avatarUrl: rows[0].avatar || '',
    memberRole: 'owner',
    title: '公司负责人',
    status: 'active',
    professionalBusinesses: [],
    joinedAt: null,
  }]);
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

async function attachCompanyProject(req, res) {
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
  'merchant_staff',
  'customer_service',
]);

async function addCompanyMember(req, res) {
  const companyId = Number(req.params.id);
  const userId = Number(req.body.user_id);
  const professionalId = Number(req.body.professional_id || 0) || null;
  const memberRole = validCompanyMemberRoles.has(req.body.member_role)
    ? req.body.member_role
    : 'merchant_staff';
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
  const memberRole = validCompanyMemberRoles.has(req.body.member_role)
    ? req.body.member_role
    : null;
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
  listCompanies,
  listMyCompanies,
  createCompany,
  updateCompany,
  listCompanyBusinesses,
  updateCompanyBusinesses,
  getCompany,
  listProfessionals,
  getProfessional,
  listCompanyMembers,
  listCompanyProjects,
  attachCompanyProject,
  updateCompanyProject,
  detachCompanyProject,
  addCompanyMember,
  updateCompanyMember,
  removeCompanyMember,
};
