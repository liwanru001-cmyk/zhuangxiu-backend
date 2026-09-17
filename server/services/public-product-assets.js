'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const storage = require('./storage.service');
const { controlledRequest } = require('./product-ingestion-fetch');

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_ASSETS_PER_PRODUCT = 250;
const ARCHIVABLE_KEYS = new Set(['cover_url', 'image_url', 'drawing_url', 'swatch_url']);
const ARCHIVABLE_ARRAY_KEYS = new Set(['image_urls']);
const TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
});

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  throw error;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceScope(source, runtime = {}) {
  const value=source.allowed_asset_hosts;
  const configuredHosts=(Array.isArray(value)?value:(()=>{try{const parsed=JSON.parse(value||'[]');return Array.isArray(parsed)?parsed:[];}catch(_){return [];}})()).map(item=>String(item).toLowerCase());
  let primaryHost='';
  try { primaryHost=new URL(source.base_url).hostname.toLowerCase(); } catch (_) {}
  const pageHosts=(Array.isArray(source.allowed_hosts)?source.allowed_hosts:(()=>{try{const parsed=JSON.parse(source.allowed_hosts||'[]');return Array.isArray(parsed)?parsed:[];}catch(_){return [];}})()).map(item=>String(item).toLowerCase());
  const hosts=[...new Set(configuredHosts.length?configuredHosts:(primaryHost&&pageHosts.includes(primaryHost)?[primaryHost]:[]))];
  if (!hosts.length) fail('来源没有可用于素材归档的授权域名', 'ASSET_HOSTS_EMPTY');
  const sourceId=source.source_id||source.id,jobId=source.job_id;
  const authorize=runtime.db&&sourceId&&jobId?async()=>{const [rows]=await runtime.db.query(`SELECT source.status source_status,job.status job_status FROM product_ingestion_sources source JOIN product_ingestion_jobs job ON job.source_id=source.id WHERE source.id=? AND job.id=?`,[sourceId,jobId]);return {...(rows[0]||{source_status:'missing',job_status:'missing'}),candidate_publish_authorized:runtime.candidatePublishAuthorized===true};}:null;
  return { allowed_asset_hosts:hosts,allowed_hosts:[],allowed_path_prefixes:['/'],source_id:sourceId,
    source_status:source.source_status||source.status,job_id:source.job_id,job_status:source.job_status,
    request_interval_ms:source.request_interval_ms||2000,policy_db:runtime.db,policy_authorizer:authorize,
    candidate_publish_authorized:runtime.candidatePublishAuthorized===true };
}

function collectReferences(node, currentPath = '$', result = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectReferences(item, `${currentPath}[${index}]`, result));
    return result;
  }
  if (!node || typeof node !== 'object') return result;
  for (const [key, value] of Object.entries(node)) {
    const valuePath = `${currentPath}.${key}`;
    if (key === 'url' && typeof value === 'string' && /^https?:\/\//i.test(value) && node.id && node.role && node.media_type) {
      result.push({ container:node,key,url:value,path:valuePath,role:String(node.role) });
      continue;
    }
    if (ARCHIVABLE_KEYS.has(key) && typeof value === 'string' && /^https?:\/\//i.test(value)) {
      result.push({ container: node, key, url: value, path: valuePath, role: key });
      continue;
    }
    if (ARCHIVABLE_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      value.forEach((url, index) => {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          result.push({ container: value, key: index, url, path: `${valuePath}[${index}]`, role: key });
        }
      });
      continue;
    }
    collectReferences(value, valuePath, result);
  }
  return result;
}

async function validateAsset(body, contentType) {
  const declaredType = String(contentType || '').split(';')[0].trim().toLowerCase();
  let type = declaredType;
  let extension = TYPES[type];
  // Some official object-storage/CDN endpoints return valid media as the
  // generic binary type. Only in that ambiguous case do we inspect the body;
  // an explicitly unsafe type such as text/html is never reinterpreted.
  if (!extension && (!type || type === 'application/octet-stream' || type === 'binary/octet-stream')) {
    if (body.subarray(0, 5).toString('ascii') === '%PDF-') {
      type = 'application/pdf';
      extension = TYPES[type];
    } else {
      try {
        const metadata = await sharp(body, { animated: true }).metadata();
        const detected = {
          jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
        }[String(metadata.format || '').toLowerCase()];
        if (detected) { type = detected; extension = TYPES[detected]; }
      } catch (_) {}
    }
  }
  if (!extension) fail(`素材类型不允许：${declaredType || '未知类'}`, 'ASSET_CONTENT_TYPE');
  if (type === 'application/pdf') {
    if (body.subarray(0, 5).toString('ascii') !== '%PDF-') fail('尺寸文件不是有效 PDF', 'ASSET_INVALID_PDF');
  } else {
    try { await sharp(body, { animated: true }).metadata(); }
    catch (_) { fail('下载内容不是有效图片', 'ASSET_INVALID_IMAGE'); }
  }
  return { type, extension };
}

async function downloadAsset(url, scope) {
  const response = await controlledRequest(url, scope, {
    purpose: 'asset',
    maxBytes: MAX_ASSET_BYTES,
    timeoutMs: 20000,
    accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,application/pdf;q=0.8',
  });
  if (response.status < 200 || response.status >= 300) fail(`素材返回 HTTP ${response.status}`, 'ASSET_HTTP_STATUS');
  const validated = await validateAsset(response.body, response.headers['content-type']);
  return { body: response.body, contentType: validated.type, extension: validated.extension };
}

async function storeAsset(downloaded) {
  const hash = crypto.createHash('sha256').update(downloaded.body).digest('hex');
  const key = `public-product-library/assets/${hash.slice(0, 2)}/${hash}.${downloaded.extension}`;
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-product-asset-'));
  const temporaryPath = path.join(temporaryDir, `${hash}.${downloaded.extension}`);
  try {
    await fs.writeFile(temporaryPath, downloaded.body, { mode: 0o600 });
    const stored = await storage.putFile({ sourcePath: temporaryPath, key, contentType: downloaded.contentType });
    return { contentHash: hash, storageUri: stored.url, contentType: downloaded.contentType, byteSize: downloaded.body.length };
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

async function archiveProductAssets(payload, source, runtime = {}) {
  const archivedPayload = jsonClone(payload);
  const references = collectReferences(archivedPayload);
  if (references.length > MAX_ASSETS_PER_PRODUCT) fail(`产品素材超过 ${MAX_ASSETS_PER_PRODUCT} 项限制`, 'ASSET_COUNT_LIMIT');
  const scope = sourceScope(source,runtime);
  scope.asset_quota={used:0,limit:MAX_ASSETS_PER_PRODUCT};
  const byUrl = new Map();
  const assets = [];
  for (const reference of references) {
    let stored = byUrl.get(reference.url);
    if (!stored) {
      try {
        stored = await storeAsset(await downloadAsset(reference.url, scope));
      } catch (error) {
        error.message = `素材归档失败（${reference.path}）：${error.message}`;
        error.status = error.status || 409;
        throw error;
      }
      byUrl.set(reference.url, stored);
    }
    reference.container[reference.key] = stored.storageUri;
    assets.push({
      ...stored,
      originalUrl: reference.url.slice(0, 1000),
      payloadPath: reference.path.slice(0, 500),
      role: reference.role.slice(0, 80),
    });
  }
  return { payload: archivedPayload, assets };
}

module.exports = {
  archiveProductAssets,
  downloadAsset,
  storeAsset,
  collectReferences,
  validateAsset,
  sourceScope,
  MAX_ASSET_BYTES,
  MAX_ASSETS_PER_PRODUCT,
};
