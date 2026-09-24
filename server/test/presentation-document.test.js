'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const {
  buildDocument,
  buildPagePlan,
  validatePagePlan,
  find,
  updatePagePlan,
  remove,
} = require('../services/presentation-document.service');
const { buildPptContent } = require('../services/presentation-page-plan');
const {
  previewContentSecurityPolicy,
  setPreviewHeaders,
} = require('../controllers/presentation-documents.controller');

const source = {
  project: {
    id: 91,
    project_name: '测试项目',
    resident_info: '两人居住',
    house_area: 90,
  },
  missing_fields: [],
  whole_house_documents: [{ id: 3, title: '户型图', category: 'layout_plan', type: 'image', url: 'https://example.test/floor.jpg', source_type: 'design_document' }],
  whole_house_renderings: [],
  spaces: [{
    id: 7, name: '主卧', design_description: '以安静的休息体验为核心，使用柔和材质与低饱和色彩。',
    plan_count: 0, rendering_count: 1, product_count: 1,
    documents: [],
    renderings: [{ id: 11, title: '主卧效果图', type: 'image', url: 'https://example.test/room.jpg', source_type: 'design_document' }],
    products: [{
      id: 21, name: '床', brand: '品牌', image_url: 'https://example.test/bed.jpg',
      image_urls: ['https://example.test/bed.jpg', 'https://example.test/bed-side.jpg'],
      description: '低靠背软包床', dimensions: { width: 1800, depth: 2100, height: 950 }, dimension_unit: 'mm',
      official_url: 'https://example.test/products/bed', public_product_id: 221,
      materials: [{ part: '床体', name: '织物' }], colors: ['米白'],
      quantity: 1, unit: '张', selection: { ppt: { included: true } },
    }],
  }],
};

test('saved presentation document uses semantic slides and stable asset references without PPT coordinates', () => {
  const document = buildDocument(source, {
    title: '主卧方案',
    spaces: [{ space_id: 7, included: true, show_plan: false, show_rendering: true, show_products: true, selected_product_ids: [21] }],
  });
  assert.equal(document.kind, 'presentation_document');
  assert.equal(document.presentation.title, '主卧方案');
  const space = document.slides.find(slide => slide.type === 'space_design');
  assert.equal(space.space_id, '7');
  assert.equal(space.layout, 'space_hero_01');
  assert.equal(space.description, source.spaces[0].design_description);
  assert.equal(space.rendering_asset_ids.length, 1);
  assert.ok(document.asset_manifest.some(asset => asset.asset_id === space.rendering_asset_ids[0]));
  const products = document.slides.find(slide => slide.type === 'product_selection');
  assert.deepEqual(products.product_ids, ['21']);
  assert.ok(document.asset_manifest.some(asset =>
    asset.source_type === 'scheme_product' && asset.source_id === 21
  ));
  for (const slide of document.slides) {
    for (const key of ['x', 'y', 'w', 'h']) assert.equal(Object.hasOwn(slide, key), false);
  }
});

test('page plan is stable, semantic and chooses product layout from content count', () => {
  const document = buildDocument(source, {
    template_id: 'wabi_sabi',
    spaces: [{ space_id: 7, included: true, show_plan: false, show_rendering: true, show_products: true, selected_product_ids: [21] }],
  });
  const first = buildPagePlan(document);
  const second = buildPagePlan(document);
  assert.deepEqual(first, second);
  assert.equal(first.theme_id, 'wabi_sabi');
  assert.equal(first.kind, 'presentation_page_plan');
  assert.deepEqual(first.pages.map(item => item.order), first.pages.map((_, index) => index + 1));
  const chapterIndex = first.pages.findIndex(item => item.type === 'chapter');
  const heroIndex = first.pages.findIndex(item => item.type === 'space_hero');
  const productIndex = first.pages.findIndex(item => item.type === 'product_feature');
  const storyIndex = first.pages.findIndex(item => item.type === 'space_story');
  assert.ok(chapterIndex >= 0 && chapterIndex < heroIndex && heroIndex < storyIndex && storyIndex < productIndex);
  assert.deepEqual(first.pages[productIndex].product_ids, ['21']);
  assert.ok(document.asset_manifest.some(asset => asset.image_role === 'gallery:2'));
  assert.equal(document.spaces[0].products[0].dimensions.width, 1800);
  assert.equal(document.spaces[0].products[0].official_url, 'https://example.test/products/bed');
  assert.equal(document.spaces[0].products[0].public_product_id, 221);
  assert.equal(document.spaces[0].design_description, source.spaces[0].design_description);
});

