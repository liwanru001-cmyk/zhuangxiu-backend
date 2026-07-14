const db = require('../config/db');
const { success, error } = require('../utils/response');

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const aliyunSms = require('../services/aliyun-sms.service');
const smsRateLimiter = require('../services/sms-rate-limiter.service');
const wechatMiniProgram = require('../services/wechat-miniprogram.service');

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}

async function findUserByPhone(phone) {
  const [userRows] = await db.query(
    `SELECT id, phone, password_hash, nickname, avatar, bio, city, role,
            admin_status, identity_onboarding_completed
       FROM users WHERE phone = ?`,
    [phone]
  );
  return userRows[0] || null;
}

async function createFormalUser(phone) {
  const [result] = await db.query(
    `INSERT INTO users (phone, nickname, admin_status)
     VALUES (?, CONVERT(0xE8A385E4BFAEE5B08FE8BEBEE4BABA USING utf8mb4), 'approved')`,
    [phone]
  );
  await db.query(
    `INSERT IGNORE INTO user_roles (user_id, role, is_default)
     VALUES (?, 'owner', 1)`,
    [result.insertId]
  );

  return {
    id: result.insertId,
    phone,
    role: 'owner',
    nickname: '装修小达人',
    avatar: '',
    bio: '',
    city: '',
    admin_status: 'approved',
    identity_onboarding_completed: 0,
    password_hash: null,
  };
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
      identity_onboarding_completed: Boolean(user.identity_onboarding_completed),
    },
  };
}

function validatePhone(phone) {
  return /^1[3-9]\d{9}$/.test(String(phone || ''));
}

function validateCode(code) {
  return /^\d{6}$/.test(String(code || ''));
}

function validatePassword(password) {
  return /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d\S]{8,}$/.test(String(password || ''));
}

function normalizeSmsScene(scene) {
  const value = String(scene || 'register').trim();
  return ['register', 'reset_password', 'login'].includes(value) ? value : null;
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
  const { phone } = req.body;
  const scene = normalizeSmsScene(req.body.scene);
  const ip = req.ip;

  // 1. 手机号格式
  if (!validatePhone(phone)) {
    return error(res, '手机号格式不正确');
  }
  if (!scene) {
    return error(res, '短信验证码场景不正确');
  }

  const existingUser = await findUserByPhone(phone);
  if (scene === 'register' && existingUser) {
    return error(res, '该手机号已注册，请使用密码登录', 409);
  }
  if (scene === 'reset_password' && !existingUser) {
    return error(res, '该手机号未注册，请先注册', 404);
  }

  let limitResult;
  try {
    limitResult = await smsRateLimiter.enforceSendLimit({ req, phone, scene });
  } catch (err) {
    console.error('[SMS] rate limiter failed:', err.message);
    return error(res, err.publicMessage || '短信风控服务暂不可用', err.statusCode || 503);
  }
  if (!limitResult.allowed) {
    if (limitResult.retryAfter) res.set?.('Retry-After', String(limitResult.retryAfter));
    return error(res, limitResult.message, limitResult.statusCode || 429);
  }

  // 2. 虚拟号段拦截（简单规则）
  const virtualPrefixes = ['170', '171', '162', '165', '167'];
  if (virtualPrefixes.some(p => phone.startsWith(p))) {
    return error(res, '不支持虚拟号码，请使用真实手机号');
  }

  // 3. 生成验证码
  const code = generateCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 分钟有效

  const [insertResult] = await db.query(
    'INSERT INTO sms_codes (phone, code, scene, ip, expires_at) VALUES (?, ?, ?, ?, ?)',
    [phone, code, scene, ip, expiresAt]
  );

  try {
    await aliyunSms.sendVerificationCode(phone, code);
  } catch (err) {
    await db.query('UPDATE sms_codes SET used = 1 WHERE id = ?', [insertResult.insertId]);
    console.error('[SMS] send failed:', err.message);
    return error(res, '短信发送失败，请稍后再试', 502);
  }

  return success(res, { expires_in: 300 }, '验证码已发送');
}

