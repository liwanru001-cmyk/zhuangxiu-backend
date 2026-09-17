'use strict';

const dns = require('dns').promises;
const crypto = require('crypto');
const { isIP } = require('net');

const addressCache = new Map();
const hostNextRequestAt = new Map();
const hostQueues = new Map();

function blockedIpv4(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && (p[1] === 168 || (p[1] === 0 && (p[2] === 0 || p[2] === 2)))) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19 || (p[1] === 51 && p[2] === 100))) ||
    (p[0] === 203 && p[1] === 0 && p[2] === 113);
}

function isBlockedAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  const family = isIP(value);
  if (family === 4) return blockedIpv4(value);
  if (family !== 6) return true;
  if (value.startsWith('::ffff:')) return blockedIpv4(value.slice(7));
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
    /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:');
}

async function publicAddresses(hostname, lookup = dns.lookup) {
  const key = String(hostname).toLowerCase();
  const cached = addressCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  const results = await lookup(key, { all:true, verbatim:true });
  if (!results.length || results.some(result => isBlockedAddress(result.address))) {
    const error = new Error('目标域名解析到了内网、环回或保留地址，已拒绝访问');
    error.code = 'SSRF_BLOCKED';
    throw error;
  }
  addressCache.set(key, { results, expiresAt:Date.now() + 60_000 });
  return results;
}

function parseList(value, lower = true) {
  const convert=item=>lower?String(item).toLowerCase():String(item);
  if (Array.isArray(value)) return value.map(convert);
  try { const parsed=JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.map(convert) : []; }
  catch (_) { return []; }
}

function decodedPath(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch (_) { return null; }
}

function pathAllowedByPrefixes(pathname, prefixes) {
  const raw=String(pathname||''),decoded=decodedPath(raw);
  if(decoded==null||/%2f|%5c/i.test(raw))return false;
  return prefixes.some(prefix=>{
    const decodedPrefix=decodedPath(prefix);if(decodedPrefix==null)return false;
    if(decodedPrefix==='/')return true;
    const base=decodedPrefix.endsWith('/')?decodedPrefix.slice(0,-1):decodedPrefix;
    return decoded===base||decoded.startsWith(`${base}/`);
  });
}

function deny(code, text, extra = {}) {
  return { decision:'DENY', allowed:false, reason_code:code, reason_text:text, ...extra };
}

