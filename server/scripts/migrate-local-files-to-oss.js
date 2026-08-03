require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
const storage = require('../services/storage.service');

const apply = process.argv.includes('--apply');
const serverRoot = path.join(__dirname, '..');
const backupPath = path.join(serverRoot, `oss-migration-backup-${Date.now()}.json`);

async function walk(root) {
  const results = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) results.push(fullPath);
    }
  }
  await visit(root);
  return results;
}

function objectKey(filePath) {
  const uploadsRoot = path.join(serverRoot, 'uploads');
  const storageRoot = path.join(serverRoot, 'storage');
  if (filePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    return `uploads/${path.relative(uploadsRoot, filePath).split(path.sep).join('/')}`;
  }
  return path.relative(storageRoot, filePath).split(path.sep).join('/');
}

function migrateValue(value, bucket) {
  if (typeof value !== 'string' || !value) return value;
  let next = value.replace(
    /https?:\/\/[^/"'\\]+\/(?:api\/)?uploads\//g,
    `oss://${bucket}/uploads/`
  );
  next = next.replace(
    /https?:\/\/[^/"'\\]+\/(?:api\/)?storage\//g,
    `oss://${bucket}/`
  );
  next = next.replace(/(^|["'])\/(?:api\/)?uploads\//g, `$1oss://${bucket}/uploads/`);
  next = next.replace(/(^|["'])\/(?:api\/)?storage\//g, `$1oss://${bucket}/`);
  return next;
}

async function uploadFiles(files) {
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const filePath = files[cursor++];
      const key = objectKey(filePath);
      await storage.putFile({ sourcePath: filePath, key, req: null });
      console.log(`uploaded ${key}`);
    }
  }
  const concurrency = Math.max(1, Number(process.env.OSS_MIGRATION_CONCURRENCY || 1));
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}

async function migrateDatabase(connection, bucket) {
  const [columns] = await connection.query(`
    SELECT c.TABLE_NAME, c.COLUMN_NAME,
      (SELECT k.COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE k
       WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA
         AND k.TABLE_NAME = c.TABLE_NAME
         AND k.CONSTRAINT_NAME = 'PRIMARY'
       LIMIT 1) AS PRIMARY_KEY,
      (SELECT COUNT(*)
       FROM information_schema.KEY_COLUMN_USAGE k
       WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA
         AND k.TABLE_NAME = c.TABLE_NAME
         AND k.CONSTRAINT_NAME = 'PRIMARY') AS PRIMARY_KEY_COUNT
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = DATABASE()
      AND t.TABLE_TYPE = 'BASE TABLE'
      AND c.DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext','json')
  `);
  const backup = [];
  for (const column of columns) {
    if (Number(column.PRIMARY_KEY_COUNT) !== 1 || !column.PRIMARY_KEY) continue;
    const table = mysql.escapeId(column.TABLE_NAME);
    const field = mysql.escapeId(column.COLUMN_NAME);
    const primary = mysql.escapeId(column.PRIMARY_KEY);
    const [rows] = await connection.query(
      `SELECT ${primary} AS row_id, ${field} AS old_value FROM ${table}
       WHERE ${field} LIKE '%/uploads/%' OR ${field} LIKE '%/storage/%'`
    );
    for (const row of rows) {
      const newValue = migrateValue(row.old_value, bucket);
      if (newValue === row.old_value) continue;
      backup.push({
        table: column.TABLE_NAME,
        column: column.COLUMN_NAME,
        primaryKey: column.PRIMARY_KEY,
        rowId: row.row_id,
        oldValue: row.old_value,
        newValue,
      });
    }
  }
  await fs.writeFile(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
  for (const item of backup) {
    await connection.query(
      `UPDATE ${mysql.escapeId(item.table)} SET ${mysql.escapeId(item.column)} = ?
       WHERE ${mysql.escapeId(item.primaryKey)} = ? AND ${mysql.escapeId(item.column)} = ?`,
      [item.newValue, item.rowId, item.oldValue]
    );
  }
  return backup.length;
}

async function main() {
  const files = [
    ...(await walk(path.join(serverRoot, 'uploads'))),
    ...(await walk(path.join(serverRoot, 'storage'))),
  ].filter((file) => !file.includes(`${path.sep}.tmp${path.sep}`));
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${files.length} local files found`);
  if (!apply) {
    console.log('No changes made. Run with --apply after a database and disk backup.');
    return;
  }
  if (!storage.useOss()) throw new Error('Set STORAGE_DRIVER=oss before applying migration');
  await storage.checkStorageConnection();
  await uploadFiles(files);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  });
  try {
    await connection.beginTransaction();
    const updates = await migrateDatabase(connection, process.env.OSS_BUCKET);
    await connection.commit();
    console.log(`Migration complete: ${files.length} files, ${updates} database values`);
    console.log(`Rollback manifest: ${backupPath}`);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
