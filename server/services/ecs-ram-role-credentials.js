'use strict';

const METADATA_ORIGIN = 'http://100.100.100.200';
let cached = null;

function roleName(env = process.env) { return String(env.OSS_RAM_ROLE_NAME || '').trim(); }

async function metadata(path, options = {}) {
  const timeoutMs = Number(process.env.ECS_METADATA_TIMEOUT_MS || 3000);
  const response = await fetch(`${METADATA_ORIGIN}${path}`, {
    ...options,
    signal: AbortSignal.timeout(Math.max(500, Math.min(10000, timeoutMs))),
  });
  if (!response.ok) throw new Error(`ECS metadata request failed: ${response.status}`);
  return response.text();
}

async function fetchRamRoleCredentials(env = process.env) {
  const configuredRole = roleName(env);
  if (!configuredRole) throw new Error('OSS_RAM_ROLE_NAME is not configured');
  if (cached && cached.role === configuredRole && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.credentials;
  const token = await metadata('/latest/api/token', { method:'PUT', headers:{'X-aliyun-ecs-metadata-token-ttl-seconds':'21600'} });
  const headers = {'X-aliyun-ecs-metadata-token':token};
  const discoveredRole = (await metadata('/latest/meta-data/ram/security-credentials/', {headers})).trim().split(/\s+/)[0];
  if (discoveredRole !== configuredRole) throw new Error(`Attached ECS RAM role does not match OSS_RAM_ROLE_NAME: ${discoveredRole || 'none'}`);
  const body = JSON.parse(await metadata(`/latest/meta-data/ram/security-credentials/${encodeURIComponent(discoveredRole)}`, {headers}));
  if (body.Code !== 'Success' || !body.AccessKeyId || !body.AccessKeySecret || !body.SecurityToken) throw new Error(`ECS RAM role credential response is invalid: ${body.Code || 'unknown'}`);
  const credentials = { accessKeyId:body.AccessKeyId, accessKeySecret:body.AccessKeySecret, stsToken:body.SecurityToken };
  cached = { role:configuredRole, credentials, expiresAt:Date.parse(body.Expiration || '') || Date.now()+30*60*1000 };
  return credentials;
}

async function initializeEcsRamRoleCredentials(env = process.env) {
  if (!roleName(env)) return null;
  const credentials = await fetchRamRoleCredentials(env);
  env.OSS_ACCESS_KEY_ID = credentials.accessKeyId;
  env.OSS_ACCESS_KEY_SECRET = credentials.accessKeySecret;
  env.OSS_STS_TOKEN = credentials.stsToken;
  return credentials;
}

function clearCredentialCache() { cached = null; }
module.exports = { roleName, fetchRamRoleCredentials, initializeEcsRamRoleCredentials, clearCredentialCache };
