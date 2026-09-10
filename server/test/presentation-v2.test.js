'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { limits } = require('../services/presentation-v2/config');
const { compile } = require('../services/presentation-v2/schema');
const { bounds, lightRepair, finishTextFit, validate, measure } = require('../services/presentation-v2/validate');
const { candidates, representatives, prepare } = require('../services/presentation-v2/assets');
const { run } = require('../services/presentation-v2/pipeline');
const { createContext } = require('../services/presentation-v2/job-store');
const settings = { spaces: [{ space_id: 31, included: true, show_plan: true, show_rendering: true, show_products: true, selected_product_ids: [] }], sections: { space_solutions: true, whole_house_plan: true, product_summary: true } };
const source = { project: { id: 3 }, whole_house_documents: [], whole_house_renderings: [], spaces: [{ id: 31, documents: [], renderings: [], products: [] }] };
function design() { return { schema_version: 2, presentation: { title: '测试', design_concept: '自然', visual_direction: '简洁', background_color: '#FFFFFF' }, slides: [{ id: 's1', design_intent: '展示需求', elements: [{ id: 't1', type: 'text', role: 'body', text: '真实内容', x: 1, y: 1, w: 5, h: 1, font_size: 18, color: '#111111' }] }] }; }
const config = limits({ PRESENTATION_V2_FALLBACK_FONT: 'Arial Unicode MS', PRESENTATION_V2_RENDER_VALIDATION: 'full' });
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
test('overflow beyond the safe minimum font and page height requires structural re-layout', async () => {
  const d = design();
  Object.assign(d.slides[0].elements[0], { y: 6, h: 1, font_size: 18, line_spacing: 24, paragraph_spacing: 6, font_family: config.fallbackFont });
  const result = await validate(d, [], { limits: config, signal: signal(), resolveFonts: async () => [], measure: async e => ({ height: e.font_size === 18 ? 2 : 1.7, lines: 4 }) });
  const error = result.issues.find(issue => issue.code === 'text_overflow');
  assert.equal(error.structural_relayout_required, true);
  assert.equal(error.minimum_safe_font_size, 15.84);
  assert.equal(error.minimum_safe_measured_height, 1.7);
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
  const { limits: runtimeLimits = config, ...adapterOverrides } = overrides;
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
    validate: async () => ({ issues: [], font_actions: [] }), render: async (d, m, output) => fs.writeFile(output, 'v2'), renderedValidation: async () => ({ issues: [], environment: {} }), ...adapterOverrides };
  return { execute: () => run({ source, rawSettings: settings, legacy, context, output: path.join(dir, 'result.pptx'), limits: runtimeLimits, signal: signal(), adapters }), events, calls, phases, context, saved: () => saved, legacy };
}
test('warning-only validation succeeds with one model request and no repair', async t => {
  const h = await harness(t, { validate: async () => ({ issues: [{ severity: 'warning', code: 'overlap' }] }) });
  assert.equal((await h.execute()).generation_status, 'ai_success'); assert.deepEqual(h.calls, ['initial']); assert.equal(h.phases.repair, 0);
});
test('static mode creates PPTX, records skipped render validation and returns an explicit status', async t => {
  const staticLimits = limits({ PRESENTATION_V2_FALLBACK_FONT: 'Arial Unicode MS', PRESENTATION_V2_RENDER_VALIDATION: 'static' });
  const h = await harness(t, {
    limits: staticLimits,
    renderedValidation: async () => { throw new Error('full render validation must not run'); },
  });
  const result = await h.execute();
  assert.equal(result.generation_status, 'ai_success_unverified_render');
  assert.equal(result.render_validation, 'skipped');
  assert.equal(result.render_validation_reason, 'render_engine_disabled');
  assert.ok(h.events.some(event => event.event === 'render_validation' && event.skipped === true));
});
test('server text fit runs before model repair and avoids a second model request', async t => {
  let checks = 0;
  const h = await harness(t, {
    validate: async () => ({ issues: checks++ === 0 ? [{ severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.03 }] : [] }),
    finishTextFit: async current => {
      const fitted = structuredClone(current); fitted.slides[0].elements[0].font_size = 17.5;
      return { design: fitted, actions: [{ type: 'font_size_adjustment' }] };
    },
  });
  const result = await h.execute();
  assert.equal(result.generation_status, 'ai_repaired_success');
  assert.deepEqual(h.calls, ['initial']); assert.equal(h.phases.repair, 0); assert.equal(h.phases.fallback, 0);
  assert.equal(h.saved().initial_text_fit_used, true);
  assert.ok(h.events.some(e => e.mode === 'initial_text_fit'));
});
test('model page repair failure stops after two requests', async t => {
  const h = await harness(t, { validate: async () => ({ issues: [{ severity: 'error', code: 'out_of_bounds', slide_id: 's1', element_id: 't1' }] }) });
  await assert.rejects(h.execute(), { code: 'repair_failed' }); assert.deepEqual(h.calls, ['initial', 'model_repair']);
});
test('model repair must structurally reallocate pages marked as height-impossible', async t => {
  const d = design();
  d.slides[0].elements.unshift({ id: 'panel', type: 'shape', shape_type: 'rect', x: 0.8, y: 0.8, w: 5.4, h: 1.4, fill: '#FFFFFF' });
  const issue = { severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', structural_relayout_required: true };
  const h = await harness(t, {
    request: async ({ reserve, repair }) => {
      await reserve(repair ? 'model_repair' : 'initial');
      if (!repair) return d;
      const page = structuredClone(d.slides[0]);
      Object.assign(page.elements.find(e => e.id === 't1'), { h: 1.4, font_size: 16, line_spacing: 18 });
      page.elements.find(e => e.id === 'panel').h = 1.8;
      return { slides: [page] };
    },
    validate: async () => ({ issues: [issue] }),
    finishTextFit: async () => null,
  });
  await assert.rejects(h.execute(), { code: 'repair_failed' });
  assert.deepEqual(h.calls, ['initial', 'model_repair']);
  assert.deepEqual(h.events.find(e => e.event === 'repair_structure_check').failed, [{ slide_id: 's1', element_id: 't1' }]);
});
test('3.4 percent residual overflow is fitted after model repair without a legacy request', async t => {
  let checks = 0, fits = 0;
  const h = await harness(t, { validate: async d => {
    const check = checks++;
    if (check === 2) {
      assert.equal(d.slides[0].elements[0].font_size, 17.28);
      return { issues: [] };
    }
    return { issues: [{ severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1',
      overflow_ratio: check === 0 ? 0.6150793650793651 : 0.033950617283950546 }] };
  }, finishTextFit: async current => {
    if (fits++ === 0) return null;
    const fitted = structuredClone(current); fitted.slides[0].elements[0].font_size = 17.28;
    return { design: fitted, actions: [{ type: 'font_size_adjustment' }] };
  } });
  const result = await h.execute();
  assert.equal(result.generation_status, 'ai_repaired_success');
  assert.deepEqual(h.calls, ['initial', 'model_repair']);
  assert.equal(h.phases.repair, 1);
  assert.equal(h.phases.fallback, 0);
  assert.equal(h.saved().text_fit_used, true);
  assert.equal(result.outline.slides[0].elements[0].text, '真实内容');
  assert.ok(h.events.some(e => e.mode === 'post_model_text_fit'));
});
test('failed post-model fit is not repeated after worker recovery', async t => {
  const issue = { severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.034 };
  const fitted = lightRepair(design(), [issue]).design;
  const h = await harness(t, { validate: async () => ({ issues: [issue] }) });
  h.context.state = { manifest: [], design: design(), repaired_design: fitted, repair_mode: 'model', text_fit_used: true };
  await assert.rejects(h.execute(), { code: 'repair_failed' });
  assert.deepEqual(h.calls, []);
  assert.ok(!h.events.some(e => e.mode === 'post_model_text_fit'));
  assert.equal(h.saved().repaired_design.slides[0].elements[0].font_size, 17.28);
});
test('a post-model fit that still overflows fails without further shrink or requests', async t => {
  let checks = 0, fits = 0;
  const h = await harness(t, { validate: async () => ({ issues: [{
    severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1',
    overflow_ratio: checks++ === 0 ? 0.61 : 0.034,
  }] }), finishTextFit: async current => {
    if (fits++ === 0) return null;
    const fitted = structuredClone(current); fitted.slides[0].elements[0].font_size = 17.28;
    return { design: fitted, actions: [{ type: 'font_size_adjustment' }] };
  } });
  await assert.rejects(h.execute(), { code: 'repair_failed' });
  assert.equal(checks, 3);
  assert.deepEqual(h.calls, ['initial', 'model_repair']);
  assert.equal(h.saved().repaired_design.slides[0].elements[0].font_size, 17.28);
  assert.equal(h.events.filter(e => e.mode === 'post_model_text_fit').length, 1);
});
test('post-model fit survives interruption before validation without shrinking again', async t => {
  const issue = { severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.034 };
  const fitted = lightRepair(design(), [issue]).design;
  const h = await harness(t);
  h.context.state = { manifest: [], design: design(), repaired_design: fitted, repair_mode: 'model', text_fit_used: true };
  const result = await h.execute();
  assert.equal(result.generation_status, 'ai_repaired_success');
  assert.equal(result.outline.slides[0].elements[0].font_size, 17.28);
  assert.deepEqual(h.calls, []);
});
test('bounded fit reduces measured CJK paragraph height with explicit line spacing', async () => {
  const d = design();
  const e = d.slides[0].elements[0];
  Object.assign(e, { font_family: 'Arial Unicode MS', text: Array(10).fill('户外茶室保留通透视野').join('\n'),
    font_size: 18, line_spacing: 24, paragraph_spacing: 6, h: 4.5 });
  const measured = await measure(e);
  e.h = measured.height / 1.0339506172839505;
  const fitted = lightRepair(d, [{ severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.0339506172839505 }]);
  const next = fitted.design.slides[0].elements[0];
  assert.equal(next.text, e.text);
  assert.deepEqual([next.x, next.y, next.w, next.h], [e.x, e.y, e.w, e.h]);
  assert.ok(next.font_size >= e.font_size * 0.96);
  assert.ok(next.line_spacing < e.line_spacing);
  assert.ok((await measure(next)).height <= next.h + 0.025);
});
test('production tea paragraph residual expands into free space before reducing font size', async () => {
  const d = design();
  Object.assign(d.slides[0].elements[0], { x: 0.8, y: 2.5, w: 5, h: 4.5, font_size: 15,
    line_spacing: 22, paragraph_spacing: 10 });
  const issues = [{ severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.033950617283950546 }];
  const fit = await finishTextFit(d, issues, { measure: async () => ({ height: 4.536944444444444 }) });
  const e = fit.design.slides[0].elements[0];
  assert.equal(e.font_size, 15);
  assert.equal(e.h, 4.547);
  assert.equal(e.text, d.slides[0].elements[0].text);
  assert.deepEqual([e.x, e.y, e.w], [0.8, 2.5, 5]);
  assert.equal(fit.actions.length, 1);
  assert.equal(d.slides[0].elements[0].h, 4.5);
});
test('text fit declines unsafe growth, rotation and alignment but can use safe page space', async () => {
  const issue = { severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.034 };
  for (const variant of ['lower_text', 'upper_layer', 'edge', 'rotation', 'middle', 'large']) {
    const d = design();
    const e = d.slides[0].elements[0];
    Object.assign(e, { x: 0.8, y: 2.5, w: 5, h: 4.5, font_size: 15 });
    if (variant === 'lower_text') d.slides[0].elements.push({ ...e, id: 'footer', y: 7.01, h: 0.2, text: '页脚' });
    if (variant === 'upper_layer') d.slides[0].elements.push({ id: 'overlay', type: 'shape', x: 0, y: 0, w: 13.3, h: 7.5 });
    if (variant === 'edge') e.y = 3;
    if (variant === 'rotation') e.rotation = 5;
    if (variant === 'middle') e.vertical_align = 'middle';
    const fit = await finishTextFit(d, [issue], { measure: async () => ({ height: variant === 'large' ? 5 : 4.536944444444444 }) });
    if (variant === 'large') {
      assert.equal(fit.design.slides[0].elements[0].h, 5);
    } else {
      assert.equal(fit, null, variant);
    }
  }
});
test('existing full background allows growth and unaffected elements remain intact', async () => {
  const d = design();
  const bg = { id: 'bg', type: 'shape', x: 0, y: 0, w: 13.3, h: 7.5 };
  d.slides[0].elements.unshift(bg);
  const fit = await finishTextFit(d, [{ severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.034 }],
    { measure: async () => ({ height: 1.03 }) });
  assert.equal(fit.design.slides[0].elements[1].h, 1.04);
  assert.deepEqual(fit.design.slides[0].elements[0], bg);
});
test('8.46 percent residual shrinks within the existing product card and is remeasured', async () => {
  const d = design();
  const e = d.slides[0].elements[0];
  Object.assign(e, { x: 5.2, y: 3.2, w: 6.8, h: 3.4, font_size: 13, line_spacing: 18, paragraph_spacing: 6 });
  d.slides[0].elements.unshift({ id: 'card', type: 'shape', shape_type: 'rect', x: 0.8, y: 1.6, w: 11.73, h: 5.2 });
  const issues = [{ severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.08455882352941169 }];
  const fit = await finishTextFit(d, issues, { measure: async candidate => ({ height: 3.6875 * candidate.font_size / 13 }) });
  assert.equal(fit.design.slides[0].elements[1].font_size, 12.5);
  assert.equal(fit.design.slides[0].elements[1].h, 3.556);
  assert.equal(fit.design.slides[0].elements[1].text, e.text);
  const blocked = await finishTextFit(d, issues, { measure: async () => ({ height: 3.7 }) });
  assert.equal(blocked, null);
});
test('text fit keeps successful elements when another element cannot be repaired', async () => {
  const d = design();
  const second = structuredClone(d.slides[0]); second.id = 's2'; second.elements[0].id = 't2'; d.slides.push(second);
  const issues = [
    { severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1', overflow_ratio: 0.03 },
    { severity: 'error', code: 'text_overflow', slide_id: 's2', element_id: 't2', overflow_ratio: 4 },
  ];
  const fit = await finishTextFit(d, issues, { measure: async element => ({ height: element.id === 't1' ? 1.03 : 100 }) });
  assert.equal(fit.design.slides[0].elements[0].h, 1.04);
  assert.equal(fit.design.slides[1].elements[0].h, 1);
  assert.ok(fit.actions.every(action => action.slide_id === 's1'));
});
test('new model errors never invoke legacy, while already persisted legacy jobs can resume', async t => {
  const h = await harness(t, { request: async () => { throw new Error('model unavailable'); } });
  await assert.rejects(h.execute(), /model unavailable/);
  assert.equal(h.phases.fallback, 0);
  assert.equal(h.saved().fallback_started, undefined);
  const old = await harness(t);
  old.context.state = { fallback_started: true, legacy_outline: { schema_version: 1, slides: [] }, fallback_reason: { code: 'old', message: 'old' } };
  assert.equal((await old.execute()).generation_status, 'legacy_fallback_success');
  assert.deepEqual(old.calls, []);
});
test('bottom overflow trims only unused frame space without changing text or typography', async () => {
  const d = design();
  Object.assign(d.slides[0].elements[0], { y: 1.8, h: 5.8 });
  d.slides.push({ ...structuredClone(d.slides[0]), id: 's2' });
  Object.assign(d.slides[1].elements[0], { y: 1.6, h: 6.2 });
  const issues = d.slides.map(s => ({ severity: 'error', code: 'out_of_bounds', slide_id: s.id, element_id: 't1' }));
  const fit = await finishTextFit(d, issues, { measure: async () => ({ height: 5.5 }) });
  assert.deepEqual(fit.design.slides.map(s => s.elements[0].h), [5.7, 5.9]);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual({ ...fit.design.slides[i].elements[0], h: d.slides[i].elements[0].h }, d.slides[i].elements[0]);
  }
  assert.equal(fit.actions.length, 2);
});
test('boundary repair refuses clipping, large overflow, rotation and horizontal changes', async () => {
  const issue = { severity: 'error', code: 'out_of_bounds', slide_id: 's1', element_id: 't1' };
  for (const variant of ['clip', 'large', 'rotate', 'right', 'bottom_align']) {
    const d = design(); const e = d.slides[0].elements[0];
    Object.assign(e, { y: 1.8, h: 5.8 });
    if (variant === 'large') e.h = 7;
    if (variant === 'rotate') e.rotation = 5;
    if (variant === 'right') e.x = 10;
    if (variant === 'bottom_align') e.vertical_align = 'bottom';
    assert.equal(await finishTextFit(d, [issue], { measure: async () => ({ height: variant === 'clip' ? 5.75 : 5 }) }), null, variant);
  }
});
test('pipeline accepts measured boundary repair with no legacy request', async t => {
  let checks = 0;
  const d = design(); Object.assign(d.slides[0].elements[0], { y: 1.8, h: 5.8 });
  const h = await harness(t, { validate: async current => {
    if (checks++ === 0) return { issues: [{ severity: 'error', code: 'out_of_bounds', slide_id: 's1', element_id: 't1' }] };
    assert.equal(current.slides[0].elements[0].h, 5.7);
    return { issues: [] };
  } });
  h.context.state = { manifest: [], design: design(), repaired_design: d, repair_mode: 'model' };
  assert.equal((await h.execute()).generation_status, 'ai_repaired_success');
  assert.deepEqual(h.calls, []);
  assert.equal(h.saved().text_fit_used, true);
});
test('model receives only unresolved pages and server restores changed text by element ID', async t => {
  let checks = 0;
  const d = design(); d.slides.push({ ...structuredClone(d.slides[0]), id: 's2' });
  const h = await harness(t, {
    request: async ({ reserve, repair }) => {
      await reserve(repair ? 'model_repair' : 'initial');
      if (!repair) return d;
      assert.deepEqual(repair.ids, ['s2']);
      const page = structuredClone(d.slides[1]); page.elements[0].x = 2; page.elements[0].text = '模型删改的文案';
      return { slides: [page] };
    },
    finishTextFit: async current => {
      const fitted = structuredClone(current); fitted.slides[0].elements[0].font_size = 17;
      return { design: fitted, actions: [{ slide_id: 's1', element_id: 't1', type: 'font_size_adjustment' }] };
    },
    validate: async current => {
      const pass = checks++;
      if (pass === 0) return { issues: [
        { severity: 'error', code: 'text_overflow', slide_id: 's1', element_id: 't1' },
        { severity: 'error', code: 'text_overflow', slide_id: 's2', element_id: 't1' },
      ] };
      if (pass === 1) {
        assert.equal(current.slides[0].elements[0].font_size, 17);
        return { issues: [{ severity: 'error', code: 'text_overflow', slide_id: 's2', element_id: 't1' }] };
      }
      assert.equal(current.slides[1].elements[0].text, '真实内容');
      assert.equal(current.slides[1].elements[0].x, 2);
      return { issues: [] };
    },
  });
  const result = await h.execute();
  assert.equal(result.generation_status, 'ai_repaired_success');
  assert.equal(result.outline.slides[0].elements[0].font_size, 17);
  assert.equal(result.outline.slides[1].elements[0].text, '真实内容');
  assert.ok(h.events.some(event => event.mode === 'model' && event.restored_text?.some(item => item.slide_id === 's2' && item.element_id === 't1')));
});
test('fatal asset failure never invokes either model or legacy', async t => {
  const h = await harness(t, { prepare: async () => { throw Object.assign(new Error('broken'), { fatal: true }); } });
  await assert.rejects(h.execute(), /broken/); assert.deepEqual(h.calls, []); assert.equal(h.phases.fallback, 0);
});
test('recovering a repaired design revalidates without consuming another repair', async t => {
  const h = await harness(t); h.context.state = { manifest: [], design: design(), repaired_design: design() };
  assert.equal((await h.execute()).generation_status, 'ai_repaired_success'); assert.deepEqual(h.calls, []);
});
test('malformed initial schema fails without legacy or whole-deck regeneration', async t => {
  const h = await harness(t, { validate: async () => ({ issues: [{ severity: 'error', code: 'schema' }] }) });
  await assert.rejects(h.execute(), { code: 'design_invalid' }); assert.deepEqual(h.calls, ['initial']);
});
test('previously persisted fallback failure propagates as failure, not success', async t => {
  const h = await harness(t, { request: async () => { throw new Error('AI failure'); } });
  h.context.state = { fallback_started: true, fallback_reason: { code: 'old_failure', message: 'old failure' } };
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
