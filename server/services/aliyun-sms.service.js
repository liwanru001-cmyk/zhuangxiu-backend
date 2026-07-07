const Dysmsapi = require('@alicloud/dysmsapi20170525');
const OpenApi = require('@alicloud/openapi-client');

let client;

function getSmsConfig() {
  return {
    accessKeyId: process.env.ALI_ACCESS_KEY_ID || process.env.SMS_ACCESS_KEY_ID,
    accessKeySecret:
      process.env.ALI_ACCESS_KEY_SECRET || process.env.SMS_ACCESS_KEY_SECRET,
    signName: process.env.ALI_SMS_SIGN_NAME || process.env.SMS_SIGN_NAME,
    templateCode:
      process.env.ALI_SMS_TEMPLATE_CODE || process.env.SMS_TEMPLATE_CODE,
  };
}

function isConfigured(config = getSmsConfig()) {
  return Boolean(
    config.accessKeyId &&
    config.accessKeySecret &&
    config.signName &&
    config.templateCode
  );
}

function getClient(config) {
  if (!client) {
    const openApiConfig = new OpenApi.Config({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
    });
    openApiConfig.endpoint = 'dysmsapi.aliyuncs.com';
    client = new Dysmsapi.default(openApiConfig);
  }
  return client;
}

async function sendVerificationCode(phone, code) {
  const config = getSmsConfig();

  if (!isConfigured(config)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('阿里云短信配置不完整');
    }
    console.log(`[SMS:DEV] phone=${phone} code=${code}`);
    return { provider: 'dev-log', bizId: null };
  }

  const request = new Dysmsapi.SendSmsRequest({
    phoneNumbers: phone,
    signName: config.signName,
    templateCode: config.templateCode,
    templateParam: JSON.stringify({ code }),
  });

  const response = await getClient(config).sendSms(request);
  const body = response.body || {};
  if (body.code !== 'OK') {
    throw new Error(body.message || body.code || '阿里云短信发送失败');
  }

  return { provider: 'aliyun', bizId: body.bizId || null, requestId: body.requestId || null };
}

module.exports = {
  sendVerificationCode,
};
