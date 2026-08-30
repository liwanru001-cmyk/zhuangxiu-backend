const API = window.ADMIN_API_BASE || localStorage.getItem('admin_api_base') || '/api/admin';
const menus = [
  { key: 'overview', label: '概览', icon: '📊', subtitle: '查看平台关键数据' },
  { key: 'users', label: '用户管理', icon: '👤', subtitle: '管理用户账号、新建账户审核与身份信息' },
  { key: 'companies', label: '公司管理', icon: '🏢', subtitle: '查看装修市场公司、业务分类、成员与项目关联' },
  { key: 'billing', label: '商户管理', icon: '💰', subtitle: '管理商户订单、支付、订阅、展示权益和操作记录' },
  { key: 'companyBilling', label: '装修公司管理', icon: '🏬', subtitle: '管理装修公司认证后的付费展示、上线状态和操作记录' },
  { key: 'shares', label: '分享管理', icon: '🧩', subtitle: '审核用户发布的公开分享内容' },
  { key: 'projectTips', label: '日志信息编辑', icon: '💡', subtitle: '管理装修日志里展示的信息轮播和项目功能说明' },
  { key: 'supportFeedback', label: '问题反馈', icon: '❓', subtitle: '编辑常见问题，查看用户提交的问题反馈' },
  { key: 'inspectionTemplates', label: '验收标准库', icon: '✅', subtitle: '维护验收模板、检查项和推荐规则底座' },
  { key: 'content', label: '内容管理', icon: '📝', subtitle: '管理用户发布内容，后续接入' },
  { key: 'projects', label: '项目进度管理', icon: '🏗️', subtitle: '维护固定阶段下的统一事项库和推荐规则' },
  { key: 'profiles', label: '身份资料', icon: '🪪', subtitle: '管理设计师、项目经理、商家主页资料' },
  { key: 'finance', label: '费用与打卡', icon: '💳', subtitle: '管理费用支出与工地打卡记录' },
  { key: 'reports', label: '举报反馈', icon: '🚩', subtitle: '处理举报、反馈和异常内容' },
  { key: 'settings', label: '系统设置', icon: '⚙️', subtitle: '管理城市、风格、身份标签等配置' },
];

const rememberedToken = localStorage.getItem('admin_remember_token') || '';
let token = sessionStorage.getItem('admin_token') || rememberedToken;
let activeMenu = window.location.pathname.includes('/admin/billing') ? 'billing' : 'overview';
let page = 1;
let total = 0;
let userTab = 'accounts';
let wechatAppealPage = 1;
let wechatAppealTotal = 0;
let accountDeletionPage = 1;
let accountDeletionTotal = 0;
let editingId = null;
let inspectionTemplates = [];
let inspectionItems = [];
let selectedInspectionTemplateId = null;
let projectTips = [];
let editingTipId = null;
let helpFaqs = [];
let editingFaqId = null;
let feedbackPage = 1;
let feedbackTotal = 0;
let features = { inspectionKb: false };
let progressStages = [];
let progressItems = [];
let selectedProgressStageId = 1;
let selectedProgressItemKey = '';
let companies = [];
let selectedCompanyId = null;
let companyTab = 'companies';
let merchants = [];
let billingMerchants = [];
let billingCompanies = [];
let selectedBillingMerchantId = null;
let selectedBillingCompanyId = null;
let billingExceptions = { payment_not_activated: [], event_failures: [] };
let merchantPlan = null;
let companyPlan = null;
let billingTab = 'merchants';
let companyBillingTab = 'companies';
let billingOrderPage = 1;
let billingOrderTotal = 0;
let companyBillingOrderPage = 1;
let companyBillingOrderTotal = 0;
let companyBillingAppealPage = 1;
let companyBillingAppealTotal = 0;
let billingAppealPage = 1;
let billingAppealTotal = 0;
let billingDetailTab = 'overview';
let selectedBillingDetailData = null;
let billingActionState = null;
let appReleases = [];

