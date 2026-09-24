(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = $('deck');
  const slidesRoot = $('slides');
  const errorRoot = $('viewer-error');
  const fullscreenButton = $('fullscreen-button');
  const overlays = [$('overview-overlay'), $('lightbox'), $('product-overlay')];
  let deck, documentData, pagePlan, assets, sourceSlides, spaces, products;
  let planProductIds = [];
  let currentProductIndex = 0;
  let currentProductImageIndex = 0;

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }
  const text = value => value == null ? '' : String(value).trim();
  const unique = values => [...new Set(values.filter(Boolean))];
  const source = page => sourceSlides.get(String(page.source_slide_id)) || {};
  const space = page => spaces.get(String(page.space_id || '')) || {};
  const productById = id => products.get(String(id));
  const pageTitle = page => text(page.title_override) || text(source(page).title) || text(space(page).name) || '设计提案';
  const assetList = ids => (ids || []).map(id => assets.get(String(id))).filter(Boolean);
  const productAssets = productId => {
    const seen = new Set();
    return [...assets.values()].filter(asset => {
      if (asset.source_type !== 'scheme_product' || String(asset.source_id) !== String(productId) || !asset.url || seen.has(asset.url)) return false;
      seen.add(asset.url);
      return true;
    });
  };
  const safeHttpUrl = value => {
    try {
      const url = new URL(text(value));
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  };

  function media(asset, className = '') {
    const button = node('button', `media ${className}`.trim());
    button.type = 'button';
    if (asset?.url && /^https?:\/\//i.test(asset.url)) {
      button.dataset.assetId = asset.asset_id;
      button.setAttribute('aria-label', `查看大图：${text(asset.title) || '方案图片'}`);
      const image = node('img');
      image.src = asset.url;
      image.alt = text(asset.title) || '方案图片';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      button.append(image);
    } else {
      button.disabled = true;
      button.append(node('span', 'media-empty', '图片暂不可用'));
    }
    return button;
  }

  function shell(page) {
    const section = node('section');
    section.id = page.page_id;
    section.dataset.pageId = page.page_id;
    section.dataset.pageType = page.type;
    if (page.space_id) section.dataset.spaceId = page.space_id;
    const content = node('div', `layout ${page.layout}`);
    section.append(content);
    return { section, content };
  }
  function footer(content, pageNumber, label = '') {
    const element = node('div', 'page-footer');
    element.append(node('span', '', label), node('span', '', String(pageNumber).padStart(2, '0')));
    content.append(element);
  }

  function renderCover(page, number) {
    const { section, content } = shell(page);
    const [hero] = assetList(page.asset_ids);
    if (hero?.url) content.append(media(hero, 'cover-media'));
    content.append(node('div', 'cover-wash'));
    const copy = node('div', 'cover-copy');
    copy.append(node('div', 'eyebrow', 'Interior design proposal'), node('h1', '', pageTitle(page)));
    const subtitle = text(source(page).subtitle) || text(documentData.presentation?.stage);
    if (subtitle) copy.append(node('p', '', subtitle));
    content.append(copy);
    footer(content, number, '装筱窝 · 让美好空间触手可及');
    return section;
  }

  function factRows(values) {
    const list = node('div', 'editorial-facts');
    values.forEach(([label, value]) => {
      if (!text(value)) return;
      const row = node('div', 'editorial-fact');
      row.append(node('span', '', label), node('strong', '', value));
      list.append(row);
    });
    return list;
  }
  function renderProfile(page, number) {
    const { section, content } = shell(page);
    const project = source(page).project || documentData.project || {};
    const head = node('div', 'editorial-head');
    head.append(node('div', 'eyebrow', 'Project profile'), node('h1', '', pageTitle(page)));
    content.append(head, factRows([
      ['项目', project.project_name], ['客户', project.client_name],
      ['面积', project.house_area ? `${project.house_area}㎡` : ''], ['户型', project.house_layout],
      ['位置', [project.project_city, project.project_address].filter(Boolean).join(' · ')], ['预算', project.budget_range],
    ]));
    footer(content, number, '项目概况');
    return section;
  }
  function renderBrief(page, number) {
    const { section, content } = shell(page);
    const values = source(page).facts || {};
    content.append(node('div', 'eyebrow', 'Design brief'), node('h1', 'brief-title', pageTitle(page)));
    const list = node('div', 'brief-list');
    [['居住成员', values.resident_info], ['生活习惯', values.lifestyle_notes], ['风格偏好', values.style_preference], ['重点空间', values.key_spaces], ['特殊需求', values.special_needs]].forEach(([label, value]) => {
      if (!text(value)) return;
      const item = node('div', 'brief-item');
      item.append(node('span', '', label), node('p', '', value));
      list.append(item);
    });
    if (!list.childElementCount) list.append(node('p', 'empty-copy', '客户需求资料待完善'));
    content.append(list);
    footer(content, number, '设计需求');
    return section;
  }
  function renderPlanGallery(page, number) {
    const { section, content } = shell(page);
    const head = node('div', 'compact-head');
    head.append(node('div', 'eyebrow', 'Planning'), node('h1', '', pageTitle(page)));
    const items = assetList(page.asset_ids);
    const gallery = node('div', `plan-gallery count-${items.length}`);
    items.forEach(asset => gallery.append(media(asset)));
    content.append(head, gallery);
    footer(content, number, '全屋规划');
    return section;
  }
  function renderChapter(page, number) {
    const { section, content } = shell(page);
    const hero = [...assets.values()].find(asset => String(asset.space_id) === String(page.space_id) && asset.image_role === 'rendering');
    if (hero?.url) content.append(media(hero, 'section-media'));
    content.append(node('div', 'section-wash'));
    const copy = node('div', 'section-copy');
    copy.append(node('span', 'section-index', String(number).padStart(2, '0')));
    copy.append(node('div', 'eyebrow', 'Space chapter'), node('h1', '', pageTitle(page)), node('p', '', `${space(page).name || '空间'} · 设计与产品选用`));
    const fullDescription = text(source(page).description) || text(space(page).design_description);
    const range = Array.isArray(page.description_range) ? page.description_range : null;
    const description = range ? text(fullDescription.slice(range[0], range[1])) : '';
    if (description) {
      const points = node('div', 'chapter-design-points');
      points.append(node('span', '', '设计要点'), node('p', '', description));
      copy.append(points);
    }
    content.append(copy);
    return section;
  }
  function renderSpaceHero(page, number) {
    const { section, content } = shell(page);
    content.append(media(assetList(page.asset_ids)[0], 'space-hero-media'));
    const caption = node('div', 'space-hero-caption');
    caption.append(node('span', 'eyebrow', 'Space design'), node('h1', '', pageTitle(page)));
    content.append(caption);
    footer(content, number, space(page).name || '空间效果');
    return section;
  }
  function renderSpaceStory(page, number) {
    const { section, content } = shell(page);
    const visual = node('div', 'narrative-visual');
    const visuals = assetList(page.asset_ids);
    if (visuals.length) visuals.forEach(asset => visual.append(media(asset)));
    else visual.append(node('div', 'narrative-number', String(number).padStart(2, '0')));
    const copy = node('div', 'narrative-copy');
    copy.append(node('div', 'eyebrow', 'Design narrative'), node('h1', '', pageTitle(page)));
    const fullDescription = text(source(page).description) || text(space(page).design_description);
    const range = Array.isArray(page.description_range) ? page.description_range : null;
    const description = range ? text(fullDescription.slice(range[0], range[1])) : fullDescription;
    if (description) copy.append(node('p', '', description));
    content.append(visual, copy);
    footer(content, number, space(page).name || '空间说明');
    return section;
  }
  function renderMoodboard(page, number) {
    const { section, content } = shell(page);
    const head = node('div', 'compact-head');
    head.append(node('div', 'eyebrow', 'Material & mood'), node('h1', '', `${pageTitle(page).replace(/设计$/, '')} · 材质与意向`));
    const items = assetList(page.asset_ids);
    const gallery = node('div', `material-board count-${items.length}`);
    items.forEach((asset, index) => {
      const item = node('div', `material-item item-${index + 1}`);
      item.append(media(asset), node('span', '', text(asset.title)));
      gallery.append(item);
    });
    content.append(head, gallery);
    footer(content, number, space(page).name || '材质意向');
    return section;
  }

  function dimensionText(product) {
    const dimensions = product?.dimensions;
    if (dimensions && typeof dimensions === 'object') {
      const labels = { width: '宽', depth: '深', height: '高', length: '长', diameter: '直径', side: '边长' };
      const values = Object.entries(dimensions).filter(([, value]) => value != null && value !== '').map(([key, value]) => `${labels[key] || key}${value}`);
      if (values.length) return `${values.join(' × ')} ${product.dimension_unit || ''}`.trim();
    }
    return text(product?.specification);
  }
  function priceText(product) {
    return product?.customer_quote == null ? '' : `¥ ${Number(product.customer_quote).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  }
  function materialText(product) {
    return (product?.materials || []).map(item => [item.part, item.name || item.material, item.code].filter(Boolean).join(' · ')).filter(Boolean).join(' / ');
  }
  function productVisual(product, mode = '') {
    const button = node('button', `product-visual ${mode}`.trim());
    button.type = 'button';
    button.dataset.productId = product.id;
    button.setAttribute('aria-label', `查看产品详情：${product.name}`);
    const asset = productAssets(product.id)[0];
    if (asset?.url) {
      const image = node('img'); image.src = asset.url; image.alt = product.name; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; button.append(image);
    } else button.append(node('span', 'media-empty', '暂无产品图片'));
    return button;
  }
  function productCopy(product, level = 'h2') {
    const copy = node('div', 'product-copy');
    copy.append(node('div', 'product-brand meta-brand', product.brand || '精选产品'));
    copy.append(node(level, 'product-name', product.name));
    const dimension = dimensionText(product);
    if (dimension) copy.append(node('div', 'product-spec meta-dimensions', dimension));
    const material = materialText(product);
    if (material) copy.append(node('div', 'product-material', material));
    const price = priceText(product);
    if (price) copy.append(node('div', 'product-price meta-price', price));
    return copy;
  }
  function renderProductFeature(page, number) {
    const { section, content } = shell(page);
    const product = productById(page.product_ids?.[0]);
    content.append(productVisual(product), productCopy(product));
    footer(content, number, space(page).name || '产品选用');
    return section;
  }
  function renderProductDuo(page, number) {
    const { section, content } = shell(page);
    content.append(node('div', 'eyebrow duo-kicker', `${space(page).name || ''} · Product selection`));
    const grid = node('div', 'product-duo-grid');
    (page.product_ids || []).map(productById).filter(Boolean).forEach(product => {
      const item = node('div', 'product-duo-item');
      item.append(productVisual(product), productCopy(product));
      grid.append(item);
    });
    content.append(grid);
    footer(content, number, space(page).name || '产品选用');
    return section;
  }
  function renderProductGrid(page, number) {
    const { section, content } = shell(page);
    const head = node('div', 'compact-head');
    head.append(node('div', 'eyebrow', `${space(page).name || ''} · Product selection`), node('h1', '', pageTitle(page)));
    const grid = node('div', `proposal-product-grid count-${(page.product_ids || []).length}`);
    (page.product_ids || []).map(productById).filter(Boolean).forEach(product => {
      const item = node('div', 'proposal-product');
      item.append(productVisual(product, 'compact'), productCopy(product));
      grid.append(item);
    });
    content.append(head, grid);
    footer(content, number, space(page).name || '产品选用');
    return section;
  }
  function renderEnd(page, number) {
    const { section, content } = shell(page);
    content.append(node('div', 'eyebrow', 'Thank you'), node('h1', '', pageTitle(page) || '感谢观看'), node('p', '', documentData.presentation?.title || '装筱窝设计方案'));
    footer(content, number, '装筱窝 · 让美好空间触手可及');
    return section;
  }

  const renderers = {
    cover: renderCover, project_profile: renderProfile, client_requirements: renderBrief,
    whole_house_plan: renderPlanGallery, chapter: renderChapter, space_hero: renderSpaceHero,
    space_story: renderSpaceStory, moodboard: renderMoodboard,
    product_feature: renderProductFeature, product_duo: renderProductDuo,
    product_grid: renderProductGrid, end: renderEnd,
  };
  function renderPage(page, number) {
    if (!renderers[page.type]) throw Error(`暂不支持页面类型：${page.type}`);
    return renderers[page.type](page, number);
  }

  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function syncFullscreenState() {
    const active = Boolean(fullscreenElement()) || document.body.classList.contains('presentation-mode');
    document.body.classList.toggle('fullscreen-active', active);
    fullscreenButton.textContent = active ? '退出全屏' : '全屏展示';
    fullscreenButton.setAttribute('aria-pressed', String(active));
  }
  async function toggleFullscreen() {
    if (document.body.classList.contains('presentation-mode')) {
      document.body.classList.remove('presentation-mode'); syncFullscreenState(); return;
    }
    if (fullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
      syncFullscreenState(); return;
    }
    const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (request) {
      try { await request.call(document.documentElement); if (fullscreenElement()) { syncFullscreenState(); return; } } catch (_) {}
    }
    document.body.classList.add('presentation-mode'); syncFullscreenState();
  }
  function setOverlay(element, open) {
    element.hidden = !open;
    document.body.classList.toggle('overlay-open', overlays.some(item => !item.hidden));
  }
  function openLightbox(assetId) {
    const asset = assets.get(String(assetId));
    if (!asset?.url) return;
    $('lightbox-image').src = asset.url;
    $('lightbox-caption').textContent = asset.title || '';
    setOverlay($('lightbox'), true);
  }
  function renderProductGallery(product) {
    const gallery = $('product-dialog-gallery'); gallery.replaceChildren();
    const images = productAssets(product.id).slice(0, 8);
    if (!images.length) {
      gallery.append(node('div', 'media-empty', '暂无产品图片'));
      return;
    }
    currentProductImageIndex = Math.min(currentProductImageIndex, images.length - 1);
    const stage = node('div', 'product-gallery-stage');
    stage.append(media(images[currentProductImageIndex], 'product-gallery-main'));
    if (images.length > 1) {
      const previous = node('button', 'product-gallery-arrow previous', '‹');
      previous.type = 'button'; previous.setAttribute('aria-label', '上一张产品图片');
      previous.addEventListener('click', event => { event.stopPropagation(); moveProductImage(-1); });
      const next = node('button', 'product-gallery-arrow next', '›');
      next.type = 'button'; next.setAttribute('aria-label', '下一张产品图片');
      next.addEventListener('click', event => { event.stopPropagation(); moveProductImage(1); });
      stage.append(previous, next, node('span', 'product-image-position', `${currentProductImageIndex + 1} / ${images.length}`));
    }
    gallery.append(stage);
    if (images.length > 1) {
      const thumbs = node('div', 'product-gallery-thumbs');
      images.forEach((asset, index) => {
        const button = node('button', `product-gallery-thumb${index === currentProductImageIndex ? ' active' : ''}`);
        button.type = 'button'; button.setAttribute('aria-label', `查看第 ${index + 1} 张产品图片`);
        const image = node('img'); image.src = asset.url; image.alt = text(asset.title) || `产品图片 ${index + 1}`; image.referrerPolicy = 'no-referrer';
        button.append(image);
        button.addEventListener('click', () => { currentProductImageIndex = index; renderProductGallery(product); });
        thumbs.append(button);
      });
      gallery.append(thumbs);
    }
  }
  function moveProductImage(delta) {
    const product = productById(planProductIds[currentProductIndex]);
    const count = product ? productAssets(product.id).slice(0, 8).length : 0;
    if (count < 2) return;
    currentProductImageIndex = (currentProductImageIndex + delta + count) % count;
    renderProductGallery(product);
  }
  function openNativeProduct(product) {
    if (!product?.public_product_id) return false;
    const message = { type: 'open_public_product', product_id: Number(product.public_product_id) };
    if (window.ZhuangxiaoBridge?.postMessage) {
      window.ZhuangxiaoBridge.postMessage(JSON.stringify(message));
      return true;
    }
    if (window.chrome?.webview?.postMessage) {
      window.chrome.webview.postMessage(message);
      return true;
    }
    return false;
  }
  function renderProductDialog() {
    const product = productById(planProductIds[currentProductIndex]);
    if (!product) return;
    $('product-dialog-title').textContent = product.name;
    renderProductGallery(product);
    const meta = $('product-dialog-meta'); meta.replaceChildren();
    [
      ['品牌', product.brand, 'meta-brand'], ['尺寸', dimensionText(product), 'meta-dimensions'],
      ['材质', materialText(product), ''], ['颜色', (product.colors || []).join(' / '), ''],
      ['规格', product.configuration, ''], ['数量', product.quantity, ''],
      ['价格', priceText(product), 'meta-price'], ['说明', product.note || product.description, ''],
    ].forEach(([label, value, className]) => {
      if (!text(value)) return;
      const row = node('div', `product-detail-row ${className}`.trim());
      row.append(node('span', '', label), node('strong', '', value)); meta.append(row);
    });
    const officialUrl = safeHttpUrl(product.official_url);
    if (officialUrl) {
      const row = node('div', 'product-detail-row product-official-link');
      const link = node('a', '', '访问产品官网');
      link.href = officialUrl;
      link.rel = 'noreferrer';
      row.append(node('span', '', '官网'), link);
      meta.append(row);
    }
    $('product-position').textContent = `${currentProductIndex + 1} / ${planProductIds.length}`;
    $('previous-product').disabled = planProductIds.length < 2;
    $('next-product').disabled = planProductIds.length < 2;
  }
  function openProduct(productId) {
    const index = planProductIds.indexOf(String(productId));
    if (index < 0) return;
    currentProductIndex = index;
    const product = productById(planProductIds[currentProductIndex]);
    if (openNativeProduct(product)) return;
    currentProductImageIndex = 0; renderProductDialog(); setOverlay($('product-overlay'), true);
  }
  function moveProduct(delta) {
    if (!planProductIds.length) return;
    currentProductIndex = (currentProductIndex + delta + planProductIds.length) % planProductIds.length;
    currentProductImageIndex = 0;
    renderProductDialog();
  }
  function buildOverview(visiblePages) {
    const grid = $('overview-grid'); grid.replaceChildren();
    visiblePages.forEach((page, index) => {
      const button = node('button', 'overview-item');
      button.type = 'button'; button.dataset.slideIndex = index;
      const preview = assetList(page.asset_ids)[0];
      if (preview?.url) { const image = node('img'); image.src = preview.url; image.alt = ''; image.referrerPolicy = 'no-referrer'; button.append(image); }
      button.append(node('span', 'overview-number', String(index + 1).padStart(2, '0')), node('strong', '', pageTitle(page)), node('small', '', space(page).name || page.type.replaceAll('_', ' ')));
      grid.append(button);
    });
  }
  function applyDisplaySettings() {
    document.body.classList.toggle('hide-brand', !$('toggle-brand').checked);
    document.body.classList.toggle('hide-price', !$('toggle-price').checked);
    document.body.classList.toggle('hide-dimensions', !$('toggle-dimensions').checked);
  }
  function bindInteractions() {
    fullscreenButton.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    $('overview-button').addEventListener('click', () => setOverlay($('overview-overlay'), true));
    $('display-button').addEventListener('click', () => {
      $('display-menu').hidden = !$('display-menu').hidden;
      $('display-button').setAttribute('aria-expanded', String(!$('display-menu').hidden));
    });
    ['brand', 'price', 'dimensions'].forEach(key => $(`toggle-${key}`).addEventListener('change', applyDisplaySettings));
    $('theme-select').addEventListener('change', () => {
      document.body.dataset.theme = $('theme-select').value;
    });
    document.addEventListener('click', event => {
      const mediaButton = event.target.closest('[data-asset-id]');
      const productButton = event.target.closest('[data-product-id]');
      const close = event.target.closest('[data-close]');
      const overviewItem = event.target.closest('[data-slide-index]');
      if (mediaButton) openLightbox(mediaButton.dataset.assetId);
      if (productButton) openProduct(productButton.dataset.productId);
      if (overviewItem) { deck.slide(Number(overviewItem.dataset.slideIndex)); setOverlay($('overview-overlay'), false); }
      if (close?.dataset.close === 'overview') setOverlay($('overview-overlay'), false);
      if (close?.dataset.close === 'lightbox') setOverlay($('lightbox'), false);
      if (close?.dataset.close === 'product') setOverlay($('product-overlay'), false);
      if (!$('display-menu').hidden && !event.target.closest('#display-menu') && !event.target.closest('#display-button')) {
        $('display-menu').hidden = true; $('display-button').setAttribute('aria-expanded', 'false');
      }
    });
    $('previous-product').addEventListener('click', () => moveProduct(-1));
    $('next-product').addEventListener('click', () => moveProduct(1));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { overlays.forEach(item => setOverlay(item, false)); return; }
      if (!$('product-overlay').hidden && event.key === 'ArrowLeft') { moveProduct(-1); event.preventDefault(); return; }
      if (!$('product-overlay').hidden && event.key === 'ArrowRight') { moveProduct(1); event.preventDefault(); return; }
      if (overlays.some(item => !item.hidden) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key === 'ArrowLeft') deck.prev();
      else if (event.key === 'ArrowRight') deck.next();
      else return;
      event.preventDefault();
    });
    root.setAttribute('tabindex', '-1');
    root.addEventListener('pointerdown', () => root.focus({ preventScroll: true }));
    root.focus({ preventScroll: true });
    syncFullscreenState();
  }

  async function load() {
    try {
      const endpoint = `${location.pathname.replace(/\/preview$/, '/preview-data')}${location.search}`;
      const response = await fetch(endpoint, { cache: 'no-store', credentials: 'omit' });
      const payload = await response.json();
      if (!response.ok || !payload.data?.document || !payload.data?.page_plan) throw Error(payload.message || '汇报方案读取失败');
      documentData = payload.data.document;
      pagePlan = payload.data.page_plan;
      const themeId = pagePlan.theme_id || 'modern_minimal';
      document.body.dataset.theme = themeId;
      $('theme-select').value = themeId;
      const visiblePages = (pagePlan.pages || []).filter(page => page.hidden !== true).sort((a, b) => Number(a.order) - Number(b.order));
      if (!visiblePages.length) throw Error('汇报方案没有可展示的页面');
      $('viewer-title').textContent = documentData.presentation?.title || payload.data.title || '方案汇报';
      document.title = `${$('viewer-title').textContent} · 装筱窝`;
      assets = new Map((documentData.asset_manifest || []).map(item => [String(item.asset_id), item]));
      sourceSlides = new Map((documentData.slides || []).map(item => [String(item.id), item]));
      spaces = new Map((documentData.spaces || []).map(item => [String(item.id), item]));
      products = new Map((documentData.spaces || []).flatMap(item => item.products || []).map(item => [String(item.id), item]));
      planProductIds = unique(visiblePages.flatMap(page => page.product_ids || []).map(String)).filter(id => products.has(id));
      visiblePages.forEach((page, index) => slidesRoot.append(renderPage(page, index + 1)));
      buildOverview(visiblePages);
      const display = pagePlan.display || {};
      $('toggle-brand').checked = display.show_brand !== false;
      $('toggle-price').checked = display.show_price === true;
      $('toggle-dimensions').checked = display.show_dimensions !== false;
      applyDisplaySettings();
      const portrait = window.innerWidth < 700 && window.innerHeight > window.innerWidth;
      if (portrait) root.classList.add('portrait-deck');
      deck = new Reveal(root, {
        embedded: true, hash: true, controls: true, controlsLayout: 'edges', progress: true,
        keyboard: false, center: false, transition: 'fade', width: portrait ? 640 : 1280,
        height: portrait ? 1180 : 720, margin: 0,
      });
      await deck.initialize();
      bindInteractions();
    } catch (error) {
      errorRoot.hidden = false;
      errorRoot.textContent = error.message || '汇报方案打开失败';
    }
  }
  load();
})();
