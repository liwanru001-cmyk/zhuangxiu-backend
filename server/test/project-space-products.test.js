const test = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const controller = require('../controllers/project-space-products.controller');
const valid = { merchant_product_id: 5, quantity: 2, unit: '件' };
test('unspecified client quote remains null and does not copy merchant price', () => {
  assert.equal(controller.parseInput(valid).price, null);
  assert.equal(controller.parseInput({ ...valid, customer_unit_price: 0 }).price, 0);
});
test('reject invalid quantity, price precision and invalid product identity', () => {
  for (const quantity of [0, -1, 'NaN', Infinity, 1.0001]) assert.throws(() => controller.parseInput({ ...valid, quantity }));
  for (const customer_unit_price of ['面议', -1, Infinity, 1.111]) assert.throws(() => controller.parseInput({ ...valid, customer_unit_price }));
  assert.throws(() => controller.parseInput({ ...valid, merchant_product_id: 1.5 }));
});
test('project-specific specification and note remain separate from live source', () => {
  const value = controller.parseInput({ ...valid, selected_spec: '米白三人位', note: '靠窗', customer_unit_price: 3200.50 });
  assert.equal(value.spec, '米白三人位'); assert.equal(value.note, '靠窗'); assert.equal(value.price, 3200.5);
});
test('structured selection must use a real configuration and its allowed materials', () => {
  const details = {
    configurations: [{
      id: 'three-seat',
      material_options: [{ part: '坐面', material_ids: [12, 13] }],
    }],
    material_groups: [{ part: '坐面', material_ids: [12, 13, 14] }],
  };
  const selection = controller.parseInput({
    ...valid,
    customer_unit_price: 3200,
    selection_details: {
      configuration_id: 'three-seat',
      configuration_name: '三人位',
      materials: [{ part: '坐面', material_id: 12 }],
      price_status: 'quoted',
      ppt: { included: true, show_materials: true, show_quantity: true, show_price: true },
    },
  }).selection;
  assert.doesNotThrow(() => controller.validateSelectionAgainstProduct(details, selection));
  assert.doesNotThrow(() => controller.validateSelectionAgainstProduct(details, null));
  assert.throws(() => controller.validateSelectionAgainstProduct(details, { ...selection, configuration_id: 'missing' }));
  assert.throws(() => controller.validateSelectionAgainstProduct(details, { ...selection, materials: [{ part: '坐面', material_id: 14 }] }));
  assert.throws(() => controller.validateSelectionAgainstProduct(details, { ...selection, materials: [] }));
});
test('selection warnings only follow the configuration and materials actually selected', () => {
  const item = {
    cover_url: '/cover.jpg',
    product_details: {
      configurations: [{ id: 'chair', name: '餐椅标准款', image_url: '/chair.jpg' }],
      material_groups: [{
        part: '坐面',
        materials: [
          { id: 12, name: '米白布', status: 'active', revision: 3 },
          { id: 13, name: '旧款皮', status: 'discontinued', revision: 2 },
        ],
      }],
    },
    selection_details: {
      configuration_id: 'chair',
      configuration_name: '餐椅标准款',
      materials: [{ part: '坐面', material_id: 12, material_revision: 3 }],
    },
  };
  const current = controller.hydrateSelectionStatus(item);
  assert.deepEqual(current.selection_warnings, []);
  assert.equal(current.preview_image_url, '/chair.jpg');
  assert.equal(current.selection_details.materials[0].live_material.name, '米白布');

  const unavailable = controller.hydrateSelectionStatus({
    ...item,
    selection_details: {
      ...item.selection_details,
      materials: [{ part: '坐面', material_id: 13, material_revision: 2 }],
    },
  });
  assert.equal(unavailable.selection_warnings[0].type, 'material_unavailable');
});