document.getElementById('u-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

const rememberedUsername = localStorage.getItem('admin_remember_username') || '';
if (rememberedUsername) document.getElementById('u-name').value = rememberedUsername;
document.getElementById('remember-login').checked = Boolean(rememberedToken);
if (token) sessionStorage.setItem('admin_token', token);

renderNav();
if (token) showMain();

async function doLogin() {
  const username = document.getElementById('u-name').value.trim();
  const password = document.getElementById('u-pass').value;
  const rememberLogin = document.getElementById('remember-login').checked;
  document.getElementById('login-err').textContent = '';
  try {
    const r = await fetch(`${API}/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username, password}),
    });
    const j = await r.json();
    if (j.code !== 200) {
      document.getElementById('login-err').textContent = j.message || '登录失败';
      return;
    }
    token = j.data.token;
    sessionStorage.setItem('admin_token', token);
    if (rememberLogin) {
      localStorage.setItem('admin_remember_token', token);
      localStorage.setItem('admin_remember_username', username);
    } else {
      localStorage.removeItem('admin_remember_token');
      localStorage.removeItem('admin_remember_username');
    }
    document.getElementById('u-pass').value = '';
    showMain();
  } catch (e) {
    document.getElementById('login-err').textContent = '网络错误';
  }
}

async function showMain() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('main-page').style.display = 'block';
  await loadFeatures();
  if (activeMenu === 'inspectionTemplates' && !features.inspectionKb) activeMenu = 'overview';
  switchMenu(activeMenu);
}

function logout() {
  sessionStorage.removeItem('admin_token');
  localStorage.removeItem('admin_remember_token');
  localStorage.removeItem('admin_remember_username');
  token = '';
  document.getElementById('u-pass').value = '';
  document.getElementById('remember-login').checked = false;
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('main-page').style.display = 'none';
}

function renderNav() {
  const visibleMenus = menus.filter(item => item.key !== 'inspectionTemplates' || features.inspectionKb);
  document.getElementById('nav').innerHTML = visibleMenus.map(item => `
    <button class="${item.key === activeMenu ? 'active' : ''}" onclick="switchMenu('${item.key}')">
      <span class="icon">${item.icon}</span><span>${item.label}</span>
    </button>
  `).join('');
}

async function loadFeatures() {
  try {
    const j = await adminFetch('/features');
    if (j.code === 200) features = Object.assign({ inspectionKb: false }, j.data || {});
  } catch (e) {
    features = { inspectionKb: false };
  }
}

function switchMenu(key) {
  activeMenu = key;
  renderNav();
  const item = menus.find(menu => menu.key === key) || menus[0];
  document.getElementById('page-title').textContent = item.label;
  document.getElementById('page-subtitle').textContent = item.subtitle;
  if (key === 'overview') renderOverview();
  else if (key === 'users') renderUsers();
  else if (key === 'companies') renderCompanies();
  else if (key === 'billing') renderBilling();
  else if (key === 'companyBilling') renderCompanyBilling();
  else if (key === 'shares') renderShares();
  else if (key === 'projectTips') renderProjectTips();
  else if (key === 'supportFeedback') renderSupportFeedback();
  else if (key === 'inspectionTemplates') renderInspectionTemplates();
  else if (key === 'reports') renderReports();
  else if (key === 'projects') renderProgressLibrary();
  else if (key === 'settings') renderSystemSettings();
  else renderPlaceholder(item);
}

function refreshCurrent() {
  if (activeMenu === 'overview') renderOverview();
  else if (activeMenu === 'users') {
    if (userTab === 'wechatAppeals') loadWechatBindingAppeals(wechatAppealPage);
    else loadUsers(page);
  }
  else if (activeMenu === 'companies') {
    if (companyTab === 'merchants') loadMerchants(page);
    else loadCompanies(page);
  }
  else if (activeMenu === 'billing') {
    refreshBillingTab();
  }
  else if (activeMenu === 'companyBilling') {
    refreshCompanyBillingTab();
  }
  else if (activeMenu === 'shares') loadShares(page);
  else if (activeMenu === 'projectTips') loadProjectTips();
  else if (activeMenu === 'supportFeedback') {
    loadHelpFaqs();
    loadUserFeedback(feedbackPage);
  }
  else if (activeMenu === 'inspectionTemplates') loadInspectionTemplates();
  else if (activeMenu === 'projects') loadProgressLibrary();
  else if (activeMenu === 'settings') loadAppReleases();
  else if (activeMenu === 'reports') loadReports();
  else switchMenu(activeMenu);
}

let reportPage = 1;
let reportStatus = 'pending';
let reportTotal = 0;
let pendingReportAction = null;

function renderReports() {
  const item = menus.find(menu => menu.key === 'reports');
  document.getElementById('page-title').textContent = item.label;
  document.getElementById('page-subtitle').textContent = item.subtitle;
  document.getElementById('page-content').innerHTML = `
    <div class="toolbar">
      <select id="reportStatus" onchange="reportStatus=this.value;reportPage=1;loadReports()">
        <option value="pending">待处理</option><option value="processing">处理中</option>
        <option value="resolved">已处理</option><option value="">全部</option>
      </select>
      <button class="ghost-btn" onclick="loadReports()">刷新</button>
    </div>
    <div class="card">
      <div id="reportList"><div class="empty-state">正在加载举报记录…</div></div>
      <div class="pagination">
        <span id="report-page-info"></span>
        <button id="report-prev" onclick="loadReports(reportPage-1)">‹ 上一页</button>
        <button id="report-next" onclick="loadReports(reportPage+1)">下一页 ›</button>
      </div>
    </div>`;
  document.getElementById('reportStatus').value = reportStatus;
  loadReports();
}

async function loadReports(nextPage = reportPage) {
  reportPage = Math.max(1, Number(nextPage) || 1);
  const list = document.getElementById('reportList');
  if (!list) return;
  try {
    const params = new URLSearchParams({ page: reportPage, pageSize: 10 });
    if (reportStatus) params.set('status', reportStatus);
    const j = await adminFetch(`/reports?${params}`);
    const items = j.data?.items || [];
    reportTotal = Number(j.data?.total || 0);
    const totalPages = Math.max(1, Math.ceil(reportTotal / 10));
    if (reportPage > totalPages) return loadReports(totalPages);
    list.innerHTML = items.length ? `<table><thead><tr><th>ID</th><th>举报对象</th><th>类型</th><th>次数</th><th>状态</th><th>最近提交</th><th>操作</th></tr></thead><tbody>${items.map(item => `
      <tr><td>${item.id}</td><td>${esc(item.reported_nickname || '-')} (#${item.reported_user_id})</td>
      <td>${reportCategoryLabel(item.latest_category)}</td><td>${item.report_count}</td><td>${reportStatusLabel(item.status)}</td>
      <td>${esc(String(item.updated_at || '').replace('T',' ').slice(0,16))}</td>
      <td><button class="ghost-btn" onclick="openReport(${item.id})">查看处理</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty-state">暂无符合条件的举报</div>';
    document.getElementById('report-page-info').textContent = `共 ${reportTotal} 条 · ${reportPage}/${totalPages}`;
    document.getElementById('report-prev').disabled = reportPage <= 1;
    document.getElementById('report-next').disabled = reportPage >= totalPages;
  } catch (e) { list.innerHTML = `<div class="message error">${esc(e.message)}</div>`; }
}

async function openReport(id) {
  document.getElementById('page-title').textContent = `举报 #${id}`;
  document.getElementById('page-subtitle').textContent = '查看举报内容、图片凭证与处理记录';
  const root = document.getElementById('page-content');
  root.innerHTML = `<div class="report-detail-toolbar"><button class="ghost-btn report-back-button" onclick="backToReportList()">‹ 返回举报列表</button></div><div class="card"><div class="empty-state">正在读取举报详情…</div></div>`;
  try {
    const j = await adminFetch(`/reports/${id}`);
    const data = j.data || {}; const report = data.report || {};
    const evidence = data.evidence || [];
    const occurrences = data.occurrences || [];
    const actions = data.actions || [];
    root.innerHTML = `<div class="report-detail-toolbar"><button class="ghost-btn report-back-button" onclick="backToReportList()">‹ 返回举报列表</button></div><section class="card report-detail-card">
      <header class="report-detail-header">
        <div><span class="report-eyebrow">举报详情</span><h2>举报 #${id}</h2></div>
        <span class="badge status-${esc(report.status || 'pending')}">${reportStatusLabel(report.status)}</span>
      </header>
      <div class="report-summary-grid">
        <div class="report-summary-item"><span>被举报账号</span><strong>${esc(report.reported_nickname || '-')}</strong><small>用户 ID：${report.reported_user_id || '-'}</small></div>
        <div class="report-summary-item"><span>举报对象</span><strong>${reportTargetLabel(report.target_type)}</strong><small>会话 #${report.consultation_id || '-'} · 消息 #${report.message_id || '-'}</small></div>
        <div class="report-summary-item"><span>最近原因</span><strong>${reportCategoryLabel(report.latest_category)}</strong><small>累计 ${report.report_count || 1} 次举报</small></div>
      </div>
      <div class="report-detail-columns">
        <div class="report-main-column">
          <section class="report-section"><h3>举报内容</h3>
            <div class="report-field"><span>消息快照</span><div class="report-copy">${esc(report.message_snapshot || '无单条消息快照')}</div></div>
            <div class="report-field"><span>补充说明</span><div class="report-copy">${esc(report.latest_description || '无补充说明')}</div></div>
          </section>
          <section class="report-section"><div class="report-section-title"><h3>图片凭证</h3><span>${evidence.length} 张</span></div>
            ${evidence.length ? `<div class="report-evidence-grid">${evidence.map((item, index) => `<button class="report-evidence-button" type="button" data-url="${esc(item.image_url)}" onclick="previewReportEvidence(this.dataset.url, ${index + 1})"><img src="${esc(item.image_url)}" alt="举报凭证 ${index + 1}" loading="lazy"><span>点击预览</span></button>`).join('')}</div>` : '<div class="report-empty">未提交图片凭证</div>'}
          </section>
          <section class="report-section"><div class="report-section-title"><h3>举报明细</h3><span>${occurrences.length} 条</span></div>
            <div class="report-record-list">${occurrences.map(o => `<div class="report-record"><div><strong>${esc(o.reporter_nickname || '-')}</strong><span class="badge status-pending">${reportCategoryLabel(o.category)}</span></div><p>${esc(o.description || '无补充说明')}</p><time>${formatReportTime(o.created_at)}</time></div>`).join('') || '<div class="report-empty">暂无举报明细</div>'}</div>
          </section>
        </div>
        <aside class="report-action-column">
          <section class="report-section report-action-panel"><h3>处理举报</h3><label for="reportActionNote">处理备注</label><textarea id="reportActionNote" maxlength="1000" placeholder="填写判断依据或处理说明"></textarea>
            <div class="report-action-buttons"><button class="ghost-btn" onclick="handleReport(${id},'ignore')">忽略</button><button class="ghost-btn" onclick="handleReport(${id},'warn')">警告</button>${report.message_id ? `<button class="danger-btn" onclick="handleReport(${id},'delete_message')">删除消息</button>` : ''}<button class="danger-btn" onclick="handleReport(${id},'mute')">禁言 7 天</button><button class="danger-btn" onclick="handleReport(${id},'ban')">封禁账号</button></div>
          </section>
          <section class="report-section"><div class="report-section-title"><h3>处理记录</h3><span>${actions.length} 条</span></div>
            <div class="report-record-list">${actions.map(a => `<div class="report-record"><div><strong>${esc(a.admin_name || '管理员')}</strong><span>${reportActionLabel(a.action)}</span></div><p>${esc(a.note || '无处理备注')}</p><time>${formatReportTime(a.created_at)}</time></div>`).join('') || '<div class="report-empty">暂无处理记录</div>'}</div>
          </section>
        </aside>
      </div>
    </section>`;
  } catch (e) {
    root.innerHTML = `<div class="report-detail-toolbar"><button class="ghost-btn report-back-button" onclick="backToReportList()">‹ 返回举报列表</button></div><div class="card message error">${esc(e.message)}</div>`;
  }
}

function backToReportList() {
  renderReports();
}

async function handleReport(id, action) {
  const note = document.getElementById('reportActionNote')?.value.trim() || '';
  const config = reportActionConfig(action);
  pendingReportAction = { id, action, note };
  document.getElementById('report-confirm-title').textContent = config.title;
  document.getElementById('report-confirm-description').textContent = config.description;
  document.getElementById('report-confirm-target').textContent = `举报 #${id}`;
  document.getElementById('report-confirm-note').textContent = note || '未填写处理备注';
  const submit = document.getElementById('report-confirm-submit');
  submit.textContent = config.button;
  submit.className = config.danger ? 'danger-btn' : 'primary';
  submit.disabled = false;
  document.getElementById('report-confirm-error').textContent = '';
  document.getElementById('report-confirm-modal').classList.add('show');
}

function reportActionConfig(action) {
  return {
    ignore: { title: '确认忽略该举报？', description: '该举报将标记为已处理，不会对被举报用户采取处罚。', button: '确认忽略', danger: false },
    warn: { title: '确认警告该用户？', description: '系统将记录本次警告，并把举报标记为已处理。', button: '确认警告', danger: false },
    delete_message: { title: '确认删除被举报消息？', description: '消息删除后将无法在会话中恢复，请确认举报内容和凭证无误。', button: '确认删除消息', danger: true },
    mute: { title: '确认禁言 7 天？', description: '被举报用户在 7 天内将无法发送消息。', button: '确认禁言', danger: true },
    ban: { title: '确认封禁该账号？', description: '账号封禁后将无法继续使用相关服务，请谨慎操作。', button: '确认封禁账号', danger: true },
  }[action] || { title: '确认处理该举报？', description: '请核对处理内容后再提交。', button: '确认处理', danger: false };
}

function closeReportActionModal() {
  document.getElementById('report-confirm-modal').classList.remove('show');
  document.getElementById('report-confirm-error').textContent = '';
  pendingReportAction = null;
}

async function submitReportAction() {
  if (!pendingReportAction) return;
  const current = pendingReportAction;
  const submit = document.getElementById('report-confirm-submit');
  submit.disabled = true;
  submit.textContent = '提交中…';
  document.getElementById('report-confirm-error').textContent = '';
  try {
    const duration = current.action === 'mute' ? 7 * 24 * 60 : null;
    await adminFetch(`/reports/${current.id}/actions`, { method: 'POST', body: JSON.stringify({ action: current.action, note: current.note, duration_minutes: duration }) });
    closeReportActionModal();
    toast(`${reportActionLabel(current.action)}处理成功`);
    await openReport(current.id);
  } catch (e) {
    document.getElementById('report-confirm-error').textContent = e.message || '提交失败，请稍后重试';
    submit.disabled = false;
    const config = reportActionConfig(current.action);
    submit.textContent = config.button;
  }
}

function reportCategoryLabel(value) {
  return { sexual:'色情低俗', fraud_gambling:'欺诈或赌博', illegal:'违法违规', harassment:'辱骂骚扰', advertising:'广告营销', impersonation:'冒充他人', privacy:'泄露个人隐私', other:'其他' }[value] || value || '-';
}
function reportStatusLabel(value) { return { pending:'待处理', processing:'处理中', resolved:'已处理' }[value] || value || '-'; }
function reportTargetLabel(value) { return { user:'用户', conversation:'会话', message:'单条消息' }[value] || value || '-'; }
function reportActionLabel(value) { return { ignore:'忽略', delete_message:'删除消息', warn:'警告', mute:'禁言', ban:'封禁账号' }[value] || value || '-'; }
function formatReportTime(value) { return esc(String(value || '-').replace('T', ' ').replace('.000Z', '').slice(0, 19)); }

function previewReportEvidence(url, index) {
  let overlay = document.getElementById('reportEvidencePreview');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'reportEvidencePreview';
    overlay.className = 'report-preview-overlay';
    overlay.innerHTML = '<div class="report-preview-dialog"><div class="report-preview-head"><strong id="reportPreviewTitle">图片凭证</strong><button type="button" aria-label="关闭预览" onclick="closeReportEvidencePreview()">×</button></div><div class="report-preview-stage"><img id="reportPreviewImage" alt="举报图片凭证"></div></div>';
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closeReportEvidencePreview(); });
    document.body.appendChild(overlay);
  }
  document.getElementById('reportPreviewTitle').textContent = `图片凭证 ${index || ''}`;
  document.getElementById('reportPreviewImage').src = url;
  overlay.classList.add('show');
  document.body.classList.add('preview-open');
}

function closeReportEvidencePreview() {
  const overlay = document.getElementById('reportEvidencePreview');
  if (overlay) overlay.classList.remove('show');
  document.body.classList.remove('preview-open');
}

function renderSystemSettings() {
  const inDesktopApp = document.documentElement.classList.contains('xiaowo-desktop-app');
  if (inDesktopApp) {
    document.getElementById('page-content').innerHTML = `
      <div class="settings-grid"><div class="card settings-section-card">
        <div class="card-title"><div><h3>版本发布中心</h3><p>在桌面软件原生页面中管理安装包、更新说明与发布状态</p></div>
        <button class="primary-btn" onclick="location.href='xiaowo-admin://release-center'">打开版本发布中心</button></div>
      </div></div>`;
    return;
  }
  document.getElementById('page-content').innerHTML = `
    <div class="settings-grid">
      <div class="card settings-section-card">
        <div class="card-title">
          <div>
            <h3>版本发布中心</h3>
            <p>统一管理 Windows、macOS 和 Android 安装包、更新说明与发布状态</p>
          </div>
          <button class="primary-btn" onclick="toggleReleaseForm(true)">+新建版本</button>
        </div>
        <div id="release-create-panel" class="release-create-panel" hidden>
          <form id="release-form" onsubmit="createAppRelease(event)">
            <div class="release-form-grid">
              <label>平台<select name="platform" required><option value="windows">Windows</option><option value="macos">macOS</option><option value="android">Android</option></select></label>
              <label>版本号<input name="version_name" required placeholder="例如 1.2.0" pattern="\\d+\\.\\d+\\.\\d+.*"></label>
              <label>构建号<input name="build_number" required type="number" min="1" step="1" placeholder="例如 7"></label>
              <label>更新方式<select name="update_mode" required><option value="optional">普通更新</option><option value="required">强制更新</option></select></label>
            </div>
            <label class="release-field">安装包<input name="package" required type="file" accept=".exe,.msix,.dmg,.pkg,.apk"><small>Windows 支持 .exe/.msix，macOS 支持 .dmg/.pkg，Android 支持 .apk，最大 1GB</small></label>
            <label class="release-field">更新说明<textarea name="release_notes" required placeholder="请说明本次新增、修复和注意事项"></textarea></label>
            <div class="release-form-actions">
              <button type="button" class="ghost-btn" onclick="toggleReleaseForm(false)">取消</button>
              <button id="release-submit" type="submit" class="primary-btn">上传并保存草稿</button>
            </div>
            <div id="release-upload-status" class="muted" hidden></div>
          </form>
        </div>
        <div id="release-list" class="release-list"><div class="empty-editor">正在读取版本……</div></div>
      </div>
      <div class="card settings-section-card">
        <div class="card-title"><div><h3>其他系统设置</h3><p>城市、风格和身份标签等配置后续在此接入</p></div></div>
        <div class="empty-editor">当前优先上线桌面软件版本发布能力。</div>
      </div>
    </div>
  `;
  loadAppReleases();
}

function toggleReleaseForm(show) {
  const panel = document.getElementById('release-create-panel');
  if (panel) panel.hidden = !show;
}

async function loadAppReleases() {
  const host = document.getElementById('release-list');
  if (!host) return;
  try {
    const j = await adminFetch('/app-releases');
    if (j.code !== 200) throw new Error(j.message || '版本列表加载失败');
    appReleases = Array.isArray(j.data) ? j.data : [];
    const totalDownloads = appReleases.reduce((total, item) => total + Number(item.download_count || 0), 0);
    host.innerHTML = appReleases.length ? `
      <div class="empty-editor"><strong>总下载数量：${totalDownloads} 次</strong></div>
      <div class="table-wrap"><table class="release-table">
        <thead><tr><th>平台</th><th>版本</th><th>下载数量</th><th>状态</th><th>更新方式</th><th>安装包</th><th>更新说明</th><th>发布时间</th><th>操作</th></tr></thead>
        <tbody>${appReleases.map(releaseRowHtml).join('')}</tbody>
      </table></div>
    ` : '<div class="empty-editor">还没有桌面端版本，点击“新建版本”开始上传。</div>';
  } catch (e) {
    host.innerHTML = `<div class="empty-editor">${esc(e.message || '版本列表加载失败')}</div>`;
  }
}

function releaseRowHtml(item) {
  const status = { draft: '草稿', published: '已发布', withdrawn: '已撤回' }[item.status] || item.status;
  const mode = item.update_mode === 'required' ? '强制更新' : '普通更新';
  const platform = { windows: 'Windows', macos: 'macOS', android: 'Android' }[item.platform] || item.platform;
  return `<tr>
    <td><span class="badge ${item.platform === 'windows' ? 'status-processing' : 'status-approved'}">${esc(platform)}</span></td>
    <td><strong>${esc(item.version_name)}</strong><div class="muted">Build ${Number(item.build_number || 0)}</div></td>
    <td><strong>${Number(item.download_count || 0)}</strong> 次</td>
    <td><span class="badge status-${item.status === 'published' ? 'approved' : item.status === 'draft' ? 'draft' : 'hidden'}">${status}</span></td>
    <td>${mode}</td>
    <td><a href="${esc(item.package_url)}" target="_blank" rel="noopener">${esc(item.package_name)}</a><div class="muted">${formatFileSize(item.package_size)} · SHA-256 ${esc(String(item.sha256 || '').slice(0, 12))}…</div></td>
    <td><div class="detail-text">${esc(item.release_notes || '')}</div></td>
    <td>${item.published_at ? formatAdminTime(item.published_at) : '-'}</td>
    <td><div class="row-actions">
      ${item.status === 'draft' ? `<button class="success-btn" onclick="publishAppRelease(${Number(item.id)})">发布</button>` : ''}
      ${item.status !== 'withdrawn' ? `<button class="danger-btn" onclick="withdrawAppRelease(${Number(item.id)})">撤回</button>` : ''}
    </div></td>
  </tr>`;
}

function formatFileSize(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
}

function formatAdminTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
}

async function createAppRelease(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.getElementById('release-submit');
  const status = document.getElementById('release-upload-status');
  const fields = new FormData(form);
  const file = fields.get('package');
  let sessionToken = '';
  submit.disabled = true;
  submit.textContent = '准备上传……';
  if (status) {
    status.hidden = false;
    status.textContent = '正在计算安装包校验值……';
  }
  try {
    if (!(file instanceof File) || file.size <= 0) throw new Error('请选择安装包');
    if (!window.crypto?.subtle) throw new Error('当前浏览器不支持安全文件校验，请升级浏览器后重试');

    const digestPromise = crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const initialized = await adminFetch('/app-releases/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: fields.get('platform'),
        version_name: fields.get('version_name'),
        build_number: fields.get('build_number'),
        update_mode: fields.get('update_mode'),
        release_notes: fields.get('release_notes'),
        package_name: file.name,
        package_size: file.size,
        content_type: file.type || 'application/octet-stream',
      }),
    });
    if (initialized.code !== 200) throw new Error(initialized.message || '无法创建上传会话');
    sessionToken = initialized.data.session_token;
    const partSize = Number(initialized.data.part_size);
    const partCount = Number(initialized.data.part_count);
    const parts = new Array(partCount);
    let nextPart = 0;
    let completedBytes = 0;

    async function uploadWorker() {
      while (nextPart < partCount) {
        const index = nextPart++;
        const number = index + 1;
        const start = index * partSize;
        const end = Math.min(start + partSize, file.size);
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const signed = await adminFetch(`/app-releases/uploads/${sessionToken}/part-url`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ part_number: number }),
            });
            if (signed.code !== 200) throw new Error(signed.message || `无法上传第 ${number} 个分片`);
            const response = await fetch(signed.data.upload_url, {
              method: 'PUT',
              body: file.slice(start, end),
            });
            if (!response.ok) throw new Error(`第 ${number} 个分片上传失败（HTTP ${response.status}）`);
            const etag = response.headers.get('etag');
            if (!etag) throw new Error('OSS 响应未暴露 ETag');
            parts[index] = { number, etag };
            completedBytes += end - start;
            const percent = Math.min(100, completedBytes / file.size * 100).toFixed(1);
            submit.textContent = `正在上传 ${percent}%`;
            if (status) status.textContent = `正在直传 OSS · ${percent}%（${number}/${partCount}）`;
            lastError = null;
            break;
          } catch (error) {
            try {
              if (status) status.textContent = `OSS 直传不可用，正在通过服务器上传第 ${number}/${partCount} 个分片……`;
              const proxied = await adminFetch(`/app-releases/uploads/${sessionToken}/parts/${number}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file.slice(start, end),
                timeoutMs: 180000,
              });
              if (proxied.code !== 200 || !proxied.data?.etag) {
                throw new Error(proxied.message || `第 ${number} 个分片服务器上传失败`);
              }
              parts[index] = { number, etag: proxied.data.etag };
              completedBytes += end - start;
              const percent = Math.min(100, completedBytes / file.size * 100).toFixed(1);
              submit.textContent = `正在上传 ${percent}%`;
              if (status) status.textContent = `正在通过服务器上传 · ${percent}%（${number}/${partCount}）`;
              lastError = null;
              break;
            } catch (proxyError) {
              lastError = new Error(
                `第 ${number} 个分片上传失败：${proxyError.message || error.message || '网络错误'}`
              );
            }
          }
        }
        if (lastError) throw lastError;
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, partCount) }, uploadWorker));
    submit.textContent = '正在确认版本……';
    if (status) status.textContent = '安装包上传完成，正在确认版本信息……';
    const digest = Array.from(new Uint8Array(await digestPromise), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const completed = await adminFetch(`/app-releases/uploads/${sessionToken}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256: digest, parts }),
      timeoutMs: 60000,
    });
    if (completed.code !== 200) throw new Error(completed.message || '版本确认失败');
    sessionToken = '';
    toast(completed.message || '版本草稿已创建');
    form.reset();
    toggleReleaseForm(false);
    await loadAppReleases();
  } catch (e) {
    if (sessionToken) {
      await adminFetch(`/app-releases/uploads/${sessionToken}`, { method: 'DELETE' }).catch(() => {});
    }
    toast(e.message || '版本上传失败');
    if (status) status.textContent = e.message || '版本上传失败';
  } finally {
    submit.disabled = false;
    submit.textContent = '上传并保存草稿';
  }
}

