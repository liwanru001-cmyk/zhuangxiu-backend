'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const service = require('../services/project-presentation.service');
const { generateFromPlan } = require('../scripts/generate-ppt-from-plan');

function sourceFixture() {
  return {
    schema_version: 1,
    project: {
      id: 3,
      project_code: 'FV29360102',
      project_name: '海景花园',
      client_name: 'luck',
      owner_joined: false,
      preparation_stage: 'preparation',
      house_area: 120,
      house_layout: '三室两厅',
      budget_range: '30-50万',
      resident_info: '两位成人和一名儿童',
      lifestyle_notes: '重视公共空间互动',
      style_preference: '现代自然',
      key_spaces: '客厅、餐厅',
      special_needs: '儿童收纳',
    },
    missing_fields: [],
    whole_house_documents: [{ id: 10, title: '全屋平面方案', type: 'image', url: '' }],
    spaces: [{
      id: 31,
      name: '客厅',
      plan_count: 1,
      rendering_count: 0,
      product_count: 1,
      documents: [{ id: 11, title: '客厅尺寸图', type: 'image', url: '' }],
      renderings: [],
      products: [{
        id: 41,
        name: '云朵沙发',
        brand: '样板品牌',
        specification: '宽2200mm',
        configuration: '三人位标准款',
        image_url: '',
        quantity: 1,
        unit: '件',
        customer_unit_price: 8999,
        note: '靠主墙摆放',
        selection: {
          ppt: { included: true, show_price: true },
          materials: [{ part: '面料', brand: '样板品牌', series: 'A系列', name: '米白布', code: 'A01' }],
        },
      }],
    }],
  };
}

function settingsFixture() {
  return {
    project_id: 3,
    title: '海景花园设计方案汇报',
    audience: '业主',
    stage: '平面方案汇报',
    detail_level: 'standard',
    template_id: 'warm_minimal',
    user_instruction: '重点说明客厅动线',
    sections: {
      project_profile: true,
      client_requirements: true,
      whole_house_plan: true,
      space_solutions: true,
      product_summary: true,
    },
    product_display: { show_brand: true, show_materials: true, show_quantity: true, show_price: true },
    spaces: [{
      space_id: 31,
      included: true,
      show_plan: true,
      show_rendering: false,
      show_products: true,
      selected_product_ids: [41],
    }],
  };
}

function outlineFixture() {
  return {
    schema_version: 1,
    title: '海景花园设计方案汇报',
    summary: '围绕公共空间动线与现代自然风格展开。',
    missing_information: [],
    slides: [
      { id: 'cover', type: 'cover', title: '海景花园设计方案汇报', subtitle: '平面方案汇报', source_refs: ['project'], narrative: '' },
      { id: 'profile', type: 'project_profile', title: '项目概况', subtitle: '', source_refs: ['project'], narrative: '' },
      { id: 'requirements', type: 'client_requirements', title: '客户需求', subtitle: '', source_refs: ['project.requirements'], narrative: '重视公共空间互动。' },
      { id: 'plan', type: 'whole_house_plan', title: '全屋平面方案', subtitle: '', source_refs: ['documents.10'], narrative: '' },
      { id: 'space-31', type: 'space_solution', title: '客厅设计方案', subtitle: '', space_id: 31, source_refs: ['space.31'], narrative: '保证会客与通行互不干扰。' },
      { id: 'products', type: 'product_summary', title: '方案选品汇总', subtitle: '', source_refs: ['spaces.products'], narrative: '' },
      { id: 'ending', type: 'ending', title: '方案沟通与下一步', subtitle: '', source_refs: [], narrative: '确认平面方案后进入效果深化。' },
    ],
  };
}

test('default DeepSeek configuration leaves only the API key missing', () => {
  const configuration = service.modelConfiguration({});
  assert.equal(configuration.base_url, 'https://api.deepseek.com');
  assert.equal(configuration.model, 'deepseek-v4-flash');
  assert.deepEqual(configuration.missing, ['PRESENTATION_AI_API_KEY']);
});

test('outline generation uses an OpenAI-compatible API and validates its JSON', async () => {
  let request;
  const result = await service.generateOutline(sourceFixture(), settingsFixture(), {
    env: {
      PRESENTATION_AI_BASE_URL: 'https://model.example/v1',
      PRESENTATION_AI_API_KEY: 'secret',
      PRESENTATION_AI_MODEL: 'cn-model',
    },
    fetch: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(outlineFixture()) } }] }; } };
    },
  });
  assert.equal(request.url, 'https://model.example/v1/chat/completions');
  assert.equal(request.body.model, 'cn-model');
  assert.equal(result.outline.slides[4].space_id, 31);
  const submitted = request.body.messages[1].content;
  assert.ok(!submitted.includes('secret'));
  assert.ok(!submitted.includes('image_url'));
});

test('missing model configuration blocks only the AI outline step', async () => {
  await assert.rejects(
    service.generateOutline(sourceFixture(), settingsFixture(), { env: {} }),
    error => error.code === 'PRESENTATION_MODEL_NOT_CONFIGURED' && error.status === 503
  );
  const plan = service.buildRenderPlan(sourceFixture(), settingsFixture(), outlineFixture());
  assert.equal(plan.spaces[0].products[0].materials[0], '面料 · 样板品牌 · A系列 · 米白布 · A01');
});

test('validated project data and outline render to a temporary PPTX', async () => {
  const plan = service.buildRenderPlan(sourceFixture(), settingsFixture(), outlineFixture());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-presentation-service-'));
  const output = path.join(directory, '海景花园.pptx');
  const result = await generateFromPlan(plan, output);
  const stat = await fs.stat(output);
  assert.ok(result.slideCount >= 7);
  assert.ok(stat.size > 10000);
  await fs.rm(directory, { recursive: true, force: true });
});

test('Qwen outline explicitly disables thinking and requests non-streaming JSON', async () => {
  await service.generateOutline(sourceFixture(), settingsFixture(), {
    env: { PRESENTATION_AI_API_KEY: 'test-key', PRESENTATION_AI_MODEL: 'qwen3.8-max' },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.enable_thinking, false);
      assert.equal(body.stream, false);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(outlineFixture()) } }] }) };
    },
  });
});
test('background model budget overrides legacy 90-second configuration', async () => {
  await service.generateOutline(sourceFixture(), settingsFixture(), {
    env: { PRESENTATION_AI_API_KEY: 'test-key', PRESENTATION_AI_TIMEOUT_MS: '1' },
    timeoutMs: 1000,
    fetch: async (url, options) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(options.signal.aborted, false);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(outlineFixture()) } }] }) };
    },
  });
});
test('timeout during response-body reading preserves model timeout diagnostics', async () => {
  await assert.rejects(service.generateOutline(sourceFixture(), settingsFixture(), {
    env: { PRESENTATION_AI_API_KEY: 'secret-not-for-errors', PRESENTATION_AI_MODEL: 'qwen3.8-max' },
    timeoutMs: 5,
    fetch: async (url, options) => ({ ok: true, json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) }),
  }), error => error.code === 'PRESENTATION_MODEL_TIMEOUT' && !error.message.includes('secret-not-for-errors'));
});
