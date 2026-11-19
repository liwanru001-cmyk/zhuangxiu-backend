// Keep admin membership aligned with the app: explicit company links plus
// projects involving active company members, excluding deleted projects.
function projectLinks(companyIds) {
  const ids = [...new Set(companyIds.map(Number))]
    .filter(id => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return null;
  const placeholders = ids.map(() => '?').join(',');
  return {
    sql: `SELECT c.id AS company_id, ppe.project_id, ppe.id AS link_id,
                 ppe.role_type, ppe.status AS participant_status,
                 COALESCE(ppe.user_id, prof.user_id) AS responsible_user_id,
                 prof.display_name AS professional_name,
                 ppe.created_at AS joined_at, ppe.updated_at AS participant_updated_at,
                 'project_participants_ext' AS source, 1 AS priority
          FROM companies c
          JOIN project_participants_ext ppe
            ON (ppe.company_id = c.id
                OR (ppe.participant_type = 'company' AND ppe.participant_id = c.id))
          LEFT JOIN professionals prof ON prof.id = ppe.professional_id
          WHERE c.id IN (${placeholders}) AND ppe.status <> 'removed'
          UNION ALL
          SELECT cm.company_id, pm.project_id, cm.id AS link_id,
                 CASE cm.member_role
                   WHEN 'designer' THEN 'designer'
                   WHEN 'supervisor' THEN 'supervisor'
                   WHEN 'project_manager' THEN 'pm'
                   ELSE 'contractor'
                 END AS role_type,
                 'active' AS participant_status, cm.user_id AS responsible_user_id,
                 NULL AS professional_name,
                 pm.joined_at, cm.updated_at AS participant_updated_at,
                 'inferred_company_member' AS source, 0 AS priority
          FROM company_members cm
          JOIN project_members pm ON pm.user_id = cm.user_id AND pm.status = 1
          WHERE cm.company_id IN (${placeholders}) AND cm.status = 'active'`,
    params: [...ids, ...ids],
  };
}

async function counts(db, companyIds) {
  const links = projectLinks(companyIds);
  if (!links) return new Map();
  const [rows] = await db.query(
    `WITH company_project_links AS (${links.sql})
     SELECT links.company_id, COUNT(DISTINCT p.id) AS project_count
     FROM company_project_links links
     JOIN renovation_projects p ON p.id = links.project_id
       AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
     GROUP BY links.company_id`,
    links.params
  );
  return new Map(rows.map(row => [Number(row.company_id), Number(row.project_count) || 0]));
}

function mergeProjects(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.project_id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return [...groups.values()].map(group => {
    // Like the app, explicit participation takes precedence over member inference.
    const explicit = group.filter(row => row.source === 'project_participants_ext');
    const preferred = explicit.length ? explicit : group;
    const first = preferred[0];
    const unique = key => [...new Set(preferred.map(row => row[key]).filter(Boolean))].sort();
    const roles = unique('role_type');
    const statuses = unique('participant_status');
    const dates = key => preferred.map(row => row[key]).filter(Boolean)
      .sort((a, b) => new Date(a) - new Date(b));
    const joinedAt = dates('joined_at')[0] || null;
    return {
      project_id: Number(first.project_id),
      project_code: first.project_code || '', project_name: first.project_name || '',
      project_city: first.project_city || '', project_address: first.project_address || '',
      house_area: first.house_area == null ? null : Number(first.house_area),
      house_layout: first.house_layout || '', current_stage: Number(first.current_stage || 0),
      project_status: Number(first.project_status || 0), lifecycle_status: first.lifecycle_status || 'active',
      role_types: roles, participant_statuses: statuses,
      responsible_names: unique('responsible_name').join('、'),
      joined_at: joinedAt,
      participant_updated_at: dates('participant_updated_at').at(-1) || null,
      updated_at: first.updated_at || null, source: first.source,
      // Preserve the existing company-detail table's scalar fields.
      id: Number(first.link_id), role_type: roles[0] || '',
      status: statuses[0] || '', created_at: joinedAt,
    };
  });
}

async function list(db, companyId) {
  const links = projectLinks([companyId]);
  if (!links) return [];
  const [rows] = await db.query(
    `WITH company_project_links AS (${links.sql})
     SELECT p.id AS project_id, p.project_code, p.project_name, p.project_city, p.project_address,
            p.house_area, p.house_layout, p.current_stage, p.status AS project_status,
            p.lifecycle_status, p.updated_at, links.link_id, links.role_type,
            links.participant_status, links.joined_at, links.participant_updated_at,
            links.source, COALESCE(u.nickname, links.professional_name) AS responsible_name
     FROM company_project_links links
     JOIN renovation_projects p ON p.id = links.project_id
       AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
     LEFT JOIN users u ON u.id = links.responsible_user_id
     ORDER BY p.updated_at DESC, p.id DESC, links.priority DESC, links.link_id DESC`,
    links.params
  );
  return mergeProjects(rows);
}

module.exports = { counts, list, mergeProjects };
