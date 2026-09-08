const path = require('node:path');
const mysql = require('mysql2/promise');
const { assertSchema } = require('../services/independent-project-schema');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  try {
    await assertSchema(connection);
    console.log('Independent project schema verified (columns, nullable fields, legacy defaults).');
    console.log('Independent project creation enabled:', require('../services/independent-project-rollout').enabled());
  } finally { await connection.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