async function auditDecision(context, url, result) {
  if (!context.actual_request || !context.db) return;
  const target=String(url);
  const params = [context.source_id || null, context.job_id || null, context.purpose, target,
    crypto.createHash('sha256').update(target).digest('hex'), result.decision, result.reason_code,
    String(result.reason_text || '').slice(0, 500) || null, result.matched_rule || null,
    context.robots_snapshot_id || null, context.redirect_from || null];
  try {
    await context.db.query(`INSERT INTO product_ingestion_request_decisions
      (source_id,job_id,purpose,url,url_hash,decision,reason_code,reason_text,matched_rule,robots_snapshot_id,redirect_from)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, params);
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }
}

async function applyRateLimit(hostname, intervalMs) {
  const previous=hostQueues.get(hostname)||Promise.resolve();
  let release;
  const current=new Promise(resolve=>{release=resolve;});
  hostQueues.set(hostname,current);
  await previous;
  try {
    const interval=Math.max(0,Number(intervalMs)||0),waitMs=Math.max(0,(hostNextRequestAt.get(hostname)||0)-Date.now());
    if (waitMs) await new Promise(resolve=>setTimeout(resolve,waitMs));
    hostNextRequestAt.set(hostname,Date.now()+interval);
  } finally {
    release();
    if (hostQueues.get(hostname)===current) hostQueues.delete(hostname);
  }
}

async function canRequest(raw, context = {}) {
  if (typeof context.authorize === 'function') {
    const state=await context.authorize();
    context={...context,...state};
  }
  let url;
  try { url = new URL(String(raw || '')); }
  catch (_) { const result=deny('INVALID_URL', '网址格式不正确'); await auditDecision(context, String(raw||''), result); return result; }
  url.hash = '';
  let result;
  if (!context.source_status) result=deny('SOURCE_CONTEXT_REQUIRED', '请求缺少来源授权状态');
  else if (context.source_status !== 'active') result=deny('SOURCE_NOT_ACTIVE', '抓取来源未启用');
  else if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) result=deny('SCHEME_NOT_ALLOWED', '只允许不含账号、密码和非标准端口的 HTTP/HTTPS 网址');
  const purpose = context.purpose || 'page';
  const method = String(context.method || 'GET').toUpperCase();
  if (!result && method !== 'GET' && !(method === 'POST' && purpose === 'product' && context.read_only_post_approved === true)) {
    result=deny('METHOD_NOT_ALLOWED', '只允许 GET；POST 必须经恢复计划的只读白名单批准');
  }
  if (!result && !context.job_status) result=deny('JOB_CONTEXT_REQUIRED', '请求缺少已授权任务状态');
  else if (!result && ['robots_bootstrap','sitemap','page','product'].includes(purpose) && !['discovering','running'].includes(context.job_status)) {
    result=deny('JOB_NOT_EXECUTABLE', '抓取任务当前不允许发出网络请求');
  } else if (!result && purpose === 'asset' && context.job_status !== 'completed') {
    result=deny('JOB_NOT_EXECUTABLE', '只能为已完成抓取并通过人工审核的候选归档素材');
  }
  const allowedHosts = purpose === 'asset' ? parseList(context.allowed_asset_hosts) : parseList(context.allowed_hosts);
  if (!result && !allowedHosts.includes(url.hostname.toLowerCase())) result=deny(purpose === 'asset' ? 'ASSET_HOST_NOT_ALLOWED' : 'DOMAIN_NOT_ALLOWED', `域名 ${url.hostname} 不在${purpose === 'asset' ? '素材' : '页面'}授权范围内`);
  if (!result && !['asset','robots_bootstrap'].includes(purpose)) {
    const paths = parseList(context.allowed_path_prefixes,false);
    const allowed = pathAllowedByPrefixes(url.pathname,paths);
    if (!allowed) result=deny('PATH_NOT_ALLOWED', `路径 ${url.pathname} 不在允许范围内`);
  }
  if (!result && !['asset','robots_bootstrap'].includes(purpose)) {
    if (!context.robots_policy) result=deny('ROBOTS_POLICY_MISSING', '请求前没有可用的 robots policy');
    else {
      const robots = await context.robots_policy.evaluate(url.toString());
      if (!robots.allowed) result=deny('ROBOTS_DISALLOW', 'robots.txt 不允许抓取该路径', { matched_rule:robots.matched_rule });
      else context.robots_matched_rule=robots.matched_rule||null;
    }
  }
  const quotaCharge=!context.redirect_from;
  if (!result && quotaCharge && context.quota && Number(context.quota.used || 0) >= Number(context.quota.limit || Infinity)) result=deny('REQUEST_QUOTA_EXCEEDED', '已达到本次任务请求上限');
  if (!result) {
    try { await publicAddresses(url.hostname, context.lookup); }
    catch (error) { result=deny(error.code || 'DNS_LOOKUP_FAILED', error.message || '域名解析失败'); }
  }
  if (!result) result={ decision:'ALLOW', allowed:true, reason_code:'POLICY_ALLOWED', reason_text:'已通过统一请求安全检查', matched_rule:context.robots_matched_rule||null };
  await auditDecision(context, url, result);
  if (result.allowed && context.actual_request) {
    await applyRateLimit(url.hostname.toLowerCase(), context.request_interval_ms);
    if (quotaCharge && context.quota) context.quota.used = Number(context.quota.used || 0) + 1;
  }
  return { ...result, url:url.toString() };
}

function policyError(result) {
  const error = new Error(result.reason_text || '请求被安全策略拒绝');
  error.code = result.reason_code;
  error.status = 409;
  error.policy = result;
  return error;
}

module.exports = { canRequest, policyError, isBlockedAddress, publicAddresses, parseList, auditDecision, pathAllowedByPrefixes };
