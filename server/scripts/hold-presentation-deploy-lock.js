'use strict';

const mysql = require('mysql2/promise');

const rawTimeout = process.argv.find(value => value.startsWith('--timeout-seconds='))?.split('=')[1];
const timeoutSeconds = Math.max(1, Math.min(900, Number(rawTimeout || 600)));

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const [[result]] = await connection.query("SELECT GET_LOCK('zxw_presentation_worker', ?) AS acquired", [timeoutSeconds]);
  if (Number(result.acquired) !== 1) {
    await connection.end();
    throw new Error(`Timed out after ${timeoutSeconds}s waiting for active PPT generation to drain`);
  }
  process.stdout.write('PRESENTATION_DEPLOY_LOCK_ACQUIRED\n');
  let closing = false;
  const close = async exitCode => {
    if (closing) return;
    closing = true;
    await connection.query("SELECT RELEASE_LOCK('zxw_presentation_worker')").catch(() => {});
    await connection.end().catch(() => {});
    process.exit(exitCode);
  };
  process.once('SIGINT', () => void close(0));
  process.once('SIGTERM', () => void close(0));
  connection.on('error', error => {
    process.stderr.write(`Presentation deploy lock connection failed: ${error.message}\n`);
    void close(1);
  });
  setInterval(() => {}, 60000);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
