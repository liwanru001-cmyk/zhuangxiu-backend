const fs = require('node:fs/promises');
const path = require('node:path');
const migrationName = '20260908_independent_designer_projects.sql';
const requiredColumns = {
  renovation_projects: ['created_by', 'creation_source', 'preparation_stage', 'client_name', 'user_id', 'start_date'],
  project_owner_invitations: ['id', 'project_id', 'invited_by', 'target_user_id', 'status', 'expires_at', 'created_at', 'updated_at'],
};
async function columns(connection) {
  const [rows] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`, [Object.keys(requiredColumns)]);
  return new Map(rows.map(row => [`${row.TABLE_NAME}.${row.COLUMN_NAME}`, row]));
}
async function assertSchema(connection) {
  const actual = await columns(connection);
  const problems = [];
  for (const [table, names] of Object.entries(requiredColumns)) {
    for (const name of names) if (!actual.has(`${table}.${name}`)) problems.push(`missing ${table}.${name}`);
  }
  for (const name of ['user_id', 'start_date']) {
    if (actual.get(`renovation_projects.${name}`)?.IS_NULLABLE !== 'YES') problems.push(`${name} must allow NULL`);
  }
  for (const [name, value] of [['creation_source', 'owner'], ['preparation_stage', 'construction']]) {
    if (actual.get(`renovation_projects.${name}`)?.COLUMN_DEFAULT !== value) problems.push(`${name} default must be ${value}`);
  }
  if (problems.length) throw new Error(`Independent project migration required: ${problems.join('; ')}`);
  return { ok: true };
}
// MySQL DDL auto-commits. Resume a partial migration by inspecting each column,
// never by swallowing arbitrary SQL errors or repeatedly modifying a large table.
async function migrate(connection) {
  const lockName = 'zxw_independent_projects_20260908';
  const [[lock]] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
  if (Number(lock.acquired) !== 1) throw new Error('Independent project migration lock unavailable');
  try {
    await connection.query('SET SESSION lock_wait_timeout = 15');
    const sql = await fs.readFile(path.join(__dirname, '..', 'migrations', migrationName), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      const alter = statement.match(/^ALTER TABLE renovation_projects (ADD|MODIFY) COLUMN (\w+) /);
      if (alter) {
        const actual = await columns(connection);
        const column = actual.get(`renovation_projects.${alter[2]}`);
        if (alter[1] === 'ADD' && column) continue;
        if (alter[1] === 'MODIFY' && column?.IS_NULLABLE === 'YES') continue;
      }
      await connection.query(statement);
    }
    await assertSchema(connection);
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
  }
}
module.exports = { migrationName, requiredColumns, assertSchema, migrate };
