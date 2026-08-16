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

    if (missing.length) console.warn(`Missing test accounts: ${missing.join(',')}`);
    if (unapproved.length) console.warn(`Unapproved test accounts: ${unapproved.join(',')}`);
    console.log(
      `Test login accounts: ${phones.length - missing.length - unapproved.length} approved, ` +
      `${missing.length} missing, ${unapproved.length} unapproved.`
    );
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
