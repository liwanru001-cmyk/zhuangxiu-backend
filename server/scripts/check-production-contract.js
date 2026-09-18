'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createClient } = require('redis');
const { chromium } = require('playwright-core');
const adminAuthentication = require('../services/admin-auth');
const { configuration: ingestionAiConfiguration } = require('../services/product-ingestion-qwen-analyzer');
const { executablePath: chromiumExecutablePath } = require('../services/product-ingestion-rendered-fetch');
const storage = require('../services/storage.service');
const { runtimeRole, API_ROLE, INGESTION_WORKER_ROLE } = require('../services/runtime-role');
const { initializeEcsRamRoleCredentials } = require('../services/ecs-ram-role-credentials');

function executable(value, env = process.env) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  const isExecutable = target => {
    try { fs.accessSync(target, fs.constants.X_OK); return true; }
    catch { return false; }
  };
  if (path.isAbsolute(candidate)) return isExecutable(candidate) ? candidate : null;
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const target = path.join(directory, candidate);
    if (isExecutable(target)) return target;
  }
  return null;
}

function validateProductionContract(env = process.env, runtime = {}) {
  const errors = [];
  const warnings = [];
  const nodeVersion = runtime.nodeVersion || process.versions.node;
  const expectedNodeMajor = Number.parseInt(env.PRODUCTION_NODE_MAJOR || '22', 10);
  const actualNodeMajor = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  const role = runtimeRole(env);
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production');
  if (!['', 'normal'].includes(String(env.APP_RUNTIME_MODE || '').trim().toLowerCase())) errors.push('APP_RUNTIME_MODE must be normal in production');
  if (![API_ROLE,INGESTION_WORKER_ROLE].includes(role)) errors.push('APP_RUNTIME_ROLE must be api or ingestion-worker');
  if (!Number.isSafeInteger(expectedNodeMajor) || expectedNodeMajor < 20) errors.push('PRODUCTION_NODE_MAJOR is invalid');
  else if (actualNodeMajor !== expectedNodeMajor) errors.push(`Node.js major must be ${expectedNodeMajor}, got ${actualNodeMajor}`);

  for (const name of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!String(env[name] || '').trim()) errors.push(`${name} is required`);
  }
  if(role===API_ROLE){try { adminAuthentication.assertConfiguration(env); }
  catch (error) { errors.push(error.message); }}

  const concurrency = Number.parseInt(env.INGESTION_GLOBAL_CONCURRENCY || '2', 10);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    errors.push('INGESTION_GLOBAL_CONCURRENCY must be an integer between 1 and 8');
  }
  const retryMs = Number.parseInt(env.INGESTION_GLOBAL_SLOT_RETRY_MS || '1000', 10);
  if (!Number.isSafeInteger(retryMs) || retryMs < 100 || retryMs > 60000) {
    errors.push('INGESTION_GLOBAL_SLOT_RETRY_MS must be between 100 and 60000');
  }

  const ai = ingestionAiConfiguration(env);
  if(role===INGESTION_WORKER_ROLE){
    if (!ai.apiKey) errors.push('Ingestion AI API key is required');
    if (!ai.model) errors.push('Ingestion AI model is required');
    if (!String(ai.endpoint || '').startsWith('/')) errors.push('Ingestion AI endpoint must start with /');
    try {
      const url = new URL(ai.baseUrl);
      if (url.protocol !== 'https:') errors.push('Ingestion AI base URL must use HTTPS');
      if (url.username || url.password || url.search || url.hash) errors.push('Ingestion AI base URL must not contain credentials, query parameters, or fragments');
    } catch { errors.push('Ingestion AI base URL is invalid'); }
  }

  let redisProtocol = null;
  if(role===API_ROLE){try {
    const url = new URL(String(env.REDIS_URL || ''));
    redisProtocol = url.protocol;
    if (!['redis:', 'rediss:'].includes(url.protocol)) errors.push('REDIS_URL must use redis:// or rediss://');
  } catch { errors.push('REDIS_URL is required and must be valid'); }
  if (env.SMS_RATE_LIMIT_ALLOW_MEMORY_FALLBACK === 'true') errors.push('Production Redis memory fallback must be disabled');}

  const chromePath = (runtime.chromiumExecutablePath || chromiumExecutablePath)(env);
  if (role===INGESTION_WORKER_ROLE&&!chromePath) errors.push('INGESTION_CHROME_PATH must resolve to an installed Chromium executable');
  if (role===API_ROLE&&chromePath) errors.push('API role must not configure an ingestion Chromium executable');

  const fcMatch = role===API_ROLE?(runtime.executable || executable)(env.PRESENTATION_FC_MATCH || 'fc-match', env):null;
  if (role===API_ROLE&&!fcMatch) errors.push('PRESENTATION_FC_MATCH must resolve to an executable');
  const font = String(env.PRESENTATION_V2_FALLBACK_FONT || '').trim();
  if (role===API_ROLE&&!font) errors.push('PRESENTATION_V2_FALLBACK_FONT is required');
  else if (role===API_ROLE&&fcMatch && runtime.checkFont !== false) {
    try {
      const resolved = execFileSync(fcMatch, ['-f', '%{family}\n', font], { encoding: 'utf8', timeout: 5000 }).trim();
      if (!resolved.toLowerCase().includes(font.toLowerCase())) errors.push(`Required font is not installed: ${font}`);
    } catch { errors.push(`Unable to resolve required font: ${font}`); }
  }

  const driver = String(env.STORAGE_DRIVER || 'local').trim().toLowerCase();
  if (!['local', 'oss'].includes(driver)) errors.push('STORAGE_DRIVER must be local or oss');
  if (driver === 'oss') {
    const names = ['OSS_REGION', 'OSS_BUCKET'];
    if (!String(env.OSS_RAM_ROLE_NAME || '').trim()) names.push('OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET');
    for (const name of names) {
      if (!String(env[name] || '').trim()) errors.push(`${name} is required when STORAGE_DRIVER=oss`);
    }
  } else {
    warnings.push('STORAGE_DRIVER=local requires persistent private host storage and single-host operation');
  }

  if (errors.length) {
    const error = new Error(`Production environment contract failed:\n- ${errors.join('\n- ')}`);
    error.code = 'PRODUCTION_CONTRACT_INVALID';
    error.details = { errors, warnings };
    throw error;
  }
  return {
    node_major: actualNodeMajor,
    runtime_role: role,
    ingestion_global_concurrency: concurrency,
    ingestion_ai_model: ai.model,
    ingestion_ai_base_url: ai.baseUrl,
    redis_protocol: redisProtocol,
    chromium_path: chromePath,
    storage_driver: driver,
    fallback_font: font,
    warnings,
  };
}

