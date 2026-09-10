'use strict';
const parse = (value, fallback = {}) => {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const outcomes = ['direct', 'repaired', 'draft', 'failed', 'fallback', 'legacy', 'pending', 'unknown'];
function filters(query = {}, now = new Date()) {
  const end = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const start = new Date(new Date(`${end}T00:00:00Z`).getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const from = String(query.from || start), to = String(query.to || end);
  const valid = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to) || to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 89) throw fail('请选择有效日期范围，最多 90 天');
  const project = String(query.project || '').trim();
  if (project && !/^[1-9]\d{0,9}$/.test(project)) throw fail('项目 ID 必须是正整数');
  const outcome = String(query.outcome || '');
  if (outcome && !outcomes.includes(outcome)) throw fail('无效的结果筛选');
  const search = String(query.search || '').trim();
  if (search.length > 200) throw fail('搜索内容最多 200 字');
  const page = Number(query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1) throw fail('无效页码');
  return { from, to, project, outcome, search, page, version: String(query.version || '').slice(0, 240) };
}
function classify(row) {
  const result = parse(row.result_json);
  const v2 = Number(row.requested_version) === 2 || !!row.run_id;
  let outcome = 'unknown';
  if (['queued', 'running'].includes(row.status)) outcome = 'pending';
  else if (row.status === 'failed') outcome = 'failed';
  else if (row.status === 'completed') {
    if (Number(row.fallback_used) || result.fallback_used || result.generation_status === 'legacy_fallback_success' || (v2 && result.generation_mode === 'legacy')) outcome = 'fallback';
    else if (result.generation_mode === 'ai_design_v2' && Number(result.schema_version) === 2 && result.generation_status === 'ai_draft') outcome = 'draft';
    else if (result.generation_mode === 'ai_design_v2' && Number(result.schema_version) === 2 && /^ai_(repaired_)?success(?:_unverified_render)?$/.test(result.generation_status)) outcome = result.generation_status.includes('repaired') ? 'repaired' : 'direct';
    else if (!v2 || result.generation_mode === 'legacy') outcome = 'legacy';
  }
  const code = parse(row.generator_version, null)?.code || 'unrecorded';
  const prompt = row.prompt_version || 'unrecorded';
  return { id: row.id, project_id: row.project_id, title: row.title, status: row.status, phase: row.phase,
    created_at: row.created_at, updated_at: row.updated_at, duration_seconds: row.status === 'completed' || row.status === 'failed' ? Number(row.duration_seconds) : null,
    outcome, is_v2_task: v2, generation_status: result.generation_status || null,
    render_verified: result.render_validation === 'passed' || ['ai_success', 'ai_repaired_success'].includes(result.generation_status),
    model_requests: row.model_requests == null ? null : Number(row.model_requests), repair_used: !!Number(row.repair_used), warnings: Number(row.warning_count || 0),
    draft_issue_count: result.generation_status === 'ai_draft' ? Number(result.draft_issue_count || 0) : 0,
    version: JSON.stringify([code, prompt]), code_version: code, prompt_version: prompt,
    error: row.error_message || null };
}
function summarize(rows) {
  const counts = Object.fromEntries(outcomes.map(o => [o, 0]));
  let finished = 0, successful = 0, verified = 0, repairAttempts = 0, repaired = 0;
  for (const row of rows) {
    counts[row.outcome]++;
    if (!row.is_v2_task) continue;
    if (row.outcome !== 'pending') finished++;
    if (['direct', 'repaired'].includes(row.outcome)) { successful++; if (row.render_verified) verified++; }
    if (row.repair_used) { repairAttempts++; if (['direct', 'repaired'].includes(row.outcome)) repaired++; }
  }
  return { total: rows.length, counts, v2_finished: finished, v2_successful: successful,
    v2_success_rate: finished ? successful / finished : null, render_verified: verified, with_warnings: rows.filter(r => ['direct', 'repaired'].includes(r.outcome) && r.warnings > 0).length,
    repair_attempts: repairAttempts, repair_successes: repaired, repair_success_rate: repairAttempts ? repaired / repairAttempts : null };
}
// Raw model responses sometimes contain JSON inside a string. Decode before
// redaction so credentials or signed URLs cannot bypass the structured filter.
function redact(value, key = '', depth = 0) {
  if (/password|secret|authorization|cookie|(?:^|_)token(?:$|_)|(?:access|refresh|auth).?token|api[_-]?key/i.test(key)) return '[已隐藏]';
  if (depth > 40) return '[内容层级过深]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(v => redact(v, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  if (typeof value !== 'string') return value;
  if (/^[\s]*[\[{]/.test(value)) {
    try { return redact(JSON.parse(value), key, depth + 1); } catch {}
  }
  return value.replace(/data:image\/[^\s"']+/gi, '[图片二进制已省略]')
    .replace(/https?:\/\/[^\s<>"']+/gi, url => url.replace(/[?#].*$/, '?[链接参数已隐藏]'))
    .replace(/Bearer\s+[a-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]');
}
function createMonitor(db) {
  function where(f) {
    return { sql: 'j.created_at >= ? AND j.created_at < DATE_ADD(?, INTERVAL 1 DAY)' + (f.project ? ' AND j.project_id = ?' : ''),
      args: [f.from, f.to, ...(f.project ? [f.project] : [])] };
  }
  async function rows(f) {
    const w = where(f);
    const [data] = await db.query(`SELECT j.id, j.project_id, j.title, j.status, j.phase, j.created_at, j.updated_at, j.error_message,
      TIMESTAMPDIFF(SECOND, j.created_at, j.updated_at) AS duration_seconds,
      JSON_UNQUOTE(JSON_EXTRACT(j.settings_json, '$._generation_version')) AS requested_version,
      r.job_id AS run_id, r.result_json, r.model_requests, r.repair_used, r.fallback_used,
      JSON_UNQUOTE(JSON_EXTRACT(r.state_json, '$.prompt_version')) AS prompt_version,
      JSON_LENGTH(JSON_EXTRACT(r.state_json, '$.validation_issues')) AS warning_count,
      JSON_EXTRACT(r.state_json, '$.generator_version') AS generator_version
      FROM project_presentation_jobs j LEFT JOIN project_presentation_runs r ON r.job_id = j.id
      WHERE ${w.sql} ORDER BY j.created_at DESC, j.id DESC LIMIT 10001`, w.args);
    if (data.length > 10000) throw fail('所选范围超过 10000 个任务，请缩短日期范围或指定项目', 422);
    return data.map(classify);
  }
  function select(rows, f) {
    return rows.filter(r => (!f.outcome || r.outcome === f.outcome) && (!f.version || r.version === f.version)
      && (!f.search || `${r.id} ${r.title}`.toLowerCase().includes(f.search.toLowerCase())));
  }
  return {
    async summary(query) {
      const f = filters(query), all = await rows(f), selected = select(all, f), allowed = new Set(selected.map(r => r.id));
      const w = where(f);
      const [events] = await db.query(`SELECT e.job_id,
        JSON_UNQUOTE(JSON_EXTRACT(e.event_json, '$.event')) AS kind,
        JSON_EXTRACT(e.event_json, '$.issues') AS issues,
        JSON_UNQUOTE(JSON_EXTRACT(e.event_json, '$.code')) AS code
        FROM project_presentation_events e JOIN project_presentation_jobs j ON j.id = e.job_id
        WHERE ${w.sql} AND JSON_UNQUOTE(JSON_EXTRACT(e.event_json, '$.event')) IN ('validation','render_validation','primary_generation_error','task_failed')`, w.args);
      const problems = new Map();
      for (const event of events) {
        if (!allowed.has(event.job_id)) continue;
        const issues = parse(event.issues, []);
        if (event.code && event.code !== 'null') issues.push({ code: event.code, severity: 'error' });
        for (const issue of issues) {
          const key = `${issue.severity || 'error'}:${issue.code || 'unknown'}`;
          if (!problems.has(key)) problems.set(key, { code: issue.code || 'unknown', severity: issue.severity || 'error', jobs: new Set(), pages: new Set() });
          const p = problems.get(key); p.jobs.add(event.job_id); if (issue.slide_id) p.pages.add(`${event.job_id}:${issue.slide_id}`);
        }
      }
      const groups = new Map();
      for (const row of all) { if (!groups.has(row.version)) groups.set(row.version, []); groups.get(row.version).push(row); }
      return { filters: f, ...summarize(selected),
        denominator_note: 'V2 成功率 = V2 正式成功交付数 / 已结束的 V2 任务数（含草稿、失败、回退和结果未知；不含排队中、生成中及旧 V1 任务）。草稿可下载查看，但不计为正式成功。',
        problems: [...problems.values()].map(p => ({ code: p.code, severity: p.severity, jobs: p.jobs.size, pages: p.pages.size })).sort((a, b) => b.jobs - a.jobs),
        versions: [...groups].map(([version, items]) => ({ version, code_version: items[0].code_version, prompt_version: items[0].prompt_version,
          first_seen: items[items.length - 1].created_at, last_seen: items[0].created_at, ...summarize(items) })),
        version_note: '版本比较使用日期及项目范围，不受结果筛选影响；历史未记录的代码版本不推测归属。' };
    },
    async jobs(query) { const f = filters(query), items = select(await rows(f), f); return { items: items.slice((f.page - 1) * 20, f.page * 20), total: items.length, page: f.page, page_size: 20 }; },
    async diagnosis(id) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw fail('无效任务 ID');
      // Guard large diagnostic bodies before fetching raw request/response data.
      const [[size]] = await db.query(`SELECT COALESCE(SUM(OCTET_LENGTH(event_json)),0) AS bytes FROM project_presentation_events WHERE job_id = ?`, [id]);
      const [[jobSize]] = await db.query(`SELECT OCTET_LENGTH(COALESCE(j.source_json,'')) + OCTET_LENGTH(COALESCE(j.outline_json,'')) + OCTET_LENGTH(COALESCE(r.state_json,'')) AS bytes
        FROM project_presentation_jobs j LEFT JOIN project_presentation_runs r ON r.job_id=j.id WHERE j.id=?`, [id]);
      if (!jobSize) throw fail('任务不存在', 404);
      if (Number(size.bytes) + Number(jobSize.bytes) > 12 * 1024 * 1024) throw fail('该任务诊断数据超过 12 MB，请使用服务器诊断脚本导出', 413);
      const [[job]] = await db.query(`SELECT id, project_id, title, status, phase, attempts, created_at, updated_at, error_message, settings_json, source_json, outline_json FROM project_presentation_jobs WHERE id = ?`, [id]);
      const [[run]] = await db.query('SELECT schema_version, model_requests, initial_used, model_repair_used, legacy_used, repair_used, fallback_used, state_json, result_json FROM project_presentation_runs WHERE job_id = ?', [id]);
      const [events] = await db.query('SELECT id, created_at, event_json FROM project_presentation_events WHERE job_id = ? ORDER BY id', [id]);
      const state = parse(run?.state_json), result = parse(run?.result_json);
      const item = classify({ ...job, ...run, requested_version: parse(job.settings_json)._generation_version,
        run_id: run ? id : null, generator_version: state.generator_version, prompt_version: state.prompt_version, warning_count: state.validation_issues?.length });
      return redact({ task: item, input: { settings: parse(job.settings_json), source: parse(job.source_json) },
        output: { result, outline: parse(job.outline_json, null), initial_design: state.design || null, repaired_design: state.repaired_design || null },
        diagnostics: { ...run, state_json: undefined, result_json: undefined, fallback_reason: state.fallback_reason, v2_failure: state.v2_failure, validation_errors: state.validation_errors,
          text_fit_actions: state.text_fit_actions, generator_version: state.generator_version },
        events: events.map(e => ({ id: e.id, time: e.created_at, ...parse(e.event_json) })),
        exported_at: new Date().toISOString(), redaction_note: '已隐藏密钥、令牌、图片二进制与 URL 查询参数；项目文字和模型原文供管理员诊断。' });
    },
  };
}
module.exports = { createMonitor, filters, classify, summarize, redact };
