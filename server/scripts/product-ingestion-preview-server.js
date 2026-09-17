'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const mysql = require('mysql2/promise');

require('dotenv').config({ path:path.join(__dirname, '..', '.env') });

const host = '127.0.0.1';
const port = Number(process.env.PRODUCT_INGESTION_PREVIEW_PORT || 4310);
const sourceDbName = String(process.env.DB_NAME || '').trim();
const previewDbName = String(process.env.PRODUCT_INGESTION_PREVIEW_DB_NAME || `${sourceDbName}_ingestion_preview`).trim();
const username = String(process.env.PRODUCT_INGESTION_PREVIEW_USERNAME || 'preview-admin');
const password = String(process.env.PRODUCT_INGESTION_PREVIEW_PASSWORD || 'goepcLQM34JP');
const token = crypto.randomBytes(32).toString('hex');

function assertLocalConfiguration() {
  const dbHost = String(process.env.DB_HOST || 'localhost').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(dbHost)) throw new Error('本地预览只允许连接 localhost 数据库');
  if (!sourceDbName) throw new Error('server/.env 缺少 DB_NAME');
  if (!/^[a-zA-Z0-9_]+$/.test(previewDbName)) throw new Error('预览数据库名称只能包含字母、数字和下划线');
  if (previewDbName === sourceDbName) throw new Error('预览数据库必须与现有应用数据库隔离');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('预览端口须为 1024 至 65535 的整数');
}

function connectionOptions(database) {
  return {
    host:process.env.DB_HOST || 'localhost', port:Number(process.env.DB_PORT || 3306),
    user:process.env.DB_USER, password:process.env.DB_PASSWORD,
    ...(database ? { database } : {}), charset:'utf8mb4', multipleStatements:true,
  };
}

async function prepareDatabase() {
  const admin = await mysql.createConnection(connectionOptions());
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${previewDbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally { await admin.end(); }
  const connection = await mysql.createConnection(connectionOptions(previewDbName));
  try {
    for (const filename of [
      '20260910_product_ingestion_control.sql',
      '20260911_public_library_project_snapshots.sql',
      '20260912_brand_ingestion_discovery.sql',
      '20260913_public_product_taxonomy.sql',
      '20260914_product_category_governance.sql',
      '20260915_ingestion_automatic_classification.sql',
      '20260916_universal_product_ingestion.sql',
      '20260917_ingestion_request_policy.sql',
      '20260918_ingestion_job_recovery.sql',
      '20260919_ingestion_field_review_rules.sql',
      '20260920_ingestion_recollection.sql',
      '20260921_ingestion_job_soft_delete.sql',
      '20260922_ingestion_ai_site_profile.sql',
      '20260923_public_library_lifecycle.sql',
      '20260924_ingestion_ai_recovery.sql',
      '20260925_ingestion_recovery_closed_loop.sql',
      '20260926_ingestion_site_rule_sandbox.sql',
      '20260927_ingestion_site_cognition.sql',
      '20260928_product_schema_v2.sql',
      '20260929_official_brand_material_library.sql',
      '20260930_official_material_onboarding.sql',
    ]) {
      const migration = await fs.readFile(path.join(__dirname, '..', 'migrations', filename), 'utf8');
      await connection.query(migration);
    }
  } finally { await connection.end(); }
}

function response(res, data = null, message = 'success', code = 200) {
  return res.status(code).json({ code, message, data });
}
function sameSecret(left, right) {
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

async function main() {
  assertLocalConfiguration();
  await prepareDatabase();
  const db = mysql.createPool({ ...connectionOptions(previewDbName), multipleStatements:false, connectionLimit:5 });
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy:false }));
  app.use(express.json({ limit:'1mb' }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.post('/api/admin/login', (req, res) => {
    const suppliedUser = String(req.body?.username || '');
    const suppliedPassword = String(req.body?.password || '');
    if (!sameSecret(suppliedUser, username) || !sameSecret(suppliedPassword, password)) return response(res, null, '用户名或密码错误', 401);
    return response(res, { token, user:{ username } });
  });
  const previewAuth = (req, res, next) => {
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!sameSecret(supplied, token)) return response(res, null, '未登录或预览服务已重启', 401);
    req.admin = { role:'preview-admin', username };
    next();
  };
  app.use('/api/admin/product-ingestion', previewAuth, require('../routes/admin-product-ingestion.routes')(db));
  app.use('/api/storage', express.static(path.join(__dirname, '..', 'storage'), {
    dotfiles:'deny',
    etag:true,
    fallthrough:true,
    immutable:true,
    maxAge:'1y',
  }));
  app.get('/health', async (_req, res) => {
    try { await db.query('SELECT 1'); return response(res, { status:'ok', environment:'local-product-ingestion-preview', database:previewDbName }); }
    catch (_) { return response(res, { status:'degraded' }, '本地预览数据库不可用', 503); }
  });
  const adminPublic = path.join(__dirname, '..', 'public', 'admin');
  app.get('/', (_req, res) => res.redirect('/admin/product-ingestion'));
  app.get('/admin/product-ingestion', (_req, res) => res.sendFile(path.join(adminPublic, 'product-ingestion-preview.html')));
  app.use('/admin', express.static(adminPublic, { etag:false, maxAge:0 }));

  const server = app.listen(port, host, () => {
    console.log(`\n装筱窝产品抓取本地预览已启动：`);
    console.log(`地址：http://${host}:${port}/admin/product-ingestion`);
    console.log(`用户名：${username}`);
    console.log(`密码：${password}`);
    console.log(`隔离数据库：${previewDbName}`);
    console.log('按 Ctrl+C 停止。保存或授权任务不会访问网站；只有点击确认开始分析或抓取才会访问已确认范围。\n');
  });
  const close = async () => { server.close(async () => { await db.end(); process.exit(0); }); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch(error => { console.error(`本地预览启动失败：${error.message}`); process.exit(1); });