test('long space descriptions become stable story pages with ranges into Document content', () => {
  const longDescription = `${'安静舒适的睡眠空间。'.repeat(55)}\n${'材质保持自然温润。'.repeat(35)}`;
  const document = buildDocument({
    ...source,
    spaces: [{ ...source.spaces[0], design_description: longDescription }],
  }, {});
  const plan = buildPagePlan(document);
  const stories = plan.pages.filter(page => page.type === 'space_story');
  assert.ok(stories.length >= 2);
  assert.deepEqual(stories[0].description_range[0], 0);
  assert.equal(stories.at(-1).description_range[1], longDescription.length);
  const restored = stories.map(page => longDescription.slice(...page.description_range)).join('');
  assert.equal(restored.replace(/\s/g, ''), longDescription.replace(/\s/g, ''));
  assert.doesNotThrow(() => validatePagePlan(plan, document));
});

test('page plan validation saves order, hidden state, layout and theme without changing Document', () => {
  const document = buildDocument(source, {});
  const original = structuredClone(document);
  const plan = buildPagePlan(document);
  const reversed = validatePagePlan({
    ...plan,
    theme_id: 'industrial',
    pages: plan.pages.toReversed().map((page, index) => ({ ...page, order: index + 1, hidden: index === 1 })),
  }, document);
  assert.equal(reversed.theme_id, 'industrial');
  assert.equal(reversed.pages[1].hidden, true);
  assert.equal(reversed.pages[0].order, 1);
  assert.deepEqual(document, original);
  assert.throws(() => validatePagePlan({ ...plan, pages: plan.pages.map(page => ({ ...page, hidden: true })) }, document), /至少保留一页/);
  assert.throws(() => validatePagePlan({ ...plan, pages: [{ ...plan.pages[0], asset_ids: ['missing'] }] }, document), /素材已不存在/);
  assert.throws(() => validatePagePlan({ ...plan, pages: [{ ...plan.pages[0], layout: 'admin_card' }] }, document), /版式不受支持/);
});

test('PPT content uses visible Page Plan order and maps stable assets to prepared asset IDs', () => {
  const document = buildDocument(source, {});
  const plan = buildPagePlan(document);
  const stableAsset = document.asset_manifest.find(asset =>
    plan.pages.some(page => (page.asset_ids || []).includes(asset.asset_id))
  );
  const prepared = document.asset_manifest.map(asset => ({
    ...asset,
    asset_id: `prepared:${asset.asset_id}`,
  }));
  plan.pages[1].hidden = true;
  const content = buildPptContent(document, plan, prepared);
  assert.equal(content.page_plan.theme_id, 'modern_minimal');
  assert.equal(content.page_plan.pages.length, plan.pages.length - 1);
  assert.deepEqual(content.page_plan.pages.map(item => item.order), content.page_plan.pages.map((_, index) => index + 1));
  if (stableAsset) {
    assert.ok(content.page_plan.pages.flatMap(item => item.asset_ids || []).includes(`prepared:${stableAsset.asset_id}`));
  }
  assert.equal(content.presentation_document.asset_manifest, undefined);
  assert.throws(() => buildPptContent(document, plan, []), /素材无法用于 PPT/);
});

test('old saved documents receive one persisted page plan and updates increment its version', async () => {
  const document = buildDocument(source, {});
  const queries = [];
  const database = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM project_presentation_documents')) return [[{
      id: 'doc', project_id: 91, created_by: 7, title: '测试', document_json: JSON.stringify(document),
      page_plan_json: null, page_plan_version: 1, page_plan_updated_by: null,
    }]];
    return [{ affectedRows: 1 }];
  } };
  const saved = await find(91, 'doc', database);
  assert.equal(saved.page_plan.kind, 'presentation_page_plan');
  assert.ok(queries.some(item => item.sql.includes('page_plan_json = ?')));
  const updated = await updatePagePlan(91, 'doc', 8, { ...saved.page_plan, theme_id: 'natural_resort' }, database);
  assert.equal(updated.page_plan.theme_id, 'natural_resort');
  assert.equal(updated.page_plan_version, 2);
});

test('old documents are enriched with their public library product id', async () => {
  const document = buildDocument(source, {});
  delete document.spaces[0].products[0].public_product_id;
  const queries = [];
  const database = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM project_presentation_documents')) return [[{
      id: 'old-doc', project_id: 91, created_by: 7, title: '旧汇报',
      document_json: JSON.stringify(document), page_plan_json: JSON.stringify(buildPagePlan(document)),
      page_plan_version: 1, page_plan_updated_by: null,
    }]];
    if (sql.includes('FROM project_scheme_products')) return [[{ id: 21, public_product_id: 221 }]];
    return [{ affectedRows: 1 }];
  } };
  const saved = await find(91, 'old-doc', database);
  assert.equal(saved.document.spaces[0].products[0].public_product_id, 221);
  assert.ok(queries.some(item => item.sql.includes('SET document_json = ?')));
});

