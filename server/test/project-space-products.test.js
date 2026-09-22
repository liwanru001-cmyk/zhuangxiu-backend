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

test('public library source pins a version and optionally one configuration', () => {
  const input = controller.parseInput({
    source_type: 'public_library',
    public_product_id: 3,
    public_product_version_id: 7,
    public_product_configuration_id: 11,
    quantity: 1,
    unit: '件',
  });
  assert.equal(input.sourceType, 'public_library');
  assert.equal(input.publicVersionId, 7);
  assert.equal(controller.parseInput({
    source_type: 'public_library', public_product_id: 3,
    public_product_version_id: 7, quantity: 1, unit: '件',
  }).publicConfigurationId, null);
  assert.throws(() => controller.parseInput({
    source_type: 'public_library', public_product_id: 3, quantity: 1, unit: '件',
  }), /公共产品来源/);
  assert.throws(() => controller.parseInput({
    source_type: 'public_library', public_product_id: 3, public_product_version_id: 7,
    public_product_configuration_id: 11, merchant_product_id: 2, quantity: 1, unit: '件',
  }), /一种有效的产品来源/);
});

test('product-level public selection is allowed only for a version without configurations', () => {
  const input = controller.parseInput({
    source_type: 'public_library', public_product_id: 3,
    public_product_version_id: 7, quantity: 1, unit: '件',
    selection_details: {
      selection_scope: 'product', materials: [], price_status: 'pending',
      ppt: { included: true, show_materials: true, show_quantity: true, show_price: false },
    },
  });
  assert.equal(input.selection.selection_scope, 'product');
  assert.equal(input.selection.configuration_id, null);
  assert.doesNotThrow(() => controller.assertPublicConfigurationChoice(input, {
    has_configurations: 0, configuration_id: null,
  }));
  assert.throws(() => controller.assertPublicConfigurationChoice(input, {
    has_configurations: 1, configuration_id: null,
  }), /请选择具体规格/);
  assert.throws(() => controller.assertPublicConfigurationChoice({
    publicConfigurationId: 11,
  }, { has_configurations: 1, configuration_id: null }), /不可用/);
  assert.throws(() => controller.validateSelectionAgainstProduct({
    configurations: [{ id: 'standard' }],
  }, input.selection), /须选择具体规格/);
  const selection = controller.selectionForPublicProduct(input.selection, null, null);
  assert.equal(selection.selection_scope, 'product');
  assert.equal(selection.configuration_id, null);
});

test('product-level snapshot and status keep the product without inventing a configuration', () => {
  const snapshot = controller.publicSnapshot({
    product_id: 3, version_id: 7, version_no: 1,
    configuration_id: null, configuration_key: null, configuration_payload: null,
    product_payload: { name: '无规格沙发', brand: '示例品牌', cover_url: '/cover.jpg' },
  });
  assert.equal(snapshot.configuration, null);
  assert.equal(snapshot.configuration_id, null);
  const hydrated = controller.hydrateSelectionStatus({
    source_type: 'public_library',
    product_details: { configurations: [], material_groups: [] },
    selection_details: { selection_scope: 'product', configuration_id: null, materials: [] },
  });
  assert.deepEqual(hydrated.selection_warnings, []);
});

test('official brand material selection snapshot keeps its source boundary',()=>{
  const input=controller.parseInput({
    source_type:'public_library',public_product_id:3,public_product_version_id:7,
    public_product_configuration_id:11,quantity:1,unit:'件',
    selection_details:{configuration_id:'cfg',materials:[{part:'坐面',material_id:225,material_source:'official_brand',material_revision:2,brand:'示例',kind:'面料',composition:'官网原文',official_status:'unconfirmed',selection_basis:'open_world'}]},
  });
  assert.equal(input.selection.materials[0].material_source,'official_brand');
  assert.equal(input.selection.materials[0].composition,'官网原文');
  assert.equal(input.selection.materials[0].selection_basis,'open_world');
});

test('public project snapshot pins product facts and one formal configuration', () => {
  const snapshot = controller.publicSnapshot({
    product_id: 3,
    version_id: 7,
    version_no: 2,
    configuration_id: 11,
    configuration_key: 'hw01-2400',
    content_fingerprint: 'abc',
    source_url: 'https://www.example.com/product/3',
    product_payload: {
      name: '折纸沙发', brand: '示例品牌', cover_url: '/api/storage/cover.jpg',
      product_group: 'soft_furnishings', product_type: 'furniture',
      product_details: { model: 'HW01' },
    },
    configuration_payload: { id: 'hw01-2400', name: '2400mm', image_url: '/api/storage/config.jpg' },
  });
  assert.equal(snapshot.product.name, '折纸沙发');
  assert.equal(snapshot.version_id, 7);
  assert.equal(snapshot.configuration_id, 11);
  assert.equal(snapshot.configuration.name, '2400mm');
});

test('a newer public library version cannot change an existing project snapshot', () => {
  const base = {
    product_id: 3,
    configuration_id: 11,
    configuration_key: 'hw01-standard',
    source_url: 'https://www.example.com/product/3',
  };
  const savedProjectSnapshot = controller.publicSnapshot({
    ...base,
    version_id: 7,
    version_no: 1,
    content_fingerprint: 'v1',
    product_payload: {
      name: '折纸沙发', brand: '示例品牌', cover_url: '/api/storage/v1-cover.jpg',
      product_group: 'soft_furnishings', product_type: 'furniture',
    },
    configuration_payload: { id: 'hw01-standard', name: '标准款', image_url: '/api/storage/v1-config.jpg' },
  });
  const newlyPublishedSnapshot = controller.publicSnapshot({
    ...base,
    version_id: 8,
    version_no: 2,
    content_fingerprint: 'v2',
    product_payload: {
      name: '折纸沙发（新版）', brand: '示例品牌', cover_url: '/api/storage/v2-cover.jpg',
      product_group: 'soft_furnishings', product_type: 'furniture',
    },
    configuration_payload: { id: 'hw01-standard', name: '新版标准款', image_url: '/api/storage/v2-config.jpg' },
  });

  assert.equal(savedProjectSnapshot.version_id, 7);
  assert.equal(savedProjectSnapshot.product.name, '折纸沙发');
  assert.equal(savedProjectSnapshot.configuration.image_url, '/api/storage/v1-config.jpg');
  assert.equal(newlyPublishedSnapshot.version_id, 8);
  assert.notDeepEqual(savedProjectSnapshot, newlyPublishedSnapshot);
});

test('public selection identity is server controlled', () => {
  const selection = controller.selectionForPublicProduct({
    schema_version: 1,
    configuration_id: 'forged',
    configuration_name: '伪造规格',
    materials: [],
    price_status: 'quoted',
    ppt: { included: true, show_materials: true, show_quantity: true, show_price: true },
  }, { name: '标准款' }, 'official-key');
  assert.equal(selection.configuration_id, 'official-key');
  assert.equal(selection.configuration_name, '标准款');
  assert.equal(selection.price_status, 'quoted');
});
