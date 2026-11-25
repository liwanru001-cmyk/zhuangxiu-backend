/* global window, document, fetch, sessionStorage, localStorage, FormData */
(() => {
  const element = id => document.getElementById(id);
  const form = element('login');
  const dashboard = element('dashboard');
  const status = element('status');
  const records = element('records');
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let token = sessionStorage.getItem('admin_token') || localStorage.getItem('admin_remember_token');
  let sequence = 0;

  function showLogin(message) {
    form.hidden = false;
    dashboard.hidden = true;
    status.textContent = message;
  }

  function row(values) {
    const tr = document.createElement('tr');
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    return tr;
  }

  function render(data) {
    for (const name of ['missing', 'server']) {
      const count = element(name);
      count.textContent = data.counts[name];
      count.classList.toggle('failure', data.counts[name] > 0);
    }
    records.replaceChildren(...data.rows.map(event => row([
      event.status, event.method + ' ' + event.route, event.count,
      formatter.format(new Date(event.first_at)), formatter.format(new Date(event.last_at)),
    ])));
    element('details').hidden = data.rows.length === 0;
    const result = data.total ? '共 ' + data.total + ' 组异常' : '这个时间范围内暂无记录';
    const limit = data.total > data.rows.length ? '，显示最近 ' + data.rows.length + ' 组' : '';
    const incomplete = data.truncated ? '。部分记录未能收集，次数可能偏少' : '';
    status.textContent = result + limit + ' · 更新于 ' + formatter.format(new Date(data.checked_at)) + '（北京时间）' + incomplete;
  }

  async function load(showLoading = true) {
    if (!token) return showLogin('请登录管理后台账号。');
    form.hidden = true;
    dashboard.hidden = false;
    if (showLoading) status.textContent = '正在读取异常记录…';
    const generation = ++sequence;
    try {
      const response = await fetch('/api/admin/backend-alerts?days=' + element('days').value, {
        headers: { Authorization: 'Bearer ' + token }, cache: 'no-store',
      });
      const payload = await response.json();
      if (generation !== sequence) return;
      if (response.status === 401 || response.status === 403) {
        token = null;
        return showLogin('登录已过期，请重新登录。');
      }
      if (!response.ok || payload.code !== 200) throw new Error('读取异常记录失败');
      render(payload.data);
    } catch {
      if (generation === sequence) status.textContent = '读取失败，请刷新重试。上次读取的记录仍保留在页面上。';
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const payload = await response.json();
      if (!response.ok || payload.code !== 200) {
        status.textContent = payload.message || '登录失败，请重试。';
        return;
      }
      token = payload.data.token;
      sessionStorage.setItem('admin_token', token);
      form.reset();
      await load();
    } catch {
      status.textContent = '暂时无法登录，请重试。';
    } finally {
      button.disabled = false;
    }
  });

  element('days').addEventListener('change', () => load());
  element('refresh').addEventListener('click', () => load());
  window.setInterval(() => {
    if (token && document.visibilityState === 'visible') load(false);
  }, 60000);
  load();
})();
