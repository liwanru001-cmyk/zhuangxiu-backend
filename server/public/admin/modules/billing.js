function renderBilling() {
  selectedBillingMerchantId = null;
  selectedBillingDetailData = null;
  document.getElementById('page-content').innerHTML = `
    <div class="billing-header">
      ${billingTabsHtml()}
      <button class="ghost-btn" onclick="openBillingGuideModal()">操作说明</button>
    </div>
    <div id="billing-tab-content"></div>
  `;
  renderBillingTabContent();
}

function billingTabsHtml() {
  return `
    <div class="tabs">
      <button class="${billingTab === 'summary' ? 'active' : ''}" onclick="switchBillingTab('summary')">财务概览</button>
      <button class="${billingTab === 'merchants' ? 'active' : ''}" onclick="switchBillingTab('merchants')">商户列表</button>
      <button class="${billingTab === 'appeals' ? 'active' : ''}" onclick="switchBillingTab('appeals')">申诉记录</button>
      <button class="${billingTab === 'orders' ? 'active' : ''}" onclick="switchBillingTab('orders')">订单记录</button>
      <button class="${billingTab === 'exceptions' ? 'active' : ''}" onclick="switchBillingTab('exceptions')">异常处理</button>
      <button class="${billingTab === 'plan' ? 'active' : ''}" onclick="switchBillingTab('plan')">套餐配置</button>
    </div>
  `;
}

function openBillingGuideModal() {
  const modal = document.getElementById('billing-guide-modal');
  const body = document.getElementById('billing-guide-content');
  if (body) body.innerHTML = billingGuideHtml();
  if (modal) modal.classList.add('show');
}

function closeBillingGuideModal() {
  const modal = document.getElementById('billing-guide-modal');
  if (modal) modal.classList.remove('show');
}

function billingGuideHtml() {
  return `
    <section>
      <h4>1. 怎么开通商户展示</h4>
      <ol>
        <li>商户正常线上付款后，系统会自动开通展示。</li>
        <li>如果是线下收款或支付成功但没有自动开通，进入「商户列表」或「异常处理」，点击「手动开通 / 补开权益」。</li>
        <li>填写开通原因、收款金额、凭证说明后确认。</li>
        <li>开通成功后，店铺会进入公开展示，可参与搜索、地图和推荐展示。</li>
      </ol>
    </section>
    <section>
      <h4>2. 怎么关闭权益 / 处理退款</h4>
      <ol>
        <li>进入商户详情，点击「关闭权益 / 退款」。</li>
        <li>填写关闭原因、退款金额、退款或关闭凭证说明。</li>
        <li>确认后，订阅取消、权益失效、店铺立即下架。</li>
        <li>没有退款时退款金额填 0，但仍然要写清楚关闭凭证或客服处理单号。</li>
      </ol>
    </section>
    <section>
      <h4>3. 怎么处理商户申诉</h4>
      <ol>
        <li>进入「申诉记录」，优先处理「待处理」申诉。</li>
        <li>点击「商户详情」核对关闭原因、权益状态、审计日志。</li>
        <li>确认问题已处理后，点击「通过恢复」，系统会恢复展示权益。</li>
        <li>如果资料仍不符合要求，点击「驳回」，填写清楚驳回原因，商户可在 App 查看并重新提交。</li>
      </ol>
    </section>
    <section>
      <h4>4. 怎么查订单</h4>
      <ol>
        <li>进入「订单记录」。</li>
        <li>可按订单号、商家名称、手机号搜索。</li>
        <li>可按订单状态、支付渠道、时间范围筛选。</li>
        <li>点击「查看订单」可查看支付、订阅、权益、审计和事件记录。</li>
        <li>需要对账时，点击导出 CSV。</li>
      </ol>
    </section>
    <section>
      <h4>5. 怎么处理异常</h4>
      <ol>
        <li>进入「异常处理」。</li>
        <li>支付成功但未开通：先核对订单、支付和权益，确认无误后补开权益。</li>
        <li>事件失败或死信：先确认是否影响商户展示；需要重跑就点击重跑，已经人工处理就标记已处理或忽略。</li>
        <li>死信的意思是：系统自动重试多次仍失败，需要人工查看。</li>
      </ol>
    </section>
    <section>
      <h4>6. 操作留痕要求</h4>
      <ol>
        <li>开通、关闭、退款、重跑、忽略都会写入审计日志和事件记录。</li>
        <li>原因和凭证说明要写清楚，方便客服追踪和财务对账。</li>
        <li>不要无凭证发放付费权益，不要重复补开同一笔支付异常。</li>
      </ol>
    </section>
  `;
}

function switchBillingTab(tab) {
  billingTab = tab;
  page = 1;
  selectedBillingMerchantId = null;
  selectedBillingDetailData = null;
  renderBilling();
}

function refreshBillingTab() {
  if (billingTab === 'plan') {
    loadMerchantPlanConfig();
  } else if (billingTab === 'exceptions') {
    loadBillingExceptions();
  } else if (billingTab === 'orders') {
    loadBillingOrders(billingOrderPage);
  } else if (billingTab === 'appeals') {
    loadBillingAppeals(billingAppealPage);
  } else if (billingTab === 'summary') {
    loadBillingSummary();
  } else {
    loadBillingMerchants(page);
    if (selectedBillingMerchantId) viewBillingMerchant(selectedBillingMerchantId, false);
  }
}

function renderBillingTabContent() {
  const box = document.getElementById('billing-tab-content');
  if (!box) return;
  if (billingTab === 'plan') {
    box.innerHTML = `<div id="merchant-plan-config"></div>`;
    loadMerchantPlanConfig();
    return;
  }
  if (billingTab === 'exceptions') {
    box.innerHTML = `<div id="billing-exceptions"></div>`;
    loadBillingExceptions();
    return;
  }
  if (billingTab === 'orders') {
    box.innerHTML = billingOrdersTabHtml();
    loadBillingOrders(1);
    return;
  }
  if (billingTab === 'appeals') {
    box.innerHTML = billingAppealsTabHtml();
    loadBillingAppeals(1);
    return;
  }
  if (billingTab === 'summary') {
    box.innerHTML = billingSummaryTabHtml();
    setBillingSummaryRange('today');
    return;
  }
  box.innerHTML = `
    <div class="toolbar">
      <input id="billingSearch" placeholder="搜索商家/用户/手机号" onkeydown="if(event.key==='Enter')loadBillingMerchants(1)">
      <select id="billingStatus" onchange="loadBillingMerchants(1)">
        <option value="">全部展示状态</option>
        <option value="visible">展示中</option>
        <option value="not_visible">未展示</option>
        <option value="expired">已到期</option>
      </select>
      <button class="primary-btn" onclick="loadBillingMerchants(1)">查询</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>商户列表</h3>
          <p>查看商户展示状态、当前订阅和最近订单，进入详情后可处理权益。</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>商家</th><th>店铺</th><th>展示状态</th><th>订阅</th><th>最近订单</th><th>到期时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="billing-merchant-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="billing-page-info"></span>
        <button id="billing-btn-prev" onclick="loadBillingMerchants(page-1)">‹ 上一页</button>
        <button id="billing-btn-next" onclick="loadBillingMerchants(page+1)">下一页 ›</button>
      </div>
    </div>
    <div id="billing-detail" class="item-panel"></div>
  `;
  loadBillingMerchants(1);
}

function billingSummaryTabHtml() {
  return `
    <div class="toolbar">
      <select id="billingSummaryRange" onchange="onBillingSummaryRangeChange()">
        <option value="today">今天</option>
        <option value="yesterday">昨天</option>
        <option value="last7">近7天</option>
        <option value="custom">自定义</option>
      </select>
      <input id="billingSummaryDateFrom" type="date" disabled>
      <input id="billingSummaryDateTo" type="date" disabled>
      <button class="primary-btn" onclick="loadBillingSummary()">刷新</button>
    </div>
    <div id="billing-summary-content"></div>
  `;
}

function setBillingSummaryRange(range) {
  const select = document.getElementById('billingSummaryRange');
  if (select) select.value = range;
  onBillingSummaryRangeChange();
}

function onBillingSummaryRangeChange() {
  const range = document.getElementById('billingSummaryRange')?.value || 'today';
  const custom = range === 'custom';
  const from = document.getElementById('billingSummaryDateFrom');
  const to = document.getElementById('billingSummaryDateTo');
  if (from) from.disabled = !custom;
  if (to) to.disabled = !custom;
  loadBillingSummary();
}

