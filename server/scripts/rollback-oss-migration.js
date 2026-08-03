require('dotenv').config();
const fs = require('fs/promises');
const mysql = require('mysql2/promise');

async function main() {
  const manifest = process.argv[2];
  if (!manifest || !process.argv.includes('--apply')) {
    throw new Error('Usage: node scripts/rollback-oss-migration.js <backup.json> --apply');
  }
  const backup = JSON.parse(await fs.readFile(manifest, 'utf8'));
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
    for (const item of backup) {
      await connection.query(
        `UPDATE ${mysql.escapeId(item.table)} SET ${mysql.escapeId(item.column)} = ?
         WHERE ${mysql.escapeId(item.primaryKey)} = ? AND ${mysql.escapeId(item.column)} = ?`,
        [item.oldValue, item.rowId, item.newValue]
      );
    }
    await connection.commit();
    console.log(`Restored ${backup.length} database values. OSS objects were retained.`);
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