async function publishAppRelease(id) {
  if (!confirm('确定发布该版本？发布后桌面软件将能检查到它。')) return;
  const j = await adminFetch(`/app-releases/${id}/publish`, { method: 'POST' });
  if (j.code !== 200) return toast(j.message || '发布失败');
  toast(j.message || '版本已发布');
  loadAppReleases();
}

async function withdrawAppRelease(id) {
  if (!confirm('确定撤回该版本？撤回后客户端不再获取它。')) return;
  const j = await adminFetch(`/app-releases/${id}/withdraw`, { method: 'POST' });
  if (j.code !== 200) return toast(j.message || '撤回失败');
  toast(j.message || '版本已撤回');
  loadAppReleases();
}

async function adminFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${token}` });
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 12000);
  const requestOptions = Object.assign({}, options);
  delete requestOptions.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${API}${path}`;
  let r;
  try {
    r = await fetch(url, Object.assign({}, requestOptions, { headers, signal: controller.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`接口请求超时：${url}`);
    throw new Error(`接口请求失败：${url}；${e.message || '请确认 API 地址和 HTTPS/跨域配置'}`);
  } finally {
    clearTimeout(timer);
  }
  const contentType = r.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await r.text();
    const brief = text.replace(/\s+/g, ' ').slice(0, 80);
    throw new Error(`接口返回非 JSON：${url}；请确认 admin 域名已反代 /api 到后端。${r.status} ${brief}`);
  }
  const j = await r.json();
  if (j.code === 401) {
    logout();
    throw new Error('登录已过期');
  }
  return j;
}

async function renderOverview() {
  document.getElementById('page-content').innerHTML = `
    <div class="stats" id="stats">
      ${statSkeleton('用户总数')}${statSkeleton('待审核账号')}${statSkeleton('今日新增')}${statSkeleton('小程序微信用户')}${statSkeleton('发布内容')}
    </div>
    <div class="placeholder">
      <h3>管理后台第一版</h3>
      <p>左侧菜单已经搭好。当前只有“用户管理”接入真实接口，其他功能会按模块逐步接入。</p>
    </div>
  `;
  try {
    const j = await adminFetch('/stats');
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const s = j.data || {};
    document.getElementById('stats').innerHTML = [
      statCard('用户总数', s.total_users),
      statCard('待审核账号', s.pending_users),
      statCard('今日新增', s.today_users),
      statCard('小程序微信用户', s.wechat_miniprogram_users),
      statCard('发布内容', s.total_notes),
    ].join('');
  } catch (e) {
    toast(e.message || '概览加载失败');
  }
}

function renderUsers() {
  document.getElementById('page-content').innerHTML = `
    ${userTabsHtml()}
    <div id="user-tab-content"></div>
  `;
  renderUserTabContent();
}

function userTabsHtml() {
  return `
    <div class="tabs">
      <button class="${userTab === 'accounts' ? 'active' : ''}" onclick="switchUserTab('accounts')">账号列表</button>
      <button class="${userTab === 'wechatAppeals' ? 'active' : ''}" onclick="switchUserTab('wechatAppeals')">异常绑定</button>
      <button class="${userTab === 'accountDeletions' ? 'active' : ''}" onclick="switchUserTab('accountDeletions')">注销账号</button>
    </div>
  `;
}

function switchUserTab(tab) {
  userTab = tab;
  page = 1;
  wechatAppealPage = 1;
  accountDeletionPage = 1;
  renderUsers();
}

function renderUserTabContent() {
  if (userTab === 'wechatAppeals') renderWechatBindingAppealsTab();
  else if (userTab === 'accountDeletions') renderAccountDeletionsTab();
  else renderUserAccountsTab();
}

function renderAccountDeletionsTab() {
  document.getElementById('user-tab-content').innerHTML = `
    <div class="toolbar">
      <input id="accountDeletionSearch" placeholder="搜索用户ID/昵称/手机号" onkeydown="if(event.key==='Enter')loadAccountDeletions(1)">
      <select id="accountDeletionRole" onchange="loadAccountDeletions(1)">
        <option value="">全部身份</option>
        <option value="owner">业主</option>
        <option value="designer">设计师</option>
        <option value="merchant">商家</option>
        <option value="project_manager">项目经理</option>
        <option value="project_supervisor">项目监理</option>
      </select>
      <button class="primary-btn" onclick="loadAccountDeletions(1)">查询</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>注销账号</h3>
          <p>记录用户注销时的账号和绑定信息，原始数据不脱敏展示。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>记录ID</th><th>原用户ID</th><th>手机号</th><th>昵称</th><th>身份</th>
            <th>城市</th><th>微信绑定</th><th>注册时间</th><th>注销时间</th>
          </tr></thead>
          <tbody id="account-deletion-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="account-deletion-page-info"></span>
        <button id="account-deletion-prev" onclick="loadAccountDeletions(accountDeletionPage-1)">‹ 上一页</button>
        <button id="account-deletion-next" onclick="loadAccountDeletions(accountDeletionPage+1)">下一页 ›</button>
      </div>
    </div>
  `;
  loadAccountDeletions(1);
}

async function loadAccountDeletions(p) {
  accountDeletionPage = Math.max(1, p || 1);
  const keyword = document.getElementById('accountDeletionSearch')?.value.trim() || '';
  const role = document.getElementById('accountDeletionRole')?.value || '';
  const params = new URLSearchParams({ page: accountDeletionPage, pageSize: 20 });
  if (keyword) params.set('keyword', keyword);
  if (role) params.set('role', role);
  const body = document.getElementById('account-deletion-body');
  body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/account-deletions?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const records = j.data.records || [];
    accountDeletionTotal = j.data.total || 0;
    body.innerHTML = records.map(accountDeletionRow).join('') ||
      '<tr><td colspan="9" style="text-align:center;color:#999;padding:32px;">暂无注销记录</td></tr>';
    const totalPages = Math.ceil(accountDeletionTotal / 20) || 1;
    document.getElementById('account-deletion-page-info').textContent = `共 ${accountDeletionTotal} 条 · ${accountDeletionPage}/${totalPages}`;
    document.getElementById('account-deletion-prev').disabled = accountDeletionPage <= 1;
    document.getElementById('account-deletion-next').disabled = accountDeletionPage >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function accountDeletionRow(item) {
  const roleSnapshots = parseJsonArray(item.roles_snapshot);
  const roles = normalizeRoles(
    roleSnapshots.map(snapshot => snapshot?.role).filter(Boolean),
    item.role
  );
  const identities = parseJsonArray(item.wechat_identities_snapshot);
  const wechat = identities.length
    ? identities.map(identity => `${esc(identity.platform || '-')}: ${esc(identity.openid || '-')}${identity.unionid ? `<div class="muted">UnionID: ${esc(identity.unionid)}</div>` : ''}`).join('<br>')
    : '-';
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td class="mono">${item.original_user_id}</td>
      <td>${esc(item.phone || '-')}</td>
      <td>${esc(item.nickname || '-')}</td>
      <td>${roles.map(role => `<span class="badge badge-${role}">${roleLabel(role)}</span>`).join('') || '-'}</td>
      <td>${esc(item.city || '-')}</td>
      <td>${wechat}</td>
      <td>${fmtTime(item.registered_at)}</td>
      <td>${fmtTime(item.deleted_at)}</td>
    </tr>
  `;
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function renderUserAccountsTab() {
  document.getElementById('user-tab-content').innerHTML = `
    <div class="toolbar">
      <input id="search" placeholder="搜索昵称/手机号" onkeydown="if(event.key==='Enter')loadUsers(1)">
      <select id="filterRole" onchange="loadUsers(1)">
        <option value="">全部身份</option>
        <option value="owner">业主</option>
        <option value="designer">设计师</option>
        <option value="merchant">商家</option>
        <option value="project_manager">项目经理</option>
        <option value="project_supervisor">项目监理</option>
      </select>
      <select id="filterStatus" onchange="loadUsers(1)">
        <option value="">全部审核状态</option>
        <option value="pending">待审核</option>
        <option value="approved">已通过</option>
        <option value="rejected">已驳回</option>
      </select>
      <button class="primary-btn" onclick="loadUsers(1)">查询</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>用户管理</h3>
          <p>新建账户、身份信息和账号审核都在这里处理。</p>
        </div>
        <button class="ghost-btn" onclick="quickPending()">只看待审核</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>手机号</th><th>昵称</th><th>身份</th><th>登录方式</th><th>审核状态</th>
              <th>城市</th><th>关注</th><th>获赞</th><th>最近设备</th><th>最近使用</th><th>注册时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="user-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="page-info"></span>
        <button id="btn-prev" onclick="loadUsers(page-1)">‹ 上一页</button>
        <button id="btn-next" onclick="loadUsers(page+1)">下一页 ›</button>
      </div>
    </div>
  `;
  loadUsers(1);
}

function renderWechatBindingAppealsTab() {
  document.getElementById('user-tab-content').innerHTML = `
    <div class="toolbar">
      <select id="wechatAppealStatus" onchange="loadWechatBindingAppeals(1)">
        <option value="">全部状态</option>
        <option value="pending">待处理</option>
        <option value="processing">处理中</option>
        <option value="resolved">已解决</option>
        <option value="rejected">已驳回</option>
      </select>
      <button class="primary-btn" onclick="loadWechatBindingAppeals(1)">查询</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>微信异常绑定</h3>
          <p>处理老账号同步微信时产生的账号占用、手机号冲突和换绑申请。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>提交用户</th><th>当前手机号</th><th>微信手机号</th><th>冲突类型</th>
              <th>冲突对象</th><th>状态</th><th>备注</th><th>提交时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="wechat-appeal-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="wechat-appeal-page-info"></span>
        <button id="wechat-appeal-prev" onclick="loadWechatBindingAppeals(wechatAppealPage-1)">‹ 上一页</button>
        <button id="wechat-appeal-next" onclick="loadWechatBindingAppeals(wechatAppealPage+1)">下一页 ›</button>
      </div>
    </div>
  `;
  loadWechatBindingAppeals(1);
}

async function loadUsers(p) {
  page = Math.max(1, p || 1);
  const kw = document.getElementById('search')?.value.trim() || '';
  const role = document.getElementById('filterRole')?.value || '';
  const adminStatus = document.getElementById('filterStatus')?.value || '';
  const params = new URLSearchParams({ page, pageSize: 20 });
  if (kw) params.set('keyword', kw);
  if (role) params.set('role', role);
  if (adminStatus) params.set('adminStatus', adminStatus);

  const body = document.getElementById('user-body');
  body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/users?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const users = j.data.users || [];
    total = j.data.total || 0;
    body.innerHTML = users.map(userRow).join('') ||
      '<tr><td colspan="11" style="text-align:center;color:#999;padding:32px;">暂无数据</td></tr>';
    const totalPages = Math.ceil(total / 20) || 1;
    document.getElementById('page-info').textContent = `共 ${total} 条 · ${page}/${totalPages}`;
    document.getElementById('btn-prev').disabled = page <= 1;
    document.getElementById('btn-next').disabled = page >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

async function loadWechatBindingAppeals(p) {
  wechatAppealPage = Math.max(1, p || 1);
  const status = document.getElementById('wechatAppealStatus')?.value || '';
  const params = new URLSearchParams({ page: wechatAppealPage, pageSize: 20 });
  if (status) params.set('status', status);

  const body = document.getElementById('wechat-appeal-body');
  body.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/wechat-binding-appeals?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const appeals = j.data.appeals || [];
    wechatAppealTotal = j.data.total || 0;
    body.innerHTML = appeals.map(wechatBindingAppealRow).join('') ||
      '<tr><td colspan="10" style="text-align:center;color:#999;padding:32px;">暂无异常绑定</td></tr>';
    const totalPages = Math.ceil(wechatAppealTotal / 20) || 1;
    document.getElementById('wechat-appeal-page-info').textContent = `共 ${wechatAppealTotal} 条 · ${wechatAppealPage}/${totalPages}`;
    document.getElementById('wechat-appeal-prev').disabled = wechatAppealPage <= 1;
    document.getElementById('wechat-appeal-next').disabled = wechatAppealPage >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function wechatBindingAppealRow(item) {
  const status = item.status || 'pending';
  const conflictUser = item.conflict_user_id
    ? `${esc(item.conflict_user_nickname || '用户')} / ${esc(item.conflict_user_phone || '-')}`
    : '-';
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td>
        <div class="share-title">${esc(item.user_nickname || '未知用户')}</div>
        <div class="muted">ID ${item.user_id} · ${esc(item.user_phone || '-')}</div>
      </td>
      <td>${esc(item.current_phone || '-')}</td>
      <td>${esc(item.wechat_phone || '-')}</td>
      <td>
        <span class="badge status-hidden">${wechatConflictLabel(item.conflict_type)}</span>
        <div class="muted">${esc(item.conflict_message || '-')}</div>
      </td>
      <td>${conflictUser}</td>
      <td><span class="badge status-${wechatAppealStatusClass(status)}">${wechatAppealStatusLabel(status)}</span></td>
      <td><div class="share-content">${esc(item.admin_note || '-')}</div></td>
      <td>${fmtTime(item.created_at)}</td>
      <td>
        <div class="row-actions">
          ${status !== 'processing' ? `<button class="action-btn" onclick="updateWechatBindingAppeal(${item.id}, 'processing')">处理中</button>` : ''}
          ${status !== 'resolved' ? `<button class="success-btn" onclick="updateWechatBindingAppeal(${item.id}, 'resolved')">已解决</button>` : ''}
          ${status !== 'rejected' ? `<button class="danger-btn" onclick="updateWechatBindingAppeal(${item.id}, 'rejected')">驳回</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

async function updateWechatBindingAppeal(id, status) {
  const note = prompt('请输入处理备注（可留空）', '');
  if (note === null) return;
  try {
    const j = await adminFetch(`/wechat-binding-appeals/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ status, admin_note: note }),
    });
    if (j.code === 200) {
      toast('异常绑定状态已更新');
      loadWechatBindingAppeals(wechatAppealPage);
    } else {
      toast(j.message || '操作失败');
    }
  } catch (e) {
    toast(e.message || '操作失败');
  }
}

function userRow(u) {
  const roles = normalizeRoles(u.roles, u.role);
  const status = u.admin_status || 'approved';
  return `
    <tr>
      <td class="mono">${u.id}</td>
      <td>${esc(u.phone)}</td>
      <td>${esc(u.nickname)}</td>
      <td>${roles.map(r => `<span class="badge badge-${r}">${roleLabel(r)}</span>`).join('')}</td>
      <td>${loginMethodCell(u)}</td>
      <td><span class="badge status-${status}">${statusLabel(status)}</span></td>
      <td>${esc(u.city) || '-'}</td>
      <td>${u.followers_count || 0}</td>
      <td>${u.likes_received || 0}</td>
      <td>${userDeviceCell(u)}</td>
      <td>${userClientCell(u)}</td>
      <td>${fmtMinute(u.created_at)}</td>
      <td>
        <div class="row-actions">
          ${status !== 'approved' ? `<button class="success-btn" onclick="reviewUser(${u.id}, 'approve')">通过</button>` : ''}
          ${status !== 'rejected' ? `<button class="danger-btn" onclick="reviewUser(${u.id}, 'reject')">驳回</button>` : ''}
          <button class="action-btn" onclick="openEdit(${u.id}, '${jsEsc(u.nickname)}', '${jsEsc(u.role)}', '${jsEsc(status)}')">编辑</button>
        </div>
      </td>
    </tr>
  `;
}

function userDeviceCell(u) {
  const model = [u.last_device_brand, u.last_device_model].filter(Boolean).join(' · ');
  const system = [u.last_os_name, u.last_os_version].filter(Boolean).join(' ');
  if (!model && !system) return '<span class="muted">暂无记录</span>';
  return `<strong>${esc(model || system)}</strong>${model && system ? `<div class="muted">${esc(system)}</div>` : ''}`;
}

function userClientCell(u) {
  const labels = { ios: 'iOS App', macos: 'macOS App', android: 'Android App', windows: 'Windows App', miniprogram: '微信小程序', web: 'Web' };
  if (!u.last_client_type && !u.last_client_at) return '<span class="muted">暂无记录</span>';
  const version = [u.last_app_version, u.last_build_number ? `(${u.last_build_number})` : ''].filter(Boolean).join(' ');
  return `<strong>${esc(labels[u.last_client_type] || u.last_client_type || '未知客户端')}${version ? ` · ${esc(version)}` : ''}</strong><div class="muted">${fmtMinute(u.last_client_at)}</div>`;
}

function loginMethodCell(u) {
  const hasWechat = Number(u.wechat_miniprogram_count || 0) > 0;
  const hasPassword = Boolean(Number(u.has_password || 0));
  const hasUnionid = Number(u.wechat_unionid_count || 0) > 0;
  const methods = [];
  if (hasWechat) methods.push('<span class="badge badge-wechat">微信小程序</span>');
  if (hasPassword) methods.push('<span class="badge badge-password">密码</span>');
  if (!methods.length) methods.push('<span class="muted">未设置</span>');
  const tips = [];
  if (hasWechat && u.wechat_miniprogram_last_login_at) {
    tips.push(`最近微信登录：${fmtTime(u.wechat_miniprogram_last_login_at)}`);
  }
  if (hasWechat) tips.push(hasUnionid ? 'UnionID 已同步' : 'UnionID 未获取');
  return `<div>${methods.join('')}</div>${tips.length ? `<div class="muted">${tips.map(esc).join(' · ')}</div>` : ''}`;
}

function quickPending() {
  document.getElementById('filterStatus').value = 'pending';
  loadUsers(1);
}

async function reviewUser(id, action) {
  const label = action === 'approve' ? '通过' : '驳回';
  if (!confirm(`确认${label}这个账号？`)) return;
  const j = await adminFetch(`/users/${id}/review`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ action }),
  });
  if (j.code === 200) {
    toast(`${label}成功`);
    loadUsers(page);
    if (activeMenu === 'overview') renderOverview();
  } else {
    toast(j.message || `${label}失败`);
  }
}

function openEdit(id, nick, role, status) {
  editingId = id;
  document.getElementById('edit-nickname').value = nick || '';
  document.getElementById('edit-role').value = role || 'owner';
  document.getElementById('edit-status').value = status || 'approved';
  document.getElementById('edit-modal').classList.add('show');
}

function closeModal() {
  document.getElementById('edit-modal').classList.remove('show');
  editingId = null;
}

async function saveUser() {
  const nickname = document.getElementById('edit-nickname').value.trim();
  const role = document.getElementById('edit-role').value;
  const admin_status = document.getElementById('edit-status').value;
  const j = await adminFetch(`/users/${editingId}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ nickname, role, admin_status }),
  });
  if (j.code === 200) {
    toast('保存成功');
    closeModal();
    loadUsers(page);
  } else {
    toast(j.message || '保存失败');
  }
}