async function consumeSmsCode(phone, code, scene) {
  if (!validatePhone(phone)) {
    return { errorMessage: '手机号格式不正确' };
  }
  if (!validateCode(code)) {
    return { errorMessage: '验证码格式不正确' };
  }
  if (!normalizeSmsScene(scene)) {
    return { errorMessage: '短信验证码场景不正确' };
  }

  const [rows] = await db.query(
    'SELECT id, code, expires_at, used FROM sms_codes WHERE phone = ? AND scene = ? AND used = 0 ORDER BY id DESC LIMIT 1',
    [phone, scene]
  );

  if (rows.length === 0) {
    return { errorMessage: '请先获取验证码' };
  }

  if (rows[0].code !== code) {
    const failure = await smsRateLimiter.registerCodeFailure({
      phone,
      scene,
      codeId: rows[0].id,
    });
    if (failure.exhausted) {
      await db.query('UPDATE sms_codes SET used = 1 WHERE id = ?', [rows[0].id]);
      return { errorMessage: '验证码错误次数过多，请重新获取' };
    }
    return { errorMessage: '验证码错误' };
  }

  if (new Date() > rows[0].expires_at) {
    return { errorMessage: '验证码已过期' };
  }

  await smsRateLimiter.clearCodeFailures({ phone, scene, codeId: rows[0].id });
  await db.query('UPDATE sms_codes SET used = 1 WHERE id = ?', [rows[0].id]);
  return { ok: true };
}

// 短信验证码注册正式账号
async function verifySms(req, res) {
  const { phone, code } = req.body;

  const smsResult = await consumeSmsCode(phone, code, 'register');
  if (!smsResult.ok) return error(res, smsResult.errorMessage);

  const existingUser = await findUserByPhone(phone);
  if (existingUser) {
    return error(res, '该手机号已注册，请使用密码登录', 409);
  }

  const user = await createFormalUser(phone);
  const blocked = guardAdminStatus(res, user);
  if (blocked) return blocked;
  return success(res, await buildLoginResponse(user));
}

// 兼容旧验证码登录路径：现在用于短信注册。
async function login(req, res) {
  return verifySms(req, res);
}

async function passwordLogin(req, res) {
  const { phone, password } = req.body;

  if (!validatePhone(phone)) {
    return error(res, '手机号格式不正确');
  }

  const user = await findUserByPhone(phone);
  if (!user) {
    return error(res, '该手机号未注册，请先短信验证', 404);
  }
  const blocked = guardAdminStatus(res, user);
  if (blocked) return blocked;
  if (!user.password_hash) {
    return error(res, '该账号尚未设置密码，请先设置密码', 403);
  }
  const passwordMatches = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!passwordMatches) {
    return error(res, '手机号或密码错误', 401);
  }
  return success(res, await buildLoginResponse(user));
}

async function testLogin(req, res) {
  const { phone, password } = req.body;
  const testPassword = String(process.env.TEST_LOGIN_PASSWORD || '');

  if (!testPassword) {
    return error(res, '测试登录未启用', 404);
  }
  if (!validatePhone(phone)) {
    return error(res, '手机号格式不正确');
  }
  if (String(password || '') !== testPassword) {
    return error(res, '手机号或密码错误', 401);
  }

  let user = await findUserByPhone(phone);
  if (!user) {
    user = await createFormalUser(phone);
  }

  const blocked = guardAdminStatus(res, user);
  if (blocked) return blocked;
  return success(res, await buildLoginResponse(user));
}

