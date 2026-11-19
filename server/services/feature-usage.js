const FEATURES = [
  { key: 'projects', label: '创建工地', table: 'renovation_projects', actor: 'COALESCE(created_by, user_id)' },
  { key: 'progress', label: '施工进度管理', sources: [
    { table: 'project_progress_item_adjustments', actor: 'changed_by' },
    { table: 'project_task_adjustments', actor: 'changed_by' },
  ] },
  { key: 'joined', label: '加入工地', table: 'project_members', actor: 'user_id', time: 'joined_at',
    filter: `status = 1 AND role <> 'owner' AND EXISTS (
      SELECT 1 FROM renovation_projects p
      WHERE p.id = project_members.project_id
        AND COALESCE(p.created_by, p.user_id) <> project_members.user_id
    )` },
  { key: 'documents', label: '上传设计资料', table: 'project_design_documents', actor: 'uploaded_by' },
  { key: 'images', label: '上传空间图片', table: 'project_space_images', actor: 'created_by', filter: "source_type IN ('manual_upload', 'designer_upload')" },
  { key: 'checkins', label: '工地打卡', table: 'project_checkins', actor: 'user_id' },
  { key: 'expenses', label: '装修记账', table: 'project_expenses', actor: 'created_by' },
  { key: 'inspections', label: '提交验收', table: 'project_inspections', actor: 'submitted_by' },
  { key: 'materials', label: '材料清单', table: 'project_material_items', actor: 'created_by', filter: 'deleted_at IS NULL' },
  { key: 'products', label: '方案选品', table: 'project_scheme_products', actor: 'created_by' },
  { key: 'notes', label: '发布内容', table: 'notes', actor: 'user_id', filter: 'status IN (0, 1, 3)' },
];
const { attachLocations } = require('./phone-location.service');

function options(query = {}) {
  const days = String(query.days || '30');
  if (!['7', '30', 'all'].includes(days)) throw Object.assign(new Error('时间范围仅支持7天、30天或全部'), { status: 400 });
  const page = Math.max(1, Math.min(1000000, parseInt(query.page, 10) || 1));
  return { days, page, pageSize: 20, keyword: String(query.keyword || '').trim().slice(0, 100),
    excludeTests: query.includeTests !== '1', feature: String(query.feature || '') };
}

// Aggregate each source before joining, so unrelated business rows cannot multiply counts.
function eventSql(features, days) {
  function sourceSql(source, key) {
    const time = source.time || 'created_at';
    const where = [source.filter, days !== 'all' && `${time} >= NOW() - INTERVAL ${Number(days)} DAY`].filter(Boolean);
    return `SELECT ${source.actor} AS user_id, '${key}' AS feature, COUNT(*) AS total, MAX(${time}) AS last_at
      FROM ${source.table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY ${source.actor}`;
  }
  return features.map(f => {
    if (!f.sources) return sourceSql(f, f.key);
    return `SELECT user_id, '${f.key}' AS feature, SUM(total) AS total, MAX(last_at) AS last_at
      FROM (${f.sources.map(source => sourceSql(source, f.key)).join('\nUNION ALL\n')}) feature_sources
      GROUP BY user_id`;
  }).join('\nUNION ALL\n');
}

async function attachProjects(db, users) {
  for (const user of users) user.projects = [];
  if (!users.length) return;
  const ids = users.map(u => u.id);
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await db.query(`SELECT DISTINCT rel.user_id, p.id, p.project_name, p.project_code, p.lifecycle_status
    FROM renovation_projects p
    JOIN (
      SELECT user_id, id AS project_id FROM renovation_projects WHERE user_id IN (${placeholders})
      UNION
      SELECT user_id, project_id FROM project_members WHERE status = 1 AND user_id IN (${placeholders})
    ) rel ON rel.project_id = p.id
    WHERE COALESCE(p.lifecycle_status, 'active') <> 'deleted'
    ORDER BY p.id DESC`, [...ids, ...ids]);
  const byId = new Map(users.map(u => [String(u.id), u]));
  for (const row of rows) {
    const user = byId.get(String(row.user_id));
    if (!user || user.projects.some(p => String(p.id) === String(row.id))) continue;
    user.projects.push({ id: row.id, name: String(row.project_name || '').trim() || `工地${row.project_code || row.id}`,
      archived: row.lifecycle_status === 'archived' });
  }
}