function renderCompanies() {
  selectedCompanyId = null;
  document.getElementById('page-content').innerHTML = `
    ${companyTabsHtml()}
    <div id="company-tab-content"></div>
  `;
  renderCompanyTabContent();
}

function companyTabsHtml() {
  return `
    <div class="tabs">
      <button class="${companyTab === 'companies' ? 'active' : ''}" onclick="switchCompanyTab('companies')">公司管理</button>
      <button class="${companyTab === 'merchants' ? 'active' : ''}" onclick="switchCompanyTab('merchants')">商家管理</button>
    </div>
  `;
}

function switchCompanyTab(tab) {
  companyTab = tab;
  page = 1;
  selectedCompanyId = null;
  renderCompanies();
}

function renderCompanyTabContent() {
  if (companyTab === 'merchants') {
    renderMerchantManagement();
    return;
  }
  document.getElementById('company-tab-content').innerHTML = `
    <div class="toolbar">
      <input id="companySearch" placeholder="搜索公司/负责人/手机号" onkeydown="if(event.key==='Enter')loadCompanies(1)">
      <select id="companyStatus" onchange="loadCompanies(1)">
        <option value="">全部状态</option>
        <option value="draft">待审核</option>
        <option value="active">正常</option>
        <option value="suspended">停用</option>
        <option value="deleted">已删除</option>
      </select>
      <select id="companyVerificationStatus" onchange="loadCompanies(1)">
        <option value="">全部认证</option>
        <option value="unverified">未认证</option>
        <option value="pending">待审核</option>
        <option value="verified">已认证</option>
        <option value="rejected">已拒绝</option>
      </select>
      <button class="primary-btn" onclick="loadCompanies(1)">查询</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>公司管理</h3>
          <p>这里管理新市场旁路体系里的公司主体，不影响旧商家资料。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>公司</th><th>业务</th><th>负责人</th><th>城市/范围</th>
              <th>成员/项目</th><th>状态</th><th>认证</th><th>来源</th><th>更新时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="company-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="company-page-info"></span>
        <button id="company-btn-prev" onclick="loadCompanies(page-1)">‹ 上一页</button>
        <button id="company-btn-next" onclick="loadCompanies(page+1)">下一页 ›</button>
      </div>
    </div>
    <div id="company-detail"></div>
  `;
  loadCompanies(1);
}

function renderMerchantManagement() {
  document.getElementById('company-tab-content').innerHTML = `
    <div class="toolbar">
      <input id="merchantSearch" placeholder="搜索商家/用户/手机号" onkeydown="if(event.key==='Enter')loadMerchants(1)">
      <select id="verifiedMerchantStatus" onchange="loadMerchants(1)">
        <option value="">全部入驻状态</option>
        <option value="pending">待审核</option>
        <option value="approved">已通过</option>
        <option value="rejected">已拒绝</option>
        <option value="suspended">已暂停</option>
      </select>
      <select id="merchantCategoryGroup" onchange="loadMerchants(1)">
        <option value="">全部分类</option>
        <option value="建材">建材</option>
        <option value="家居">家居</option>
      </select>
      <button class="primary-btn" onclick="loadMerchants(1)">查询</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>商家管理</h3>
          <p>审核入驻商家状态，控制是否出现在 App 找商家。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>用户</th><th>店铺</th><th>分类</th><th>联系信息</th><th>商品</th>
              <th>入驻状态</th><th>到期时间</th><th>更新时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="merchant-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="merchant-page-info"></span>
        <button id="merchant-btn-prev" onclick="loadMerchants(page-1)">‹ 上一页</button>
        <button id="merchant-btn-next" onclick="loadMerchants(page+1)">下一页 ›</button>
      </div>
    </div>
  `;
  loadMerchants(1);
}

async function loadCompanies(p) {
  page = Math.max(1, p || 1);
  const kw = document.getElementById('companySearch')?.value.trim() || '';
  const status = document.getElementById('companyStatus')?.value || '';
  const verificationStatus = document.getElementById('companyVerificationStatus')?.value || '';
  const params = new URLSearchParams({ page, pageSize: 20 });
  if (kw) params.set('keyword', kw);
  if (status) params.set('status', status);
  if (verificationStatus) params.set('verificationStatus', verificationStatus);

  const body = document.getElementById('company-body');
  body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/companies?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    companies = j.data.companies || [];
    total = j.data.total || 0;
    body.innerHTML = companies.map(companyRow).join('') ||
      '<tr><td colspan="11" style="text-align:center;color:#999;padding:32px;">暂无公司</td></tr>';
    const totalPages = Math.ceil(total / 20) || 1;
    document.getElementById('company-page-info').textContent = `共 ${total} 条 · ${page}/${totalPages}`;
    document.getElementById('company-btn-prev').disabled = page <= 1;
    document.getElementById('company-btn-next').disabled = page >= totalPages;
    if (selectedCompanyId && companies.every(item => Number(item.id) !== Number(selectedCompanyId))) {
      document.getElementById('company-detail').innerHTML = '';
      selectedCompanyId = null;
    }
  } catch (e) {
    body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

async function loadMerchants(p) {
  page = Math.max(1, p || 1);
  const kw = document.getElementById('merchantSearch')?.value.trim() || '';
  const status = document.getElementById('verifiedMerchantStatus')?.value || '';
  const categoryGroup = document.getElementById('merchantCategoryGroup')?.value || '';
  const params = new URLSearchParams({ page, pageSize: 20 });
  if (kw) params.set('keyword', kw);
  if (status) params.set('status', status);
  if (categoryGroup) params.set('category_group', categoryGroup);

  const body = document.getElementById('merchant-body');
  body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/merchants?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    merchants = j.data.merchants || [];
    total = j.data.total || 0;
    body.innerHTML = merchants.map(merchantRow).join('') ||
      '<tr><td colspan="9" style="text-align:center;color:#999;padding:32px;">暂无商家</td></tr>';
    const totalPages = Math.ceil(total / 20) || 1;
    document.getElementById('merchant-page-info').textContent = `共 ${total} 条 · ${page}/${totalPages}`;
    document.getElementById('merchant-btn-prev').disabled = page <= 1;
    document.getElementById('merchant-btn-next').disabled = page >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function merchantRow(item) {
  const logo = item.logo_url
    ? `<img class="logo-thumb" src="${esc(item.logo_url)}" alt="logo">`
    : `<span class="logo-thumb">${esc((item.shop_name || item.nickname || '商').slice(0, 1))}</span>`;
  const categories = item.categories || [];
  return `
    <tr>
      <td>
        <div>${esc(item.nickname) || '-'}</div>
        <div class="muted mono">ID ${item.user_id} · ${esc(item.phone) || '-'}</div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          ${logo}
          <div>
            <div class="share-title">${esc(item.shop_name) || '<span class="muted">未填写店铺名</span>'}</div>
            <div class="muted">${esc(item.brand_intro) || '-'}</div>
          </div>
        </div>
      </td>
      <td>
        ${item.category_group ? `<span class="badge">${esc(item.category_group)}</span>` : '<span class="muted">未设置</span>'}
        <div>${categories.length ? categories.map(c => `<span class="badge">${esc(c)}</span>`).join('') : ''}</div>
      </td>
      <td>
        <div>${esc(item.contact_phone) || '-'}</div>
        <div class="muted">${esc(item.city || item.service_area) || '-'}</div>
      </td>
      <td class="muted">${item.product_count || 0}</td>
      <td><span class="badge status-${verifiedMerchantBadge(item.verified_status)}">${verifiedMerchantLabel(item.verified_status)}</span></td>
      <td>${item.verified_until ? fmtTime(item.verified_until) : '<span class="muted">长期</span>'}</td>
      <td>${fmtTime(item.profile_updated_at)}</td>
      <td>
        <div class="row-actions">
          ${item.verified_status !== 'approved' ? `<button class="success-btn" onclick="updateVerifiedMerchantStatus(${item.user_id}, 'approved')">通过</button>` : ''}
          ${item.verified_status !== 'pending' ? `<button class="action-btn" onclick="updateVerifiedMerchantStatus(${item.user_id}, 'pending')">待审</button>` : ''}
          ${item.verified_status !== 'rejected' ? `<button class="danger-btn" onclick="updateVerifiedMerchantStatus(${item.user_id}, 'rejected')">拒绝</button>` : ''}
          ${item.verified_status !== 'suspended' ? `<button class="danger-btn" onclick="updateVerifiedMerchantStatus(${item.user_id}, 'suspended')">暂停</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

async function updateVerifiedMerchantStatus(userId, status) {
  const label = verifiedMerchantLabel(status);
  let verifiedUntil = null;
  if (status === 'approved') {
    const value = prompt('入驻商家到期时间，可留空表示长期有效。格式：YYYY-MM-DD HH:mm:ss', '');
    if (value === null) return;
    verifiedUntil = value.trim();
  }
  if (!confirm(`确认将入驻状态改为“${label}”？`)) return;
  const j = await adminFetch(`/merchants/${userId}/verified-status`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ status, verified_until: verifiedUntil || null }),
  });
  if (j.code === 200) {
    toast('入驻状态已更新');
    await loadMerchants(page);
  } else {
    toast(j.message || '入驻状态更新失败');
  }
}

function companyRow(item) {
  const businesses = item.businesses || [];
  const logo = item.logo_url
    ? `<img class="logo-thumb" src="${esc(item.logo_url)}" alt="logo">`
    : `<span class="logo-thumb">${esc((item.name || '公').slice(0, 1))}</span>`;
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          ${logo}
          <div>
            <div class="share-title">${esc(item.name)}</div>
            <div class="muted">${esc(item.contact_phone) || '-'}</div>
          </div>
        </div>
      </td>
      <td>${businesses.length ? businesses.map(b => `<span class="badge">${esc(b.name)}</span>`).join('') : '<span class="muted">未设置</span>'}</td>
      <td>
        <div>${esc(item.owner_name) || '-'}</div>
        <div class="muted">${esc(item.owner_phone) || '-'}</div>
      </td>
      <td>
        <div>${esc(item.city) || '-'}</div>
        <div class="muted">${esc(item.service_area) || '-'}</div>
      </td>
      <td class="muted">成员 ${item.member_count || 0}<br>项目 ${item.project_count || 0}</td>
      <td><span class="badge status-${esc(item.status)}">${companyStatusLabel(item.status)}</span></td>
      <td><span class="badge ${companyVerificationClass(item.verification_status)}">${companyVerificationLabel(item.verification_status)}</span></td>
      <td><span class="badge">${companySourceLabel(item.source)}</span></td>
      <td>${fmtTime(item.updated_at || item.created_at)}</td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="loadCompanyDetail(${item.id})">详情</button>
          ${item.verification_status !== 'verified' ? `<button class="success-btn" onclick="updateCompanyVerificationStatus(${item.id}, 'verified')">认证通过</button>` : ''}
          ${item.verification_status !== 'rejected' ? `<button class="danger-btn" onclick="updateCompanyVerificationStatus(${item.id}, 'rejected')">拒绝认证</button>` : ''}
          ${item.status !== 'active' ? `<button class="success-btn" onclick="updateCompanyStatus(${item.id}, 'active')">${item.status === 'draft' ? '通过' : '启用'}</button>` : ''}
          ${item.status !== 'suspended' ? `<button class="danger-btn" onclick="updateCompanyStatus(${item.id}, 'suspended')">停用</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

async function loadCompanyDetail(id) {
  selectedCompanyId = id;
  const container = document.getElementById('company-detail');
  container.innerHTML = '<div class="card" style="margin-top:16px;"><div class="empty-editor">公司详情加载中...</div></div>';
  try {
    const j = await adminFetch(`/companies/${id}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const data = j.data || {};
    container.innerHTML = companyDetailHtml(data);
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    container.innerHTML = `<div class="card" style="margin-top:16px;"><div class="empty-editor" style="color:#b42318;">${esc(e.message || '详情加载失败')}</div></div>`;
  }
}

