const accessTokenCache = {
  token: '',
  expiresAt: 0,
};

function getConfig() {
  const appid = process.env.WECHAT_MINIPROGRAM_APPID || process.env.WX_MINIPROGRAM_APPID || '';
  const secret = process.env.WECHAT_MINIPROGRAM_SECRET || process.env.WX_MINIPROGRAM_SECRET || '';
  return { appid, secret };
}

function assertConfigured() {
  const config = getConfig();
  if (!config.appid || !config.secret) {
    const err = new Error('微信小程序登录未配置');
    err.publicMessage = '微信小程序登录未配置，请联系管理员';
    err.statusCode = 503;
    throw err;
  }
  return config;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    const err = new Error('微信接口响应解析失败');
    err.publicMessage = '微信登录服务暂不可用，请稍后再试';
    err.statusCode = 502;
    throw err;
  }
}

function assertWechatOk(data, fallbackMessage) {
  if (!data || data.errcode === undefined || Number(data.errcode) === 0) return;
  const err = new Error(`Wechat API error ${data.errcode}: ${data.errmsg || ''}`);
  err.publicMessage = fallbackMessage || data.errmsg || '微信登录失败，请稍后再试';
  err.statusCode = 502;
  throw err;
}

async function codeToSession(loginCode) {
  const { appid, secret } = assertConfigured();
  const params = new URLSearchParams({
    appid,
    secret,
    js_code: loginCode,
    grant_type: 'authorization_code',
  });
  const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${params.toString()}`);
  const data = await readJsonResponse(response);
  assertWechatOk(data, '微信登录凭证校验失败，请重新授权');
  if (!data.openid || !data.session_key) {
    const err = new Error('Wechat code2session missing openid/session_key');
    err.publicMessage = '微信登录凭证校验失败，请重新授权';
    err.statusCode = 502;
    throw err;
  }
  return {
    appid,
    openid: data.openid,
    unionid: data.unionid || '',
    sessionKey: data.session_key,
  };
}

async function getAccessToken() {
  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expiresAt > now + 60 * 1000) {
    return accessTokenCache.token;
  }
  const { appid, secret } = assertConfigured();
  const params = new URLSearchParams({
    grant_type: 'client_credential',
    appid,
    secret,
  });
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/token?${params.toString()}`);
  const data = await readJsonResponse(response);
  assertWechatOk(data, '微信登录服务暂不可用，请稍后再试');
  if (!data.access_token) {
    const err = new Error('Wechat access_token missing');
    err.publicMessage = '微信登录服务暂不可用，请稍后再试';
    err.statusCode = 502;
    throw err;
  }
  accessTokenCache.token = data.access_token;
  accessTokenCache.expiresAt = now + Math.max(300, Number(data.expires_in || 7200) - 300) * 1000;
  return accessTokenCache.token;
}

async function getPhoneNumber(phoneCode) {
  const accessToken = await getAccessToken();
  const response = await fetch(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: phoneCode }),
  });
  const data = await readJsonResponse(response);
  assertWechatOk(data, '微信手机号授权失败，请重新授权');
  const phoneInfo = data.phone_info || {};
  const phone = phoneInfo.purePhoneNumber || phoneInfo.phoneNumber || '';
  if (!phone) {
    const err = new Error('Wechat phone_info missing phone');
    err.publicMessage = '未获取到微信绑定手机号，请重新授权';
    err.statusCode = 502;
    throw err;
  }
  return {
    phone,
    countryCode: phoneInfo.countryCode || '',
    watermark: phoneInfo.watermark || null,
  };
}

module.exports = {
  codeToSession,
  getPhoneNumber,
};