async function getUsage(db, query) {
  const opt = options(query);
  if (opt.feature && !FEATURES.some(f => f.key === opt.feature)) {
    throw Object.assign(new Error('功能筛选不正确'), { status: 400 });
  }
  // Report absent migrations explicitly instead of presenting missing data as zero usage.
  const [columns] = await db.query(`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
  const schema = new Map();
  for (const row of columns) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Set());
    schema.get(row.table_name).add(row.column_name);
  }
  const projectColumns = schema.get('renovation_projects');
  const canIdentifyProjectCreators = ['id', 'created_by', 'user_id'].every(column => projectColumns?.has(column));
  const available = FEATURES.filter(f => (f.key !== 'joined' || canIdentifyProjectCreators) && (f.sources || [f]).every(source => {
    const actors = f.key === 'projects' ? ['created_by', 'user_id'] : [source.actor];
    const extra = { joined: ['status', 'role', 'project_id'], images: ['source_type'], materials: ['deleted_at'], notes: ['status'] }[f.key] || [];
    return schema.has(source.table) && [source.time || 'created_at', ...actors, ...extra].every(c => schema.get(source.table).has(c));
  }));
  const hasTestFlag = schema.get('users')?.has('is_test_account');
  if (opt.excludeTests && !hasTestFlag) throw new Error('缺少测试账号标记，无法可靠排除测试账号，请先更新数据库结构');
  const [users] = await db.query(`SELECT id, nickname, phone, role, created_at FROM users ${opt.excludeTests ? 'WHERE COALESCE(is_test_account, 0) = 0' : ''}`);
  const [events] = available.length ? await db.query(eventSql(available, opt.days)) : [[]];
  const byId = new Map(users.map(u => [String(u.id), { ...u, counts: {}, last_at: null, last_feature: null, total: 0 }]));
  const ranking = available.map(f => ({ key: f.key, label: f.label, users: 0, operations: 0 }));
  const byFeature = new Map(ranking.map(f => [f.key, f]));
  for (const event of events) {
    const user = byId.get(String(event.user_id));
    if (!user) continue;
    const count = Number(event.total) || 0;
    user.counts[event.feature] = count;
    user.total += count;
    const feature = byFeature.get(event.feature);
    feature.users += 1;
    feature.operations += count;
    if (!user.last_at || new Date(event.last_at) > new Date(user.last_at)) {
      user.last_at = event.last_at;
      user.last_feature = feature.label;
    }
  }
  const all = [...byId.values()];
  const summary = { total_users: all.length, used_users: all.filter(u => u.total > 0).length,
    project_users: all.filter(u => u.counts.projects).length,
    document_users: all.filter(u => u.counts.documents || u.counts.images).length,
    multi_feature_users: all.filter(u => Object.keys(u.counts).length >= 3).length };
  let filtered = all.filter(u => (!opt.keyword || String(u.id) === opt.keyword || String(u.nickname || '').toLowerCase().includes(opt.keyword.toLowerCase()))
    && (!opt.feature || u.counts[opt.feature] > 0));
  filtered.sort((a, b) => (new Date(b.last_at || 0) - new Date(a.last_at || 0)) || String(a.id).localeCompare(String(b.id)));
  const total = filtered.length;
  const page = Math.min(opt.page, Math.max(1, Math.ceil(total / opt.pageSize)));
  const pageUsers = filtered.slice((page - 1) * opt.pageSize, page * opt.pageSize);
  await attachProjects(db, pageUsers);
  await attachLocations(db, pageUsers);
  return { summary, features: FEATURES.map(f => ({ key: f.key, label: f.label, available: byFeature.has(f.key) })),
    ranking: ranking.sort((a, b) => b.users - a.users || b.operations - a.operations),
    users: pageUsers, total, page, pageSize: opt.pageSize,
    days: opt.days, excludeTests: opt.excludeTests };
}
module.exports = { FEATURES, options, eventSql, getUsage, attachProjects };