function companyDetailHtml(data) {
  const company = data.company || {};
  const businesses = data.businesses || [];
  const members = data.members || [];
  const projects = data.projects || [];
  return `
    <div class="card" style="margin-top:16px;">
      <div class="card-title">
        <div>
          <h3>${esc(company.name)} · 公司详情</h3>
          <p>公司信息、业务分类、成员和项目关联。</p>
        </div>
        <div class="row-actions">
          ${company.status !== 'active' ? `<button class="success-btn" onclick="updateCompanyStatus(${company.id}, 'active')">${company.status === 'draft' ? '审核通过' : '启用'}</button>` : ''}
          ${company.verification_status !== 'verified' ? `<button class="success-btn" onclick="updateCompanyVerificationStatus(${company.id}, 'verified')">认证通过</button>` : ''}
          ${company.verification_status !== 'pending' ? `<button class="action-btn" onclick="updateCompanyVerificationStatus(${company.id}, 'pending')">设为待审</button>` : ''}
          ${company.verification_status !== 'rejected' ? `<button class="danger-btn" onclick="updateCompanyVerificationStatus(${company.id}, 'rejected')">拒绝认证</button>` : ''}
          ${company.verification_status !== 'unverified' ? `<button class="action-btn" onclick="updateCompanyVerificationStatus(${company.id}, 'unverified')">取消认证</button>` : ''}
          ${company.status !== 'suspended' ? `<button class="danger-btn" onclick="updateCompanyStatus(${company.id}, 'suspended')">停用</button>` : ''}
          ${company.status !== 'deleted' ? `<button class="danger-btn" onclick="updateCompanyStatus(${company.id}, 'deleted')">标记删除</button>` : ''}
        </div>
      </div>
      <div class="detail-grid">
        ${detailCell('状态', `<span class="badge status-${esc(company.status)}">${companyStatusLabel(company.status)}</span>`)}
        ${detailCell('认证状态', `<span class="badge ${companyVerificationClass(company.verification_status)}">${companyVerificationLabel(company.verification_status)}</span>`)}
        ${detailCell('负责人', `${esc(company.owner_name) || '-'} ${company.owner_phone ? `· ${esc(company.owner_phone)}` : ''}`)}
        ${detailCell('城市 / 服务范围', `${esc(company.city) || '-'} / ${esc(company.service_area) || '-'}`)}
        ${detailCell('联系电话', esc(company.contact_phone) || '-')}
        ${detailCell('营业执照', company.license_url ? `<a href="${esc(company.license_url)}" target="_blank" rel="noopener">查看</a>` : '-')}
        ${detailCell('地址', esc(company.address) || '-')}
        ${detailCell('来源', companySourceLabel(company.source))}
      </div>
      <div style="padding:16px 18px;border-bottom:1px solid #edf0f3;">
        <div class="muted" style="margin-bottom:8px;">公司简介</div>
        <div class="detail-text" style="-webkit-line-clamp:unset;max-width:900px;">${esc(company.intro) || '暂无简介'}</div>
      </div>
      <div style="padding:16px 18px;border-bottom:1px solid #edf0f3;">
        <div class="muted" style="margin-bottom:8px;">业务分类</div>
        ${businesses.length ? businesses.map(b => `<span class="badge">${esc(b.parent_name)} / ${esc(b.name)}${b.is_primary ? ' · 主营' : ''}</span>`).join('') : '<span class="muted">暂无业务分类</span>'}
      </div>
      ${companyMembersHtml(members)}
      ${companyProjectsHtml(projects)}
    </div>
  `;
}

function detailCell(label, value) {
  return `<div class="detail-cell"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

function companyMembersHtml(members) {
  if (!members.length) {
    return '<div style="padding:16px 18px;border-bottom:1px solid #edf0f3;"><div class="muted">团队成员</div><p style="margin-top:8px;color:#667085;">暂无团队成员</p></div>';
  }
  return `
    <div class="table-wrap" style="border-bottom:1px solid #edf0f3;">
      <table>
        <thead><tr><th>成员</th><th>角色</th><th>职位</th><th>状态</th><th>加入时间</th></tr></thead>
        <tbody>
          ${members.map(m => `
            <tr>
              <td>
                <div>${esc(m.professional_name || m.display_name) || '-'}</div>
                <div class="muted">${esc(m.phone) || '-'}</div>
              </td>
              <td><span class="badge">${companyMemberRoleLabel(m.member_role)}</span></td>
              <td>${esc(m.title) || '-'}</td>
              <td><span class="badge status-${m.status === 'active' ? 'active' : 'hidden'}">${companyMemberStatusLabel(m.status)}</span></td>
              <td>${fmtTime(m.joined_at || m.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function companyProjectsHtml(projects) {
  if (!projects.length) {
    return '<div style="padding:16px 18px;"><div class="muted">参与项目</div><p style="margin-top:8px;color:#667085;">暂无项目关联</p></div>';
  }
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>项目ID</th><th>项目名称</th><th>参与角色</th><th>状态</th><th>关联时间</th></tr></thead>
        <tbody>
          ${projects.map(p => `
            <tr>
              <td class="mono">${p.project_id}</td>
              <td>${esc(p.project_name || p.project_code) || '-'}</td>
              <td><span class="badge">${projectParticipantRoleLabel(p.role_type)}</span></td>
              <td><span class="badge status-${p.status === 'active' ? 'active' : 'hidden'}">${projectParticipantStatusLabel(p.status)}</span></td>
              <td>${fmtTime(p.created_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function updateCompanyStatus(id, status) {
  const label = companyStatusLabel(status);
  if (!confirm(`确认将公司状态改为“${label}”？`)) return;
  const j = await adminFetch(`/companies/${id}/status`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ status }),
  });
  if (j.code === 200) {
    toast('公司状态已更新');
    await loadCompanies(page);
    if (selectedCompanyId) loadCompanyDetail(selectedCompanyId);
  } else {
    toast(j.message || '状态更新失败');
  }
}

async function updateCompanyVerificationStatus(id, status) {
  const label = companyVerificationLabel(status);
  if (!confirm(`确认将公司认证状态改为“${label}”？`)) return;
  const j = await adminFetch(`/companies/${id}/verification-status`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ verification_status: status }),
  });
  if (j.code === 200) {
    toast('公司认证状态已更新');
    await loadCompanies(page);
    if (selectedCompanyId) loadCompanyDetail(selectedCompanyId);
  } else {
    toast(j.message || '认证状态更新失败');
  }
}

function renderShares() {
  document.getElementById('page-content').innerHTML = `
    <div class="toolbar">
      <input id="shareSearch" placeholder="搜索标题/内容/作者/手机号" onkeydown="if(event.key==='Enter')loadShares(1)">
      <select id="shareSource" onchange="loadShares(1)">
        <option value="">全部来源</option>
        <option value="site_photos">工地美照</option>
        <option value="complaint">大家吐槽</option>
        <option value="question">问题汇总</option>
        <option value="good_item">好物推荐</option>
        <option value="inspiration">创意灵感</option>
        <option value="legacy">历史内容</option>
      </select>
      <select id="shareStatus" onchange="loadShares(1)">
        <option value="">全部状态</option>
        <option value="0">待审核</option>
        <option value="1">已通过</option>
        <option value="2">已驳回/隐藏</option>
      </select>
      <button class="primary-btn" onclick="loadShares(1)">查询</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>分享管理</h3>
          <p>展示装修圈公开内容，可对内容进行通过、驳回和隐藏处理。</p>
        </div>
        <button class="ghost-btn" onclick="quickPendingShares()">只看待审核</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>封面</th><th>内容</th><th>来源</th><th>作者</th><th>状态</th>
              <th>城市/风格</th><th>互动</th><th>发布时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="share-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="share-page-info"></span>
        <button id="share-btn-prev" onclick="loadShares(page-1)">‹ 上一页</button>
        <button id="share-btn-next" onclick="loadShares(page+1)">下一页 ›</button>
      </div>
    </div>
  `;
  loadShares(1);
}

