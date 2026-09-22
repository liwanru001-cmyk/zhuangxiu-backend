'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { buildDocument } = require('../services/presentation-document.service');

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
    id: 7, name: '主卧', plan_count: 0, rendering_count: 1, product_count: 1,
    documents: [],
    renderings: [{ id: 11, title: '主卧效果图', type: 'image', url: 'https://example.test/room.jpg', source_type: 'design_document' }],
    products: [{ id: 21, name: '床', brand: '品牌', image_url: 'https://example.test/bed.jpg', quantity: 1, unit: '张', selection: { ppt: { included: true } } }],
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