async function loadBillingSummary() {
  const box = document.getElementById('billing-summary-content');
  if (!box) return;
  const range = document.getElementById('billingSummaryRange')?.value || 'today';
  const params = new URLSearchParams({ range });
  if (range === 'custom') {
    const dateFrom = document.getElementById('billingSummaryDateFrom')?.value || '';
    const dateTo = document.getElementById('billingSummaryDateTo')?.value || '';
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
  }
  box.innerHTML = '<div class="placeholder">正在加载财务概览...</div>';
  try {
    const j = await adminFetch(`/billing/summary?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    box.innerHTML = billingSummaryHtml(j.data || {});
  } catch (e) {
    box.innerHTML = `<div class="placeholder" style="border-color:#fecdca;color:#b42318;">${esc(e.message || '财务概览加载失败')}</div>`;
  }
}

function billingSummaryHtml(data) {
  const orders = data.orders || {};
  const payments = data.payments || {};
  const refunds = data.refunds || {};
  const active = data.active || {};
  const exceptions = data.exceptions || {};
  const range = data.range || {};
  return `
    <div class="card">
      <div class="card-title">
        <div>
          <h3>财务概览</h3>
          <p>${esc(range.date_from || '-')} 至 ${esc(range.date_to || '-')} · 商户付费运行状态</p>
        </div>
        <button class="ghost-btn" onclick="loadBillingSummary()">刷新</button>
      </div>
      <div class="detail-grid">
        <div class="detail-cell"><span>订单数</span><strong>${esc(orders.total || 0)}</strong></div>
        <div class="detail-cell"><span>已支付订单</span><strong>${esc(orders.paid || 0)}</strong></div>
        <div class="detail-cell"><span>待支付订单</span><strong>${esc(orders.pending_payment || 0)}</strong></div>
        <div class="detail-cell"><span>已退款订单</span><strong>${esc(orders.refunded || 0)}</strong></div>
        <div class="detail-cell"><span>支付成功金额</span><strong>${moneyText(payments.successful_amount_cents, 'CNY')}</strong></div>
        <div class="detail-cell"><span>退款金额</span><strong>${moneyText(refunds.amount_cents, 'CNY')}</strong></div>
        <div class="detail-cell"><span>有效订阅</span><strong>${esc(active.subscriptions || 0)}</strong></div>
        <div class="detail-cell"><span>展示中商户</span><strong>${esc(active.visible_merchants || 0)}</strong></div>
        <button class="detail-cell" onclick="openBillingExceptions('payment')" style="text-align:left;cursor:pointer;">
          <span>支付成功未开通</span><strong>${esc(exceptions.payment_not_activated || 0)}</strong>
        </button>
        <button class="detail-cell" onclick="openBillingExceptions('event')" style="text-align:left;cursor:pointer;">
          <span>事件失败 / 死信</span><strong>${esc(exceptions.event_failures || 0)}</strong>
        </button>
      </div>
    </div>
  `;
}

function openBillingExceptions(type) {
  billingTab = 'exceptions';
  renderBilling();
  setTimeout(() => {
    const target = document.getElementById(type === 'event' ? 'billing-event-exceptions' : 'billing-payment-exceptions');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 120);
}

function billingOrdersTabHtml() {
  return `
    <div class="toolbar">
      <input id="billingOrderSearch" placeholder="搜索订单号/商家/手机号" onkeydown="if(event.key==='Enter')loadBillingOrders(1)">
      <select id="billingOrderStatus" onchange="loadBillingOrders(1)">
        <option value="">全部订单状态</option>
        <option value="pending_payment">待支付</option>
        <option value="paid">已支付</option>
        <option value="refunded">已退款</option>
        <option value="closed">已关闭</option>
      </select>
      <select id="billingOrderChannel" onchange="loadBillingOrders(1)">
        <option value="">全部支付渠道</option>
        <option value="manual">manual</option>
        <option value="wechat_pay">微信支付</option>
        <option value="alipay">支付宝</option>
        <option value="apple_iap">Apple IAP</option>
        <option value="google_play">Google Play</option>
        <option value="stripe">Stripe</option>
      </select>
      <input id="billingOrderDateFrom" type="date" onchange="loadBillingOrders(1)">
      <input id="billingOrderDateTo" type="date" onchange="loadBillingOrders(1)">
      <button class="primary-btn" onclick="loadBillingOrders(1)">查询</button>
      <button class="ghost-btn" onclick="exportBillingOrdersCsv()">导出 CSV</button>
      <button class="ghost-btn" onclick="resetBillingOrderFilters()">重置</button>
    </div>
    <div class="card">
      <div class="card-title">
        <div>
          <h3>订单记录</h3>
          <p>直接查看全部商户订单，适合运营、客服和财务按订单查账。</p>
        </div>
      </div>
      <div id="billing-order-list-detail"></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>订单</th><th>商户</th><th>状态</th><th>金额</th><th>渠道</th><th>支付</th><th>订阅</th><th>创建时间</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="billing-order-body"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="billing-order-page-info"></span>
        <button id="billing-order-btn-prev" onclick="loadBillingOrders(billingOrderPage-1)">‹ 上一页</button>
        <button id="billing-order-btn-next" onclick="loadBillingOrders(billingOrderPage+1)">下一页 ›</button>
      </div>
    </div>
  `;
}

function billingAppealsTabHtml() {
  return `
    <div class="toolbar">
      <input id="billingAppealSearch" placeholder="搜索申诉号/商家/手机号/内容" onkeydown="if(event.key==='Enter')loadBillingAppeals(1)">
      <select id="billingAppealStatus" onchange="loadBillingAppeals(1)">
        <option value="">全部申诉状态</option>
        <option value="pending">待处理</option>
        <option value="approved">已通过</option>
        <option value="rejected">已驳回</option>
        <option value="cancelled">已取消</option>
      </select>
      <button onclick="loadBillingAppeals(1)">查询</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>申诉</th>
            <th>商户</th>
            <th>关闭原因</th>
            <th>申诉内容</th>
            <th>状态</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="billing-appeal-body"></tbody>
      </table>
      <div class="pagination">
        <span id="billing-appeal-page-info"></span>
        <button id="billing-appeal-btn-prev" onclick="loadBillingAppeals(billingAppealPage-1)">‹ 上一页</button>
        <button id="billing-appeal-btn-next" onclick="loadBillingAppeals(billingAppealPage+1)">下一页 ›</button>
      </div>
    </div>
  `;
}

async function loadBillingAppeals(p) {
  billingAppealPage = Math.max(1, p || 1);
  const keyword = document.getElementById('billingAppealSearch')?.value.trim() || '';
  const status = document.getElementById('billingAppealStatus')?.value || '';
  const params = new URLSearchParams({ page: billingAppealPage, pageSize: 20 });
  if (keyword) params.set('keyword', keyword);
  if (status) params.set('status', status);

  const body = document.getElementById('billing-appeal-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/billing/appeals?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const appeals = j.data.appeals || [];
    billingAppealTotal = Number(j.data.total || 0);
    body.innerHTML = appeals.map(billingAppealRow).join('') ||
      '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">暂无申诉记录</td></tr>';
    const totalPages = Math.ceil(billingAppealTotal / 20) || 1;
    document.getElementById('billing-appeal-page-info').textContent = `共 ${billingAppealTotal} 条 · ${billingAppealPage}/${totalPages}`;
    document.getElementById('billing-appeal-btn-prev').disabled = billingAppealPage <= 1;
    document.getElementById('billing-appeal-btn-next').disabled = billingAppealPage >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function billingAppealRow(item) {
  const merchant = item.merchant || {};
  const pending = item.status === 'pending';
  return `
    <tr>
      <td>
        <div class="mono">${esc(item.appeal_no || `#${item.id}`)}</div>
        <div class="muted">ID ${esc(item.id)}</div>
      </td>
      <td>
        <div>${esc(merchant.shop_name || merchant.nickname || '-')}</div>
        <div class="muted mono">ID ${esc(merchant.user_id || item.subject_id)} · ${esc(merchant.phone || '-')}</div>
      </td>
      <td>${esc(item.reason_label || item.reason_code || '-')}</td>
      <td>
        <div>${esc(item.content || '-')}</div>
        ${item.result_reason ? `<div class="muted">处理：${esc(item.result_reason)}</div>` : ''}
      </td>
      <td><span class="badge ${appealStatusClass(item.status)}">${appealStatusLabel(item.status)}</span></td>
      <td>
        <div>${fmtTime(item.created_at)}</div>
        ${item.reviewed_at ? `<div class="muted">处理 ${fmtTime(item.reviewed_at)}</div>` : ''}
      </td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="viewBillingMerchant(${Number(merchant.user_id || item.subject_id || 0)})">商户详情</button>
          ${pending ? `<button class="success-btn" onclick="approveBillingAppeal(${Number(item.id)})">通过恢复</button>` : ''}
          ${pending ? `<button class="danger-btn" onclick="rejectBillingAppeal(${Number(item.id)})">驳回</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

function approveBillingAppeal(appealId) {
  openBillingActionModal({
    type: 'approveAppeal',
    appealId,
    title: '通过商户申诉',
    summary: '通过后会恢复该商户的展示权益，店铺重新进入公开展示。',
    submitText: '通过并恢复展示',
    fields: [
      { name: 'reason', label: '通过原因', type: 'textarea', placeholder: '例如：资料已整改，恢复展示', required: true },
    ],
  });
}

function rejectBillingAppeal(appealId) {
  openBillingActionModal({
    type: 'rejectAppeal',
    appealId,
    title: '驳回商户申诉',
    summary: '驳回后商户可在 App 查看驳回原因，并可重新提交申诉。',
    submitText: '确认驳回',
    danger: true,
    fields: [
      { name: 'reason', label: '驳回原因', type: 'textarea', placeholder: '例如：资料仍不符合展示要求，请补充资质后再提交', required: true },
    ],
  });
}

async function loadBillingOrders(p) {
  billingOrderPage = Math.max(1, p || 1);
  const params = billingOrderFilterParams({ page: billingOrderPage, pageSize: 20 });

  const body = document.getElementById('billing-order-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/billing/orders?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    const orders = j.data.orders || [];
    billingOrderTotal = Number(j.data.total || 0);
    body.innerHTML = orders.map(billingOrderListRow).join('') ||
      '<tr><td colspan="9" style="text-align:center;color:#999;padding:32px;">暂无订单记录</td></tr>';
    const totalPages = Math.ceil(billingOrderTotal / 20) || 1;
    document.getElementById('billing-order-page-info').textContent = `共 ${billingOrderTotal} 条 · ${billingOrderPage}/${totalPages}`;
    document.getElementById('billing-order-btn-prev').disabled = billingOrderPage <= 1;
    document.getElementById('billing-order-btn-next').disabled = billingOrderPage >= totalPages;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function billingOrderFilterParams(extra = {}) {
  const params = new URLSearchParams(extra);
  const keyword = document.getElementById('billingOrderSearch')?.value.trim() || '';
  const status = document.getElementById('billingOrderStatus')?.value || '';
  const channel = document.getElementById('billingOrderChannel')?.value || '';
  const dateFrom = document.getElementById('billingOrderDateFrom')?.value || '';
  const dateTo = document.getElementById('billingOrderDateTo')?.value || '';
  if (keyword) params.set('keyword', keyword);
  if (status) params.set('status', status);
  if (channel) params.set('payment_channel', channel);
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  return params;
}

async function exportBillingOrdersCsv() {
  const params = billingOrderFilterParams();
  const url = `${API}/billing/orders/export?${params}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      logout();
      throw new Error('登录已过期');
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || '导出失败');
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `merchant-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    toast('订单 CSV 已导出');
  } catch (e) {
    toast(e.message || '导出失败');
  }
}

function billingOrderListRow(item) {
  return `
    <tr>
      <td>
        <div class="mono">${esc(item.order_no || item.id)}</div>
        <div class="muted">ID ${esc(item.id)}</div>
      </td>
      <td>
        <div>${esc(item.merchant_name || '-')}</div>
        <div class="muted mono">ID ${esc(item.merchant_user_id)} · ${esc(item.phone || '-')}</div>
      </td>
      <td><span class="badge ${orderStatusClass(item.status)}">${orderStatusLabel(item.status)}</span></td>
      <td>${moneyText(item.amount_cents, item.currency)}</td>
      <td>${esc(item.payment_channel || '-')}</td>
      <td>
        <div>${paymentStatusLabel(item.payment_status)}</div>
        <div class="muted">${esc(item.payment_no || '-')}</div>
      </td>
      <td>
        <div><span class="badge ${billingStatusClass(item.subscription_status)}">${billingStatusLabel(item.subscription_status)}</span></div>
        <div class="muted">${item.subscription_expire_at ? fmtTime(item.subscription_expire_at) : '-'}</div>
      </td>
      <td>${fmtTime(item.created_at)}</td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="viewBillingOrderFromList(${Number(item.id || 0)})">订单详情</button>
          <button class="action-btn" onclick="switchBillingTabToMerchant(${Number(item.merchant_user_id || 0)})">商户详情</button>
        </div>
      </td>
    </tr>
  `;
}

function resetBillingOrderFilters() {
  ['billingOrderSearch', 'billingOrderStatus', 'billingOrderChannel', 'billingOrderDateFrom', 'billingOrderDateTo']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  loadBillingOrders(1);
}

async function viewBillingOrderFromList(orderId) {
  const box = document.getElementById('billing-order-list-detail');
  if (!box) return;
  box.innerHTML = '<div class="placeholder">正在加载订单详情...</div>';
  try {
    const j = await adminFetch(`/billing/orders/${orderId}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    box.innerHTML = billingOrderDetailHtml(j.data || {});
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    box.innerHTML = `<div class="placeholder" style="border-color:#fecdca;color:#b42318;">${esc(e.message || '订单详情加载失败')}</div>`;
  }
}

async function switchBillingTabToMerchant(userId) {
  billingTab = 'merchants';
  renderBilling();
  await loadBillingMerchants(1);
  await viewBillingMerchant(userId);
}

async function loadMerchantPlanConfig() {
  const box = document.getElementById('merchant-plan-config');
  if (!box) return;
  box.innerHTML = '<div class="placeholder">正在加载商户套餐...</div>';
  try {
    const j = await adminFetch('/billing/merchant-plan');
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    merchantPlan = j.data || {};
    box.innerHTML = merchantPlanConfigHtml(merchantPlan);
  } catch (e) {
    box.innerHTML = `<div class="placeholder" style="border-color:#fecdca;color:#b42318;">${esc(e.message || '商户套餐加载失败')}</div>`;
  }
}

function merchantPlanConfigHtml(plan) {
  const feature = plan.feature || {};
  const limit = plan.limit || {};
  const priceYuan = (Number(plan.price_cents || 0) / 100).toFixed(2);
  return `
    <div class="card">
      <div class="card-title">
        <div>
          <h3>商户套餐配置</h3>
          <p>保存会发布新版本，已购订单继续保留旧版本价格和权益。</p>
        </div>
        <span class="badge ${plan.plan_status === 'active' ? 'status-approved' : 'status-hidden'}">当前 v${esc(plan.version || 0)} · ${plan.plan_status === 'active' ? '启用' : '停用'}</span>
      </div>
      <div class="editor-body">
        <div class="form-grid">
          <div>
            <label>套餐名称</label>
            <input id="merchantPlanName" value="${esc(plan.plan_name || plan.version_name || '商家展示月度版')}">
          </div>
          <div>
            <label>价格（元）</label>
            <input id="merchantPlanPrice" type="number" min="0" step="0.01" value="${esc(priceYuan)}">
          </div>
          <div>
            <label>有效天数</label>
            <input id="merchantPlanDuration" type="number" min="1" max="3650" value="${esc(plan.duration_days || 30)}">
          </div>
          <div>
            <label>套餐状态</label>
            <select id="merchantPlanEnabled">
              <option value="1" ${plan.plan_status === 'active' ? 'selected' : ''}>启用</option>
              <option value="0" ${plan.plan_status !== 'active' ? 'selected' : ''}>停用</option>
            </select>
          </div>
          <div>
            <label>产品数量</label>
            <input id="merchantPlanProductLimit" type="number" min="0" value="${esc(limit.product_limit || 0)}">
          </div>
          <div>
            <label>案例数量</label>
            <input id="merchantPlanCaseLimit" type="number" min="0" value="${esc(limit.case_limit || 0)}">
          </div>
        </div>
        <div>
          <label>展示权益</label>
          <div class="row-actions">
            ${planFeatureCheckbox('merchantPlanShopVisible', '店铺展示', feature.shop_visible !== false)}
            ${planFeatureCheckbox('merchantPlanSearchVisible', '搜索展示', feature.search_visible !== false)}
            ${planFeatureCheckbox('merchantPlanMapVisible', '地图展示', feature.map_visible !== false)}
            ${planFeatureCheckbox('merchantPlanProductShowcase', '产品展示', feature.product_showcase !== false)}
            ${planFeatureCheckbox('merchantPlanCaseShowcase', '案例展示', feature.case_showcase !== false)}
          </div>
        </div>
        <div class="row-actions">
          <button class="primary-btn" onclick="saveMerchantPlanConfig()">发布新版本</button>
          <button class="ghost-btn" onclick="loadMerchantPlanConfig()">重置</button>
        </div>
      </div>
      ${merchantPlanVersionsTable(plan.versions || [])}
    </div>
  `;
}

function merchantPlanVersionsTable(versions) {
  const body = versions.length
    ? versions.map(item => `
      <tr>
        <td>
          <span class="badge ${item.is_current ? 'status-approved' : 'status-hidden'}">v${esc(item.version)}</span>
          ${item.is_current ? '<div class="muted">当前新订单使用</div>' : ''}
        </td>
        <td>${esc(item.name || '-')}</td>
        <td>${moneyText(item.price_cents, item.currency)}</td>
        <td>${esc(item.duration_days)} 天</td>
        <td>${esc(item.order_count || 0)}</td>
        <td>${esc(item.subscription_count || 0)}</td>
        <td>${fmtTime(item.published_at || item.created_at)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="7" style="text-align:center;color:#999;padding:22px;">暂无版本记录</td></tr>';
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th colspan="7">版本历史</th></tr>
          <tr><th>版本</th><th>名称</th><th>价格</th><th>有效期</th><th>订单数</th><th>订阅数</th><th>发布时间</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function planFeatureCheckbox(id, label, checked) {
  return `
    <label class="badge status-hidden" style="cursor:pointer;">
      <input id="${id}" type="checkbox" ${checked ? 'checked' : ''} style="margin-right:6px;">
      ${esc(label)}
    </label>
  `;
}

async function saveMerchantPlanConfig() {
  const payload = readMerchantPlanForm();
  if (!payload.name) {
    toast('套餐名称不能为空');
    return;
  }
  if (!Number.isFinite(payload.price_yuan) || payload.price_yuan < 0) {
    toast('价格不正确');
    return;
  }
  const diff = merchantPlanDiff(payload, merchantPlan || {});
  if (!diff.length) {
    toast('当前配置未变化，无需发布新版本');
    return;
  }
  const nextVersion = Number(merchantPlan?.version || 0) + 1;
  const confirmText = [
    `确认发布商户套餐 v${nextVersion}？`,
    '',
    '变更内容：',
    ...diff.map(item => `- ${item}`),
    '',
    '这会生成一个新版本。',
    '已购订单不会受影响。',
    '新订单会使用新版本。',
  ].join('\n');
  if (!confirm(confirmText)) return;
  try {
    const j = await adminFetch('/billing/merchant-plan', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        name: payload.name,
        price_cents: payload.price_cents,
        duration_days: payload.duration_days,
        enabled: payload.enabled,
        product_limit: payload.product_limit,
        case_limit: payload.case_limit,
        shop_visible: payload.shop_visible,
        search_visible: payload.search_visible,
        map_visible: payload.map_visible,
        product_showcase: payload.product_showcase,
        case_showcase: payload.case_showcase,
      }),
    });
    if (j.code !== 200) throw new Error(j.message || '保存失败');
    toast('商户套餐新版本已发布');
    await loadMerchantPlanConfig();
  } catch (e) {
    toast(e.message || '保存失败');
  }
}

function readMerchantPlanForm() {
  const priceYuan = Number(document.getElementById('merchantPlanPrice')?.value || 0);
  return {
    name: document.getElementById('merchantPlanName')?.value.trim() || '',
    price_yuan: priceYuan,
    price_cents: Math.round(priceYuan * 100),
    duration_days: Math.round(Number(document.getElementById('merchantPlanDuration')?.value || 30)),
    enabled: document.getElementById('merchantPlanEnabled')?.value === '1',
    product_limit: Math.round(Number(document.getElementById('merchantPlanProductLimit')?.value || 0)),
    case_limit: Math.round(Number(document.getElementById('merchantPlanCaseLimit')?.value || 0)),
    shop_visible: document.getElementById('merchantPlanShopVisible')?.checked === true,
    search_visible: document.getElementById('merchantPlanSearchVisible')?.checked === true,
    map_visible: document.getElementById('merchantPlanMapVisible')?.checked === true,
    product_showcase: document.getElementById('merchantPlanProductShowcase')?.checked === true,
    case_showcase: document.getElementById('merchantPlanCaseShowcase')?.checked === true,
  };
}

function merchantPlanDiff(next, current) {
  const feature = current.feature || {};
  const limit = current.limit || {};
  const previous = {
    name: current.plan_name || current.version_name || '',
    price_cents: Number(current.price_cents || 0),
    duration_days: Number(current.duration_days || 30),
    enabled: current.plan_status === 'active',
    product_limit: Number(limit.product_limit || 0),
    case_limit: Number(limit.case_limit || 0),
    shop_visible: feature.shop_visible !== false,
    search_visible: feature.search_visible !== false,
    map_visible: feature.map_visible !== false,
    product_showcase: feature.product_showcase !== false,
    case_showcase: feature.case_showcase !== false,
  };
  const items = [];
  addPlanDiff(items, '套餐名称', previous.name, next.name);
  addPlanDiff(items, '价格', moneyText(previous.price_cents, 'CNY'), moneyText(next.price_cents, 'CNY'));
  addPlanDiff(items, '有效天数', `${previous.duration_days}天`, `${next.duration_days}天`);
  addPlanDiff(items, '套餐状态', previous.enabled ? '启用' : '停用', next.enabled ? '启用' : '停用');
  addPlanDiff(items, '产品数量', previous.product_limit, next.product_limit);
  addPlanDiff(items, '案例数量', previous.case_limit, next.case_limit);
  addPlanDiff(items, '店铺展示', boolText(previous.shop_visible), boolText(next.shop_visible));
  addPlanDiff(items, '搜索展示', boolText(previous.search_visible), boolText(next.search_visible));
  addPlanDiff(items, '地图展示', boolText(previous.map_visible), boolText(next.map_visible));
  addPlanDiff(items, '产品展示', boolText(previous.product_showcase), boolText(next.product_showcase));
  addPlanDiff(items, '案例展示', boolText(previous.case_showcase), boolText(next.case_showcase));
  return items;
}

function addPlanDiff(items, label, before, after) {
  if (String(before) === String(after)) return;
  items.push(`${label}：${before || '-'} → ${after || '-'}`);
}

function boolText(value) {
  return value ? '开启' : '关闭';
}

async function loadBillingExceptions() {
  const box = document.getElementById('billing-exceptions');
  if (!box) return;
  box.innerHTML = '<div class="placeholder">正在加载异常处理...</div>';
  try {
    const j = await adminFetch('/billing/exceptions');
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    billingExceptions = Object.assign(
      { payment_not_activated: [], event_failures: [] },
      j.data || {}
    );
    box.innerHTML = billingExceptionsHtml(billingExceptions);
  } catch (e) {
    box.innerHTML = `<div class="placeholder" style="border-color:#fecdca;color:#b42318;">${esc(e.message || '异常处理加载失败')}</div>`;
  }
}

async function loadBillingMerchants(p) {
  page = Math.max(1, p || 1);
  const kw = document.getElementById('billingSearch')?.value.trim() || '';
  const billingStatus = document.getElementById('billingStatus')?.value || '';
  const params = new URLSearchParams({ page, pageSize: 20 });
  if (kw) params.set('keyword', kw);
  if (billingStatus) params.set('billing_status', billingStatus);

  const body = document.getElementById('billing-merchant-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">加载中...</td></tr>';
  try {
    const j = await adminFetch(`/billing/merchants?${params}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    billingMerchants = j.data.merchants || [];
    total = j.data.total || 0;
    body.innerHTML = billingMerchants.map(billingMerchantRow).join('') ||
      '<tr><td colspan="7" style="text-align:center;color:#999;padding:32px;">暂无商户数据</td></tr>';
    const totalPages = Math.ceil(total / 20) || 1;
    document.getElementById('billing-page-info').textContent = `共 ${total} 条 · ${page}/${totalPages}`;
    document.getElementById('billing-btn-prev').disabled = page <= 1;
    document.getElementById('billing-btn-next').disabled = page >= totalPages;
    if (selectedBillingMerchantId) viewBillingMerchant(selectedBillingMerchantId, false);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#b42318;padding:32px;">${esc(e.message || '加载失败')}</td></tr>`;
  }
}

function billingMerchantRow(item) {
  const visible = Boolean(item.shop_visible);
  return `
    <tr>
      <td>
        <div>${esc(item.nickname) || '-'}</div>
        <div class="muted mono">ID ${item.user_id} · ${esc(item.phone) || '-'}</div>
      </td>
      <td>
        <div class="share-title">${esc(item.shop_name) || '<span class="muted">未填写店铺名</span>'}</div>
        <div class="muted">${esc(item.category_group || item.city) || '-'}</div>
      </td>
      <td><span class="badge ${visible ? 'status-approved' : 'status-hidden'}">${visible ? '展示中' : '未展示'}</span></td>
      <td><span class="badge ${billingStatusClass(item.subscription_status)}">${billingStatusLabel(item.subscription_status)}</span></td>
      <td>
        <div>${esc(orderStatusLabel(item.latest_order_status))}</div>
        <div class="muted">${fmtTime(item.latest_order_at)}</div>
      </td>
      <td>${item.subscription_expire_at ? fmtTime(item.subscription_expire_at) : '<span class="muted">-</span>'}</td>
      <td>
        <div class="row-actions">
          <button class="action-btn" onclick="viewBillingMerchant(${item.user_id})">详情</button>
          ${visible
            ? `<button class="danger-btn" onclick="suspendMerchantDisplay(${item.user_id})">暂停展示</button>`
            : `<button class="success-btn" onclick="manualActivateMerchant(${item.user_id})">手动开通</button>`}
        </div>
      </td>
    </tr>
  `;
}

async function viewBillingMerchant(userId, scroll = true) {
  selectedBillingMerchantId = Number(userId);
  const detail = document.getElementById('billing-detail');
  if (!detail) return;
  detail.innerHTML = '<div class="placeholder">正在加载商户详情...</div>';
  try {
    const j = await adminFetch(`/billing/merchants/${userId}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    billingDetailTab = 'overview';
    selectedBillingDetailData = j.data || {};
    detail.innerHTML = billingDetailHtml(selectedBillingDetailData);
    if (scroll) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    detail.innerHTML = `<div class="placeholder" style="border-color:#fecdca;color:#b42318;">${esc(e.message || '加载失败')}</div>`;
  }
}

async function manualActivateMerchant(userId) {
  openBillingActionModal({
    type: 'manualActivate',
    userId,
    title: '手动开通商户展示',
    summary: '用于线下收款补单、客服补偿或支付异常补开。提交后会创建订单、支付、订阅、权益、审计和事件记录。',
    submitText: '确认开通',
    fields: [
      { name: 'reason', label: '开通原因', type: 'textarea', placeholder: '例如：线下收款补单、客服补偿、支付异常补开', required: true },
      { name: 'amount_yuan', label: '线下收款金额（元）', type: 'number', placeholder: '没有收款请填 0', required: true, value: '0' },
      { name: 'voucher_note', label: '凭证说明', type: 'textarea', placeholder: '例如：微信收款单号、银行流水号、客服补偿单号', required: true },
    ],
  });
}

async function suspendMerchantDisplay(userId) {
  openBillingActionModal({
    type: 'suspend',
    userId,
    title: '暂停商户展示',
    summary: '暂停后前台不可见，但订单和数据保留。适用于违规、退款处理中或客服人工暂停。',
    submitText: '确认暂停',
    danger: true,
    fields: [
      { name: 'reason', label: '暂停原因', type: 'textarea', placeholder: '例如：违规、退款处理中、客服人工暂停', required: true },
    ],
  });
}

async function resumeMerchantDisplay(userId) {
  openBillingActionModal({
    type: 'resume',
    userId,
    title: '恢复商户展示',
    summary: '恢复后商户会重新参与前台展示。请确认暂停原因已经处理完毕。',
    submitText: '确认恢复',
    fields: [
      { name: 'reason', label: '恢复原因', type: 'textarea', placeholder: '例如：问题已处理、客服恢复展示', required: true },
    ],
  });
}

async function closeMerchantDisplay(userId) {
  openBillingActionModal({
    type: 'closeRefund',
    userId,
    title: '关闭权益 / 退款处理',
    summary: '关闭后订阅会取消，展示权益会立即失效，店铺不再公开展示。请填写退款金额和处理凭证。',
    submitText: '确认关闭',
    danger: true,
    fields: [
      { name: 'reason', label: '关闭原因', type: 'textarea', placeholder: '例如：商户退款、合同终止、违规关闭、客服人工关闭', required: true },
      { name: 'refund_amount_yuan', label: '退款金额（元）', type: 'number', placeholder: '没有退款请填 0', required: true, value: '0' },
      { name: 'voucher_note', label: '退款或关闭凭证说明', type: 'textarea', placeholder: '例如：退款流水号、线下退款凭证、客服处理单号', required: true },
    ],
  });
}

async function refreshBillingAfterMerchantAction(userId) {
  const tasks = [];
  if (document.getElementById('billing-exceptions')) tasks.push(loadBillingExceptions());
  if (document.getElementById('billing-merchant-body')) tasks.push(loadBillingMerchants(page));
  if (document.getElementById('billing-appeal-body')) tasks.push(loadBillingAppeals(billingAppealPage));
  await Promise.all(tasks);
  if (document.getElementById('billing-detail')) await viewBillingMerchant(userId, false);
}

function openBillingActionModal(config) {
  billingActionState = config;
  document.getElementById('billing-action-title').textContent = config.title || '商户操作';
  document.getElementById('billing-action-summary').textContent = config.summary || '';
  document.getElementById('billing-action-error').textContent = '';
  const submit = document.getElementById('billing-action-submit');
  submit.textContent = config.submitText || '确认';
  submit.disabled = false;
  submit.className = config.danger ? 'danger-btn' : 'primary';
  document.getElementById('billing-action-fields').innerHTML = (config.fields || [])
    .map(billingActionFieldHtml)
    .join('');
  document.getElementById('billing-action-modal').classList.add('show');
  const first = document.querySelector('#billing-action-fields input, #billing-action-fields textarea');
  if (first) first.focus();
}

function billingActionFieldHtml(field) {
  const id = `billing-action-${field.name}`;
  const value = esc(field.value || '');
  const placeholder = esc(field.placeholder || '');
  const required = field.required ? 'data-required="1"' : '';
  if (field.type === 'number') {
    return `
      <label for="${id}">${esc(field.label)}</label>
      <input id="${id}" data-name="${esc(field.name)}" type="number" min="0" step="0.01" value="${value}" placeholder="${placeholder}" ${required}>
    `;
  }
  return `
    <label for="${id}">${esc(field.label)}</label>
    <textarea id="${id}" class="billing-action-textarea" rows="3" data-name="${esc(field.name)}" maxlength="300" placeholder="${placeholder}" ${required}>${value}</textarea>
  `;
}

function closeBillingActionModal() {
  document.getElementById('billing-action-modal').classList.remove('show');
  document.getElementById('billing-action-error').textContent = '';
  billingActionState = null;
}

function readBillingActionValues() {
  const values = {};
  const fields = document.querySelectorAll('#billing-action-fields [data-name]');
  for (const field of fields) {
    const name = field.getAttribute('data-name');
    values[name] = String(field.value || '').trim();
    if (field.getAttribute('data-required') === '1' && !values[name]) {
      throw new Error('请完整填写必填信息');
    }
  }
  if (values.amount_yuan !== undefined) {
    const amount = Number(values.amount_yuan);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('补单金额不正确');
    }
    values.amount_cents = Math.round(amount * 100);
  }
  if (values.refund_amount_yuan !== undefined) {
    const amount = Number(values.refund_amount_yuan);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('退款金额不正确');
    }
    values.refund_amount_cents = Math.round(amount * 100);
  }
  return values;
}

async function submitBillingActionModal() {
  if (!billingActionState) return;
  const errorBox = document.getElementById('billing-action-error');
  const submit = document.getElementById('billing-action-submit');
  errorBox.textContent = '';
  let values;
  try {
    values = readBillingActionValues();
  } catch (e) {
    errorBox.textContent = e.message || '请检查输入内容';
    return;
  }
  submit.disabled = true;
  try {
    await executeBillingAction(billingActionState, values);
    closeBillingActionModal();
  } catch (e) {
    errorBox.textContent = e.message || '操作失败';
    submit.disabled = false;
  }
}

async function executeBillingAction(action, values) {
  if (action.type === 'manualActivate') {
    const j = await adminFetch(`/billing/merchants/${action.userId}/manual-activate`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        reason: values.reason,
        amount_cents: values.amount_cents,
        voucher_note: values.voucher_note,
      }),
    });
    if (j.code !== 200) throw new Error(j.message || '开通失败');
    toast('商家展示已开通');
    await refreshBillingAfterMerchantAction(action.userId);
    return;
  }
  if (action.type === 'suspend' || action.type === 'resume') {
    const endpoint = action.type === 'suspend' ? 'suspend' : 'resume';
    const j = await adminFetch(`/billing/merchants/${action.userId}/${endpoint}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ reason: values.reason }),
    });
    if (j.code !== 200) throw new Error(j.message || (action.type === 'suspend' ? '暂停失败' : '恢复失败'));
    toast(action.type === 'suspend' ? '商户展示已暂停' : '商户展示已恢复');
    await refreshBillingAfterMerchantAction(action.userId);
    return;
  }
  if (action.type === 'closeRefund') {
    const j = await adminFetch(`/billing/merchants/${action.userId}/close`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        reason: values.reason,
        refund_amount_cents: values.refund_amount_cents,
        voucher_note: values.voucher_note,
      }),
    });
    if (j.code !== 200) throw new Error(j.message || '关闭失败');
    toast('商户展示权益已关闭');
    await refreshBillingAfterMerchantAction(action.userId);
    return;
  }
  if (action.type === 'approveAppeal' || action.type === 'rejectAppeal') {
    const endpoint = action.type === 'approveAppeal' ? 'approve' : 'reject';
    const j = await adminFetch(`/billing/appeals/${action.appealId}/${endpoint}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ reason: values.reason }),
    });
    if (j.code !== 200) throw new Error(j.message || (action.type === 'approveAppeal' ? '通过失败' : '驳回失败'));
    toast(action.type === 'approveAppeal' ? '申诉已通过，商户展示已恢复' : '申诉已驳回');
    if (document.getElementById('billing-appeal-body')) await loadBillingAppeals(billingAppealPage);
    if (document.getElementById('billing-merchant-body')) await loadBillingMerchants(page);
    if (selectedBillingMerchantId) await viewBillingMerchant(selectedBillingMerchantId, false);
    return;
  }
  if (action.type === 'retryEvent') {
    const j = await adminFetch(`/billing/events/${action.eventId}/retry`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ reason: values.reason }),
    });
    if (j.code !== 200) throw new Error(j.message || '重跑失败');
    toast('事件已重新加入待处理');
    await loadBillingExceptions();
    if (selectedBillingMerchantId) await viewBillingMerchant(selectedBillingMerchantId, false);
  }
  if (action.type === 'resolveEvent') {
    const j = await adminFetch(`/billing/events/${action.eventId}/resolve`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ status: action.status, reason: values.reason }),
    });
    if (j.code !== 200) throw new Error(j.message || '处理失败');
    toast(action.status === 'processed' ? '事件已标记为已处理' : '事件已标记为忽略');
    await loadBillingExceptions();
    if (selectedBillingMerchantId) await viewBillingMerchant(selectedBillingMerchantId, false);
  }
}

async function retryBillingEvent(eventId) {
  openBillingActionModal({
    type: 'retryEvent',
    eventId,
    title: '重跑 Billing 事件',
    summary: '确认后会把该事件重新加入待处理队列。只用于人工确认可以重新投递的失败或死信事件。',
    submitText: '确认重跑',
    fields: [
      { name: 'reason', label: '重跑原因', type: 'textarea', placeholder: '例如：人工确认后重新投递', required: true },
    ],
  });
}

async function resolveBillingEvent(eventId, status) {
  const processed = status === 'processed';
  openBillingActionModal({
    type: 'resolveEvent',
    eventId,
    status: processed ? 'processed' : 'ignored',
    title: processed ? '标记事件已处理' : '忽略 Billing 事件',
    summary: processed
      ? '适用于人工确认订单、订阅、权益都已经正常，不需要再重跑的事件。'
      : '适用于测试数据、重复事件或确认无影响的事件。忽略后不会继续出现在异常列表。',
    submitText: processed ? '确认已处理' : '确认忽略',
    danger: !processed,
    fields: [
      {
        name: 'reason',
        label: processed ? '处理说明' : '忽略原因',
        type: 'textarea',
        placeholder: processed ? '例如：人工确认权益已正常生效' : '例如：测试数据，无需处理',
        required: true,
      },
    ],
  });
}

function billingExceptionsHtml(data) {
  const paymentItems = data.payment_not_activated || [];
  const eventItems = data.event_failures || [];
  const totalExceptions = paymentItems.length + eventItems.length;
  return `
    <div class="card">
      <div class="card-title">
        <div>
          <h3>异常处理</h3>
          <p>支付成功未开通、事件失败和死信事件会在这里集中处理。</p>
        </div>
        <div class="row-actions">
          <span class="badge ${totalExceptions ? 'status-rejected' : 'status-approved'}">${totalExceptions ? `${totalExceptions} 个异常` : '暂无异常'}</span>
          <button class="ghost-btn" onclick="loadBillingExceptions()">刷新异常</button>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-cell"><span>支付成功未开通</span><strong>${paymentItems.length}</strong></div>
        <div class="detail-cell"><span>事件失败 / 死信</span><strong>${eventItems.length}</strong></div>
      </div>
      <div class="editor-note" style="margin:0 18px 14px;">
        处理建议：支付成功未开通优先补开权益；事件失败或死信先确认影响范围，再重跑事件。
      </div>
      ${billingPaymentExceptionTable(paymentItems)}
      ${billingEventExceptionTable(eventItems)}
    </div>
  `;
}

function billingPaymentExceptionTable(items) {
  const body = items.length
    ? items.map(item => `
      <tr>
        <td>
          <span class="badge status-rejected">支付成功未开通</span>
          <div class="muted">建议：补开权益</div>
        </td>
        <td>
          ${esc(item.merchant_name || '-')}
          <div class="muted mono">ID ${esc(item.merchant_user_id)} · ${esc(item.phone || '-')}</div>
        </td>
        <td>
          <div>${esc(item.order_no || `#${item.order_id}`)}</div>
          <div class="muted">${orderStatusLabel(item.order_status)}</div>
        </td>
        <td>
          <div>${esc(item.payment_no)}</div>
          <div class="muted">${moneyText(item.amount_cents, item.currency)} · ${fmtTime(item.paid_at)}</div>
        </td>
        <td>
          <div>${billingStatusLabel(item.entitlement_status || 'inactive')}</div>
          <div class="muted">${item.entitlement_expire_at ? fmtTime(item.entitlement_expire_at) : '无有效展示权益'}</div>
        </td>
        <td>
          <div class="row-actions">
            <button class="success-btn" onclick="manualActivateMerchant(${Number(item.merchant_user_id || 0)})">补开权益</button>
            <button class="action-btn" onclick="viewBillingExceptionOrder(${Number(item.order_id || 0)})">订单详情</button>
            <button class="action-btn" onclick="switchBillingTabToMerchant(${Number(item.merchant_user_id || 0)})">商户详情</button>
          </div>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="6" style="text-align:center;color:#999;padding:22px;">暂无支付成功未开通异常</td></tr>';
  return `
    <div class="table-wrap" id="billing-payment-exceptions">
      <table>
        <thead><tr><th colspan="6">支付成功未开通</th></tr><tr><th>异常</th><th>商户</th><th>关联订单</th><th>支付记录</th><th>当前权益</th><th>处理</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function billingEventExceptionTable(items) {
  const body = items.length
    ? items.map(item => `
      <tr>
        <td>
          <span class="badge ${item.status === 'dead_letter' ? 'status-rejected' : 'status-pending'}">${eventStatusLabel(item.status)}</span>
          <div class="muted">建议：确认后重跑</div>
        </td>
        <td>${esc(item.event_type)}<div class="muted mono">${esc(item.event_id)}</div></td>
        <td>
          ${esc(item.merchant_name || '-')}
          <div class="muted mono">${item.subject_id ? `ID ${esc(item.subject_id)} · ${esc(item.phone || '-')}` : '-'}</div>
        </td>
        <td>${esc(item.aggregate_type || '-')} #${esc(item.aggregate_id || '-')}</td>
        <td><span class="badge ${item.status === 'dead_letter' ? 'status-rejected' : 'status-pending'}">${eventStatusLabel(item.status)}</span></td>
        <td>${esc(item.retry_count || 0)}</td>
        <td>${fmtTime(item.updated_at || item.created_at)}</td>
        <td>
          <div class="row-actions">
            <button class="action-btn" onclick="retryBillingEvent(${Number(item.id || 0)})">重跑</button>
            <button class="success-btn" onclick="resolveBillingEvent(${Number(item.id || 0)}, 'processed')">已处理</button>
            <button class="danger-btn" onclick="resolveBillingEvent(${Number(item.id || 0)}, 'ignored')">忽略</button>
            ${item.aggregate_type === 'billing_order' ? `<button class="action-btn" onclick="viewBillingExceptionOrder(${Number(item.aggregate_id || 0)})">订单详情</button>` : ''}
            ${item.subject_id ? `<button class="action-btn" onclick="switchBillingTabToMerchant(${Number(item.subject_id || 0)})">商户详情</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="8" style="text-align:center;color:#999;padding:22px;">暂无失败或死信事件</td></tr>';
  return `
    <div class="table-wrap" id="billing-event-exceptions">
      <table>
        <thead><tr><th colspan="8">事件失败 / 死信</th></tr><tr><th>异常</th><th>事件</th><th>商户</th><th>关联对象</th><th>状态</th><th>重试</th><th>更新时间</th><th>处理</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function viewBillingExceptionOrder(orderId) {
  if (!orderId) {
    toast('没有关联订单');
    return;
  }
  billingTab = 'orders';
  renderBilling();
  await viewBillingOrderFromList(orderId);
}

function billingDetailHtml(data) {
  const merchant = data.merchant || {};
  const billing = data.billing || {};
  const entitlement = billing.entitlement || {};
  return `
    <div class="card">
      ${billingDetailHeaderHtml(merchant, billing, entitlement)}
      ${billingDetailTabsHtml()}
      ${billingDetailTabPanelHtml(merchant, billing, entitlement)}
    </div>
  `;
}

function billingDetailHeaderHtml(merchant, billing, entitlement) {
  const entitlementActiveUntil = entitlement.expire_at ? new Date(entitlement.expire_at).getTime() : 0;
  const hasActiveEntitlement = entitlement.status === 'active' && entitlementActiveUntil > Date.now();
  const actionButtons = billing.shop_visible
    ? `<button class="danger-btn" onclick="suspendMerchantDisplay(${Number(merchant.user_id || 0)})">暂停展示</button>`
    : hasActiveEntitlement
    ? `<button class="success-btn" onclick="resumeMerchantDisplay(${Number(merchant.user_id || 0)})">恢复展示</button>`
    : `<button class="success-btn" onclick="manualActivateMerchant(${Number(merchant.user_id || 0)})">手动开通/续期</button>`;
  const renewalButton = hasActiveEntitlement
    ? `<button class="action-btn" onclick="manualActivateMerchant(${Number(merchant.user_id || 0)})">手动开通/续期</button>`
    : '';
  const closeButton = hasActiveEntitlement
    ? `<button class="danger-btn" onclick="closeMerchantDisplay(${Number(merchant.user_id || 0)})">关闭权益/退款</button>`
    : '';
  return `
    <div class="card-title">
      <div>
        <h3>${esc(merchant.shop_name || merchant.nickname || '商户详情')}</h3>
        <p>ID ${esc(merchant.user_id)} · ${esc(merchant.phone || '-')} · ${billing.shop_visible ? '展示中' : '未展示'}</p>
      </div>
      <div class="row-actions">
        ${actionButtons}
        ${renewalButton}
        ${closeButton}
      </div>
    </div>
  `;
}

function billingDetailTabsHtml() {
  const tabs = [
    ['overview', '概览'],
    ['orders', '订单'],
    ['payments', '支付'],
    ['entitlements', '订阅与权益'],
    ['appeals', '申诉'],
    ['audit', '审计日志'],
    ['events', '事件'],
  ];
  return `
    <div class="tabs subtabs">
      ${tabs.map(([key, label]) => `<button class="${billingDetailTab === key ? 'active' : ''}" onclick="switchBillingDetailTab('${key}')">${label}</button>`).join('')}
    </div>
  `;
}

function switchBillingDetailTab(tab) {
  billingDetailTab = tab;
  const detail = document.getElementById('billing-detail');
  if (detail && selectedBillingDetailData) {
    detail.innerHTML = billingDetailHtml(selectedBillingDetailData);
  }
}

function billingDetailTabPanelHtml(merchant, billing, entitlement) {
  if (billingDetailTab === 'orders') {
    return `
      <div id="billing-order-detail"></div>
      ${billingOrdersTable(billing.orders || [])}
    `;
  }
  if (billingDetailTab === 'payments') {
    return billingSectionTable('支付', ['ID', '支付号', '订单', '状态', '金额', '渠道', '支付时间'], billing.payments || [], row => [
      row.id,
      row.payment_no,
      row.order_id,
      paymentStatusLabel(row.status),
      moneyText(row.amount_cents, row.currency),
      row.payment_channel,
      fmtTime(row.paid_at || row.created_at),
    ]);
  }
  if (billingDetailTab === 'entitlements') {
    return `
      ${billingEntitlementSummaryHtml(entitlement)}
      ${billingSectionTable('订阅', ['ID', '订阅号', '状态', '主订阅', '开始', '到期', '原因'], billing.subscriptions || [], row => [
        row.id,
        row.subscription_no,
        billingStatusLabel(row.status),
        row.is_primary ? '是' : '否',
        fmtTime(row.started_at),
        fmtTime(row.expire_at),
        row.reason || '-',
      ])}
    `;
  }
  if (billingDetailTab === 'appeals') {
    return billingSectionTable('申诉', ['ID', '申诉号', '状态', '关闭原因', '申诉内容', '处理原因', '时间'], billing.appeals || [], row => [
      row.id,
      row.appeal_no,
      appealStatusLabel(row.status),
      row.reason_label || row.reason_code || '-',
      row.content || '-',
      row.result_reason || '-',
      fmtTime(row.reviewed_at || row.created_at),
    ]);
  }
  if (billingDetailTab === 'audit') {
    return billingSectionTable('审计', ['ID', '动作', '对象', '原因', '凭证', '时间'], billing.audit_logs || [], row => [
      row.id,
      row.action,
      `${row.target_type || '-'} #${row.target_id || '-'}`,
      row.reason || '-',
      auditVoucherText(row.after_json),
      fmtTime(row.created_at),
    ]);
  }
  if (billingDetailTab === 'events') {
    return billingSectionTable('事件', ['ID', '事件', '版本', '对象', '状态', '重试', '时间'], billing.events || [], row => [
      row.id,
      row.event_type,
      row.event_version || 1,
      `${row.aggregate_type || '-'} #${row.aggregate_id || '-'}`,
      eventStatusLabel(row.status),
      row.retry_count || 0,
      fmtTime(row.created_at),
    ]);
  }
  return `
    <div class="detail-grid">
      <div class="detail-cell"><span>当前权益</span><strong>${billing.shop_visible ? '店铺可见' : '店铺不可见'}</strong></div>
      <div class="detail-cell"><span>权益到期</span><strong>${entitlement.expire_at ? fmtTime(entitlement.expire_at) : '-'}</strong></div>
      <div class="detail-cell"><span>只读模式</span><strong>${entitlement.readonly_mode ? '是' : '否'}</strong></div>
      <div class="detail-cell"><span>最近事件</span><strong>${(billing.events || []).length} 条</strong></div>
      <div class="detail-cell"><span>订单数量</span><strong>${(billing.orders || []).length} 条</strong></div>
      <div class="detail-cell"><span>支付记录</span><strong>${(billing.payments || []).length} 条</strong></div>
      <div class="detail-cell"><span>订阅记录</span><strong>${(billing.subscriptions || []).length} 条</strong></div>
      <div class="detail-cell"><span>申诉记录</span><strong>${(billing.appeals || []).length} 条</strong></div>
      <div class="detail-cell"><span>审计记录</span><strong>${(billing.audit_logs || []).length} 条</strong></div>
    </div>
  `;
}

function billingEntitlementSummaryHtml(entitlement) {
  const feature = entitlement.feature || entitlement.feature_json || {};
  const limit = entitlement.limit || entitlement.limit_json || {};
  return `
    <div class="detail-grid">
      <div class="detail-cell"><span>权益状态</span><strong>${billingStatusLabel(entitlement.status)}</strong></div>
      <div class="detail-cell"><span>到期时间</span><strong>${entitlement.expire_at ? fmtTime(entitlement.expire_at) : '-'}</strong></div>
      <div class="detail-cell"><span>店铺展示</span><strong>${feature.shop_visible === false ? '关闭' : '开启'}</strong></div>
      <div class="detail-cell"><span>搜索展示</span><strong>${feature.search_visible === false ? '关闭' : '开启'}</strong></div>
      <div class="detail-cell"><span>地图展示</span><strong>${feature.map_visible === false ? '关闭' : '开启'}</strong></div>
      <div class="detail-cell"><span>产品展示</span><strong>${feature.product_showcase === false ? '关闭' : '开启'}</strong></div>
      <div class="detail-cell"><span>产品数量</span><strong>${esc(limit.product_limit ?? '-')}</strong></div>
      <div class="detail-cell"><span>案例数量</span><strong>${esc(limit.case_limit ?? '-')}</strong></div>
    </div>
  `;
}

function billingOrdersTable(rows) {
  const body = rows.length
    ? rows.map(row => `
      <tr>
        <td>${esc(row.id)}</td>
        <td>${esc(row.order_no)}</td>
        <td>${esc(orderStatusLabel(row.status))}</td>
        <td>${esc(moneyText(row.amount_cents, row.currency))}</td>
        <td>${esc(row.payment_channel)}</td>
        <td>${esc(fmtTime(row.paid_at || row.created_at))}</td>
        <td><button class="action-btn" onclick="viewBillingOrder(${Number(row.id || 0)})">查看订单</button></td>
      </tr>
    `).join('')
    : '<tr><td colspan="7" style="text-align:center;color:#999;padding:22px;">暂无订单记录</td></tr>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th colspan="7">订单</th></tr><tr><th>ID</th><th>订单号</th><th>状态</th><th>金额</th><th>渠道</th><th>支付时间</th><th>操作</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function viewBillingOrder(orderId) {
  const box = document.getElementById('billing-order-detail');
  if (!box) return;
  box.innerHTML = '<div class="placeholder">正在加载订单详情...</div>';
  try {
    const j = await adminFetch(`/billing/orders/${orderId}`);
    if (j.code !== 200) throw new Error(j.message || '加载失败');
    box.innerHTML = billingOrderDetailHtml(j.data || {});
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    box.innerHTML = `<div class="placeholder" style="border-color:#fecdca;color:#b42318;">${esc(e.message || '订单详情加载失败')}</div>`;
  }
}

function billingOrderDetailHtml(data) {
  const order = data.order || {};
  return `
    <div class="card item-panel">
      <div class="card-title">
        <div>
          <h3>订单详情 ${esc(order.order_no || '')}</h3>
          <p>${esc(order.merchant_name || '-')} · ${esc(order.phone || '-')} · ${orderStatusLabel(order.status)}</p>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-cell"><span>订单金额</span><strong>${moneyText(order.amount_cents, order.currency)}</strong></div>
        <div class="detail-cell"><span>支付渠道</span><strong>${esc(order.payment_channel || '-')}</strong></div>
        <div class="detail-cell"><span>支付时间</span><strong>${fmtTime(order.paid_at)}</strong></div>
        <div class="detail-cell"><span>创建时间</span><strong>${fmtTime(order.created_at)}</strong></div>
      </div>
      ${billingSectionTable('订单支付', ['ID', '支付号', '状态', '金额', '渠道', '支付时间'], data.payments || [], row => [
        row.id,
        row.payment_no,
        paymentStatusLabel(row.status),
        moneyText(row.amount_cents, row.currency),
        row.payment_channel,
        fmtTime(row.paid_at || row.created_at),
      ])}
      ${billingSectionTable('订单订阅', ['ID', '订阅号', '状态', '主订阅', '开始', '到期', '原因'], data.subscriptions || [], row => [
        row.id,
        row.subscription_no,
        billingStatusLabel(row.status),
        row.is_primary ? '是' : '否',
        fmtTime(row.started_at),
        fmtTime(row.expire_at),
        row.reason || '-',
      ])}
      ${billingSectionTable('订单权益', ['ID', '订阅', '状态', '来源', '只读', '原因', '到期'], data.entitlements || [], row => [
        row.id,
        row.subscription_id || '-',
        billingStatusLabel(row.status),
        `${row.source_type || '-'} #${row.source_id || '-'}`,
        row.readonly_mode ? '是' : '否',
        row.reason || '-',
        fmtTime(row.expire_at),
      ])}
      ${billingSectionTable('订单审计', ['ID', '动作', '对象', '原因', '凭证', '时间'], data.audits || [], row => [
        row.id,
        row.action,
        `${row.target_type || '-'} #${row.target_id || '-'}`,
        row.reason || '-',
        auditVoucherText(row.after_json),
        fmtTime(row.created_at),
      ])}
      ${billingSectionTable('订单事件', ['ID', '事件', '版本', '对象', '状态', '重试', '时间'], data.events || [], row => [
        row.id,
        row.event_type,
        row.event_version || 1,
        `${row.aggregate_type || '-'} #${row.aggregate_id || '-'}`,
        eventStatusLabel(row.status),
        row.retry_count || 0,
        fmtTime(row.updated_at || row.created_at),
      ])}
    </div>
  `;
}

function billingSectionTable(title, headers, rows, mapper) {
  const body = rows.length
    ? rows.map(row => `<tr>${mapper(row).map(value => `<td>${esc(value)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" style="text-align:center;color:#999;padding:22px;">暂无${esc(title)}记录</td></tr>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th colspan="${headers.length}">${esc(title)}</th></tr><tr>${headers.map(item => `<th>${esc(item)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function orderStatusLabel(status) {
  return {
    pending_payment: '待支付',
    paid: '已支付',
    closed: '已关闭',
    refunded: '已退款',
  }[status] || status || '-';
}

function orderStatusClass(status) {
  return {
    pending_payment: 'status-pending',
    paid: 'status-approved',
    closed: 'status-hidden',
    refunded: 'status-rejected',
  }[status] || 'status-hidden';
}

function paymentStatusLabel(status) {
  return {
    succeeded: '成功',
    failed: '失败',
    pending: '处理中',
    refunded: '已退款',
  }[status] || status || '-';
}

function billingStatusLabel(status) {
  return {
    active: '生效中',
    expired: '已到期',
    cancelled: '已取消',
    inactive: '未生效',
  }[status] || status || '-';
}

function billingStatusClass(status) {
  return {
    active: 'status-approved',
    expired: 'status-hidden',
    cancelled: 'status-rejected',
    inactive: 'status-hidden',
  }[status] || 'status-hidden';
}

function appealStatusLabel(status) {
  return {
    pending: '待处理',
    approved: '已通过',
    rejected: '已驳回',
    cancelled: '已取消',
  }[status] || status || '-';
}

function appealStatusClass(status) {
  return {
    pending: 'status-pending',
    approved: 'status-approved',
    rejected: 'status-rejected',
    cancelled: 'status-hidden',
  }[status] || 'status-hidden';
}

function eventStatusLabel(status) {
  return {
    pending: '待处理',
    processed: '已处理',
    failed: '失败',
    dead_letter: '死信',
    ignored: '已忽略',
  }[status] || status || '-';
}

function auditVoucherText(value) {
  const data = parseMaybeJson(value);
  const manual = data.manual_compensation || data.refund_processing || {};
  if (!manual.voucher_note && manual.amount_cents === undefined) return '-';
  return `${moneyText(manual.amount_cents || 0, manual.currency || 'CNY')} · ${manual.voucher_note || '-'}`;
}

function parseMaybeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return {};
  }
}

function moneyText(amountCents, currency) {
  const amount = Number(amountCents || 0) / 100;
  return `${currency || 'CNY'} ${amount.toFixed(2)}`;
}
