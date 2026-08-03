const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const baseline = '20260802_project_progress_change_requests.sql';

async function main() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    for (const name of files) {
      const sql = await fs.readFile(path.join(migrationsDir, name), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const [existing] = await connection.query(
        'SELECT checksum FROM schema_migrations WHERE name = ? LIMIT 1',
        [name]
      );
      if (existing[0]) continue;

      if (name <= baseline) {
        await connection.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
          [name, checksum]
        );
        console.log(`Migration baselined: ${name}`);
        continue;
      }

      await connection.query(sql);
      await connection.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
        [name, checksum]
      );
      console.log(`Migration applied: ${name}`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
