'use strict';
const fs = require('fs/promises');
const path = require('path');
const assets = require('./assets');
const model = require('./model');
const validator = require('./validate');
const renderer = require('./render');
const { failure } = require('./config');
async function run({ source, rawSettings, legacy, context, output, limits, signal, adapters = {} }) {
  // The persisted source/settings belong to the task, never to either designer.
  const original = structuredClone(source), settingsSnapshot = structuredClone(rawSettings);
  const settings = legacy.normalizeSettings(structuredClone(settingsSnapshot), structuredClone(original));
  let state = structuredClone(context.state || {});
  const save = async patch => { state = { ...state, ...patch }; await context.save(state); };
  limits = state.limits_snapshot || limits;
  const record = event => context.record(event);
  const prepare = adapters.prepare || assets.prepare;
  const generate = adapters.request || model.request;
  const validate = adapters.validate || validator.validate;
  const render = adapters.render || renderer.render;
  const renderedValidation = adapters.renderedValidation || renderer.renderedValidation;
  async function check(design, label) {
    await context.checkpoint(); signal.throwIfAborted();
    const beforeFonts = structuredClone(design);
    const result = await validate(design, state.manifest, { limits, signal });
    await record({ event: 'validation', label, ...result, pre_font_layout: result.font_actions?.length ? beforeFonts : undefined, post_font_layout: result.font_actions?.length ? design : undefined });
    if (result.issues.some(i => i.severity === 'error')) return result.issues;
    await render(design, state.manifest, output, { signal, timeout: limits.renderTimeout });
    const actual = await renderedValidation(design, output, { limits, signal });
    await record({ event: 'render_validation', label, ...actual });
    return [...result.issues, ...actual.issues];
  }
  async function fallback(error) {
    if (error.fatal || signal.aborted) throw error;
    const reason = { code: error.code || 'v2_failed', message: error.message };
    await record({ event: 'primary_generation_error', ...reason });
    if (!state.fallback_started) {
      await context.claimFallback(reason);
      await save({ fallback_started: true, fallback_reason: reason });
    }
    let outline = state.legacy_outline;
    if (!outline) {
      const result = await legacy.generateOutline(structuredClone(original), structuredClone(settingsSnapshot), {
        maxAttempts: 1, timeoutMs: Math.min(limits.callTimeout, context.remaining()), signal,
        beforeRequest: () => context.reserve('legacy'),
        onResponse: data => record({ event: 'response', stage: 'legacy', ...data }),
      });
      outline = result.outline; await save({ legacy_outline: outline });
    }
    await context.checkpoint();
    const plan = legacy.buildRenderPlan(structuredClone(original), structuredClone(settingsSnapshot), structuredClone(outline));
    // Resolve to the frozen high-resolution files, not mutable live URLs.
    try {
      await (adapters.renderLegacy || context.renderLegacy)(plan, output, { signal, timeout: limits.renderTimeout, maxSlides: limits.maxSlides, strict: true, manifest: state.manifest });
    } catch (error) {
      await record({ event: 'fallback_result', result: 'failed', code: error.code, message: error.message });
      throw error;
    }
    await record({ event: 'fallback_result', result: 'success' });
    return { outline, schema_version: 1, generation_mode: 'legacy', generation_status: 'legacy_fallback_success', fallback_used: true, fallback_reason: state.fallback_reason };
  }
  if (state.fallback_started) return fallback(failure(state.fallback_reason?.code || 'v2_failed', state.fallback_reason?.message || '恢复旧流程'));
  try {
    if (!state.limits_snapshot) await save({ limits_snapshot: limits });
    const environment = await (adapters.preflight || renderer.preflight)({ directory: path.dirname(output), limits, signal });
    await record({ event: 'render_environment_preflight', environment });
    if (!state.manifest) {
      const manifest = await prepare(original, settings, { directory: context.assetDirectory, limits, signal, checkpoint: context.checkpoint });
      await save({ manifest, settings, prompt_version: model.PROMPT_VERSION, limits_snapshot: limits });
    }
    if (!state.design) {
      const sourceForModel = legacy.sourceForModel(original, settings);
      // Images are represented exclusively by the scoped manifest. Respect section toggles.
      if (!settings.sections.whole_house_plan) sourceForModel.whole_house_documents = [];
      for (const space of sourceForModel.spaces) {
        if (!settings.sections.space_solutions) { space.documents = []; space.renderings = []; }
        if (!settings.sections.product_summary && !settings.sections.space_solutions) space.products = [];
      }
      const design = await generate({ source: sourceForModel, settings, manifest: state.manifest, limits, signal, reserve: context.reserve, record });
      await save({ design, model_source: sourceForModel });
    }
    let design = structuredClone(state.repaired_design || state.design);
    let issues = await check(design, state.repaired_design ? 'repaired' : 'initial');
    let repaired = !!state.repaired_design;
    if (issues.some(i => i.severity === 'error')) {
      if (state.repaired_design) throw failure('repair_failed', '修正后页面仍未通过验证');
      const errors = issues.filter(i => i.severity === 'error');
      const light = validator.lightRepair(design, issues);
      // Schema-invalid or page-less output cannot be safely repaired as individual pages.
      if (!light && errors.some(e => !e.slide_id || e.code === 'duplicate_slide')) throw failure('design_invalid', '模型设计无法执行单页修复');
      await context.claimRepair(light ? 'server' : 'model');
      let next;
      if (light) {
        next = light.design;
        await record({ event: 'repair_actions', mode: 'server', actions: light.actions, pre_repair_layout: design, post_repair_layout: next });
      } else {
        const ids = [...new Set(errors.map(e => e.slide_id))];
        const result = await generate({ source: state.model_source, settings, manifest: state.manifest, limits, signal,
          repair: { design, ids, errors }, reserve: context.reserve, record });
        if (!result || Object.keys(result).some(k => k !== 'slides') || !Array.isArray(result.slides) || result.slides.length !== ids.length || new Set(result.slides.map(s => s.id)).size !== ids.length || result.slides.some(s => !ids.includes(s.id))) throw failure('repair_page_ids', '模型修正页 ID 与失败页不一致');
        next = { ...design, slides: design.slides.map(s => result.slides.find(r => r.id === s.id) || s) };
        // Factual text cannot silently disappear during a layout repair.
        for (const old of design.slides.filter(s => ids.includes(s.id))) {
          const replacement = result.slides.find(s => s.id === old.id);
          const paragraphs = page => (page.elements || []).filter(e => e.type === 'text')
            .flatMap(e => String(e.text).split(/\n+/)).map(text => text.replace(/\s/g, '')).filter(Boolean).sort();
          if (JSON.stringify(paragraphs(old)) !== JSON.stringify(paragraphs(replacement))) throw failure('repair_content_changed', '模型单页修正改变了原始文案');
        }
        await record({ event: 'repair_actions', mode: 'model', pre_repair_layout: design, post_repair_layout: next });
      }
      await save({ repaired_design: next });
      design = structuredClone(next); repaired = true;
      issues = await check(design, 'repaired');
      if (issues.some(i => i.severity === 'error')) throw failure('repair_failed', '一次修正后仍存在验证错误');
    }
    await save({ validated_response: design, validation_issues: issues });
    return { outline: design, schema_version: 2, generation_mode: 'ai_design_v2', generation_status: repaired ? 'ai_repaired_success' : 'ai_success', fallback_used: false };
  } catch (error) {
    await fs.rm(output, { force: true });
    return fallback(error);
  }
}
module.exports = { run };
