const db = require('../config/db');
const { success, error } = require('../utils/response');

const validSourceTypes = new Set(['case', 'review', 'project', 'note', 'consultation']);
const validTargetTypes = new Set(['company', 'professional', 'project', 'user']);
const validRelationTypes = new Set(['owner', 'provider', 'reviewer', 'participant', 'case_owner']);

function normalizeEnum(value) {
  return String(value || '').trim();
}

async function targetExists(targetType, targetId) {
  if (targetType === 'company') {
    if (targetId < 0) {
      const [rows] = await db.query(
        `SELECT 1 FROM merchant_profiles WHERE user_id = ? LIMIT 1`,
        [Math.abs(targetId)]
      );
      return Boolean(rows[0]);
    }
    const [rows] = await db.query(
      `SELECT 1 FROM companies WHERE id = ? AND status <> 'deleted' LIMIT 1`,
      [targetId]
    );
    return Boolean(rows[0]);
  }

  if (targetType === 'professional') {
    if (targetId < 0) {
      const encoded = Math.abs(targetId);
      const roleCode = encoded % 10;
      const userId = Math.floor(encoded / 10);
      const table = roleCode === 1 ? 'designer_profiles' : 'project_manager_profiles';
      const [rows] = await db.query(
        `SELECT 1 FROM ${table} WHERE user_id = ? LIMIT 1`,
        [userId]
      );
      return Boolean(rows[0]);
    }
    const [rows] = await db.query(
      `SELECT 1 FROM professionals WHERE id = ? AND status <> 'deleted' LIMIT 1`,
      [targetId]
    );
    return Boolean(rows[0]);
  }

  if (targetType === 'project') {
    const [rows] = await db.query(
      `SELECT 1 FROM renovation_projects
       WHERE id = ? AND COALESCE(lifecycle_status, 'active') <> 'deleted'
       LIMIT 1`,
      [targetId]
    );
    return Boolean(rows[0]);
  }

  const [rows] = await db.query(
    `SELECT 1 FROM users WHERE id = ? LIMIT 1`,
    [targetId]
  );
  return Boolean(rows[0]);
}

function mapRelation(row) {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    targetType: row.target_type,
    targetId: row.target_id,
    relationType: row.relation_type,
    roleLabel: row.role_label || '',
    createdAt: row.created_at || null,
  };
}

async function createEntityRelation(req, res) {
  const sourceType = normalizeEnum(req.body.source_type);
  const sourceId = Number(req.body.source_id);
  const targetType = normalizeEnum(req.body.target_type);
  const targetId = Number(req.body.target_id);
  const relationType = normalizeEnum(req.body.relation_type);
  const roleLabel = String(req.body.role_label || '').trim().slice(0, 80) || null;

  if (!validSourceTypes.has(sourceType)) return error(res, '来源类型不正确');
  if (!sourceId) return error(res, '来源对象不正确');
  if (!validTargetTypes.has(targetType)) return error(res, '目标类型不正确');
  if (!targetId) return error(res, '目标对象不正确');
  if (!validRelationTypes.has(relationType)) return error(res, '关系类型不正确');
  if (!(await targetExists(targetType, targetId))) {
    return error(res, '目标对象不存在', 404);
  }

  await db.query(
    `INSERT INTO entity_relations
     (source_type, source_id, target_type, target_id, relation_type, role_label)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       role_label = VALUES(role_label)`,
    [sourceType, sourceId, targetType, targetId, relationType, roleLabel]
  );

  const [rows] = await db.query(
    `SELECT * FROM entity_relations
     WHERE source_type = ? AND source_id = ?
       AND target_type = ? AND target_id = ?
       AND relation_type = ?
     LIMIT 1`,
    [sourceType, sourceId, targetType, targetId, relationType]
  );

  return success(res, mapRelation(rows[0]), '关系已建立');
}

async function listEntityRelations(req, res) {
  const params = [];
  const where = [];
  for (const [queryKey, column, allowed] of [
    ['source_type', 'source_type', validSourceTypes],
    ['target_type', 'target_type', validTargetTypes],
    ['relation_type', 'relation_type', validRelationTypes],
  ]) {
    const value = normalizeEnum(req.query[queryKey]);
    if (!value) continue;
    if (!allowed.has(value)) return error(res, `${queryKey} 不正确`);
    where.push(`${column} = ?`);
    params.push(value);
  }
  for (const [queryKey, column] of [
    ['source_id', 'source_id'],
    ['target_id', 'target_id'],
  ]) {
    if (req.query[queryKey] === undefined) continue;
    const value = Number(req.query[queryKey]);
    if (!value) return error(res, `${queryKey} 不正确`);
    where.push(`${column} = ?`);
    params.push(value);
  }

  const limit = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.query(
    `SELECT * FROM entity_relations
     ${sqlWhere}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...params, limit]
  );

  return success(res, rows.map(mapRelation));
}

module.exports = {
  createEntityRelation,
  listEntityRelations,
};