async function bindWechatIdentitySafely({ userId, appid, openid, unionid, phone, allowExistingForUser = true }) {
  const [openidRows] = await db.query(
    `SELECT user_id, phone
     FROM wechat_identities
     WHERE appid = ? AND openid = ?
     LIMIT 1`,
    [appid, openid]
  );
  const existingOpenid = openidRows[0] || null;
  if (existingOpenid && Number(existingOpenid.user_id) !== Number(userId)) {
    return {
      ok: false,
      statusCode: 409,
      message: '该微信账号已绑定其他账号，请切换账号登录或联系客服处理',
      conflictType: 'wechat_bound_other_user',
      conflictUserId: Number(existingOpenid.user_id),
    };
  }
  if (existingOpenid && !allowExistingForUser) {
    return {
      ok: false,
      statusCode: 409,
      message: '该微信账号已绑定当前账号',
      conflictType: 'wechat_bound_current_user',
    };
  }

  const [userWechatRows] = await db.query(
    `SELECT openid
     FROM wechat_identities
     WHERE user_id = ? AND platform = 'miniprogram' AND openid <> ?
     LIMIT 1`,
    [userId, openid]
  );
  if (userWechatRows[0]) {
    return {
      ok: false,
      statusCode: 409,
      message: '当前账号已绑定其他微信账号，如需更换请联系客服处理',
      conflictType: 'current_user_bound_other_wechat',
    };
  }

  const [phoneWechatRows] = await db.query(
    `SELECT user_id, openid
     FROM wechat_identities
     WHERE phone = ? AND platform = 'miniprogram' AND openid <> ?
     LIMIT 1`,
    [phone, openid]
  );
  if (phoneWechatRows[0]) {
    return {
      ok: false,
      statusCode: 409,
      message: '该手机号已绑定其他微信账号，如需更换请联系客服处理',
      conflictType: 'phone_bound_other_wechat',
      conflictUserId: Number(phoneWechatRows[0].user_id) || null,
    };
  }

  if (existingOpenid) {
    await db.query(
      `UPDATE wechat_identities
       SET unionid = ?, phone = ?, last_login_at = NOW(), updated_at = CURRENT_TIMESTAMP
       WHERE appid = ? AND openid = ?`,
      [unionid || null, phone, appid, openid]
    );
    return { ok: true, created: false };
  }

  await db.query(
    `INSERT INTO wechat_identities
       (user_id, platform, appid, openid, unionid, phone, last_login_at)
     VALUES (?, 'miniprogram', ?, ?, ?, ?, NOW())`,
    [userId, appid, openid, unionid || null, phone]
  );
  return { ok: true, created: true };
}

