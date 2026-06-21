const db = require('../config/db');
const { success, error } = require('../utils/response');

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}

async function findOrCreateUser(phone) {
  let [userRows] = await db.query(
    'SELECT id, phone, password_hash, nickname, avatar, bio, city, role, admin_status FROM users WHERE phone = ?',
    [phone]
  );
  let user = userRows[0];

  if (!user) {
    const [result] = await db.query(
      `INSERT INTO users (phone, nickname, admin_status)
       VALUES (?, CONVERT(0xE8A385E4BFAEE5B08FE8BEBEE4BABA USING utf8mb4), 'pending')`,
      [phone]
    );
    user = {
      id: result.insertId,
      phone,
      role: 'owner',
      nickname: '装修小达人',
      avatar: '',
      bio: '',
      city: '',
      admin_status: 'pending',
      password_hash: null,
    };
    await db.query(
      `INSERT IGNORE INTO user_roles (user_id, role, is_default)
       VALUES (?, 'owner', 1)`,
      [result.insertId]
    );
  }

  return user;
}

async function getUserRoles(userId, fallbackRole = 'owner') {
  const [rows] = await db.query(
    'SELECT role FROM user_roles WHERE user_id = ? ORDER BY is_default DESC, id',
    [userId]
  );
  if (rows.length > 0) return rows.map((row) => row.role);
  await db.query(
    'INSERT IGNORE INTO user_roles (user_id, role, is_default) VALUES (?, ?, 1)',
    [userId, fallbackRole]
  );
  return [fallbackRole];
}

async function buildLoginResponse(user) {
  const jwt = require('jsonwebtoken');
  const roles = await getUserRoles(user.id, user.role || 'owner');
  const currentRole = roles.includes(user.role) ? user.role : roles[0];
  const token = jwt.sign(
    { userId: user.id, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );

  return {
    token,
    user: {
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatar: user.avatar,
      bio: user.bio || '',
      city: user.city,
      role: currentRole,
      current_role: currentRole,
      roles,
    },
  };
}

function guardAdminStatus(res, user) {
  if (user.admin_status === 'pending') {
    return error(res, '账号正在审核中，请等待管理员通过', 403);
  }
  if (user.admin_status === 'rejected') {
    return error(res, '账号申请未通过，请联系管理员', 403);
  }
  return null;
}

// 发送验证码（含防刷）
async function sendSmsCode(req, res) {
  const { phone, captchaToken } = req.body;
  const ip = req.ip;

  // 1. 手机号格式
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return error(res, '手机号格式不正确');
  }

  // 2. 防刷：同手机号 60s 间隔
  const [recentRows] = await db.query(
    'SELECT id FROM sms_codes WHERE phone = ? AND created_at > DATE_SUB(NOW(), INTERVAL 60 SECOND) AND used = 0',
    [phone]
  );
  if (recentRows.length > 0) {
    return error(res, '请 60 秒后再试');
  }

  // 3. 防刷：同手机号每日上限 5 次
  const [dailyRows] = await db.query(
    'SELECT COUNT(*) as cnt FROM sms_codes WHERE phone = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)',
    [phone]
  );
  if (dailyRows[0].cnt >= 5) {
    return error(res, '今日发送次数已达上限，请明天再试');
  }

  // 4. 防刷：同 IP 每日上限 20 次
  const [ipRows] = await db.query(
    'SELECT COUNT(*) as cnt FROM sms_codes WHERE ip = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)',
    [ip]
  );
  if (ipRows[0].cnt >= 20) {
    return error(res, 'IP 请求过于频繁');
  }

  // 5. 虚拟号段拦截（简单规则）
  const virtualPrefixes = ['170', '171', '162', '165', '167'];
  if (virtualPrefixes.some(p => phone.startsWith(p))) {
    return error(res, '不支持虚拟号码，请使用真实手机号');
  }

  // 6. 生成验证码
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 分钟有效

  await db.query(
    'INSERT INTO sms_codes (phone, code, ip, expires_at) VALUES (?, ?, ?, ?)',
    [phone, code, ip, expiresAt]
  );

  // TODO: 接入阿里云短信 API 发送
  // await aliyunSms.send(phone, code);

  console.log(`📱 [SMS] phone=${phone} code=${code} (开发环境)`);

  return success(res, { expires_in: 300 }, '验证码已发送（开发环境请查看日志）');
}

// 验证码登录/注册
async function login(req, res) {
  const { phone, code } = req.body;

  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return error(res, '手机号格式不正确');
  }

  // 验证验证码
  const [rows] = await db.query(
    'SELECT id, code, expires_at, used FROM sms_codes WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1',
    [phone]
  );

  if (rows.length === 0) {
    return error(res, '请先获取验证码');
  }

  if (rows[0].code !== code) {
    return error(res, '验证码错误');
  }

  if (new Date() > rows[0].expires_at) {
    return error(res, '验证码已过期');
  }

  // 标记已使用
  await db.query('UPDATE sms_codes SET used = 1 WHERE id = ?', [rows[0].id]);

  const user = await findOrCreateUser(phone);
  const blocked = guardAdminStatus(res, user);
  if (blocked) return blocked;
  return success(res, await buildLoginResponse(user));
}

// 测试阶段密码登录。生产环境默认关闭，可通过 TEST_LOGIN_PASSWORD 显式开启。
async function passwordLogin(req, res) {
  const { phone, password } = req.body;
  const testPassword = process.env.TEST_LOGIN_PASSWORD ||
    (process.env.NODE_ENV !== 'production' ? '123456' : '');

  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return error(res, '手机号格式不正确');
  }

  const user = await findOrCreateUser(phone);
  const blocked = guardAdminStatus(res, user);
  if (blocked) return blocked;
  if (!user.password_hash && !testPassword) {
    return error(res, '该账号尚未设置密码', 403);
  }
  const passwordMatches = user.password_hash
    ? await bcrypt.compare(password, user.password_hash)
    : password === testPassword;
  if (!passwordMatches) {
    return error(res, user.password_hash ? '密码错误' : '测试密码错误');
  }
  return success(res, await buildLoginResponse(user));
}

// 测试阶段申请密码账号。账号创建后需要管理后台审核通过才可登录。
async function registerPasswordAccount(req, res) {
  const { phone, password } = req.body;
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return error(res, '手机号格式不正确');
  }
  if (!/^\d{6}$/.test(String(password || ''))) {
    return error(res, '密码必须是 6 位数字');
  }

  const [existing] = await db.query(
    'SELECT id, admin_status FROM users WHERE phone = ?',
    [phone]
  );
  if (existing[0]) {
    if (existing[0].admin_status === 'pending') {
      return error(res, '该手机号已提交申请，正在等待审核', 409);
    }
    if (existing[0].admin_status === 'rejected') {
      return error(res, '该手机号申请未通过，请联系管理员', 403);
    }
    return error(res, '该手机号已注册，请直接登录', 409);
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  const [result] = await db.query(
    `INSERT INTO users (phone, nickname, password_hash, admin_status)
     VALUES (?, CONVERT(0xE8A385E4BFAEE5B08FE8BEBEE4BABA USING utf8mb4), ?, 'pending')`,
    [phone, passwordHash]
  );
  await db.query(
    `INSERT IGNORE INTO user_roles (user_id, role, is_default)
     VALUES (?, 'owner', 1)`,
    [result.insertId]
  );
  return success(
    res,
    { id: result.insertId, admin_status: 'pending' },
    '账号申请已提交，请等待管理员审核'
  );
}

module.exports = { sendSmsCode, login, passwordLogin, registerPasswordAccount };
