const SOURCES = [
  { key: 'documents', label: '上传设计资料', table: 'project_design_documents', actor: 'uploaded_by' },
  { key: 'images', label: '上传空间图片', table: 'project_space_images', actor: 'created_by', project: 's.project_id', join: 'JOIN project_spaces s ON s.id = b.space_id', filter: "b.source_type IN ('manual_upload', 'designer_upload')" },
  { key: 'checkins', label: '工地打卡', table: 'project_checkins', actor: 'user_id' },
  { key: 'expenses', label: '装修记账', table: 'project_expenses', actor: 'created_by' },
  { key: 'inspections', label: '提交验收', table: 'project_inspections', actor: 'submitted_by' },
  { key: 'materials', label: '材料清单', table: 'project_material_items', actor: 'created_by', filter: 'b.deleted_at IS NULL' },
  { key: 'products', label: '方案选品', table: 'project_scheme_products', actor: 'created_by' },
];
const { attachLocations } = require('./phone-location.service');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function projectId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw fail('工地ID不正确');
  return Number(value);
}
function eventQuery(ids) {
  const params = [];
  const sql = SOURCES.map(f => {
    params.push(...ids);
    return `SELECT ${f.project || 'b.project_id'} AS project_id, b.id AS record_id, b.${f.actor} AS actor_id,
      '${f.key}' AS feature, b.created_at AS happened_at
      FROM ${f.table} b ${f.join || ''}
      WHERE ${f.project || 'b.project_id'} IN (${ids.map(() => '?').join(',')}) ${f.filter ? `AND ${f.filter}` : ''}`;
  }).join('\nUNION ALL\n');
  return { sql, params };
}
function mergeMembers(rows, project, metrics = []) {
  const map = new Map();
  const ensure = row => {
    const key = String(row.user_id);
    if (!map.has(key)) map.set(key, { user_id: row.user_id, nickname: row.nickname || '已注销用户', phone: row.phone || '',
      is_test_account: Boolean(Number(row.is_test_account)), roles: [], counts: {}, last_at: null });
    return map.get(key);
  };
  for (const row of rows) {
    const user = ensure(row);
    if (row.role && !user.roles.some(r => r.role === row.role && r.status === Number(row.status))) {
      user.roles.push({ role: row.role, status: Number(row.status), joined_at: row.joined_at });
    }
  }
  if (project.user_id) {
    const owner = ensure({ user_id: project.user_id, nickname: project.owner_nickname, phone: project.owner_phone, is_test_account: project.owner_is_test });
    if (!owner.roles.some(r => r.role === 'owner' && r.status === 1)) owner.roles.push({ role: 'owner', status: 1, joined_at: null });
  }
  if (project.creator_id) {
    const creator = ensure({ user_id: project.creator_id, nickname: project.creator_nickname, phone: project.creator_phone, is_test_account: project.creator_is_test });
    creator.is_creator = true;
  }
  for (const row of metrics) {
    if (!row.actor_id) continue;
    const user = ensure({ ...row, user_id: row.actor_id });
    user.counts[row.feature] = Number(row.total);
    if (!user.last_at || new Date(row.last_at) > new Date(user.last_at)) user.last_at = row.last_at;
  }
  return [...map.values()].sort((a, b) => Number(b.roles.some(r => r.role === 'owner' && r.status === 1)) - Number(a.roles.some(r => r.role === 'owner' && r.status === 1))) ;
}
const PROJECT_SELECT = `SELECT p.id, p.project_name, p.project_code, p.user_id, COALESCE(p.created_by, p.user_id) AS creator_id,
  p.creation_source, p.project_city, p.project_address, p.house_area, p.house_layout, p.renovation_method,
  p.current_stage, p.status, p.lifecycle_status, p.created_at, p.start_date,
  owner.nickname AS owner_nickname, owner.phone AS owner_phone, owner.is_test_account AS owner_is_test,
  creator.nickname AS creator_nickname, creator.phone AS creator_phone, creator.is_test_account AS creator_is_test
  FROM renovation_projects p
  LEFT JOIN users owner ON owner.id = p.user_id
  LEFT JOIN users creator ON creator.id = COALESCE(p.created_by, p.user_id)`;
