'use strict';

const { isIP } = require('net');
const { extractProduct } = require('./product-ingestion-extractor');
const { normalizeDetails } = require('./product-details');
const { pathAllowedByPrefixes } = require('./product-ingestion-runtime-safety');
const TYPES = ['furniture', 'curtains', 'rugs', 'artwork', 'accessories'];
const JOB_STATUSES = ['draft', 'discovery_approved', 'discovering', 'rule_review', 'scope_review', 'discovery_failed', 'approved', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled'];
const RECOVERY_MODES = ['off', 'shadow', 'manual', 'auto_safe'];
const MAX_DISCOVERY_PAGES = 2000;

function fail(message, status = 400) {
  const error = new Error(message); error.status = status; throw error;
}
function text(value, max, label, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result) fail(`请填写${label}`);
  if (result.length > max) fail(`${label}不能超过 ${max} 个字符`);
  return result;
}
function integer(value, min, max, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${label}须为 ${min} 至 ${max} 的整数`);
  return result;
}
function list(value, max, label) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
  const result = [...new Set(source.map(item => String(item || '').trim()).filter(Boolean))];
  if (!result.length) fail(`请填写${label}`);
  if (result.length > max) fail(`${label}最多 ${max} 项`);
  return result;
}
function optionalList(value, max, label) {
  if (value == null || value === '') return [];
  const source = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const result = [...new Set(source.map(item => String(item || '').trim()).filter(Boolean))];
  if (result.length > max) fail(`${label}最多 ${max} 项`);
  return result;
}
function httpUrl(value, label = '网址') {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { fail(`${label}格式不正确，请填写包含 https:// 或 http:// 的完整地址，www 可有可无，例如：https://example.com/`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${label}只允许不含账号密码的 http/https 完整地址`);
  if (url.port) fail(`${label}不能使用非标准端口`);
  url.hash = '';
  return url;
}
function normalizeHost(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw.includes('/') || raw.includes(':') || raw.includes('*') || !/^[a-z0-9.-]+$/.test(raw)) fail('允许域名须为精确主机名，不能使用通配符、端口或路径');
  if (isIP(raw)) fail('允许域名必须是品牌官网域名，不能填写 IP 地址');
  if (raw === 'localhost' || raw.endsWith('.localhost') || raw.endsWith('.local')) fail('不允许把本机或内网名称配置为抓取来源');
  if (!raw.includes('.') || raw.startsWith('.') || raw.endsWith('.') || raw.includes('..')) fail('允许域名格式不正确');
  return raw;
}
function normalizePath(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.includes('?') || raw.includes('#') || raw.includes('..')) fail('允许路径必须以 / 开头，且不能包含查询参数、片段或 ..');
  return raw.replace(/\/{2,}/g, '/');
}
function normalizeSourceInput(body = {}, existing = {}) {
  const brandName = text(body.brand_name ?? existing.brand_name, 120, '品牌名称', true);
  const base = httpUrl(body.base_url ?? existing.base_url, '品牌官网');
  const baseHost=normalizeHost(base.hostname);
  const suppliedHosts=body.additional_allowed_hosts!==undefined
    ? optionalList(body.additional_allowed_hosts,9,'额外允许域名').map(normalizeHost)
    : optionalList(body.allowed_hosts ?? existing.allowed_hosts,10,'允许域名').map(normalizeHost);
  const allowedHosts=[...new Set([baseHost,...suppliedHosts.filter(host=>host!==baseHost)])];
  if(allowedHosts.length>10)fail('页面域名最多 10 项');
  const suppliedAssetHosts = optionalList(body.allowed_asset_hosts ?? existing.allowed_asset_hosts, 20, '素材域名').map(normalizeHost);
  const allowedAssetHosts = [...new Set([baseHost, ...suppliedAssetHosts.filter(host => host !== baseHost)])];
  if (allowedAssetHosts.length > 20) fail('素材域名最多 20 项');
  const allowedPaths = list(body.allowed_path_prefixes ?? existing.allowed_path_prefixes ?? ['/'], 30, '允许路径').map(normalizePath);
  const adapterKey = 'universal_web_v1';
  return {
    brand_name: brandName, base_url: base.toString(), allowed_hosts: allowedHosts, allowed_asset_hosts: allowedAssetHosts,
    allowed_path_prefixes: allowedPaths, product_group: null, product_type: null,
    adapter_key: adapterKey,
    max_pages_per_run: integer(body.max_pages_per_run ?? existing.max_pages_per_run ?? 500, 1, MAX_DISCOVERY_PAGES, '单次最多页面'),
    max_products_per_run: integer(body.max_products_per_run ?? existing.max_products_per_run ?? 500, 1, 500, '单次最多产品'),
    request_interval_ms: integer(body.request_interval_ms ?? existing.request_interval_ms ?? 2000, 1000, 60000, '请求间隔'),
    obey_robots: 1, manual_review_required: 1,
    notes: text(body.notes ?? existing.notes, 1000, '说明'),
  };
}
function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
}
function parseJsonValue(value) {
  if (value == null || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}
function candidateSummary(payload) {
  const document=payload?.product_document?.data||{},product=document.product||{},details=payload?.product_details||{};
  const configurations=Array.isArray(details.configurations)?details.configurations:Array.isArray(document.configurations)?document.configurations:[];
  const assets=Array.isArray(payload?.product_document?.data?.assets)?payload.product_document.data.assets:[];
  const legacyImages=[payload?.cover_url,details?.image_url,...(Array.isArray(details?.image_urls)?details.image_urls:[]),...configurations.flatMap(item=>[item?.image_url,...(Array.isArray(item?.image_urls)?item.image_urls:[])])].filter(Boolean);
  const firstConfiguration=configurations[0]||{},assetById=new Map(assets.map(item=>[String(item?.id),item]));
  const firstConfigurationImage=Array.isArray(firstConfiguration.asset_ids)
    ? firstConfiguration.asset_ids.map(value=>assetById.get(String(value))?.url).find(Boolean)
    : null;
  const firstLegacyConfigurationImage=[firstConfiguration.image_url,...(Array.isArray(firstConfiguration.image_urls)?firstConfiguration.image_urls:[])].find(Boolean);
  const heroImage=assets.find(item=>item?.role==='hero'&&item?.url)?.url;
  return {
    product_name:String(payload?.name||product?.names?.primary||product?.names?.zh||'').trim(),
    model_code:String(payload?.model||payload?.sku||product?.identifiers?.model||product?.identifiers?.sku||'').trim(),
    configuration_count:configurations.length,
    asset_count:new Set([...assets.map(item=>item?.url),...legacyImages].filter(Boolean)).size,
    cover_image_url:String(payload?.cover_url||heroImage||firstConfigurationImage||firstLegacyConfigurationImage||legacyImages[0]||''),
    first_configuration_image_url:String(firstConfigurationImage||firstLegacyConfigurationImage||''),
  };
}
function mapSource(row) {
  const storedAssetHosts = parseJsonList(row.allowed_asset_hosts);
  let primaryAssetHost = '';
  try { primaryAssetHost = new URL(row.base_url).hostname.toLowerCase(); } catch (_) {}
  return { ...row, id: Number(row.id), allowed_hosts: parseJsonList(row.allowed_hosts),
    ai_analysis_profile:parseJsonValue(row.ai_analysis_profile),
    allowed_asset_hosts: storedAssetHosts.length ? storedAssetHosts : (primaryAssetHost ? [primaryAssetHost] : []),
    allowed_path_prefixes: parseJsonList(row.allowed_path_prefixes),
    max_pages_per_run: Number(row.max_pages_per_run), max_products_per_run: Number(row.max_products_per_run),
    request_interval_ms: Number(row.request_interval_ms), obey_robots: Boolean(row.obey_robots),
    manual_review_required: Boolean(row.manual_review_required), recovery_mode:String(row.recovery_mode || 'off') };
}
function validateUrlAgainstSource(raw, source) {
  const url = httpUrl(raw, '种子网址');
  const hosts = parseJsonList(source.allowed_hosts).map(item => String(item).toLowerCase());
  const paths = parseJsonList(source.allowed_path_prefixes);
  if (!hosts.includes(url.hostname.toLowerCase())) fail(`网址域名 ${url.hostname} 不在来源白名单内`);
  const pathAllowed = pathAllowedByPrefixes(url.pathname, paths);
  if (!pathAllowed) fail(`网址路径 ${url.pathname} 不在允许范围内`);
  url.hash = '';
  return url.toString();
}
function normalizeTaskInput(body, source) {
  if (!source || source.status !== 'active') fail('来源未启用，不能创建抓取任务');
  const jobMode = String(body.job_mode || 'detail_capture');
  if (!['detail_capture', 'brand_scan'].includes(jobMode)) fail('抓取任务类型不正确');
  const seedUrls = jobMode === 'brand_scan'
    ? [validateUrlAgainstSource(source.base_url, source)]
    : list(body.seed_urls, 100, '产品详情页网址').map(url => validateUrlAgainstSource(url, source));
  return {
    job_mode: jobMode,
    seed_urls: [...new Set(seedUrls)],
    max_pages: integer(body.max_pages ?? source.max_pages_per_run, 1, Number(source.max_pages_per_run), '任务最多页面'),
    max_products: integer(body.max_products ?? source.max_products_per_run, 1, Number(source.max_products_per_run), '任务最多产品'),
    request_interval_ms: integer(body.request_interval_ms ?? source.request_interval_ms, Number(source.request_interval_ms), 60000, '请求间隔'),
    reason: text(body.reason, 500, '本次抓取目的', true),
  };
}
function mapJob(row) {
  return { ...row, id: Number(row.id), source_id: Number(row.source_id), seed_urls: parseJsonList(row.seed_urls),
    job_mode: row.job_mode || 'detail_capture', discovered_urls: parseJsonList(row.discovered_urls),
    discovery_summary: parseJsonValue(row.discovery_summary),
    scope_snapshot: typeof row.scope_snapshot === 'string' ? JSON.parse(row.scope_snapshot || 'null') : row.scope_snapshot,
    max_pages: Number(row.max_pages), max_products: Number(row.max_products), request_interval_ms: Number(row.request_interval_ms),
    checkpoint_index:Number(row.checkpoint_index||0),
    pages_fetched: Number(row.pages_fetched || 0), candidates_found: Number(row.candidates_found || 0),
    accepted_count: Number(row.accepted_count || 0), rejected_count: Number(row.rejected_count || 0) };
}
function createControl(db) {
  async function source(id) {
    const sourceId = integer(id, 1, Number.MAX_SAFE_INTEGER, '来源 ID');
    const [rows] = await db.query('SELECT * FROM product_ingestion_sources WHERE id = ?', [sourceId]);
    return rows[0] ? mapSource(rows[0]) : null;
  }
  return {
    async summary() {
      const [[sources], [jobs], [candidates]] = await Promise.all([
        db.query(`SELECT COUNT(*) total, SUM(status='active') active FROM product_ingestion_sources`),
        db.query(`SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='running') running, SUM(status='failed') failed FROM product_ingestion_jobs WHERE deleted_at IS NULL`),
        db.query(`SELECT COUNT(*) total, SUM(candidate.validation_status='valid') valid_count, SUM(candidate.validation_status='invalid') invalid_count, SUM(candidate.review_status='pending') pending_review FROM product_ingestion_candidates candidate JOIN product_ingestion_jobs job ON job.id=candidate.job_id WHERE job.deleted_at IS NULL`),
      ]);
      return { sources: sources[0] || {}, jobs: jobs[0] || {}, candidates: candidates[0] || {}, automatic_scheduling: false };
    },
    async listSources() {
      const [rows] = await db.query('SELECT * FROM product_ingestion_sources ORDER BY status = \'active\' DESC, id DESC');
      return rows.map(mapSource);
    },
    async createSource(body, actor) {
      const value = normalizeSourceInput(body);
      const [result] = await db.query(`INSERT INTO product_ingestion_sources
        (brand_name,base_url,allowed_hosts,allowed_asset_hosts,allowed_path_prefixes,product_group,product_type,adapter_key,status,max_pages_per_run,max_products_per_run,request_interval_ms,obey_robots,manual_review_required,notes,created_by)
        VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?)`, [value.brand_name, value.base_url, JSON.stringify(value.allowed_hosts), JSON.stringify(value.allowed_asset_hosts), JSON.stringify(value.allowed_path_prefixes), value.product_group, value.product_type, value.adapter_key, value.max_pages_per_run, value.max_products_per_run, value.request_interval_ms, 1, 1, value.notes || null, actor]);
      return source(result.insertId);
    },
    async updateSource(id, body) {
      const existing = await source(id); if (!existing) fail('抓取来源不存在', 404);
      if (existing.status === 'active') fail('启用中的来源不能修改，请先暂停', 409);
      const value = normalizeSourceInput(body, existing);
      await db.query(`UPDATE product_ingestion_sources SET brand_name=?,base_url=?,allowed_hosts=?,allowed_asset_hosts=?,allowed_path_prefixes=?,product_group=?,product_type=?,adapter_key=?,max_pages_per_run=?,max_products_per_run=?,request_interval_ms=?,obey_robots=1,manual_review_required=1,notes=? WHERE id=?`,
        [value.brand_name, value.base_url, JSON.stringify(value.allowed_hosts), JSON.stringify(value.allowed_asset_hosts), JSON.stringify(value.allowed_path_prefixes), value.product_group, value.product_type, value.adapter_key, value.max_pages_per_run, value.max_products_per_run, value.request_interval_ms, value.notes || null, id]);
      return source(id);
    },
    async changeSourceStatus(id, body, actor) {
      const existing = await source(id); if (!existing) fail('抓取来源不存在', 404);
      const action = String(body.action || '');
      if (action === 'activate') {
        if (body.confirmed !== true) fail('请确认启用来源');
        await db.query(`UPDATE product_ingestion_sources SET status='active',approved_by=?,approved_at=NOW() WHERE id=?`, [actor, id]);
      } else if (action === 'pause') {
        await db.query(`UPDATE product_ingestion_sources SET status='paused' WHERE id=?`, [id]);
      } else fail('来源状态操作不正确');
      return source(id);
    },
    async changeSourceRecoveryMode(id, body, actor) {
      const existing = await source(id); if (!existing) fail('抓取来源不存在', 404);
      const mode = String(body.mode || '');
      if (!RECOVERY_MODES.includes(mode)) fail('AI 恢复模式不正确');
      if (!['off','shadow'].includes(mode)) fail('当前阶段只允许关闭或影子观察模式', 409);
      if (body.confirmed !== true) fail('请确认修改 AI 恢复模式');
      await db.query('UPDATE product_ingestion_sources SET recovery_mode=? WHERE id=?', [mode, existing.id]);
      return { id:existing.id, recovery_mode:mode, updated_by:String(actor).slice(0,80) };
    },
    async listJobs(query = {}) {
      const status = String(query.status || ''); if (status && !JOB_STATUSES.includes(status)) fail('任务状态不正确');
      const params = []; let where = 'WHERE job.deleted_at IS NULL';
      if (status) { where += ' AND job.status=?'; params.push(status); }
      const [rows] = await db.query(`SELECT job.*,source.brand_name,source.adapter_key,source.recovery_mode FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id ${where} ORDER BY job.id DESC LIMIT 200`, params);
      return rows.map(mapJob);
    },
    async getJob(id) {
      const jobId=integer(id,1,Number.MAX_SAFE_INTEGER,'任务 ID');
      const [rows]=await db.query(`SELECT job.*,source.brand_name,source.base_url,source.adapter_key,source.recovery_mode FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=? AND job.deleted_at IS NULL`,[jobId]);
      if(!rows[0])fail('抓取任务不存在',404);
      return mapJob(rows[0]);
    },
    async createJob(body, actor) {
      const sourceRow = await source(integer(body.source_id, 1, Number.MAX_SAFE_INTEGER, '来源 ID'));
      const value = normalizeTaskInput(body, sourceRow);
      const [result] = await db.query(`INSERT INTO product_ingestion_jobs (source_id,status,job_mode,seed_urls,max_pages,max_products,request_interval_ms,reason,created_by) VALUES (?,'draft',?,?,?,?,?,?,?)`,
        [sourceRow.id, value.job_mode, JSON.stringify(value.seed_urls), value.max_pages, value.max_products, value.request_interval_ms, value.reason, actor]);
      const [rows] = await db.query(`SELECT job.*,source.brand_name,source.adapter_key FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=?`, [result.insertId]);
      return mapJob(rows[0]);
    },
    async createAutomaticCollection(body, actor) {
      if(body.confirmed!==true)fail('\u8bf7\u786e\u8ba4\u5f00\u59cb\u81ea\u52a8\u91c7\u96c6');
      const website=httpUrl(body.base_url,'\u54c1\u724c\u5b98\u7f51');
      const value=normalizeSourceInput({brand_name:text(body.brand_name,120,'\u54c1\u724c\u540d\u79f0',true),base_url:website.toString(),
        allowed_path_prefixes:['/'],allowed_asset_hosts:[],max_pages_per_run:body.max_pages??500,
        max_products_per_run:body.max_products||500,request_interval_ms:body.request_interval_ms||2000,
        notes:'\u7531\u54c1\u724c\u5b98\u7f51 URL \u4e00\u952e\u91c7\u96c6\u521b\u5efa'});
      const reason=text(body.reason||'\u54c1\u724c\u5b98\u7f51\u81ea\u52a8\u53d1\u73b0\u3001\u6293\u53d6\u548c\u5019\u9009\u5165\u5e93',500,'\u672c\u6b21\u6293\u53d6\u76ee\u7684',true);
      const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
      try{
        if(typeof conn.beginTransaction==='function'){await conn.beginTransaction();transaction=true;}
        const [existingRows]=await conn.query('SELECT * FROM product_ingestion_sources WHERE base_url=? ORDER BY id DESC LIMIT 1 FOR UPDATE',[value.base_url]);
        let sourceRow=existingRows[0];
        if(!sourceRow){
          const [stored]=await conn.query(`INSERT INTO product_ingestion_sources
            (brand_name,base_url,allowed_hosts,allowed_asset_hosts,allowed_path_prefixes,product_group,product_type,adapter_key,status,max_pages_per_run,max_products_per_run,request_interval_ms,obey_robots,manual_review_required,recovery_mode,notes,approved_by,approved_at,created_by)
            VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,'shadow',?,?,NOW(),?)`,[value.brand_name,value.base_url,JSON.stringify(value.allowed_hosts),JSON.stringify(value.allowed_asset_hosts),JSON.stringify(value.allowed_path_prefixes),null,null,value.adapter_key,value.max_pages_per_run,value.max_products_per_run,value.request_interval_ms,1,1,value.notes,actor,actor]);
          sourceRow={id:stored.insertId,...value,status:'active',recovery_mode:'shadow'};
        }else{
          await conn.query(`UPDATE product_ingestion_sources SET status='active',recovery_mode='shadow',max_pages_per_run=?,approved_by=?,approved_at=NOW() WHERE id=?`,[value.max_pages_per_run,actor,sourceRow.id]);
          sourceRow=mapSource({...sourceRow,status:'active',recovery_mode:'shadow',max_pages_per_run:value.max_pages_per_run});
        }
        const scope={source_id:Number(sourceRow.id),brand_name:sourceRow.brand_name,base_url:sourceRow.base_url,
          allowed_hosts:parseJsonList(sourceRow.allowed_hosts),allowed_path_prefixes:parseJsonList(sourceRow.allowed_path_prefixes),
          product_group:null,product_type:null,adapter_key:'universal_web_v1',job_mode:'brand_scan',seed_urls:[sourceRow.base_url],
          max_pages:Math.min(integer(body.max_pages??sourceRow.max_pages_per_run,1,Number(sourceRow.max_pages_per_run),'\u4efb\u52a1\u6700\u591a\u9875\u9762'),MAX_DISCOVERY_PAGES),
          max_products:Math.min(integer(body.max_products??sourceRow.max_products_per_run,1,Number(sourceRow.max_products_per_run),'\u4efb\u52a1\u6700\u591a\u4ea7\u54c1'),500),
          request_interval_ms:integer(body.request_interval_ms??sourceRow.request_interval_ms,Number(sourceRow.request_interval_ms),60000,'\u8bf7\u6c42\u95f4\u9694'),
          obey_robots:true,allow_offsite:false,manual_review_required:true};
        const [jobResult]=await conn.query(`INSERT INTO product_ingestion_jobs
          (source_id,status,job_mode,seed_urls,max_pages,max_products,request_interval_ms,reason,scope_snapshot,discovery_approved_by,discovery_approved_at,approved_by,approved_at,created_by)
          VALUES (?,'discovery_approved','brand_scan',?,?,?,?,?,?,?,NOW(),?,NOW(),?)`,[sourceRow.id,JSON.stringify(scope.seed_urls),scope.max_pages,scope.max_products,scope.request_interval_ms,reason,JSON.stringify(scope),actor,actor,actor]);
        if(transaction)await conn.commit();
        return {source_id:Number(sourceRow.id),job_id:Number(jobResult.insertId),status:'discovery_approved'};
      }catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
    },
    async authorizeAutomaticCollection(id, body, actor) {
      const jobId=integer(id,1,Number.MAX_SAFE_INTEGER,'\u4efb\u52a1 ID');
      if(body.confirmed!==true)fail('\u8bf7\u786e\u8ba4\u91cd\u65b0\u81ea\u52a8\u91c7\u96c6');
      const [rows]=await db.query(`SELECT job.*,source.brand_name,source.base_url,source.allowed_hosts,source.allowed_path_prefixes,source.product_group,source.product_type,source.adapter_key,source.status source_status
        FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=?`,[jobId]);
      const job=rows[0];if(!job)fail('\u6293\u53d6\u4efb\u52a1\u4e0d\u5b58\u5728',404);
      if((job.job_mode||'detail_capture')!=='brand_scan')fail('\u53ea\u6709\u5168\u54c1\u724c\u4efb\u52a1\u53ef\u4ee5\u81ea\u52a8\u91cd\u6293',409);
      const discovered=parseJsonList(job.discovered_urls);
      if(!['draft','discovery_failed'].includes(job.status)&&!(job.status==='scope_review'&&!discovered.length))fail('\u5f53\u524d\u4efb\u52a1\u72b6\u6001\u4e0d\u80fd\u91cd\u65b0\u81ea\u52a8\u91c7\u96c6',409);
      if(job.source_status!=='active')fail('\u6765\u6e90\u5df2\u6682\u505c\uff0c\u4e0d\u80fd\u91cd\u65b0\u91c7\u96c6',409);
      const scope={source_id:Number(job.source_id),brand_name:job.brand_name,base_url:job.base_url,
        allowed_hosts:parseJsonList(job.allowed_hosts),allowed_path_prefixes:parseJsonList(job.allowed_path_prefixes),
        product_group:null,product_type:null,adapter_key:'universal_web_v1',job_mode:'brand_scan',seed_urls:parseJsonList(job.seed_urls),
        max_pages:Number(job.max_pages),max_products:Number(job.max_products),request_interval_ms:Number(job.request_interval_ms),
        obey_robots:true,allow_offsite:false,manual_review_required:true};
      await db.query(`UPDATE product_ingestion_jobs SET status='discovery_approved',scope_snapshot=?,discovery_approved_by=?,discovery_approved_at=NOW(),approved_by=?,approved_at=NOW(),discovered_urls=NULL,discovery_summary=NULL,last_error=NULL,finished_at=NULL WHERE id=?`,[JSON.stringify(scope),actor,actor,jobId]);
      return {id:jobId,status:'discovery_approved'};
    },
    async createRecollection(id, body, actor) {
      const previousJobId=integer(id,1,Number.MAX_SAFE_INTEGER,'任务 ID');
      if(body.confirmed!==true)fail('请确认重新采集并更新');
      const [rows]=await db.query(`SELECT job.*,source.brand_name,source.base_url,source.allowed_hosts,source.allowed_path_prefixes,source.status source_status,source.max_pages_per_run,source.max_products_per_run,source.request_interval_ms source_request_interval_ms
        FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=?`,[previousJobId]);
      const previous=rows[0];if(!previous)fail('原采集任务不存在',404);
      if((previous.job_mode||'detail_capture')!=='brand_scan')fail('只有全品牌采集计划可以重新采集更新',409);
      if(!['completed','failed','discovery_failed','cancelled'].includes(previous.status))fail('当前任务尚未结束，不能新建更新采集',409);
      if(previous.source_status!=='active')fail('品牌来源已暂停，请先启用后再采集',409);
      const [activeRows]=await db.query(`SELECT id,status FROM product_ingestion_jobs WHERE source_id=? AND status IN ('discovery_approved','discovering','queued','running') LIMIT 1`,[previous.source_id]);
      if(activeRows[0])fail(`同品牌任务 #${activeRows[0].id} 正在执行，不能重复启动`,409);
      const maxPages=Math.min(Number(previous.max_pages||500),Number(previous.max_pages_per_run||MAX_DISCOVERY_PAGES),MAX_DISCOVERY_PAGES);
      const maxProducts=Math.min(Number(previous.max_products||500),Number(previous.max_products_per_run||500),500);
      const requestInterval=Math.max(Number(previous.request_interval_ms||2000),Number(previous.source_request_interval_ms||2000),1000);
      const scope={source_id:Number(previous.source_id),brand_name:previous.brand_name,base_url:previous.base_url,
        allowed_hosts:parseJsonList(previous.allowed_hosts),allowed_path_prefixes:parseJsonList(previous.allowed_path_prefixes),
        product_group:null,product_type:null,adapter_key:'universal_web_v1',job_mode:'brand_scan',seed_urls:[previous.base_url],
        max_pages:maxPages,max_products:maxProducts,request_interval_ms:requestInterval,obey_robots:true,allow_offsite:false,manual_review_required:true,
        recollection_of_job_id:previousJobId};
      const reason=`重新采集并更新品牌资料（基于任务 #${previousJobId}）`;
      const [result]=await db.query(`INSERT INTO product_ingestion_jobs
        (source_id,parent_job_id,status,job_mode,seed_urls,max_pages,max_products,request_interval_ms,reason,scope_snapshot,discovery_approved_by,discovery_approved_at,approved_by,approved_at,created_by,current_stage,heartbeat_at)
        VALUES (?,?,'discovery_approved','brand_scan',?,?,?,?,?,?,?,NOW(),?,NOW(),?,'source_analysis',NOW())`,
        [previous.source_id,previousJobId,JSON.stringify(scope.seed_urls),maxPages,maxProducts,requestInterval,reason,JSON.stringify(scope),actor,actor,actor]);
      return {job_id:Number(result.insertId),parent_job_id:previousJobId,status:'discovery_approved'};
    },
    async approveJob(id, body, actor) {
      const jobId = integer(id, 1, Number.MAX_SAFE_INTEGER, '任务 ID');
      if (body.confirmed !== true) fail('请确认授权抓取');
      const [rows] = await db.query(`SELECT job.*,source.brand_name,source.base_url,source.allowed_hosts,source.allowed_path_prefixes,source.product_group,source.product_type,source.adapter_key,source.status source_status FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=?`, [jobId]);
      const job = rows[0]; if (!job) fail('抓取任务不存在', 404);
      const mode = job.job_mode || 'detail_capture';
      if (mode === 'brand_scan' && job.status !== 'scope_review') fail('全品牌任务必须先完成官网分析并确认发现范围', 409);
      if (mode !== 'brand_scan' && job.status !== 'draft') fail('只有草稿任务可以授权', 409);
      if (job.source_status !== 'active') fail('来源已暂停，不能授权任务', 409);
      const discoveredUrls = mode === 'brand_scan' ? parseJsonList(job.discovered_urls) : [];
      const scope = { source_id: Number(job.source_id), brand_name: job.brand_name, base_url: job.base_url,
        allowed_hosts: parseJsonList(job.allowed_hosts), allowed_path_prefixes: parseJsonList(job.allowed_path_prefixes),
        product_group: job.product_group, product_type: job.product_type, adapter_key: job.adapter_key,
        job_mode: mode,
        seed_urls: mode === 'brand_scan' ? discoveredUrls : parseJsonList(job.seed_urls),
        discovery_entry_urls: mode === 'brand_scan' ? parseJsonList(job.seed_urls) : [],
        discovery_summary: mode === 'brand_scan' ? parseJsonValue(job.discovery_summary) : null,
        max_pages: mode === 'brand_scan' ? Math.min(discoveredUrls.length, 500) : Number(job.max_pages),
        max_products: Number(job.max_products),
        request_interval_ms: Number(job.request_interval_ms), obey_robots: true, allow_offsite: false, manual_review_required: true };
      for (const url of scope.seed_urls) validateUrlAgainstSource(url, scope);
      if (!scope.seed_urls.length) fail('发现范围中没有可抓取的产品详情页', 409);
      const expectedStatus = mode === 'brand_scan' ? 'scope_review' : 'draft';
      await db.query(`UPDATE product_ingestion_jobs SET status='approved',scope_snapshot=?,approved_by=?,approved_at=NOW() WHERE id=? AND status=?`, [JSON.stringify(scope), actor, jobId, expectedStatus]);
      return { id: jobId, status: 'approved', scope_snapshot: scope };
    },
    async approveDiscovery(id, body, actor) {
      const jobId = integer(id, 1, Number.MAX_SAFE_INTEGER, '任务 ID');
      if (body.confirmed !== true) fail('请确认授权分析');
      const [rows] = await db.query(`SELECT job.*,source.brand_name,source.base_url,source.allowed_hosts,source.allowed_path_prefixes,source.product_group,source.product_type,source.adapter_key,source.status source_status FROM product_ingestion_jobs job JOIN product_ingestion_sources source ON source.id=job.source_id WHERE job.id=?`, [jobId]);
      const job = rows[0]; if (!job) fail('抓取任务不存在', 404);
      if ((job.job_mode || 'detail_capture') !== 'brand_scan' || job.status !== 'draft') fail('只有全品牌采集草稿可以授权官网分析', 409);
      if (job.source_status !== 'active') fail('来源已暂停，不能授权官网分析', 409);
      const scope = { source_id:Number(job.source_id), brand_name:job.brand_name, base_url:job.base_url,
        allowed_hosts:parseJsonList(job.allowed_hosts), allowed_path_prefixes:parseJsonList(job.allowed_path_prefixes),
        product_group:job.product_group, product_type:job.product_type, adapter_key:job.adapter_key,
        job_mode:'brand_scan', seed_urls:parseJsonList(job.seed_urls), max_pages:Number(job.max_pages),
        max_products:Number(job.max_products), request_interval_ms:Number(job.request_interval_ms),
        obey_robots:true, allow_offsite:false, manual_review_required:true };
      for (const url of scope.seed_urls) validateUrlAgainstSource(url, scope);
      await db.query(`UPDATE product_ingestion_jobs SET status='discovery_approved',scope_snapshot=?,discovery_approved_by=?,discovery_approved_at=NOW(),discovered_urls=NULL,discovery_summary=NULL WHERE id=? AND status='draft'`, [JSON.stringify(scope), actor, jobId]);
      return { id:jobId, status:'discovery_approved', scope_snapshot:scope };
    },
    async cancelJob(id) {
      const jobId = integer(id, 1, Number.MAX_SAFE_INTEGER, '任务 ID');
      const [result] = await db.query(`UPDATE product_ingestion_jobs SET status='cancelled',current_stage='cancelled',current_url=NULL,finished_at=NOW(),heartbeat_at=NOW(),failure_code=NULL,last_error='用户主动停止任务' WHERE id=? AND status IN ('draft','discovery_approved','discovering','rule_review','scope_review','approved','queued','running','paused')`, [jobId]);
      if (!result.affectedRows) fail('任务不存在或已经结束，不能取消', 409);
      return { id: jobId, status: 'cancelled' };
    },
    async pauseJob(id) {
      const jobId=integer(id,1,Number.MAX_SAFE_INTEGER,'任务 ID');
      const [rows]=await db.query('SELECT status,current_stage,checkpoint_index FROM product_ingestion_jobs WHERE id=?',[jobId]);
      const job=rows[0];if(!job)fail('抓取任务不存在',404);
      if(job.status==='paused')return {id:jobId,status:'paused',current_stage:job.current_stage,checkpoint_index:Number(job.checkpoint_index||0)};
      if(job.current_stage==='site_cognition')fail('AI 正在完成一次不可拆分的分析；请等待进入抽样检查，或使用安全停止',409);
      if(!['discovery_approved','discovering','approved','queued','running'].includes(job.status))fail('当前阶段不需要暂停',409);
      const [updated]=await db.query(`UPDATE product_ingestion_jobs SET status='paused',last_error='用户暂停任务；进度和已抓取候选均已保留',heartbeat_at=NOW() WHERE id=? AND status=?`,[jobId,job.status]);
      if(!updated.affectedRows)fail('任务状态已经变化，请刷新后重试',409);
      return {id:jobId,status:'paused',current_stage:job.current_stage,checkpoint_index:Number(job.checkpoint_index||0)};
    },
    async resumeJob(id) {
      const jobId=integer(id,1,Number.MAX_SAFE_INTEGER,'任务 ID');
      const [rows]=await db.query('SELECT status,current_stage,checkpoint_index,scope_snapshot FROM product_ingestion_jobs WHERE id=?',[jobId]);
      const job=rows[0];if(!job)fail('抓取任务不存在',404);if(job.status!=='paused')fail('只有已暂停任务可以继续',409);
      const extraction=job.current_stage==='extraction';
      const status=extraction?'queued':'discovery_approved',stage=extraction?'extraction':'source_analysis';
      await db.query(`UPDATE product_ingestion_jobs SET status=?,current_stage=?,finished_at=NULL,failure_code=NULL,last_error=NULL,heartbeat_at=NOW() WHERE id=? AND status='paused'`,[status,stage,jobId]);
      return {id:jobId,status,resume_mode:extraction?'extraction':'discovery',checkpoint_index:Number(job.checkpoint_index||0)};
    },
    async listCandidates(query = {}) {
      const status = String(query.status || ''), recoveryStatus=String(query.recovery_status||''), paged=String(query.paged||'')==='1';
      const jobId=Number(query.job_id||0),limit=paged?integer(Number(query.limit||50),1,100,'每页数量'):500,offset=paged?integer(Number(query.offset||0),0,100000,'分页位置'):0;
      const recoveryStatuses=['any','none','planning','shadow_ready','plan_rejected','awaiting_approval','executing','validated','validation_failed','failed'];
      const params = []; let where = 'WHERE job.deleted_at IS NULL';
      if (status) { if (!['pending', 'valid', 'invalid'].includes(status)) fail('候选校验状态不正确'); where += ' AND candidate.validation_status=?'; params.push(status); }
      if(jobId){if(!Number.isSafeInteger(jobId)||jobId<1)fail('任务 ID 不正确');where+=' AND candidate.job_id=?';params.push(jobId);}
      if(recoveryStatus){if(!recoveryStatuses.includes(recoveryStatus))fail('恢复状态不正确');if(recoveryStatus==='none')where+=' AND NOT EXISTS (SELECT 1 FROM product_ingestion_recovery_attempts recovery WHERE recovery.candidate_id=candidate.id)';else if(recoveryStatus==='any')where+=' AND EXISTS (SELECT 1 FROM product_ingestion_recovery_attempts recovery WHERE recovery.candidate_id=candidate.id)';else{where+=' AND EXISTS (SELECT 1 FROM product_ingestion_recovery_attempts recovery WHERE recovery.candidate_id=candidate.id AND recovery.status=?)';params.push(recoveryStatus);}}
      let total=null;
      if(paged){const [countRows]=await db.query(`SELECT COUNT(*) total FROM product_ingestion_candidates candidate JOIN product_ingestion_jobs job ON job.id=candidate.job_id ${where}`,params);total=Number(countRows[0]?.total||0);}
      const [rows] = await db.query(`SELECT candidate.id,candidate.job_id,candidate.source_id,candidate.source_url,candidate.source_external_id,candidate.normalized_payload,candidate.validation_status,candidate.validation_issues,candidate.review_status,candidate.generated_fields,candidate.classification_suggestion,candidate.classification_override,candidate.published_product_id,candidate.published_version_id,candidate.published_at,candidate.created_at,source.brand_name,source.status source_status,job.status job_status,job.current_stage,
        (SELECT COUNT(*) FROM product_ingestion_candidate_categories assignment WHERE assignment.candidate_id=candidate.id) category_count,
        (SELECT GROUP_CONCAT(category.id ORDER BY category.sort_order) FROM product_ingestion_candidate_categories assignment JOIN public_product_categories category ON category.id=assignment.category_id WHERE assignment.candidate_id=candidate.id) category_ids,
        (SELECT GROUP_CONCAT(category.name ORDER BY category.sort_order SEPARATOR '、') FROM product_ingestion_candidate_categories assignment JOIN public_product_categories category ON category.id=assignment.category_id WHERE assignment.candidate_id=candidate.id) category_names,
        (SELECT recovery.status FROM product_ingestion_recovery_attempts recovery WHERE recovery.candidate_id=candidate.id ORDER BY recovery.id DESC LIMIT 1) recovery_status,
        CASE WHEN candidate.validation_status='invalid' THEN 'needs_attention' WHEN product.id IS NULL THEN 'new' WHEN current_version.content_fingerprint=candidate.content_fingerprint THEN 'unchanged' ELSE 'updated' END change_status
        FROM product_ingestion_candidates candidate JOIN product_ingestion_sources source ON source.id=candidate.source_id JOIN product_ingestion_jobs job ON job.id=candidate.job_id
        LEFT JOIN public_product_library_products product ON product.source_id=candidate.source_id AND product.source_url_hash=candidate.source_url_hash
        LEFT JOIN public_product_library_versions current_version ON current_version.id=product.current_version_id ${where} ORDER BY candidate.id DESC LIMIT ? OFFSET ?`, [...params,limit,offset]);
      const items=rows.map(row => {const payload=parseJsonValue(row.normalized_payload),summary=candidateSummary(payload),categoryCount=Number(row.category_count||0),blockers=[];
        if(!row.published_product_id){if(row.validation_status!=='valid')blockers.push('结构未通过');if(row.review_status!=='approved')blockers.push('未审核通过');if(!categoryCount)blockers.push('未设置标准分类');if(row.source_status!=='active')blockers.push('来源未启用');}
        return { ...row, id: Number(row.id), job_id: Number(row.job_id), source_id: Number(row.source_id),category_count:categoryCount,
          category_ids:String(row.category_ids||'').split(',').map(Number).filter(Number.isSafeInteger),category_names:String(row.category_names||'').split('、').filter(Boolean),...summary,publish_ready:!row.published_product_id&&!blockers.length,publish_blockers:blockers,
          normalized_payload:payload,validation_issues: parseJsonList(row.validation_issues), generated_fields: parseJsonList(row.generated_fields),
          classification_suggestion:parseJsonValue(row.classification_suggestion),classification_override:parseJsonValue(row.classification_override) };});
      return paged?{items,total,limit,offset}:items;
    },
    async getCandidate(id) {
      const candidateId = integer(id, 1, Number.MAX_SAFE_INTEGER, '候选 ID');
      const [rows] = await db.query(`SELECT candidate.id,candidate.job_id,candidate.source_id,candidate.source_url,candidate.source_external_id,candidate.content_fingerprint,candidate.raw_http_status,candidate.raw_content_type,OCTET_LENGTH(candidate.raw_html) raw_html_bytes,candidate.extracted_payload,candidate.normalized_payload,candidate.generated_fields,candidate.classification_suggestion,candidate.classification_override,candidate.validation_status,candidate.validation_issues,candidate.review_status,candidate.review_note,candidate.reviewed_by,candidate.reviewed_at,candidate.published_product_id,candidate.published_version_id,candidate.published_at,candidate.created_at,candidate.updated_at,source.brand_name FROM product_ingestion_candidates candidate JOIN product_ingestion_sources source ON source.id=candidate.source_id WHERE candidate.id=?`, [candidateId]);
      const row = rows[0]; if (!row) fail('候选产品不存在', 404);
      return { ...row, id:candidateId, job_id:Number(row.job_id), source_id:Number(row.source_id),
        raw_html_bytes:Number(row.raw_html_bytes || 0), extracted_payload:parseJsonValue(row.extracted_payload),
        normalized_payload:parseJsonValue(row.normalized_payload), generated_fields:parseJsonList(row.generated_fields),
        classification_suggestion:parseJsonValue(row.classification_suggestion),classification_override:parseJsonValue(row.classification_override),
        validation_issues:parseJsonList(row.validation_issues) };
    },
    async reclassifyCandidates(body, actor) {
      const candidateIds=[...new Set((Array.isArray(body.candidate_ids)?body.candidate_ids:[]).map(Number))];
      if(!candidateIds.length||candidateIds.length>200||candidateIds.some(value=>!Number.isSafeInteger(value)||value<1))fail('请选择 1 至 200 个候选产品');
      const productGroup=String(body.product_group||'soft_furnishings'),productType=String(body.product_type||'');
      if(productGroup!=='soft_furnishings'||!TYPES.includes(productType))fail('目标产品分类不受支持');
      const conn=typeof db.getConnection==='function'?await db.getConnection():db;let transaction=false;
      try{
        await conn.beginTransaction();transaction=true;
        for(const candidateId of candidateIds){
          const [rows]=await conn.query(`SELECT candidate.*,source.adapter_key FROM product_ingestion_candidates candidate JOIN product_ingestion_sources source ON source.id=candidate.source_id WHERE candidate.id=? FOR UPDATE`,[candidateId]);
          const candidate=rows[0];if(!candidate)fail(`候选 #${candidateId} 不存在`,404);if(candidate.published_product_id)fail(`候选 #${candidateId} 已发布，请在正式产品中调整`,409);if(!candidate.raw_html)fail(`候选 #${candidateId} 缺少原始页面，无法重建产品结构`,409);
          const result=extractProduct(Buffer.from(candidate.raw_html).toString('utf8'),productType,candidate.source_url);
          const previous=parseJsonValue(candidate.classification_override)||parseJsonValue(candidate.classification_suggestion)||{};
          const override={product_group:productGroup,product_type:productType,method:'manual',updated_by:String(actor).slice(0,80),updated_at:new Date().toISOString()};
          result.generatedFields.push({path:'classification',rule:'manual_override',value:`${productGroup}/${productType}`});
          await conn.query(`UPDATE product_ingestion_candidates SET normalized_payload=?,generated_fields=?,classification_override=?,validation_status='valid',validation_issues='[]',review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?`,[JSON.stringify(result.payload),JSON.stringify(result.generatedFields),JSON.stringify(override),candidateId]);
          await conn.query('DELETE FROM product_ingestion_candidate_categories WHERE candidate_id=?',[candidateId]);
          await conn.query(`INSERT INTO product_ingestion_candidate_categories (candidate_id,category_id,assigned_by,assigned_at,assignment_type) SELECT ?,id,?,NOW(),'manual' FROM public_product_categories WHERE category_code=? AND status='active' LIMIT 1`,[candidateId,String(actor).slice(0,80),productType]);
          await conn.query(`INSERT INTO product_ingestion_candidate_classification_changes (candidate_id,previous_product_group,previous_product_type,new_product_group,new_product_type,changed_by,changed_at) VALUES (?,?,?,?,?,?,NOW())`,[candidateId,previous.product_group||null,previous.product_type||null,productGroup,productType,String(actor).slice(0,80)]);
        }
        await conn.commit();transaction=false;return {updated_count:candidateIds.length,product_group:productGroup,product_type:productType};
      }catch(error){if(transaction)await conn.rollback();throw error;}finally{if(conn!==db&&typeof conn.release==='function')conn.release();}
    },
    async updateCandidateConfigurationImages(id, configurationValue, body, actor) {
      const candidateId=integer(id,1,Number.MAX_SAFE_INTEGER,'候选 ID');
      const configurationId=text(configurationValue,80,'型号 ID',true);
      if(!Array.isArray(body.image_urls))fail('图片列表格式不正确');
      const imageUrls=[...new Set(body.image_urls.map(value=>String(value||'').trim()).filter(Boolean))];
      if(imageUrls.length>5)fail('每个型号最多保留 5 张图片');
      const [rows]=await db.query('SELECT normalized_payload,generated_fields,published_product_id FROM product_ingestion_candidates WHERE id=?',[candidateId]);
      const candidate=rows[0];if(!candidate)fail('候选产品不存在',404);if(candidate.published_product_id)fail('已发布候选的图片不可修改',409);
      const payload=parseJsonValue(candidate.normalized_payload);if(!payload?.product_details)fail('候选缺少标准产品数据',409);
      const configuration=payload.product_details.configurations?.find(item=>String(item.id)===configurationId);if(!configuration)fail('型号不存在',404);
      configuration.image_urls=imageUrls;configuration.image_url=imageUrls[0]||'';
      payload.product_details=normalizeDetails(payload.product_details,payload.product_type);
      const generated=parseJsonList(candidate.generated_fields).filter(item=>!(item?.rule==='manual_configuration_images'&&item?.configuration_id===configurationId));
      generated.push({path:`product_details.configurations.${configurationId}.image_urls`,rule:'manual_configuration_images',configuration_id:configurationId,count:imageUrls.length,updated_by:String(actor).slice(0,80)});
      await db.query(`UPDATE product_ingestion_candidates SET normalized_payload=?,generated_fields=?,review_status='pending',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?`,[JSON.stringify(payload),JSON.stringify(generated),candidateId]);
      return {id:candidateId,configuration_id:configurationId,image_urls:imageUrls,image_url:imageUrls[0]||''};
    },
    async reviewCandidate(id, body, actor) {
      const candidateId = integer(id, 1, Number.MAX_SAFE_INTEGER, '候选 ID');
      const action = String(body.action || '');
      if (!['approve','reject'].includes(action)) fail('审核操作不正确');
      const note = text(body.note, 500, '审核说明', action === 'reject');
      const [rows] = await db.query('SELECT validation_status,published_product_id FROM product_ingestion_candidates WHERE id=?', [candidateId]);
      if (!rows[0]) fail('候选产品不存在', 404);
      if (rows[0].published_product_id) fail('已发布候选的审核结论不可修改', 409);
      if (action === 'approve' && rows[0].validation_status !== 'valid') fail('结构校验未通过的候选不能审核通过', 409);
      const reviewStatus = action === 'approve' ? 'approved' : 'rejected';
      await db.query('UPDATE product_ingestion_candidates SET review_status=?,review_note=?,reviewed_by=?,reviewed_at=NOW() WHERE id=?', [reviewStatus,note || null,actor,candidateId]);
      return { id:candidateId,review_status:reviewStatus,review_note:note };
    },
  };
}

module.exports = { createControl, normalizeSourceInput, normalizeTaskInput, validateUrlAgainstSource, mapSource, mapJob };