async function loadShares(p) {
  page = Math.max(1, p || 1);
  const kw = document.getElementById('shareSearch')?.value.trim() || '';
  const sourceType = document.getElementById('shareSource')?.value || '';
  const status = document.getElementById('shareStatus')?.value || '';
  const params = new URLSearchParams({ page, pageSize: 20 });
  if (kw) params.set('keyword', kw);
  if (sourceType) params.set('sourceType', sourceType);
  if (status !== '') params.set('status', status);

  const body = document.getElementById('share-body');
  body.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/shares?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const shares = j.data.shares || [];
    total = j.data.total || 0;
    body.innerHTML = shares.map(shareRow).join('') ||
      '<tr><td colspan="10" style="text-align:center;color:#999;padding:32px;">暂无数据</td></tr>';
    const totalPages = Math.ceil(total / 20) || 1;
    document.getElementById('share-page-info').textContent = `共 ${total} 条 · ${page}/${totalPages}`;
    document.getElementById('share-btn-prev').disabled = page <= 1;
    document.getElementById('share-btn-next').disabled = page >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function shareRow(item) {
  const status = Number(item.status ?? 0);
  const cover = shareCover(item);
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td>${cover}</td>
      <td>
        <div class="share-title">${esc(item.title) || '-'}</div>
        <div class="share-content">${esc(item.content) || '-'}</div>
      </td>
      <td><span class="badge">${sourceLabel(item.source_type)}</span></td>
      <td>
        <div>${esc(item.author_name) || '-'}</div>
        <div class="muted">${esc(item.phone) || '-'}</div>
      </td>
      <td><span class="badge ${noteStatusClass(status)}">${noteStatusLabel(status)}</span></td>
      <td>
        <div>${esc(item.city) || '-'}</div>
        <div class="muted">${styleLabel(item.decoration_style)}</div>
      </td>
      <td class="muted">
        赞 ${item.likes_count || 0}<br>
        评 ${item.comments_count || 0} · 藏 ${item.collections_count || 0}
      </td>
      <td>${fmtTime(item.created_at)}</td>
      <td>
        <div class="row-actions">
          ${status !== 1 ? `<button class="success-btn" onclick="reviewShare(${item.id}, 'approve')">通过</button>` : ''}
          ${status !== 2 ? `<button class="danger-btn" onclick="reviewShare(${item.id}, 'reject')">驳回</button>` : ''}
          ${status !== 0 ? `<button class="action-btn" onclick="reviewShare(${item.id}, 'pending')">转待审</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

function shareCover(item) {
  if (item.cover_image) {
    return `<img class="cover-thumb" src="${esc(item.cover_image)}" alt="封面">`;
  }
  if (item.video_cover_url) {
    return `<span class="cover-thumb cover-video"><img class="cover-thumb" src="${esc(item.video_cover_url)}" alt="视频封面"></span>`;
  }
  if (item.video_url) {
    return `<span class="cover-thumb cover-video"><video class="cover-thumb" src="${esc(item.video_url)}" muted preload="metadata"></video></span>`;
  }
  return '<span class="cover-thumb">无图</span>';
}

function quickPendingShares() {
  document.getElementById('shareStatus').value = '0';
  loadShares(1);
}

async function reviewShare(id, action) {
  const labelMap = { approve: '通过', reject: '驳回', hide: '隐藏', pending: '转为待审核' };
  const label = labelMap[action] || '处理';
  if (!confirm(`确认${label}这条分享内容？`)) return;
  const j = await adminFetch(`/shares/${id}/review`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ action }),
  });
  if (j.code === 200) {
    toast(`${label}成功`);
    loadShares(page);
  } else {
    toast(j.message || `${label}失败`);
  }
}

function renderProjectTips() {
  document.getElementById('page-content').innerHTML = `
    <div class="toolbar">
      <select id="tipRoleFilter" onchange="handleTipRoleChange()">
        <option value="owner">业主</option>
        <option value="designer">设计师（占位）</option>
        <option value="project_manager">项目经理（占位）</option>
        <option value="project_supervisor">项目监理（占位）</option>
        <option value="merchant">商家（占位）</option>
      </select>
      <select id="tipTypeFilter" onchange="loadProjectTips()">
        <option value="">全部分类</option>
        <option value="general">装修贴士</option>
        <option value="function_intro">项目功能说明</option>
      </select>
      <select id="tipActiveFilter" onchange="loadProjectTips()">
        <option value="">全部状态</option>
        <option value="1">启用</option>
        <option value="0">停用</option>
      </select>
      <button class="primary-btn" onclick="loadProjectTips()">查询</button>
      <button class="ghost-btn" onclick="openTipModal()">新增日志信息</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>日志信息编辑</h3>
          <p>这里维护的内容会显示在 App 装修日志的信息轮播和项目功能说明里。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>分类</th><th>标题/内容</th><th>排序</th><th>状态</th><th>更新时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="project-tip-body"></tbody>
        </table>
      </div>
    </div>
  `;
  loadProjectTips();
}

function handleTipRoleChange() {
  const role = document.getElementById('tipRoleFilter')?.value || 'owner';
  const typeFilter = document.getElementById('tipTypeFilter');
  const activeFilter = document.getElementById('tipActiveFilter');
  const addButton = document.querySelector('#page-content .ghost-btn');
  const disabled = role !== 'owner';
  if (typeFilter) typeFilter.disabled = disabled;
  if (activeFilter) activeFilter.disabled = disabled;
  if (addButton) addButton.disabled = disabled;
  loadProjectTips();
}

async function loadProjectTips() {
  const role = document.getElementById('tipRoleFilter')?.value || 'owner';
  const type = document.getElementById('tipTypeFilter')?.value || '';
  const active = document.getElementById('tipActiveFilter')?.value || '';
  const body = document.getElementById('project-tip-body');
  if (role !== 'owner') {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">该身份的日志信息路径暂未接入，先预留位置。</td></tr>';
    return;
  }
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (active !== '') params.set('active', active);
  body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/project-tips?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    projectTips = j.data.tips || [];
    body.innerHTML = projectTips.map(projectTipRow).join('') ||
      '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">暂无日志信息</td></tr>';
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function projectTipRow(item) {
  const active = Number(item.is_active) === 1;
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td><span class="badge">${tipTypeLabel(item.type)}</span></td>
      <td>
        <div class="share-title">${esc(item.title)}</div>
        <div class="share-content">${esc(item.content)}</div>
      </td>
      <td>${item.sort_order || 0}</td>
      <td><span class="badge ${active ? 'status-approved' : 'status-hidden'}">${active ? '启用' : '停用'}</span></td>
      <td>${fmtTime(item.updated_at || item.created_at)}</td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="openTipModal(${item.id})">编辑</button>
          <button class="${active ? 'danger-btn' : 'success-btn'}" onclick="toggleProjectTip(${item.id}, ${active ? 0 : 1})">${active ? '停用' : '启用'}</button>
          <button class="danger-btn" onclick="deleteProjectTip(${item.id})">删除</button>
        </div>
      </td>
    </tr>
  `;
}

function openTipModal(id) {
  editingTipId = id || null;
  const current = projectTips.find(item => Number(item.id) === Number(id)) || {};
  document.getElementById('tip-modal-title').textContent = editingTipId ? '编辑日志信息' : '新增日志信息';
  document.getElementById('tip-type').value = current.type || 'general';
  document.getElementById('tip-title').value = current.title || '';
  document.getElementById('tip-content').value = current.content || '';
  document.getElementById('tip-sort').value = current.sort_order ?? 0;
  document.getElementById('tip-active').value = String(current.is_active ?? 1);
  document.getElementById('tip-modal').classList.add('show');
}

function closeTipModal() {
  document.getElementById('tip-modal').classList.remove('show');
  editingTipId = null;
}

async function saveProjectTip() {
  const payload = {
    type: document.getElementById('tip-type').value,
    title: document.getElementById('tip-title').value.trim(),
    content: document.getElementById('tip-content').value.trim(),
    sort_order: Number(document.getElementById('tip-sort').value || 0),
    is_active: Number(document.getElementById('tip-active').value),
  };
  if (!payload.title || !payload.content) return toast('标题和内容不能为空');
  const path = editingTipId ? `/project-tips/${editingTipId}` : '/project-tips';
  const method = editingTipId ? 'PUT' : 'POST';
  const j = await adminFetch(path, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (j.code === 200) {
    toast(editingTipId ? '日志信息已保存' : '日志信息已新增');
    closeTipModal();
    loadProjectTips();
  } else {
    toast(j.message || '保存失败');
  }
}

async function toggleProjectTip(id, active) {
  const current = projectTips.find(item => Number(item.id) === Number(id));
  if (!current) return toast('贴士不存在');
  const j = await adminFetch(`/project-tips/${id}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(Object.assign({}, current, { is_active: active })),
  });
  if (j.code === 200) {
    toast(active ? '日志信息已启用' : '日志信息已停用');
    loadProjectTips();
  } else {
    toast(j.message || '操作失败');
  }
}

async function deleteProjectTip(id) {
  if (!confirm('确认删除这条日志信息？删除后 App 不再展示。')) return;
  const j = await adminFetch(`/project-tips/${id}`, { method: 'DELETE' });
  if (j.code === 200) {
    toast('日志信息已删除');
    loadProjectTips();
  } else {
    toast(j.message || '删除失败');
  }
}

function renderSupportFeedback() {
  feedbackPage = 1;
  editingFaqId = null;
  document.getElementById('page-content').innerHTML = `
    <div class="card">
      <div class="card-title">
        <div>
          <h3>预设常见问题编辑</h3>
          <p>App 帮助与反馈页会读取这里启用的常见问题，最多允许配置 10 条。</p>
        </div>
        <button class="ghost-btn" id="faq-add-btn" onclick="startNewFaq()">新增常见问题</button>
      </div>
      <div class="toolbar" style="align-items:flex-start;">
        <input id="faq-question" placeholder="问题标题，最多 120 字" maxlength="120">
        <input id="faq-sort" type="number" placeholder="排序" value="0" style="max-width:110px;">
        <select id="faq-active" style="max-width:110px;">
          <option value="1">启用</option>
          <option value="0">停用</option>
        </select>
      </div>
      <div style="margin-bottom:12px;">
        <textarea id="faq-answer" rows="5" maxlength="2000" placeholder="答案内容，最多 2000 字" style="width:100%;box-sizing:border-box;border:1px solid #e5e7eb;border-radius:12px;padding:12px;font:inherit;resize:vertical;"></textarea>
      </div>
      <div class="row-actions" style="margin-bottom:12px;">
        <button class="primary-btn" onclick="saveHelpFaq()" id="faq-save-btn">保存常见问题</button>
        <button class="ghost-btn" onclick="resetFaqForm()">清空表单</button>
        <span id="faq-edit-hint" style="color:#6b7280;font-size:13px;">当前为新增状态</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>问题/答案</th><th>排序</th><th>状态</th><th>更新时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="help-faq-body"></tbody>
        </table>
      </div>
    </div>
    <div class="card" style="margin-top:16px;">
      <div class="card-title">
        <div>
          <h3>问题反馈设置</h3>
          <p>这里显示用户在 App 帮助与反馈页提交的问题、建议和异常反馈。</p>
        </div>
        <select id="feedbackStatusFilter" onchange="loadUserFeedback(1)">
          <option value="">全部状态</option>
          <option value="pending">待处理</option>
          <option value="reviewed">已处理</option>
          <option value="ignored">已忽略</option>
        </select>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>用户</th><th>反馈内容</th><th>状态</th><th>提交时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="user-feedback-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="feedback-page-info"></span>
        <button id="feedback-prev" onclick="loadUserFeedback(feedbackPage-1)">‹ 上一页</button>
        <button id="feedback-next" onclick="loadUserFeedback(feedbackPage+1)">下一页 ›</button>
      </div>
    </div>
  `;
  loadHelpFaqs();
  loadUserFeedback(1);
}

async function loadHelpFaqs() {
  const body = document.getElementById('help-faq-body');
  body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch('/help-faqs');
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    helpFaqs = j.data.faqs || [];
    const addButton = document.getElementById('faq-add-btn');
    if (addButton) {
      addButton.disabled = helpFaqs.length >= 10;
      addButton.textContent = helpFaqs.length >= 10 ? '已达 10 条上限' : `新增常见问题（${helpFaqs.length}/10）`;
    }
    body.innerHTML = helpFaqs.map(helpFaqRow).join('') ||
      '<tr><td colspan="6" style="text-align:center;color:#999;padding:32px;">暂无常见问题</td></tr>';
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function helpFaqRow(item) {
  const active = Number(item.is_active) === 1;
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td>
        <div class="share-title">${esc(item.question)}</div>
        <div class="share-content">${esc(item.answer)}</div>
      </td>
      <td>${item.sort_order || 0}</td>
      <td><span class="badge ${active ? 'status-approved' : 'status-hidden'}">${active ? '启用' : '停用'}</span></td>
      <td>${fmtTime(item.updated_at || item.created_at)}</td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="editHelpFaq(${item.id})">编辑</button>
          <button class="${active ? 'danger-btn' : 'success-btn'}" onclick="toggleHelpFaq(${item.id}, ${active ? 0 : 1})">${active ? '停用' : '启用'}</button>
          <button class="danger-btn" onclick="deleteHelpFaq(${item.id})">删除</button>
        </div>
      </td>
    </tr>
  `;
}

function startNewFaq() {
  if (helpFaqs.length >= 10) return toast('常见问题最多只能添加 10 条');
  resetFaqForm();
  document.getElementById('faq-question').focus();
}

function editHelpFaq(id) {
  const current = helpFaqs.find(item => Number(item.id) === Number(id));
  if (!current) return toast('常见问题不存在');
  editingFaqId = current.id;
  document.getElementById('faq-question').value = current.question || '';
  document.getElementById('faq-answer').value = current.answer || '';
  document.getElementById('faq-sort').value = current.sort_order ?? 0;
  document.getElementById('faq-active').value = String(current.is_active ?? 1);
  document.getElementById('faq-edit-hint').textContent = `正在编辑 ID ${current.id}`;
  document.getElementById('faq-save-btn').textContent = '保存修改';
  document.getElementById('faq-question').focus();
}

function resetFaqForm() {
  editingFaqId = null;
  const question = document.getElementById('faq-question');
  const answer = document.getElementById('faq-answer');
  const sort = document.getElementById('faq-sort');
  const active = document.getElementById('faq-active');
  if (question) question.value = '';
  if (answer) answer.value = '';
  if (sort) sort.value = '0';
  if (active) active.value = '1';
  const hint = document.getElementById('faq-edit-hint');
  if (hint) hint.textContent = '当前为新增状态';
  const save = document.getElementById('faq-save-btn');
  if (save) save.textContent = '保存常见问题';
}

async function saveHelpFaq() {
  if (!editingFaqId && helpFaqs.length >= 10) return toast('常见问题最多只能添加 10 条');
  const saveButton = document.getElementById('faq-save-btn');
  const payload = {
    question: document.getElementById('faq-question').value.trim(),
    answer: document.getElementById('faq-answer').value.trim(),
    sort_order: Number(document.getElementById('faq-sort').value || 0),
    is_active: Number(document.getElementById('faq-active').value),
  };
  if (!payload.question || !payload.answer) return toast('问题和答案不能为空');
  const path = editingFaqId ? `/help-faqs/${editingFaqId}` : '/help-faqs';
  const method = editingFaqId ? 'PUT' : 'POST';
  const wasEditing = Boolean(editingFaqId);
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中...';
  }
  try {
    const j = await adminFetch(path, {
      method,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    if (j.code === 200) {
      toast(wasEditing ? '常见问题已保存' : '常见问题已新增');
      resetFaqForm();
      loadHelpFaqs();
    } else {
      toast(j.message || '保存失败');
    }
  } catch (e) {
    toast(e.message || '保存失败');
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = editingFaqId ? '保存修改' : '保存常见问题';
    }
  }
}

async function toggleHelpFaq(id, active) {
  const current = helpFaqs.find(item => Number(item.id) === Number(id));
  if (!current) return toast('常见问题不存在');
  try {
    const j = await adminFetch(`/help-faqs/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(Object.assign({}, current, { is_active: active })),
    });
    if (j.code === 200) {
      toast(active ? '常见问题已启用' : '常见问题已停用');
      loadHelpFaqs();
    } else {
      toast(j.message || '操作失败');
    }
  } catch (e) {
    toast(e.message || '操作失败');
  }
}

async function deleteHelpFaq(id) {
  if (!confirm('确认删除这条常见问题？删除后 App 不再展示。')) return;
  try {
    const j = await adminFetch(`/help-faqs/${id}`, { method: 'DELETE' });
    if (j.code === 200) {
      toast('常见问题已删除');
      if (Number(editingFaqId) === Number(id)) resetFaqForm();
      loadHelpFaqs();
    } else {
      toast(j.message || '删除失败');
    }
  } catch (e) {
    toast(e.message || '删除失败');
  }
}

async function loadUserFeedback(p) {
  feedbackPage = Math.max(1, p || 1);
  const status = document.getElementById('feedbackStatusFilter')?.value || '';
  const params = new URLSearchParams({ page: feedbackPage, pageSize: 20 });
  if (status) params.set('status', status);
  const body = document.getElementById('user-feedback-body');
  body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/user-feedback?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const list = j.data.feedback || [];
    feedbackTotal = j.data.total || 0;
    body.innerHTML = list.map(userFeedbackRow).join('') ||
      '<tr><td colspan="6" style="text-align:center;color:#999;padding:32px;">暂无反馈</td></tr>';
    const totalPages = Math.ceil(feedbackTotal / 20) || 1;
    document.getElementById('feedback-page-info').textContent = `共 ${feedbackTotal} 条 · ${feedbackPage}/${totalPages}`;
    document.getElementById('feedback-prev').disabled = feedbackPage <= 1;
    document.getElementById('feedback-next').disabled = feedbackPage >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function userFeedbackRow(item) {
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td>
        <div class="share-title">${esc(item.nickname || '未知用户')}</div>
        <div class="share-content">${esc(item.phone || item.contact || '-')}</div>
      </td>
      <td><div class="share-content">${esc(item.content)}</div></td>
      <td><span class="badge status-${item.status || 'pending'}">${feedbackStatusLabel(item.status)}</span></td>
      <td>${fmtTime(item.created_at)}</td>
      <td>
        <div class="row-actions">
          <button class="success-btn" onclick="updateUserFeedback(${item.id}, 'reviewed')">标记已处理</button>
          <button class="danger-btn" onclick="updateUserFeedback(${item.id}, 'ignored')">忽略</button>
        </div>
      </td>
    </tr>
  `;
}

function feedbackStatusLabel(status) {
  return { pending: '待处理', reviewed: '已处理', ignored: '已忽略' }[status] || '待处理';
}

async function updateUserFeedback(id, status) {
  try {
    const j = await adminFetch(`/user-feedback/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ status }),
    });
    if (j.code === 200) {
      toast('反馈状态已更新');
      loadUserFeedback(feedbackPage);
    } else {
      toast(j.message || '操作失败');
    }
  } catch (e) {
    toast(e.message || '操作失败');
  }
}

function renderInspectionTemplates() {
  selectedInspectionTemplateId = null;
  document.getElementById('page-content').innerHTML = `
    <div class="toolbar">
      <select id="inspectionStage" onchange="loadInspectionTemplates()">
        <option value="">全部阶段</option>
        <option value="3">水电隐蔽</option>
        <option value="4">泥瓦防水</option>
        <option value="5">木工/吊顶/柜体</option>
        <option value="6">油漆墙面</option>
        <option value="8">竣工总验</option>
      </select>
      <select id="inspectionActive" onchange="loadInspectionTemplates()">
        <option value="">全部状态</option>
        <option value="1">启用</option>
        <option value="0">停用</option>
      </select>
      <button class="primary-btn" onclick="loadInspectionTemplates()">查询</button>
      <button class="ghost-btn" onclick="createInspectionTemplate()">新增模板</button>
    </div>
    <div class="stack">
      <div class="card">
        <div class="card-title">
          <div>
            <h3>验收模板</h3>
            <p>用于按项目阶段自动推荐验收内容，后续也会给大模型做标准依据。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>模板</th><th>阶段</th><th>依据/工具</th><th>检查项</th><th>状态</th><th>操作</th>
              </tr>
            </thead>
            <tbody id="inspection-template-body"></tbody>
          </table>
        </div>
      </div>
      <div id="inspection-item-panel"></div>
    </div>
  `;
  loadInspectionTemplates();
}

async function loadInspectionTemplates() {
  const stageId = document.getElementById('inspectionStage')?.value || '';
  const active = document.getElementById('inspectionActive')?.value || '';
  const params = new URLSearchParams();
  if (stageId) params.set('stageId', stageId);
  if (active !== '') params.set('active', active);
  const body = document.getElementById('inspection-template-body');
  if (body) body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/inspection-templates?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    inspectionTemplates = j.data.templates || [];
    body.innerHTML = inspectionTemplates.map(inspectionTemplateRow).join('') ||
      '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">暂无模板</td></tr>';
    if (!selectedInspectionTemplateId) {
      document.getElementById('inspection-item-panel').innerHTML = '';
    }
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function inspectionTemplateRow(item) {
  const active = Number(item.is_active) === 1;
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td>
        <div class="share-title">${esc(item.title)}</div>
        <div class="muted">${esc(item.code)} · ${esc(item.node_type || 'stage')}</div>
        <div class="detail-text">${esc(item.description) || '-'}</div>
      </td>
      <td><span class="badge">${inspectionStageLabel(item.stage_id)}</span></td>
      <td>
        <div class="detail-text">${esc(item.standard_basis) || '-'}</div>
        <div class="muted">${listLabel(item.recommended_tools)}</div>
      </td>
      <td>
        <div>${item.item_count || 0} 项</div>
        <div class="muted">必须 ${item.must_count || 0} · 重点 ${item.important_count || 0}</div>
      </td>
      <td><span class="badge ${active ? 'status-approved' : 'status-hidden'}">${active ? '启用' : '停用'}</span></td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="loadInspectionTemplateItems(${item.id})">检查项</button>
          <button class="action-btn" onclick="editInspectionTemplate(${item.id})">编辑</button>
          <button class="${active ? 'danger-btn' : 'success-btn'}" onclick="toggleInspectionTemplate(${item.id}, ${active ? 0 : 1})">${active ? '停用' : '启用'}</button>
        </div>
      </td>
    </tr>
  `;
}

async function loadInspectionTemplateItems(templateId) {
  selectedInspectionTemplateId = templateId;
  const panel = document.getElementById('inspection-item-panel');
  const template = inspectionTemplates.find(item => Number(item.id) === Number(templateId));
  panel.innerHTML = `
    <div class="card item-panel">
      <div class="card-title">
        <div>
          <h3>${esc(template?.title || '检查项')}</h3>
          <p>每条检查项会成为用户验收时的核对内容。</p>
        </div>
        <button class="ghost-btn" onclick="createInspectionItem(${templateId})">新增检查项</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>检查项</th><th>标准/方法</th><th>工具</th><th>风险</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="inspection-item-body">
            <tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
  try {
    const j = await adminFetch(`/inspection-templates/${templateId}/items`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    inspectionItems = j.data.items || [];
    document.getElementById('inspection-item-body').innerHTML = inspectionItems.map(inspectionItemRow).join('') ||
      '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">暂无检查项</td></tr>';
  } catch (e) {
    document.getElementById('inspection-item-body').innerHTML =
      `<tr><td colspan="7" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function inspectionItemRow(item) {
  const active = Number(item.is_active) === 1;
  return `
    <tr>
      <td class="mono">${item.id}</td>
      <td>
        <div class="share-title">${esc(item.title)}</div>
        <div class="muted">${esc(item.code)} · 排序 ${item.sort_order || 0}</div>
      </td>
      <td>
        <div class="detail-text">${esc(item.standard_text) || '-'}</div>
        <div class="muted">${esc(item.check_method) || '-'}</div>
        <div class="muted">${esc(item.failure_action) || '-'}</div>
      </td>
      <td>${listLabel(item.required_tools)}</td>
      <td>
        <span class="badge ${riskClass(item.risk_level)}">${riskLabel(item.risk_level)}</span>
        ${Number(item.require_photo) === 1 ? '<span class="badge status-pending">需拍照</span>' : ''}
      </td>
      <td><span class="badge ${active ? 'status-approved' : 'status-hidden'}">${active ? '启用' : '停用'}</span></td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="editInspectionItem(${item.id})">编辑</button>
          <button class="${active ? 'danger-btn' : 'success-btn'}" onclick="toggleInspectionItem(${item.id}, ${active ? 0 : 1})">${active ? '停用' : '启用'}</button>
        </div>
      </td>
    </tr>
  `;
}

async function createInspectionTemplate() {
  const payload = readInspectionTemplateInput({});
  if (!payload) return;
  const j = await adminFetch('/inspection-templates', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (j.code === 200) {
    toast('模板已新增');
    loadInspectionTemplates();
  } else {
    toast(j.message || '新增失败');
  }
}

async function editInspectionTemplate(id) {
  const current = inspectionTemplates.find(item => Number(item.id) === Number(id));
  if (!current) return toast('模板不存在');
  const payload = readInspectionTemplateInput(current);
  if (!payload) return;
  const j = await adminFetch(`/inspection-templates/${id}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (j.code === 200) {
    toast('模板已保存');
    loadInspectionTemplates();
  } else {
    toast(j.message || '保存失败');
  }
}

async function toggleInspectionTemplate(id, active) {
  const current = inspectionTemplates.find(item => Number(item.id) === Number(id));
  if (!current) return toast('模板不存在');
  const j = await adminFetch(`/inspection-templates/${id}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(Object.assign({}, current, { is_active: active })),
  });
  if (j.code === 200) {
    toast(active ? '模板已启用' : '模板已停用');
    loadInspectionTemplates();
  } else {
    toast(j.message || '操作失败');
  }
}

async function createInspectionItem(templateId) {
  const payload = readInspectionItemInput({});
  if (!payload) return;
  const j = await adminFetch(`/inspection-templates/${templateId}/items`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (j.code === 200) {
    toast('检查项已新增');
    loadInspectionTemplateItems(templateId);
    loadInspectionTemplates();
  } else {
    toast(j.message || '新增失败');
  }
}

async function editInspectionItem(id) {
  const current = inspectionItems.find(item => Number(item.id) === Number(id));
  if (!current) return toast('检查项不存在');
  const payload = readInspectionItemInput(current);
  if (!payload) return;
  const j = await adminFetch(`/inspection-template-items/${id}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (j.code === 200) {
    toast('检查项已保存');
    loadInspectionTemplateItems(selectedInspectionTemplateId);
    loadInspectionTemplates();
  } else {
    toast(j.message || '保存失败');
  }
}

async function toggleInspectionItem(id, active) {
  const current = inspectionItems.find(item => Number(item.id) === Number(id));
  if (!current) return toast('检查项不存在');
  const j = await adminFetch(`/inspection-template-items/${id}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(Object.assign({}, current, { is_active: active })),
  });
  if (j.code === 200) {
    toast(active ? '检查项已启用' : '检查项已停用');
    loadInspectionTemplateItems(selectedInspectionTemplateId);
    loadInspectionTemplates();
  } else {
    toast(j.message || '操作失败');
  }
}

function renderProgressLibrary() {
  document.getElementById('page-content').innerHTML = `
    <div class="progress-summary" id="progress-summary">
      ${miniStat('事项总数', '-')}${miniStat('默认加入', '-')}${miniStat('核心事项', '-')}${miniStat('需验收', '-')}
    </div>
    <div class="progress-admin">
      <aside class="stage-tree">
        <h3>固定阶段</h3>
        <div class="stage-list" id="progress-stage-list"></div>
      </aside>
      <section class="card">
        <div class="card-title">
          <div>
            <h3 id="progress-stage-title">统一事项库</h3>
            <p>维护固定阶段下的事项库、默认加入规则和验收提醒规则。</p>
          </div>
          <button class="ghost-btn" onclick="createProgressItem()">新增事项</button>
        </div>
        <div class="toolbar" style="padding:14px 16px 0;margin-bottom:10px;">
          <input id="progressKeyword" placeholder="搜索事项名称/说明" onkeydown="if(event.key==='Enter')renderProgressTable()">
          <select id="progressSource" onchange="renderProgressTable()">
            <option value="">全部来源</option>
            <option value="default">默认任务</option>
            <option value="recommendation">验收必看事项</option>
          </select>
          <select id="progressLevel" onchange="renderProgressTable()">
            <option value="">全部等级</option>
            <option value="core">核心</option>
            <option value="recommended">推荐</option>
            <option value="optional">可选</option>
            <option value="blank">未设置</option>
          </select>
          <select id="progressInspection" onchange="renderProgressTable()">
            <option value="">全部验收</option>
            <option value="1">需要验收</option>
            <option value="0">不需要验收</option>
            <option value="blank">未设置</option>
          </select>
          <button class="primary-btn" onclick="renderProgressTable()">查询</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>事项</th><th>来源</th><th>等级</th><th>默认加入</th><th>需验收</th><th>负责人</th><th>建议时机</th><th>状态</th>
              </tr>
            </thead>
            <tbody id="progress-item-body"></tbody>
          </table>
        </div>
      </section>
      <aside class="item-editor" id="progress-editor">
        <h3>事项编辑</h3>
        <div class="empty-editor">从中间表格选择一个事项，或点击新增事项。</div>
      </aside>
    </div>
  `;
  loadProgressLibrary();
}

async function loadProgressLibrary() {
  const stageList = document.getElementById('progress-stage-list');
  const body = document.getElementById('progress-item-body');
  if (stageList) stageList.innerHTML = '<div class="muted" style="padding:10px;">加载中...</div>';
  if (body) body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch('/progress-item-library');
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    progressStages = j.data.stages || [];
    progressItems = j.data.items || [];
    if (!progressStages.some(stage => Number(stage.id) === Number(selectedProgressStageId))) {
      selectedProgressStageId = progressStages[0]?.id || 1;
    }
    renderProgressSummary();
    renderProgressStages();
    renderProgressTable();
  } catch (e) {
    toast(e.message || '事项库加载失败');
    if (stageList) stageList.innerHTML = '<div class="muted" style="padding:10px;color:#b42318;">加载失败</div>';
    if (body) body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function renderProgressSummary() {
  const total = progressItems.length;
  const defaultCount = progressItems.filter(item => item.default_join).length;
  const coreCount = progressItems.filter(item => item.required_level === 'core' || item.is_key_node).length;
  const inspectionCount = progressItems.filter(item => item.requires_inspection === true).length;
  const el = document.getElementById('progress-summary');
  if (!el) return;
  el.innerHTML = [
    miniStat('事项总数', total),
    miniStat('默认加入', defaultCount),
    miniStat('核心事项', coreCount),
    miniStat('需验收', inspectionCount),
  ].join('');
}

function renderProgressStages() {
  const el = document.getElementById('progress-stage-list');
  if (!el) return;
  el.innerHTML = progressStages.map(stage => {
    const count = progressItems.filter(item => Number(item.stage_id) === Number(stage.id)).length;
    return `
      <button class="stage-node ${Number(stage.id) === Number(selectedProgressStageId) ? 'active' : ''}" onclick="selectProgressStage(${stage.id})">
        <span>${esc(stage.name)}</span>
        <small>${count}</small>
      </button>
    `;
  }).join('');
}

function selectProgressStage(stageId) {
  selectedProgressStageId = Number(stageId);
  selectedProgressItemKey = '';
  renderProgressStages();
  renderProgressTable();
  renderProgressEditor(null);
}

function filteredProgressItems() {
  const keyword = document.getElementById('progressKeyword')?.value.trim().toLowerCase() || '';
  const source = document.getElementById('progressSource')?.value || '';
  const level = document.getElementById('progressLevel')?.value || '';
  const inspection = document.getElementById('progressInspection')?.value || '';
  return progressItems.filter(item => {
    if (Number(item.stage_id) !== Number(selectedProgressStageId)) return false;
    if (source && item.source !== source) return false;
    if (level === 'blank' && item.required_level) return false;
    if (level && level !== 'blank' && item.required_level !== level) return false;
    if (inspection === '1' && item.requires_inspection !== true) return false;
    if (inspection === '0' && item.requires_inspection !== false) return false;
    if (inspection === 'blank' && item.requires_inspection !== null) return false;
    if (keyword) {
      const haystack = `${item.title || ''} ${item.description || ''} ${item.suggested_timing || ''}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
  return progressTreeItems(items);
}

function progressTreeItems(items) {
  const byKey = new Map(items.map(item => [item.template_key, item]));
  return [...items].sort((a, b) => {
    const aParent = a.parent_template_key ? byKey.get(a.parent_template_key) : null;
    const bParent = b.parent_template_key ? byKey.get(b.parent_template_key) : null;
    const aRootSort = Number((aParent || a).sort_order || 0);
    const bRootSort = Number((bParent || b).sort_order || 0);
    if (aRootSort !== bRootSort) return aRootSort - bRootSort;
    if (!a.parent_template_key && b.parent_template_key === a.template_key) return -1;
    if (!b.parent_template_key && a.parent_template_key === b.template_key) return 1;
    return Number(a.sort_order || 0) - Number(b.sort_order || 0);
  });
}

function renderProgressTable() {
  const stage = progressStages.find(item => Number(item.id) === Number(selectedProgressStageId));
  const title = document.getElementById('progress-stage-title');
  if (title) title.textContent = `${stage?.name || '阶段'} · 事项库`;
  const body = document.getElementById('progress-item-body');
  if (!body) return;
  const items = filteredProgressItems();
  body.innerHTML = items.map(progressItemRow).join('') ||
    '<tr><td colspan="8" style="text-align:center;color:#999;padding:32px;">当前筛选下暂无事项</td></tr>';
}

function progressItemRow(item) {
  const selected = item.template_key === selectedProgressItemKey;
  const isChild = Boolean(item.parent_template_key);
  return `
    <tr onclick="selectProgressItem('${jsEsc(item.template_key)}')" style="${selected ? 'outline:2px solid #4f6ef7;outline-offset:-2px;' : ''}">
      <td>
        <div class="tree-title ${isChild ? 'tree-child' : ''}">
          <strong>${esc(item.title)}</strong>
          <span class="muted mono">${esc(item.template_key)}${isChild ? ` · 父级：${esc(item.parent_title || item.parent_template_key)}` : ''}</span>
        </div>
      </td>
      <td>${progressSourceLabel(item.source)}</td>
      <td>${levelBadge(item.required_level)}</td>
      <td>${item.default_join ? '是' : '否'}</td>
      <td>${item.requires_inspection === null ? '-' : item.requires_inspection ? '是' : '否'}</td>
      <td>${roleLabel(item.default_responsible_role) || '-'}</td>
      <td>${esc(item.suggested_timing) || '-'}</td>
      <td><span class="badge ${item.is_active ? 'status-approved' : 'status-hidden'}">${item.is_active ? '启用' : '停用'}</span></td>
    </tr>
  `;
}

function selectProgressItem(key) {
  selectedProgressItemKey = key;
  const item = progressItems.find(row => row.template_key === key);
  renderProgressTable();
  renderProgressEditor(item);
}

function createProgressItem() {
  selectedProgressItemKey = '';
  const nextSort = Math.max(
    0,
    ...progressItems
      .filter(item => Number(item.stage_id) === Number(selectedProgressStageId))
      .map(item => Number(item.sort_order || 0))
  ) + 10;
  renderProgressTable();
  renderProgressEditor({
    template_key: '',
    stage_id: selectedProgressStageId,
    parent_template_key: '',
    title: '',
    required_level: 'recommended',
    source: 'recommendation',
    default_join: false,
    is_key_node: false,
    requires_inspection: false,
    inspection_template_key: '',
    default_responsible_role: '',
    suggested_timing: '',
    description: '',
    applicable_project_types: '',
    not_applicable_note: '',
    merge_status: '',
    sort_order: nextSort,
    is_active: 1,
  }, true);
}

function renderProgressEditor(item, isNew = false) {
  const el = document.getElementById('progress-editor');
  if (!el) return;
  if (!item) {
    el.innerHTML = '<h3>事项编辑</h3><div class="empty-editor">从中间表格选择一个事项，或点击新增事项。</div>';
    return;
  }
  el.innerHTML = `
    <h3>${isNew ? '新增事项' : '事项编辑'}</h3>
    <div class="editor-body">
      <div class="editor-note">默认加入会自动进入新项目进度；核心事项会在施工记录中重点提醒。</div>
      <div>
        <label>事项编码</label>
        <input id="progress-template-key" class="inline-edit" value="${attr(item.template_key || '')}" placeholder="可留空，新增时自动生成">
      </div>
      <div>
        <label>事项名称</label>
        <input id="progress-title" class="inline-edit" value="${attr(item.title)}">
      </div>
      <div class="form-grid">
        <div>
          <label>所属阶段</label>
          <select id="progress-stage-id">${progressStages.map(stage => `<option value="${stage.id}" ${Number(stage.id) === Number(item.stage_id) ? 'selected' : ''}>${esc(stage.name)}</option>`).join('')}</select>
        </div>
        <div>
          <label>父级事项</label>
          <select id="progress-parent-key">
            <option value="">无父级</option>
            ${progressParentOptions(item)}
          </select>
        </div>
      </div>
      <div class="form-grid">
        <div>
          <label>推荐等级</label>
          <select id="progress-required-level">
            <option value="" ${!item.required_level ? 'selected' : ''}>未设置</option>
            <option value="core" ${item.required_level === 'core' ? 'selected' : ''}>核心</option>
            <option value="recommended" ${item.required_level === 'recommended' ? 'selected' : ''}>推荐</option>
            <option value="optional" ${item.required_level === 'optional' ? 'selected' : ''}>可选</option>
          </select>
        </div>
        <div>
          <label>事项来源</label>
          <select id="progress-source-field">
            <option value="default" ${item.source === 'default' ? 'selected' : ''}>默认任务</option>
            <option value="recommendation" ${item.source !== 'default' ? 'selected' : ''}>验收必看</option>
          </select>
        </div>
      </div>
      <div class="form-grid">
        <div>
          <label>默认加入</label>
          <select id="progress-default-join">
            <option value="1" ${item.default_join ? 'selected' : ''}>是</option>
            <option value="0" ${!item.default_join ? 'selected' : ''}>否</option>
          </select>
        </div>
        <div>
          <label>关键节点</label>
          <select id="progress-key-node">
            <option value="1" ${item.is_key_node ? 'selected' : ''}>是</option>
            <option value="0" ${!item.is_key_node ? 'selected' : ''}>否</option>
          </select>
        </div>
      </div>
      <div class="form-grid">
        <div>
          <label>是否需要验收</label>
          <select id="progress-requires-inspection">
            <option value="0" ${!item.requires_inspection ? 'selected' : ''}>否</option>
            <option value="1" ${item.requires_inspection === true ? 'selected' : ''}>是</option>
          </select>
        </div>
        <div>
          <label>默认负责人</label>
          <select id="progress-responsible-role">
            ${['', 'owner', 'designer', 'project_manager', 'project_supervisor', 'merchant'].map(role => `<option value="${role}" ${item.default_responsible_role === role ? 'selected' : ''}>${role ? roleLabel(role) : '未设置'}</option>`).join('')}
          </select>
        </div>
      </div>
      <div>
        <label>验收模板编码</label>
        <input id="progress-inspection-template-key" value="${attr(item.inspection_template_key || '')}" placeholder="可为空">
      </div>
      <div>
        <label>建议时机</label>
        <input id="progress-suggested-timing" value="${attr(item.suggested_timing || '')}" placeholder="例如：封槽前、贴砖前">
      </div>
      <div>
        <label>事项说明</label>
        <textarea id="progress-description">${esc(item.description || '')}</textarea>
      </div>
      <div>
        <label>适用项目类型</label>
        <input id="progress-applicable-project-types" value="${attr(item.applicable_project_types || '')}" placeholder="例如：毛坯房,旧房,精装房">
      </div>
      <div>
        <label>不适用说明</label>
        <textarea id="progress-not-applicable-note">${esc(item.not_applicable_note || '')}</textarea>
      </div>
      <div class="form-grid">
        <div>
          <label>排序</label>
          <input id="progress-sort-order" type="number" value="${Number(item.sort_order || 0)}">
        </div>
        <div>
          <label>启用状态</label>
          <select id="progress-active">
            <option value="1" ${item.is_active ? 'selected' : ''}>启用</option>
            <option value="0" ${!item.is_active ? 'selected' : ''}>停用</option>
          </select>
        </div>
      </div>
      <button class="primary-btn" onclick="saveProgressItem(${isNew ? 'true' : 'false'}, '${jsEsc(item.template_key || '')}')">保存配置</button>
    </div>
  `;
}

function progressParentOptions(item) {
  return progressItems
    .filter(row =>
      Number(row.stage_id) === Number(item.stage_id) &&
      row.template_key &&
      row.template_key !== item.template_key &&
      !row.parent_template_key
    )
    .map(row => `<option value="${attr(row.template_key)}" ${item.parent_template_key === row.template_key ? 'selected' : ''}>${esc(row.title)}</option>`)
    .join('');
}

async function saveProgressItem(isNew, originalKey) {
  const payload = {
    template_key: document.getElementById('progress-template-key').value.trim(),
    title: document.getElementById('progress-title').value.trim(),
    stage_id: Number(document.getElementById('progress-stage-id').value),
    parent_template_key: document.getElementById('progress-parent-key').value,
    required_level: document.getElementById('progress-required-level').value,
    source: document.getElementById('progress-source-field').value,
    default_join: Number(document.getElementById('progress-default-join').value),
    is_key_node: Number(document.getElementById('progress-key-node').value),
    requires_inspection: Number(document.getElementById('progress-requires-inspection').value),
    inspection_template_key: document.getElementById('progress-inspection-template-key').value.trim(),
    default_responsible_role: document.getElementById('progress-responsible-role').value,
    suggested_timing: document.getElementById('progress-suggested-timing').value.trim(),
    description: document.getElementById('progress-description').value.trim(),
    applicable_project_types: document.getElementById('progress-applicable-project-types').value.trim(),
    not_applicable_note: document.getElementById('progress-not-applicable-note').value.trim(),
    sort_order: Number(document.getElementById('progress-sort-order').value || 0),
    is_active: Number(document.getElementById('progress-active').value),
  };
  if (!payload.title) return toast('事项名称不能为空');
  const path = isNew ? '/progress-item-library' : `/progress-item-library/${encodeURIComponent(originalKey)}`;
  const method = isNew ? 'POST' : 'PUT';
  try {
    const j = await adminFetch(path, {
      method,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    if (j.code === 200) {
      toast(isNew ? '事项已新增' : '事项已保存');
      selectedProgressStageId = payload.stage_id;
      selectedProgressItemKey = j.data?.template_key || payload.template_key || originalKey;
      await loadProgressLibrary();
      const item = progressItems.find(row => row.template_key === selectedProgressItemKey);
      renderProgressEditor(item);
    } else {
      toast(j.message || '保存失败');
    }
  } catch (e) {
    toast(e.message || '保存失败');
  }
}

function miniStat(label, value) {
  return `<div class="mini-stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function progressSourceLabel(source) {
  return source === 'default'
    ? '<span class="badge status-approved">默认任务</span>'
    : '<span class="badge status-pending">验收必看</span>';
}

function levelBadge(level) {
  if (level === 'core') return '<span class="badge status-rejected">核心</span>';
  if (level === 'recommended') return '<span class="badge status-approved">推荐</span>';
  if (level === 'optional') return '<span class="badge status-hidden">可选</span>';
  return '<span class="badge status-hidden">未设置</span>';
}

function readInspectionTemplateInput(current) {
  const title = prompt('模板名称', current.title || '');
  if (title === null) return null;
  const code = prompt('模板编码（英文/数字/下划线）', current.code || '');
  if (code === null) return null;
  const stageId = prompt('阶段ID：3水电 4泥瓦 5木工 6油漆 8竣工，可空', current.stage_id || '');
  if (stageId === null) return null;
  const description = prompt('模板说明', current.description || '');
  if (description === null) return null;
  const standardBasis = prompt('执行依据', current.standard_basis || '');
  if (standardBasis === null) return null;
  const tools = prompt('推荐工具，逗号或换行分隔', listLabel(current.recommended_tools, ''));
  if (tools === null) return null;
  const sortOrder = prompt('排序数字', current.sort_order || 0);
  if (sortOrder === null) return null;
  return {
    title,
    code,
    stage_id: stageId,
    node_type: current.node_type || 'stage',
    description,
    standard_basis: standardBasis,
    recommended_tools: tools,
    applicable_project_types: current.applicable_project_types || [],
    applicable_methods: current.applicable_methods || [],
    sort_order: Number(sortOrder || 0),
    is_active: current.is_active === undefined ? 1 : current.is_active,
  };
}

function readInspectionItemInput(current) {
  const title = prompt('检查项名称', current.title || '');
  if (title === null) return null;
  const code = prompt('检查项编码（英文/数字/下划线）', current.code || '');
  if (code === null) return null;
  const standardText = prompt('验收标准', current.standard_text || '');
  if (standardText === null) return null;
  const checkMethod = prompt('检查方法', current.check_method || '');
  if (checkMethod === null) return null;
  const tools = prompt('需要工具，逗号或换行分隔', listLabel(current.required_tools, ''));
  if (tools === null) return null;
  const riskLevel = prompt('风险等级：must / important / normal', current.risk_level || 'normal');
  if (riskLevel === null) return null;
  const failureAction = prompt('不合格处理建议', current.failure_action || '');
  if (failureAction === null) return null;
  const requirePhoto = confirm('是否要求拍照留存？');
  const sortOrder = prompt('排序数字', current.sort_order || 0);
  if (sortOrder === null) return null;
  return {
    title,
    code,
    standard_text: standardText,
    check_method: checkMethod,
    required_tools: tools,
    risk_level: riskLevel || 'normal',
    failure_action: failureAction,
    require_photo: requirePhoto ? 1 : 0,
    sort_order: Number(sortOrder || 0),
    is_active: current.is_active === undefined ? 1 : current.is_active,
  };
}

function renderPlaceholder(item) {
  document.getElementById('page-content').innerHTML = `
    <div class="placeholder">
      <h3>${esc(item.label)} · 功能占位</h3>
      <p>${esc(item.subtitle)}</p>
      <p style="margin-top:10px;">第一版先把入口和页面结构做好，后续再逐个接入真实接口。</p>
    </div>
  `;
}

function statSkeleton(label) {
  return `<div class="stat-card"><span>${label}</span><strong>-</strong></div>`;
}

function statCard(label, value) {
  return `<div class="stat-card"><span>${label}</span><strong>${Number(value || 0).toLocaleString('zh-CN')}</strong></div>`;
}

function normalizeRoles(raw, fallback) {
  if (Array.isArray(raw)) return raw.length ? raw : [fallback || 'owner'];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {}
  }
  return [fallback || 'owner'];
}

function roleLabel(role) {
  return {
    owner: '业主',
    designer: '设计师',
    merchant: '商家',
    project_manager: '项目经理',
    project_supervisor: '项目监理',
  }[role] || role;
}

function statusLabel(status) {
  return { pending: '待审核', approved: '已通过', rejected: '已驳回' }[status] || status;
}

function wechatAppealStatusLabel(status) {
  return {
    pending: '待处理',
    processing: '处理中',
    resolved: '已解决',
    rejected: '已驳回',
  }[status] || status || '-';
}

function wechatAppealStatusClass(status) {
  return {
    pending: 'pending',
    processing: 'processing',
    resolved: 'resolved',
    rejected: 'rejected',
  }[status] || 'hidden';
}

function wechatConflictLabel(type) {
  return {
    wechat_bound_other_user: '微信已绑定其他账号',
    wechat_bound_current_user: '微信已绑定当前账号',
    current_user_bound_other_wechat: '当前账号已绑定微信',
    phone_bound_other_wechat: '手机号已绑定其他微信',
  }[type] || type || '-';
}

function companyStatusLabel(status) {
  return { draft: '待审核', active: '正常', suspended: '停用', deleted: '已删除' }[status] || status || '-';
}

function companyVerificationLabel(status) {
  return {
    unverified: '未认证',
    pending: '待审核',
    verified: '已认证',
    rejected: '已拒绝',
  }[status] || status || '-';
}

function companyVerificationClass(status) {
  return {
    unverified: 'status-hidden',
    pending: 'status-pending',
    verified: 'status-approved',
    rejected: 'status-rejected',
  }[status] || 'status-hidden';
}

function verifiedMerchantLabel(status) {
  return {
    none: '未申请',
    pending: '待审核',
    approved: '已通过',
    rejected: '已拒绝',
    suspended: '已暂停',
  }[status] || status || '-';
}

function verifiedMerchantBadge(status) {
  return {
    none: 'hidden',
    pending: 'pending',
    approved: 'approved',
    rejected: 'rejected',
    suspended: 'suspended',
  }[status] || 'hidden';
}

function companySourceLabel(source) {
  return { manual: '手动创建', migrated_merchant: '旧商家迁移', admin_created: '后台创建' }[source] || source || '-';
}

function companyMemberRoleLabel(role) {
  return {
    owner: '负责人',
    admin: '管理员',
    designer: '设计师',
    supervisor: '监理',
    project_manager: '项目经理',
    merchant_staff: '员工',
    customer_service: '客服',
  }[role] || role || '-';
}

function companyMemberStatusLabel(status) {
  return { pending: '待确认', active: '正常', rejected: '已拒绝', removed: '已移除' }[status] || status || '-';
}

function projectParticipantRoleLabel(role) {
  return { designer: '设计', supervisor: '监理', contractor: '施工/服务商', client: '客户', pm: '项目经理' }[role] || role || '-';
}

function projectParticipantStatusLabel(status) {
  return { invited: '已邀请', active: '进行中', rejected: '已拒绝', removed: '已移除' }[status] || status || '-';
}

function sourceLabel(sourceType) {
  return {
    site_photos: '工地美照',
    complaint: '大家吐槽',
    question: '问题汇总',
    good_item: '好物推荐',
    inspiration: '创意灵感',
    legacy: '历史内容',
  }[sourceType] || sourceType || '-';
}

function noteStatusLabel(status) {
  return { 0: '待审核', 1: '已通过', 2: '已驳回/隐藏' }[Number(status)] || status;
}

function noteStatusClass(status) {
  return { 0: 'status-pending', 1: 'status-approved', 2: 'status-hidden' }[Number(status)] || 'status-hidden';
}

function tipTypeLabel(type) {
  return { general: '装修贴士', function_intro: '项目功能说明', stage: '阶段建议' }[type] || type || '-';
}

function styleLabel(style) {
  return {
    modern: '现代简约',
    cream: '奶油风',
    wood: '原木风',
    nordic: '北欧风',
    french: '法式',
    new_chinese: '新中式',
    light_luxury: '轻奢',
    american: '美式',
  }[style] || style || '-';
}

function inspectionStageLabel(stageId) {
  return {
    1: '准备阶段',
    2: '设计规划',
    3: '水电隐蔽',
    4: '泥瓦防水',
    5: '木工/吊顶/柜体',
    6: '油漆墙面',
    7: '安装收尾',
    8: '竣工总验',
  }[Number(stageId)] || '通用';
}

function riskLabel(risk) {
  return { must: '必须项', important: '重点项', normal: '普通项' }[risk] || risk || '-';
}

function riskClass(risk) {
  return { must: 'status-rejected', important: 'status-pending', normal: 'status-approved' }[risk] || 'status-hidden';
}

function listLabel(value, fallback = '-') {
  if (Array.isArray(value)) return value.length ? value.join('、') : fallback;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.length ? parsed.join('、') : fallback;
    } catch (e) {
      return value || fallback;
    }
  }
  return fallback;
}

function fmtTime(value) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '-';
}

function fmtMinute(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(/\//g, '-');
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(value) {
  return esc(value).replace(/'/g, '&#39;');
}

function jsEsc(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}