test('saved presentation documents can be deleted within their project', async () => {
  const queries = [];
  const database = { query: async (sql, params) => {
    queries.push({ sql, params });
    return [{ affectedRows: 1 }];
  } };
  assert.equal(await remove(91, 'doc-to-delete', database), true);
  assert.match(queries[0].sql, /DELETE FROM project_presentation_documents/);
  assert.deepEqual(queries[0].params, [91, 'doc-to-delete']);
});

test('PDF design sources use a preview image when one exists', () => {
  const document = buildDocument({
    ...source,
    whole_house_documents: [{
      id: 4, title: '全屋平面图', type: 'pdf',
      original_url: 'https://example.test/plan.pdf',
      original_type: 'pdf',
      url: 'https://example.test/plan-preview.png',
      source_type: 'design_document',
    }],
  }, {});
  const plan = document.asset_manifest.find(asset => asset.source_id === 4);
  assert.equal(plan.url, 'https://example.test/plan-preview.png');
});

test('presentation document respects disabled sections and excluded spaces', () => {
  const document = buildDocument(source, {
    sections: { project_profile: false, client_requirements: false, whole_house_plan: false, space_solutions: true, product_summary: false },
    spaces: [{ space_id: 7, included: false, show_plan: true, show_rendering: true, show_products: true }],
  });
  assert.deepEqual(document.slides.map(slide => slide.type), ['cover', 'ending']);
  assert.deepEqual(document.asset_manifest, []);
});

test('Reveal preview allows HTTPS images while keeping scripts same-origin', () => {
  const headers = new Map();
  setPreviewHeaders({ setHeader: (name, value) => headers.set(name, value) });
  assert.equal(headers.get('Content-Security-Policy'), previewContentSecurityPolicy);
  assert.match(previewContentSecurityPolicy, /img-src 'self' data: blob: https:/);
  assert.match(previewContentSecurityPolicy, /script-src 'self'/);
  assert.doesNotMatch(previewContentSecurityPolicy, /script-src[^;]*https:/);
});

test('Reveal preview provides WebKit fullscreen support and an embedded-view fallback', () => {
  const webRoot = path.join(__dirname, '../services/presentation-document/web');
  const script = fs.readFileSync(path.join(webRoot, 'presentation.js'), 'utf8');
  const styles = fs.readFileSync(path.join(webRoot, 'presentation.css'), 'utf8');
  assert.match(script, /webkitRequestFullscreen/);
  assert.match(script, /classList\.add\('presentation-mode'\)/);
  assert.match(script, /退出全屏/);
  assert.match(styles, /body\.fullscreen-active \.reveal/);
});

test('Reveal preview places navigation on the edges and handles horizontal arrow keys', () => {
  const webRoot = path.join(__dirname, '../services/presentation-document/web');
  const script = fs.readFileSync(path.join(webRoot, 'presentation.js'), 'utf8');
  const styles = fs.readFileSync(path.join(webRoot, 'presentation.css'), 'utf8');
  assert.match(script, /controlsLayout: 'edges'/);
  assert.match(script, /event\.key === 'ArrowLeft'\) deck\.prev\(\)/);
  assert.match(script, /event\.key === 'ArrowRight'\) deck\.next\(\)/);
  assert.match(styles, /navigate-left\.enabled[^}]*opacity: 0/);
  assert.match(styles, /navigate-right\.enabled:hover/);
});

test('Reveal renderer uses Page Plan layouts, eight themes and proposal interactions', () => {
  const webRoot = path.join(__dirname, '../services/presentation-document/web');
  const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(webRoot, 'presentation.js'), 'utf8');
  const styles = fs.readFileSync(path.join(webRoot, 'presentation.css'), 'utf8');
  for (const type of ['cover', 'chapter', 'space_hero', 'space_story', 'moodboard', 'product_feature', 'product_duo', 'product_grid', 'end']) {
    assert.match(script, new RegExp(`${type}:`));
  }
  for (const theme of ['modern_minimal', 'wabi_sabi', 'italian_luxury', 'modern_chinese', 'scandinavian', 'french_classic', 'industrial', 'natural_resort']) {
    assert.match(html, new RegExp(`value="${theme}"`));
    if (theme !== 'modern_minimal') assert.match(styles, new RegExp(`data-theme="${theme}"`));
  }
  assert.match(script, /pagePlan\.pages/);
  assert.match(script, /openLightbox/);
  assert.match(script, /openProduct/);
  assert.match(script, /moveProduct/);
  assert.match(script, /moveProductImage/);
  assert.match(script, /product\.official_url/);
  assert.match(script, /open_public_product/);
  assert.match(styles, /product-gallery-thumbs/);
  assert.match(script, /buildOverview/);
  assert.doesNotMatch(script, /本空间.*设计资料与方案逻辑/);
});
