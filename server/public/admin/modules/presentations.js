/* Administrator-only, read-only presentation diagnostics. */
(function () {
  const labels = { direct: 'V2 直接成功', repaired: 'V2 修复后成功', draft: 'V2 草稿', failed: '生成失败', fallback: '退回 V1', legacy: '旧 V1 任务', pending: '排队 / 生成中', unknown: '结果未知' };
  const codes = { text_overflow: '文字溢出', out_of_bounds: '元素越界', text_collision: '文字重叠', text_occluded: '文字被遮挡', overlap: '元素叠放提醒', repair_failed: '修复后校验失败', schema: '设计结构不合格', unknown_asset: '引用未知素材', repair_content_changed: '修复改变文案', task_budget_or_lease: '任务超时或执行权失效', render_failed: '渲染失败' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const versionLabel = v => `${v.code_version === 'unrecorded' ? '代码版本未记录' : v.code_version} · ${v.prompt_version === 'unrecorded' ? '提示词未记录' : v.prompt_version}`;
  function layoutChanges(event) {
    if (!event.pre_repair_layout?.slides || !event.post_repair_layout?.slides) return [];
    const fields = { x: '横坐标', y: '纵坐标', w: '宽度', h: '高度', font_size: '字号', line_spacing: '行距', paragraph_spacing: '段距', fit: '图片适配' };
    const changes = [];
    for (const slide of event.post_repair_layout.slides) {
      const oldSlide = event.pre_repair_layout.slides.find(s => s.id === slide.id);
      for (const element of slide.elements || []) {
        const old = oldSlide?.elements?.find(e => e.id === element.id); if (!old) continue;
        const changed = Object.entries(fields).filter(([key]) => old[key] !== element[key]).map(([key, label]) => `${label} ${old[key] ?? '默认'} → ${element[key] ?? '默认'}`);
        if (changed.length) changes.push(`${slide.id} / ${element.id}：${changed.join('，')}`);
      }
    }
    return changes;
  }
  let refresh = () => {};
  function mount({ root, request }) {
    const shell = document.createElement('div'); shell.className = 'ppt-monitor'; root.replaceChildren(shell);
    let page = 1, sequence = 0, detailSequence = 0, versions = [];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const start = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
    shell.innerHTML = `
      <div class="ppt-heading"><div><div class="ppt-eyebrow">AI PPT / 生成监控</div><h3>让每次生成都有据可查</h3><p class="muted">观察交付结果，定位失败页面，对比每次更新的效果。</p></div><span class="ppt-readonly">只读诊断</span></div>
      <form class="ppt-filters">
        <label>开始日期<input name="from" type="date" value="${start}" required></label>
        <label>结束日期<input name="to" type="date" value="${today}" required></label>
        <label>项目 ID<input name="project" inputmode="numeric" placeholder="全部项目"></label>
        <label>任务结果<select name="outcome"><option value="">全部结果</option>${Object.entries(labels).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="ppt-search">任务标题 / 编号<input name="search" placeholder="输入标题或完整任务 ID" maxlength="200"></label>
        <button class="primary-btn" type="submit">查询</button><button class="ghost-btn" type="button" data-action="direct">按编号诊断</button>
      </form>
      <div class="ppt-status" role="status" aria-live="polite"></div>
      <div class="ppt-results"></div>
      <dialog class="ppt-dialog"><div class="ppt-dialog-head"><strong>任务诊断</strong><button class="ghost-btn" data-action="close" aria-label="关闭任务诊断">关闭</button></div><div class="ppt-detail"></div></dialog>`;
    const form = shell.querySelector('form'), results = shell.querySelector('.ppt-results'), status = shell.querySelector('.ppt-status'), dialog = shell.querySelector('dialog');
    async function get(path) { const response = await request(path); if (response.code !== 200) throw new Error(response.message || '读取失败'); return response.data; }
    function params() { return new URLSearchParams([...new FormData(form), ['page', String(page)]]); }
    function metric(label, value, hint = '') { return `<div class="ppt-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(hint)}</small></div>`; }
    async function load() {
      const seq = ++sequence; status.textContent = '正在读取任务和校验记录…'; results.setAttribute('aria-busy', 'true'); results.style.opacity = '.55';
      try {
        const p = params();
        const [s, list] = await Promise.all([get(`/presentations/summary?${p}`), get(`/presentations/jobs?${p}`)]);
        if (!shell.isConnected || seq !== sequence) return;
        versions = s.versions;
        status.textContent = `按任务创建日期统计 · ${s.filters.from} 至 ${s.filters.to} · ${new Date().toLocaleTimeString('zh-CN')} 更新`;
        results.innerHTML = `
          <div class="ppt-metrics">
          ${metric('V2 成功交付率', pct(s.v2_success_rate), `${s.v2_successful} / ${s.v2_finished} 个已结束 V2 任务`)}
          ${metric('V2 直接成功', s.counts.direct, '无需修复即可交付')}
          ${metric('V2 修复后成功', s.counts.repaired, `修复成功 ${s.repair_successes} / ${s.repair_attempts} 次`)}
          ${metric('V2 草稿', s.counts.draft, '已生成文件，仍有排版问题')}
          ${metric('生成失败', s.counts.failed, '未交付文件')}
          ${metric('退回 V1', s.counts.fallback, '不计入 V2 成功')}
          ${metric('排队 / 生成中', s.counts.pending, '不计入成功率分母')}
          </div><p class="ppt-note">${esc(s.denominator_note)} 带提醒交付 ${s.with_warnings} 次；渲染验证通过 ${s.render_verified} 次。旧 V1 任务 ${s.counts.legacy} 次，结果未知 ${s.counts.unknown} 次。</p>
          <div class="ppt-panels"><section class="card"><h3>问题排行</h3><p class="muted">同一问题在同一任务内只计一次，包含已修复的问题和草稿遗留问题。</p><div class="ppt-scroll"><table><thead><tr><th>问题</th><th>级别</th><th>任务数</th><th>页面数</th></tr></thead><tbody>${s.problems.length ? s.problems.map(p => `<tr><td>${esc(codes[p.code] || p.code)}<small class="ppt-code">${esc(p.code)}</small></td><td><span class="ppt-badge ${p.severity === 'warning' ? 'pending' : 'failed'}">${p.severity === 'warning' ? '提醒' : '错误'}</span></td><td>${p.jobs}</td><td>${p.pages || '—'}</td></tr>`).join('') : '<tr><td colspan="4" class="ppt-empty">该范围暂无问题记录</td></tr>'}</tbody></table></div></section>
          <section class="card"><h3>版本效果对比</h3><p class="muted">${esc(s.version_note)}</p><div class="ppt-compare-controls"><label>更新前<select data-compare="before">${versions.map((v, i) => `<option value="${i}" ${i === versions.length - 1 ? 'selected' : ''}>${esc(versionLabel(v))}</option>`).join('')}</select></label><label>更新后<select data-compare="after">${versions.map((v, i) => `<option value="${i}">${esc(versionLabel(v))}</option>`).join('')}</select></label></div><div class="ppt-comparison"></div></section></div>
          <section class="card"><h3>生成任务 <small class="muted">${list.total} 条</small></h3><div class="ppt-scroll"><table><thead><tr><th>任务 / 项目</th><th>生成结果</th><th>版本</th><th>创建时间 / 耗时</th><th>模型调用</th><th>操作</th></tr></thead><tbody>${list.items.length ? list.items.map(j => `<tr><td><strong>${esc(j.title)}</strong><small class="ppt-code">项目 ${j.project_id} · ${esc(j.id)}</small></td><td><span class="ppt-badge ${esc(j.outcome)}">${esc(labels[j.outcome])}</span>${j.outcome === 'draft' ? `<small class="ppt-code">${j.draft_issue_count} 项遗留问题</small>` : j.warnings ? `<small class="ppt-code">${j.warnings} 项提醒</small>` : ''}</td><td>${esc(j.prompt_version === 'unrecorded' ? '提示词未记录' : j.prompt_version)}<small class="ppt-code">${esc(j.code_version === 'unrecorded' ? '代码版本未记录' : j.code_version)}</small></td><td>${esc(date(j.created_at))}<small class="ppt-code">${j.duration_seconds == null ? '进行中' : `${j.duration_seconds} 秒（含排队）`}</small></td><td>${j.model_requests ?? '—'}</td><td><button class="ghost-btn" data-job="${esc(j.id)}">查看诊断</button></td></tr>`).join('') : '<tr><td colspan="6" class="ppt-empty">暂无匹配任务，可调整日期或筛选条件。</td></tr>'}</tbody></table></div><div class="pagination"><span>第 ${page} / ${Math.max(1, Math.ceil(list.total / 20))} 页</span><button data-action="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button><button data-action="next" ${page * 20 >= list.total ? 'disabled' : ''}>下一页</button></div></section>`;
        compare();
      } catch (e) { if (shell.isConnected && seq === sequence) { status.textContent = e.message; results.replaceChildren(); } }
      finally { if (seq === sequence) { results.removeAttribute('aria-busy'); results.style.opacity = ''; } }
    }
    function compare() {
      const target = shell.querySelector('.ppt-comparison'); if (!target) return;
      const before = versions[Number(shell.querySelector('[data-compare="before"]').value)], after = versions[Number(shell.querySelector('[data-compare="after"]').value)];
      if (!before || !after) { target.innerHTML = '<p class="ppt-empty">暂无版本数据</p>'; return; }
      const delta = before.v2_success_rate == null || after.v2_success_rate == null ? null : (after.v2_success_rate - before.v2_success_rate) * 100;
      target.innerHTML = `<table><thead><tr><th>指标</th><th>更新前</th><th>更新后</th></tr></thead><tbody>
        <tr><td>已结束 V2 任务</td><td>${before.v2_finished}</td><td>${after.v2_finished}</td></tr>
        <tr><td>V2 成功率</td><td>${pct(before.v2_success_rate)}</td><td>${pct(after.v2_success_rate)}</td></tr>
        <tr><td>修复后成功</td><td>${before.counts.repaired}</td><td>${after.counts.repaired}</td></tr>
        <tr><td>草稿 / 失败 / 回退 V1</td><td>${before.counts.draft} / ${before.counts.failed} / ${before.counts.fallback}</td><td>${after.counts.draft} / ${after.counts.failed} / ${after.counts.fallback}</td></tr></tbody></table>
        <p class="ppt-note">${before.version === after.version ? '请选择两个不同版本；历史记录不足时，等待新版本任务积累。' : `成功率变化：${delta == null ? '暂无可比样本' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} 个百分点`}。样本和输入可能不同，不能仅凭成功率判断更新效果。`}</p>`;
    }
    async function detail(id) {
      const seq = ++detailSequence, target = shell.querySelector('.ppt-detail');
      target.textContent = '正在读取完整诊断…'; if (!dialog.open) dialog.showModal();
      try {
        const d = await get(`/presentations/jobs/${encodeURIComponent(id)}/diagnosis`);
        if (!shell.isConnected || seq !== detailSequence) return;
        const validations = d.events.filter(e => e.event === 'validation');
        const first = validations.find(e => e.label === 'initial') || validations[0];
        const later = validations.filter(e => e !== first);
        const final = later[later.length - 1] || (d.task.outcome === 'direct' ? first : null);
        const errorCount = e => e?.issues?.filter(i => i.severity === 'error').length ?? 0;
        target.innerHTML = `<h3>${esc(d.task.title)}</h3><p class="ppt-task-id">${esc(d.task.id)}</p><p><span class="ppt-badge ${esc(d.task.outcome)}">${esc(labels[d.task.outcome])}</span> 初次校验 ${errorCount(first)} 项错误 → ${final ? `最终校验 ${errorCount(final)} 项错误` : '最终校验未执行'}；模型调用 ${d.task.model_requests ?? '未记录'} 次。</p><p class="ppt-note">${esc(d.task.error || d.diagnostics.fallback_reason?.message || d.diagnostics.v2_failure?.message || '')}</p><div class="toolbar"><button class="primary-btn" data-action="export">导出完整诊断 JSON</button></div><h4>生成与修复过程</h4><ol class="ppt-timeline">${d.events.map(e => {
          const names = { request: '模型请求', response: '模型返回', validation: '排版校验', render_validation: '渲染校验', repair_actions: '执行修复', draft_delivered: '输出 V2 草稿', primary_generation_error: 'V2 失败', fallback_result: 'V1 回退结果', task_failed: '任务失败', fallback_blocked: '已阻止 V1 回退', render_environment_preflight: '环境检查', model_request_reserved: '分配模型调用额度', repair_reserved: '开始修复', fallback_reserved: '开始回退 V1' };
          const issues = e.issues?.filter(i => i.severity === 'error') || [];
          return `<li><span class="muted">${esc(date(e.time))}</span><strong>${esc(names[e.event] || e.event)} <small>${esc(e.label || e.stage || e.mode || '')}</small></strong>${e.skipped ? '<p>未执行视觉渲染验证</p>' : ''}${e.message ? `<p>${esc(e.message)}</p>` : ''}${issues.map(i => `<p>${esc(codes[i.code] || i.code)} · ${esc(i.slide_id || '整份设计')} / ${esc(i.element_id || '')}${Number.isFinite(i.overflow_ratio) ? ` · 溢出 ${(i.overflow_ratio * 100).toFixed(2)}%` : ''}</p>`).join('')}${(e.actions || []).map(a => `<p>${esc(a.slide_id)} / ${esc(a.element_id)}：${esc(a.type)} ${esc(a.before)} → ${esc(a.after)}</p>`).join('')}${e.mode === 'model' ? layoutChanges(e).map(change => `<p>${esc(change)}</p>`).join('') : ''}</li>`;
        }).join('') || '<li>该任务没有保存详细事件</li>'}</ol><h4>实际输入与输出</h4><p class="ppt-note">${esc(d.redaction_note)}</p><div class="ppt-raw"></div>`;
        for (const [label, value] of [['业务输入及生成设置', d.input], ['V2 初次设计', d.output.initial_design], ['修复后设计', d.output.repaired_design], ['最终交付内容及结果', { result: d.output.result, outline: d.output.outline }], ['完整事件（含模型请求、响应及修复前后）', d.events]]) {
          const section = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre'); summary.textContent = label; section.append(summary, pre);
          section.addEventListener('toggle', () => { if (section.open && !pre.textContent) pre.textContent = JSON.stringify(value, null, 2); }); target.querySelector('.ppt-raw').append(section);
        }
        target.querySelector('[data-action="export"]').onclick = () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
          const a = document.createElement('a'); a.href = url; a.download = `ppt-diagnosis-${d.task.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
      } catch (e) { if (seq === detailSequence) target.textContent = e.message; }
    }
    form.addEventListener('submit', e => { e.preventDefault(); page = 1; load(); });
    shell.addEventListener('change', e => { if (e.target.dataset.compare) compare(); });
    shell.addEventListener('click', e => {
      const button = e.target.closest('button'); if (!button) return;
      if (button.dataset.job) return detail(button.dataset.job);
      if (button.dataset.action === 'close') { detailSequence++; dialog.close(); }
      if (button.dataset.action === 'prev') { page--; load(); }
      if (button.dataset.action === 'next') { page++; load(); }
      if (button.dataset.action === 'direct') {
        const id = form.elements.search.value.trim();
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) { status.textContent = '请在任务标题 / 编号框输入完整任务 ID'; return; }
        detail(id);
      }
    });
    dialog.addEventListener('cancel', () => { detailSequence++; });
    refresh = load; load();
  }
  window.PresentationMonitor = { mount, refresh: () => refresh() };
})();
