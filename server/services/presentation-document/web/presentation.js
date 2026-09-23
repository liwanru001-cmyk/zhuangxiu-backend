(() => {
  'use strict';
  const root = document.getElementById('deck');
  const slidesRoot = document.getElementById('slides');
  const errorRoot = document.getElementById('viewer-error');
  const titleRoot = document.getElementById('viewer-title');
  const fullscreenButton = document.getElementById('fullscreen-button');

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function syncFullscreenState() {
    const active = Boolean(fullscreenElement()) || document.body.classList.contains('presentation-mode');
    document.body.classList.toggle('fullscreen-active', active);
    fullscreenButton.textContent = active ? '退出全屏' : '全屏展示';
    fullscreenButton.setAttribute('aria-label', active ? '退出全屏' : '全屏展示');
    fullscreenButton.setAttribute('aria-pressed', String(active));
  }

  async function toggleFullscreen() {
    if (document.body.classList.contains('presentation-mode')) {
      document.body.classList.remove('presentation-mode');
      syncFullscreenState();
      return;
    }
    if (fullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
      syncFullscreenState();
      return;
    }

    const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (request) {
      try {
        await request.call(document.documentElement);
        if (fullscreenElement()) {
          syncFullscreenState();
          return;
        }
      } catch (_) {
        // Embedded WebViews commonly expose the API but reject the request.
      }
    }

    document.body.classList.add('presentation-mode');
    syncFullscreenState();
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }
  function text(value) { return value == null ? '' : String(value).trim(); }
  function appendIf(parent, label, value) {
    if (!text(value)) return;
    const fact = node('div', 'fact');
    fact.append(node('div', 'fact-label', label), node('div', 'fact-value', value));
    parent.append(fact);
  }
  function image(asset, hero = false) {
    const frame = node('div', `image-frame${hero ? ' hero' : ''}`);
    if (asset && /^https?:\/\//i.test(text(asset.url))) {
      const picture = node('img');
      picture.src = asset.url;
      picture.alt = text(asset.title) || '方案图片';
      picture.loading = 'lazy';
      picture.referrerPolicy = 'no-referrer';
      frame.append(picture);
    } else frame.append(node('span', '', '图片暂不可用'));
    return frame;
  }
  function renderSlide(slide, documentData, assets, number) {
    const section = node('section');
    const shell = node('div', `slide-shell ${slide.type || ''}`);
    section.append(shell);
    shell.append(node('div', 'slide-kicker', '装筱窝 · 设计方案汇报'));
    shell.append(node('h1', 'slide-title', slide.title || '未命名页面'));
    if (slide.subtitle) shell.append(node('div', 'slide-subtitle', slide.subtitle));
    const body = node('div', 'slide-body');
    shell.append(body);

    if (slide.type === 'cover') {
      const first = assets.get((slide.asset_ids || [])[0]);
      if (first) body.append(image(first, true));
    } else if (slide.type === 'project_profile') {
      const facts = node('div', 'fact-grid');
      const project = slide.project || documentData.project || {};
      appendIf(facts, '项目', project.project_name);
      appendIf(facts, '客户', project.client_name);
      appendIf(facts, '面积', project.house_area ? `${project.house_area}㎡` : '');
      appendIf(facts, '户型', project.house_layout);
      appendIf(facts, '位置', [project.project_city, project.project_address].filter(Boolean).join(' · '));
      appendIf(facts, '预算', project.budget_range);
      body.append(facts);
    } else if (slide.type === 'client_requirements') {
      const facts = node('div', 'fact-grid');
      const fields = slide.facts || {};
      appendIf(facts, '居住成员', fields.resident_info);
      appendIf(facts, '生活习惯', fields.lifestyle_notes);
      appendIf(facts, '风格偏好', fields.style_preference);
      appendIf(facts, '重点空间', fields.key_spaces);
      appendIf(facts, '特殊需求', fields.special_needs);
      body.append(facts.childElementCount ? facts : node('div', 'slide-text', '客户需求资料待完善'));
    } else if (slide.type === 'whole_house_plan') {
      const grid = node('div', 'image-grid');
      for (const id of (slide.asset_ids || []).slice(0, 4)) grid.append(image(assets.get(id)));
      body.append(grid);
    } else if (slide.type === 'space_design') {
      const ids = [...(slide.rendering_asset_ids || []), ...(slide.plan_asset_ids || [])];
      const grid = node('div', 'image-grid');
      for (const id of ids.slice(0, 4)) grid.append(image(assets.get(id), id === ids[0]));
      body.append(grid);
      if (text(slide.description)) body.append(node('div', 'space-side', slide.description));
    } else if (slide.type === 'product_selection') {
      const space = (documentData.spaces || []).find(item => String(item.id) === String(slide.space_id));
      const products = new Map((space?.products || []).map(item => [String(item.id), item]));
      const grid = node('div', 'product-grid');
      for (const id of (slide.product_ids || []).slice(0, 6)) {
        const product = products.get(String(id));
        if (!product) continue;
        const card = node('div', 'product-card');
        const productAsset = [...assets.values()].find(asset => asset.source_type === 'scheme_product' && String(asset.source_id) === String(id));
        const frame = node('div', 'product-image');
        if (productAsset?.url) frame.append(image(productAsset).firstChild);
        else frame.append(node('span', '', '暂无图片'));
        card.append(frame, node('div', 'product-name', product.name));
        card.append(node('div', 'product-meta', [product.brand, product.configuration || product.specification].filter(Boolean).join(' · ')));
        grid.append(card);
      }
      body.append(grid);
    } else if (slide.type === 'ending') {
      body.append(node('div', 'slide-text', '感谢观看'));
    } else {
      body.append(node('div', 'slide-text', slide.description || ''));
    }
    shell.append(node('div', 'slide-footer', `${number} / ${documentData.slides.length}`));
    return section;
  }

  async function load() {
    try {
      const endpoint = `${location.pathname.replace(/\/preview$/, '/preview-data')}${location.search}`;
      const response = await fetch(endpoint, { cache: 'no-store', credentials: 'omit' });
      const payload = await response.json();
      if (!response.ok || !payload.data?.document) throw Error(payload.message || '汇报方案读取失败');
      const documentData = payload.data.document;
      if (!Array.isArray(documentData.slides) || !documentData.slides.length) throw Error('汇报方案没有可展示的页面');
      titleRoot.textContent = documentData.presentation?.title || payload.data.title || '方案汇报';
      document.title = `${titleRoot.textContent} · 装筱窝`;
      const assets = new Map((documentData.asset_manifest || []).map(item => [item.asset_id, item]));
      documentData.slides.forEach((slide, index) => slidesRoot.append(renderSlide(slide, documentData, assets, index + 1)));
      const portrait = window.innerWidth < 700 && window.innerHeight > window.innerWidth;
      if (portrait) root.classList.add('portrait-deck');
      const deck = new Reveal(root, {
        embedded: true,
        hash: true,
        controls: true,
        controlsLayout: 'edges',
        progress: true,
        keyboard: false,
        center: false,
        transition: 'fade',
        width: portrait ? 640 : 1280,
        height: portrait ? 1180 : 720,
        margin: 0.03,
      });
      await deck.initialize();
      const handleKeyboardNavigation = event => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        if (event.key === 'ArrowLeft') deck.prev();
        else if (event.key === 'ArrowRight') deck.next();
        else return;
        event.preventDefault();
      };
      document.addEventListener('keydown', handleKeyboardNavigation);
      root.setAttribute('tabindex', '-1');
      root.addEventListener('pointerdown', () => root.focus({ preventScroll: true }));
      root.focus({ preventScroll: true });
      fullscreenButton.addEventListener('click', toggleFullscreen);
      document.addEventListener('fullscreenchange', syncFullscreenState);
      document.addEventListener('webkitfullscreenchange', syncFullscreenState);
      syncFullscreenState();
    } catch (error) {
      errorRoot.hidden = false;
      errorRoot.textContent = error.message || '汇报方案打开失败';
    }
  }
  load();
})();