async function createWechatBindingAppeal({
  userId,
  currentPhone,
  wechatPhone,
  appid,
  openid,
  unionid,
  conflictType,
  conflictMessage,
  conflictUserId,
}) {
  const [existingRows] = await db.query(
    `SELECT id
     FROM wechat_binding_appeals
     WHERE user_id = ? AND appid = ? AND openid = ? AND conflict_type = ?
       AND status IN ('pending', 'processing')
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, appid, openid, conflictType || 'unknown']
  );

  if (existingRows[0]) {
    await db.query(
      `UPDATE wechat_binding_appeals
       SET current_phone = ?, wechat_phone = ?, unionid = ?, conflict_message = ?,
           conflict_user_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        currentPhone || null,
        wechatPhone || null,
        unionid || null,
        conflictMessage || '',
        conflictUserId || null,
        existingRows[0].id,
      ]
    );
    return existingRows[0].id;
  }

  const [result] = await db.query(
    `INSERT INTO wechat_binding_appeals
       (user_id, current_phone, wechat_phone, appid, openid, unionid,
        conflict_type, conflict_message, conflict_user_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      userId,
      currentPhone || null,
      wechatPhone || null,
      appid,
      openid,
      unionid || null,
      conflictType || 'unknown',
      conflictMessage || '',
      conflictUserId || null,
    ]
  );
  return result.insertId;
}

async function wechatPhoneLogin(req, res) {
  const loginCode = String(req.body.login_code || req.body.loginCode || '').trim();
  const phoneCode = String(req.body.phone_code || req.body.phoneCode || '').trim();
  if (!loginCode) return error(res, '缺少微信登录凭证');
  if (!phoneCode) return error(res, '缺少微信手机号授权凭证');

  let session;
  let phoneInfo;
  try {
    [session, phoneInfo] = await Promise.all([
      wechatMiniProgram.codeToSession(loginCode),
      wechatMiniProgram.getPhoneNumber(phoneCode),
    ]);
  } catch (err) {
    console.error('[WechatLogin] failed:', err.message);
    return error(res, err.publicMessage || '微信登录失败，请稍后再试', err.statusCode || 502);
  }

  const phone = String(phoneInfo.phone || '').replace(/\D/g, '').slice(-11);
  if (!validatePhone(phone)) {
    return error(res, '微信手机号格式不正确');
  }

  let user = await findUserByPhone(phone);
  const isNewUser = !user;
  if (!user) {
    user = await createFormalUser(phone);
  }
  const blocked = guardAdminStatus(res, user);
  if (blocked) return blocked;

  const bindResult = await bindWechatIdentitySafely({
    userId: user.id,
    appid: session.appid,
    openid: session.openid,
    unionid: session.unionid,
    phone,
  });
  if (!bindResult.ok) return error(res, bindResult.message, bindResult.statusCode);

  const loginResponse = await buildLoginResponse(user);
  loginResponse.is_new_user = isNewUser;
  return success(res, loginResponse);
}

async function bindWechatMiniProgram(req, res) {
  const loginCode = String(req.body.login_code || req.body.loginCode || '').trim();
  const phoneCode = String(req.body.phone_code || req.body.phoneCode || '').trim();
  if (!loginCode) return error(res, '缺少微信登录凭证');
  if (!phoneCode) return error(res, '缺少微信手机号授权凭证');

  let session;
  let phoneInfo;
  try {
    [session, phoneInfo] = await Promise.all([
      wechatMiniProgram.codeToSession(loginCode),
      wechatMiniProgram.getPhoneNumber(phoneCode),
    ]);
  } catch (err) {
    console.error('[WechatBind] failed:', err.message);
    return error(res, err.publicMessage || '微信账号同步失败，请稍后再试', err.statusCode || 502);
  }

  const phone = String(phoneInfo.phone || '').replace(/\D/g, '').slice(-11);
  if (!validatePhone(phone)) {
    return error(res, '微信手机号格式不正确');
  }
  if (String(req.user.phone || '') !== phone) {
    return error(res, '授权手机号不一致，请更换授权微信号重新绑定', 409);
  }

  const [currentWechatRows] = await db.query(
    `SELECT id
     FROM wechat_identities
     WHERE user_id = ? AND platform = 'miniprogram'
     LIMIT 1`,
    [req.user.id]
  );
  if (currentWechatRows[0]) {
    return success(res, {
      bound: true,
      already_bound: true,
      phone,
    }, '当前账号已同步微信账户，无需重复绑定');
  }

  const bindResult = await bindWechatIdentitySafely({
    userId: req.user.id,
    appid: session.appid,
    openid: session.openid,
    unionid: session.unionid,
    phone,
  });
  if (!bindResult.ok) {
    await createWechatBindingAppeal({
      userId: req.user.id,
      currentPhone: req.user.phone,
      wechatPhone: phone,
      appid: session.appid,
      openid: session.openid,
      unionid: session.unionid,
      conflictType: bindResult.conflictType,
      conflictMessage: bindResult.message,
      conflictUserId: bindResult.conflictUserId,
    });
    return error(res, `${bindResult.message}，已提交给管理员处理`, bindResult.statusCode);
  }

  return success(res, {
    bound: true,
    phone,
    unionid_bound: Boolean(session.unionid),
  }, '微信账号已同步');
}

async function setPassword(req, res) {
  const { password } = req.body;

  if (!validatePassword(password)) {
    return error(res, '密码必须至少8位，并且包含字母和数字');
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id]);

  return success(res, { password_set: true }, '密码设置成功');
}

async function resetPassword(req, res) {
  const { phone, code, password } = req.body;

  if (!validatePassword(password)) {
    return error(res, '密码必须至少8位，并且包含字母和数字');
  }

  const smsResult = await consumeSmsCode(phone, code, 'reset_password');
  if (!smsResult.ok) return error(res, smsResult.errorMessage);

  const user = await findUserByPhone(phone);
  if (!user) {
    return error(res, '该手机号未注册，请先短信验证', 404);
  }
  const blocked = guardAdminStatus(res, user);
  if (blocked) return blocked;

  const passwordHash = await bcrypt.hash(String(password), 10);
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);

  return success(res, { password_reset: true }, '密码已重置，请使用新密码登录');
}

// 旧密码注册入口已关闭，注册必须先通过短信验证。
async function registerPasswordAccount(req, res) {
  const { phone } = req.body;
  if (!validatePhone(phone)) {
    return error(res, '手机号格式不正确');
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

  return error(res, '请先通过短信验证码注册账号', 400);
}

module.exports = {
  sendSmsCode,
  verifySms,
  login,
  passwordLogin,
  testLogin,
  wechatPhoneLogin,
  bindWechatMiniProgram,
  setPassword,
  resetPassword,
  registerPasswordAccount,
};
