const mysql = require('mysql2/promise');

function configuredPhones() {
  return [...new Set(
    String(process.env.TEST_LOGIN_PHONES || '')
      .split(',')
      .map((phone) => phone.trim())
      .filter(Boolean)
  )];
}

async function main() {
  const phones = configuredPhones();
  if (phones.length === 0) {
    throw new Error('TEST_LOGIN_PHONES is empty');
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    const placeholders = phones.map(() => '?').join(',');
    const [rows] = await connection.query(
      `SELECT phone, admin_status FROM users WHERE phone IN (${placeholders})`,
      phones
    );
    const usersByPhone = new Map(rows.map((row) => [String(row.phone), row]));
    const missing = phones.filter((phone) => !usersByPhone.has(phone));
    const unapproved = phones.filter((phone) => {
      const user = usersByPhone.get(phone);
      return user && user.admin_status !== 'approved';
    });

    if (missing.length || unapproved.length) {
      if (missing.length) console.error(`Missing test accounts: ${missing.join(',')}`);
      if (unapproved.length) console.error(`Unapproved test accounts: ${unapproved.join(',')}`);
      throw new Error('Test login allowlist validation failed');
    }

    console.log(`Verified ${phones.length} pre-created, approved test login accounts.`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