async function checkConnectivity(contract, env = process.env) {
  const redis = contract.runtime_role===API_ROLE?createClient({
    url: env.REDIS_URL,
    socket: { connectTimeout: Number(env.REDIS_CONNECT_TIMEOUT_MS || 1500), reconnectStrategy: false },
  }):null;
  redis?.on('error', () => {});
  let browser;
  try {
    if(redis){await redis.connect();const pong = await redis.ping();if (pong !== 'PONG') throw new Error('Redis did not return PONG');}
    const configuredTimeout = Number(env.PRODUCTION_CHROMIUM_LAUNCH_TIMEOUT_MS || 30000);
    const launchTimeout = Number.isFinite(configuredTimeout) ? Math.max(15000, Math.min(60000, configuredTimeout)) : 30000;
    let launchError;
    for (let attempt = 1; contract.runtime_role===INGESTION_WORKER_ROLE&&attempt <= 2; attempt++) {
      try {
        browser = await chromium.launch({ headless: true, executablePath: contract.chromium_path, timeout: launchTimeout, args: ['--disable-background-networking', '--no-first-run'] });
        break;
      } catch (error) {
        launchError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    if (contract.runtime_role===INGESTION_WORKER_ROLE&&!browser) throw launchError;
    if (contract.storage_driver === 'oss') {
      const result = await storage.checkStorageConnection();
      if (!result.ok) throw new Error('OSS bucket check failed');
    }
    return { redis: redis?'ok':'not_required', chromium: browser?'ok':'forbidden_on_api', storage: contract.storage_driver === 'oss' ? 'ok' : 'local' };
  } finally {
    await browser?.close().catch(() => {});
    if (redis?.isOpen) await redis.quit().catch(() => redis.disconnect().catch(() => {}));
  }
}

async function main() {
  await initializeEcsRamRoleCredentials();
  const contract = validateProductionContract();
  const connectivity = process.argv.includes('--connectivity')
    ? await checkConnectivity(contract)
    : { skipped: true };
  process.stdout.write(`${JSON.stringify({ ok: true, contract, connectivity }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { executable, validateProductionContract, checkConnectivity };
