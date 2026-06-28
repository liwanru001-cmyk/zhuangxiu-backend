const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const migrationPath = process.argv[2];
  if (!migrationPath) {
    throw new Error('Usage: node scripts/run-migration.js <migration.sql>');
  }

  const absolutePath = path.resolve(process.cwd(), migrationPath);
  const sql = await fs.readFile(absolutePath, 'utf8');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  try {
    await connection.query(sql);
    console.log(`Migration applied: ${migrationPath}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