async function addMetrics(db, projects) {
  for (const p of projects) { p.counts = {}; p.members = []; p.last_at = p.created_at; p.last_feature = '创建工地'; p.last_actor = p.creator_nickname || '未知用户'; }
  if (!projects.length) return;
  const ids = projects.map(p => p.id);
  const ev = eventQuery(ids);
  const [metrics] = await db.query(`SELECT project_id, feature, COUNT(*) AS total FROM (${ev.sql}) ev GROUP BY project_id, feature`, ev.params);
  const [members] = await db.query(`SELECT pm.project_id, pm.user_id, pm.role, pm.status, u.nickname
    FROM project_members pm LEFT JOIN users u ON u.id = pm.user_id WHERE pm.status = 1 AND pm.project_id IN (${ids.map(() => '?').join(',')})`, ids);
  const [latest] = await db.query(`SELECT * FROM (SELECT ev.project_id, ev.feature, ev.happened_at, u.nickname,
    ROW_NUMBER() OVER (PARTITION BY ev.project_id ORDER BY ev.happened_at DESC, ev.feature, ev.record_id DESC) AS rn
    FROM (${ev.sql}) ev LEFT JOIN users u ON u.id = ev.actor_id) ranked WHERE rn = 1`, ev.params);
  const map = new Map(projects.map(p => [String(p.id), p]));
  for (const row of metrics) map.get(String(row.project_id)).counts[row.feature] = Number(row.total);
  for (const row of members) map.get(String(row.project_id)).members.push(row);
  for (const p of projects) {
    if (p.user_id && !p.members.some(m => String(m.user_id) === String(p.user_id) && m.role === 'owner')) p.members.push({ user_id: p.user_id, role: 'owner', nickname: p.owner_nickname });
    p.member_count = new Set(p.members.map(m => String(m.user_id))).size;
    p.role_counts = {};
    for (const m of p.members) p.role_counts[m.role] = (p.role_counts[m.role] || 0) + 1;
    delete p.members;
  }
  for (const row of latest) {
    const p = map.get(String(row.project_id));
    if (Number(row.rn) === 1 && new Date(row.happened_at) >= new Date(p.last_at)) {
      p.last_at = row.happened_at; p.last_feature = SOURCES.find(f => f.key === row.feature).label; p.last_actor = row.nickname || '已注销用户';
    }
  }
  const contacts = projects.flatMap(project => [
    { phone: project.owner_phone },
    { phone: project.creator_phone },
  ]);
  await attachLocations(db, contacts);
  for (let index = 0; index < projects.length; index += 1) {
    projects[index].owner_location = contacts[index * 2].phone_location || null;
    projects[index].creator_location = contacts[index * 2 + 1].phone_location || null;
  }
}
async function list(db, query = {}) {
  const lifecycle = String(query.lifecycle || 'all');
  if (!['all', 'active', 'archived'].includes(lifecycle)) throw fail('工地状态不正确');
  const keyword = String(query.keyword || '').trim().slice(0, 100);
  const clauses = ["COALESCE(p.lifecycle_status, 'active') <> 'deleted'"];
  const params = [];
  if (query.includeTests !== '1') clauses.push('COALESCE(owner.is_test_account, 0) = 0 AND COALESCE(creator.is_test_account, 0) = 0');
  if (lifecycle !== 'all') { clauses.push("COALESCE(p.lifecycle_status, 'active') = ?"); params.push(lifecycle); }
  if (keyword) {
    clauses.push(`(p.project_name LIKE ? OR p.project_code LIKE ? OR CAST(p.id AS CHAR) = ? OR owner.nickname LIKE ? OR owner.phone LIKE ?
      OR EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = p.id AND pm.status = 1 AND (u.nickname LIKE ? OR u.phone LIKE ?)))`);
    const kw = `%${keyword}%`; params.push(kw, kw, keyword, kw, kw, kw, kw);
  }
  const from = PROJECT_SELECT.slice(PROJECT_SELECT.indexOf('FROM renovation_projects'));
  const [[count]] = await db.query(`SELECT COUNT(*) AS total ${from} WHERE ${clauses.join(' AND ')}`, params);
  const total = Number(count.total);
  const pageSize = 20;
  const page = Math.min(Math.max(1, parseInt(query.page, 10) || 1), Math.max(1, Math.ceil(total / pageSize)));
  const [projects] = await db.query(`${PROJECT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  await addMetrics(db, projects);
  return { projects, total, page, pageSize, features: SOURCES.map(({ key, label }) => ({ key, label })) };
}
async function detail(db, value) {
  const id = projectId(value);
  const [[project]] = await db.query(`${PROJECT_SELECT} WHERE p.id = ? AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'`, [id]);
  if (!project) throw fail('工地不存在或已删除', 404);
  await addMetrics(db, [project]);
  const [members] = await db.query(`SELECT pm.user_id, pm.role, pm.status, pm.joined_at, u.nickname, u.phone, u.is_test_account
    FROM project_members pm LEFT JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY pm.joined_at`, [id]);
  const ev = eventQuery([id]);
  const [metrics] = await db.query(`SELECT ev.actor_id, ev.feature, COUNT(*) AS total, MAX(ev.happened_at) AS last_at, u.nickname, u.phone, u.is_test_account
    FROM (${ev.sql}) ev LEFT JOIN users u ON u.id = ev.actor_id
    GROUP BY ev.actor_id, ev.feature, u.nickname, u.phone, u.is_test_account`, ev.params);
  const [timeline] = await db.query(`SELECT ev.*, u.nickname, u.phone FROM (${ev.sql}) ev
    LEFT JOIN users u ON u.id = ev.actor_id ORDER BY ev.happened_at DESC, ev.feature, ev.record_id DESC LIMIT 30`, ev.params);
  const mergedMembers = mergeMembers(members, project, metrics);
  await attachLocations(db, mergedMembers);
  return { project, members: mergedMembers, timeline, features: SOURCES.map(({ key, label }) => ({ key, label })) };
}
module.exports = { list, detail, mergeMembers, eventQuery, projectId };
