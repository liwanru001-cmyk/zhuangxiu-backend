'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { limits } = require('../services/presentation-v2/config');
const { compile } = require('../services/presentation-v2/schema');
const { bounds, lightRepair, validate } = require('../services/presentation-v2/validate');
const { candidates, representatives, prepare } = require('../services/presentation-v2/assets');
const { run } = require('../services/presentation-v2/pipeline');
const { createContext } = require('../services/presentation-v2/job-store');
const settings = { spaces: [{ space_id: 31, included: true, show_plan: true, show_rendering: true, show_products: true, selected_product_ids: [] }], sections: { space_solutions: true, whole_house_plan: true, product_summary: true } };
const source = { project: { id: 3 }, whole_house_documents: [], whole_house_renderings: [], spaces: [{ id: 31, documents: [], renderings: [], products: [] }] };
function design() { return { schema_version: 2, presentation: { title: '测试', design_concept: '自然', visual_direction: '简洁', background_color: '#FFFFFF' }, slides: [{ id: 's1', design_intent: '展示需求', elements: [{ id: 't1', type: 'text', role: 'body', text: '真实内容', x: 1, y: 1, w: 5, h: 1, font_size: 18, color: '#111111' }] }] }; }
const config = limits({ PRESENTATION_V2_FALLBACK_FONT: 'Arial Unicode MS' });
const signal = () => new AbortController().signal;
test('v2 strict schema rejects unknown fields, NaN, unsupported shapes and wrong opacity', () => {
  const { validate } = compile(config); assert.equal(validate(design()), true);
  for (const patch of [{ x: NaN }, { opacity: 2 }, { url: 'https://invented' }, { font_size: 0 }]) {
    const d = design(); Object.assign(d.slides[0].elements[0], patch); assert.equal(validate(d), false);
  }
});
test('rotation checks actual bounding rectangle', () => {
  const b = bounds({ x: 0, y: 0, w: 4, h: 1, rotation: 45 }); assert.ok(b.y < 0); assert.ok(b.h > 1);
});
test('only small error overflow is eligible for one light repair; warnings do not consume it', () => {
  const warning = [{ severity: 'warning', code: 'overlap' }]; assert.equal(lightRepair(design(), warning), null);
  const issue = { severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.03 };
  const result = lightRepair(design(), [issue]); assert.equal(result.design.slides[0].elements[0].font_size, 17.28);
  assert.equal(lightRepair(design(), [{ ...issue, overflow_ratio: 0.2 }]), null);
});
test('representatives honor primary and existing order, separate whole house and avoid non-layout documents', () => {
  const s = structuredClone(source);
  s.spaces[0].documents = [{ id: 1, category: 'construction_drawing', url: 'https://x/1' }, { id: 2, category: 'layout_plan', url: 'https://x/2' }];
  s.spaces[0].renderings = [{ id: 1, source_type: 'design_document', url: 'https://x/3' }, { id: 1, source_type: 'space_image', is_primary: true, url: 'https://x/4' }];
  s.whole_house_renderings = [{ id: 3, source_type: 'design_document', url: 'https://x/5' }];
  const all = candidates(s, settings), chosen = [...representatives(all)];
  assert.equal(all.length, 5); assert.equal(chosen.length, 3);
  assert.ok(chosen.some(a => a.source_type === 'space_image')); assert.ok(chosen.some(a => a.space_id === 'whole_house'));
  assert.equal(chosen.filter(a => a.space_id === 31).length, 2);
});
test('asset manifest separates colliding business IDs and snapshots original versus compressed preview', async t => {
  const sharp = require('sharp');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'v2-assets-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#bbaa99' } }).png().toBuffer();
  const s = structuredClone(source);
  s.spaces[0].renderings = [{ id: 1, source_type: 'design_document', url: 'https://x/a' }, { id: 1, source_type: 'space_image', url: 'https://x/b' }];
  const manifest = await prepare(s, settings, { directory, limits: config, signal: signal(), fetchAsset: async () => bytes });
  assert.notEqual(manifest[0].asset_id, manifest[1].asset_id); assert.equal(manifest[0].width, 1200);
  assert.equal((await sharp(manifest[0].preview_path).metadata()).width, 768);
  assert.equal(manifest[1].vision_preview_provided, false);
  assert.deepEqual(await fs.readFile(manifest[0].original_path), bytes);
});
async function harness(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v2-pipeline-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const events = [], calls = [], phases = { repair: 0, fallback: 0 }; let saved = {};
  const context = { state: {}, assetDirectory: dir, remaining: () => 100000, checkpoint: async () => {},
    save: async s => { saved = structuredClone(s); }, record: async e => events.push(e), reserve: async stage => calls.push(stage),
    claimRepair: async () => { if (phases.repair++) throw new Error('duplicate repair'); }, claimFallback: async () => { if (phases.fallback++) throw new Error('duplicate fallback'); },
    renderLegacy: async (plan, output) => { assert.deepEqual(plan.source, source); assert.deepEqual(plan.settings, settings); await fs.writeFile(output, 'legacy'); },
  };
  const legacy = { normalizeSettings: () => structuredClone(settings), sourceForModel: () => ({ spaces: [] }),
    generateOutline: async (s, set, options) => { assert.deepEqual(s, source); assert.deepEqual(set, settings); assert.equal(options.maxAttempts, 1); await options.beforeRequest(); return { outline: { schema_version: 1, slides: [] } }; },
    buildRenderPlan: (s, set, outline) => ({ source: s, settings: set, outline }),
  };
  const adapters = { preflight: async () => ({}), prepare: async () => [], request: async ({ reserve, repair }) => { await reserve(repair ? 'model_repair' : 'initial'); return repair ? { slides: design().slides } : design(); },
    validate: async () => ({ issues: [], font_actions: [] }), render: async (d, m, output) => fs.writeFile(output, 'v2'), renderedValidation: async () => ({ issues: [], environment: {} }), ...overrides };
  return { execute: () => run({ source, rawSettings: settings, legacy, context, output: path.join(dir, 'result.pptx'), limits: config, signal: signal(), adapters }), events, calls, phases, context, saved: () => saved, legacy };
}
test('warning-only validation succeeds with one model request and no repair', async t => {
  const h = await harness(t, { validate: async () => ({ issues: [{ severity: 'warning', code: 'overlap' }] }) });
  assert.equal((await h.execute()).generation_status, 'ai_success'); assert.deepEqual(h.calls, ['initial']); assert.equal(h.phases.repair, 0);
});
test('server repair failure falls straight to original legacy, never model repair', async t => {
  const h = await harness(t, { validate: async () => ({ issues: [{ severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.03 }] }) });
  const result = await h.execute(); assert.equal(result.generation_status, 'legacy_fallback_success');
  assert.deepEqual(h.calls, ['initial', 'legacy']); assert.equal(h.phases.repair, 1); assert.equal(h.phases.fallback, 1);
});
test('model page repair failure uses at most three requests', async t => {
  const h = await harness(t, { validate: async () => ({ issues: [{ severity: 'error', code: 'out_of_bounds', slide_id: 's1', element_id: 't1' }] }) });
  assert.equal((await h.execute()).generation_status, 'legacy_fallback_success'); assert.deepEqual(h.calls, ['initial', 'model_repair', 'legacy']);
});
test('model repairs only failed pages and keeps valid pages untouched', async t => {
  let checks = 0;
  const d = design(); d.slides.push({ ...structuredClone(d.slides[0]), id: 's2' });
  const h = await harness(t, {
    request: async ({ reserve, repair }) => { await reserve(repair ? 'model_repair' : 'initial'); if (!repair) return d; assert.deepEqual(repair.ids, ['s1']); const page = design().slides[0]; page.elements[0].x = 2; return { slides: [page] }; },
    validate: async () => ({ issues: checks++ === 0 ? [{ severity: 'error', code: 'out_of_bounds', slide_id: 's1' }] : [] }),
  });
  const result = await h.execute(); assert.equal(result.generation_status, 'ai_repaired_success'); assert.deepEqual(result.outline.slides[1], d.slides[1]);
});
test('fatal asset failure never invokes either model or legacy', async t => {
  const h = await harness(t, { prepare: async () => { throw Object.assign(new Error('broken'), { fatal: true }); } });
  await assert.rejects(h.execute(), /broken/); assert.deepEqual(h.calls, []); assert.equal(h.phases.fallback, 0);
});
test('recovering a repaired design revalidates without consuming another repair', async t => {
  const h = await harness(t); h.context.state = { manifest: [], design: design(), repaired_design: design() };
  assert.equal((await h.execute()).generation_status, 'ai_repaired_success'); assert.deepEqual(h.calls, []);
});
test('malformed initial schema falls back without attempting whole-deck regeneration', async t => {
  const h = await harness(t, { validate: async () => ({ issues: [{ severity: 'error', code: 'schema' }] }) });
  assert.equal((await h.execute()).generation_status, 'legacy_fallback_success'); assert.deepEqual(h.calls, ['initial', 'legacy']);
});
test('fallback failure propagates as failure, not success', async t => {
  const h = await harness(t, { request: async () => { throw new Error('AI failure'); } });
  h.legacy.generateOutline = async () => { throw new Error('legacy failure'); };
  await assert.rejects(h.execute(), /legacy failure/);
});
test('multimodal request sends only previews, records usage, and reserves before network', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'v2-model-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const preview = path.join(directory, 'preview.jpg'); await fs.writeFile(preview, 'compressed-preview');
  const calls = [], events = [];
  const d = await require('../services/presentation-v2/model').request({ source: {}, settings, manifest: [{ asset_id: 'a', vision_preview_provided: true, preview_path: preview, original_path: '/not-to-send' }, { asset_id: 'b', vision_preview_provided: false }], limits: config, signal: signal(), reserve: async stage => calls.push(stage), record: async e => events.push(e),
    env: { PRESENTATION_V2_MODEL: 'test-qwen', PRESENTATION_V2_BASE_URL: 'https://test.invalid', PRESENTATION_V2_API_KEY: 'secret' },
    fetchImpl: async (url, options) => {
      assert.deepEqual(calls, ['initial']); const body = JSON.parse(options.body);
      assert.equal(body.enable_thinking, false); assert.equal(body.messages[1].content.filter(c => c.type === 'image_url').length, 1);
      assert.ok(!options.body.includes('/not-to-send')); assert.ok(!options.body.includes('secret'));
      return new Response(JSON.stringify({ model: 'test-qwen-version', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(design()) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } }));
    },
  });
  assert.equal(d.schema_version, 2); assert.equal(events.find(e => e.event === 'response').usage.completion_tokens, 200);
});
test('model timeout outcome is recorded without retrying', async () => {
  let requests = 0; const events = [];
  await assert.rejects(require('../services/presentation-v2/model').request({ source: {}, settings, manifest: [], limits: config, signal: signal(), reserve: async () => {}, record: async e => events.push(e), env: { PRESENTATION_V2_MODEL: 'qwen', PRESENTATION_V2_BASE_URL: 'https://test.invalid', PRESENTATION_V2_API_KEY: 'secret' }, fetchImpl: async () => { requests++; throw new Error('timeout'); } }), /timeout/);
  assert.equal(requests, 1); assert.ok(events.some(e => e.event === 'failure'));
});
test('selected material swatches are available assets but never additional vision inputs', () => {
  const s = structuredClone(source);
  s.spaces[0].products = [{ id: 9, name: '沙发', image_url: 'https://x/cover', selection: { materials: [{ part: '面料', material_id: 4, swatch_url: 'https://x/swatch' }] } }];
  const all = candidates(s, { ...settings, product_display: { show_materials: true } });
  assert.equal(all.length, 2); assert.equal(all[1].source_type, 'scheme_product_material');
  assert.equal(representatives(all).size, 0);
  assert.equal(candidates(s, { ...settings, product_display: { show_materials: false } }).length, 1);
});
