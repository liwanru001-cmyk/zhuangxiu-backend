'use strict';
const fs = require('fs/promises');
const path = require('path');
const assets = require('./assets');
const model = require('./model');
const validator = require('./validate');
const renderer = require('./render');
const { failure } = require('./config');
const changed = (a, b) => Math.abs(Number(a) - Number(b)) > 0.001;
const draftableLayoutErrors = new Set([
  'text_overflow', 'out_of_bounds', 'text_collision', 'text_occluded',
  'render_text_overflow', 'render_text_missing', 'render_page_count', 'render_failed',
]);
function canRenderDraft(issues) {
  const errors = (issues || []).filter(issue => issue.severity === 'error');
  return errors.length > 0 && errors.every(issue => draftableLayoutErrors.has(issue.code));
}
function structuralRepairFailures(design, repairedSlides, errors) {
  const failures = [];
  for (const error of errors.filter(e => e.structural_relayout_required)) {
    const beforePage = design.slides.find(s => s.id === error.slide_id);
    const afterPage = repairedSlides.find(s => s.id === error.slide_id);
    const beforeText = beforePage?.elements.find(e => e.id === error.element_id && e.type === 'text');
    const afterText = afterPage?.elements.find(e => e.id === error.element_id && e.type === 'text');
    if (!beforeText || !afterText) continue;
    const textReallocated = ['x', 'y', 'w'].some(key => changed(beforeText[key], afterText[key]));
    const adjacentReallocated = beforePage.elements.some(before => {
      if (!['image', 'shape'].includes(before.type)) return false;
      const gapX = Math.max(beforeText.x - (before.x + before.w), before.x - (beforeText.x + beforeText.w), 0);
      const gapY = Math.max(beforeText.y - (before.y + before.h), before.y - (beforeText.y + beforeText.h), 0);
      if (gapX > 1 || gapY > 1) return false;
      const after = afterPage.elements.find(e => e.id === before.id && e.type === before.type);
      if (!after) return false;
      const moved = changed(before.x, after.x) || changed(before.y, after.y);
      const shrunk = after.w < before.w - 0.001 || after.h < before.h - 0.001;
      return moved || shrunk;
    });
    if (!textReallocated && !adjacentReallocated) failures.push({ slide_id: error.slide_id, element_id: error.element_id });
  }
  return failures;
}
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
  const finishTextFit = adapters.finishTextFit || validator.finishTextFit;
  const render = adapters.render || renderer.render;
  const renderedValidation = adapters.renderedValidation || renderer.renderedValidation;
  let draftCandidate = null, draftIssues = [], repairStructureFailures = state.repair_structure_failures || [];
  async function deliverDraft(design, issues, reason) {
    const errors = issues.filter(issue => issue.severity === 'error');
    try { await fs.access(output); }
    catch { await render(design, state.manifest, output, { signal, timeout: limits.renderTimeout }); }
    const draftIssueCount = errors.length || repairStructureFailures.length;
    await save({
      validated_response: design,
      validation_issues: issues,
      validation_errors: errors,
      repair_structure_failures: repairStructureFailures,
      draft_reason: reason,
    });
    await record({ event: 'draft_delivered', reason, issues: errors, repair_structure_failures: repairStructureFailures });
    return {
      outline: design,
      schema_version: 2,
      generation_mode: 'ai_design_v2',
      generation_status: 'ai_draft',
      draft: true,
      draft_issue_count: draftIssueCount,
      draft_reason: reason,
      fallback_used: false,
      render_validation: errors.some(issue => issue.code.startsWith('render_')) ? 'failed' : 'skipped',
      render_validation_reason: errors.some(issue => issue.code.startsWith('render_')) ? 'draft_render_validation_errors' : 'draft_layout_errors',
    };
  }
  async function check(design, label) {
    await context.checkpoint(); signal.throwIfAborted();
    const beforeFonts = structuredClone(design);
    const result = await validate(design, state.manifest, { limits, signal });
    await record({ event: 'validation', label, ...result, pre_font_layout: result.font_actions?.length ? beforeFonts : undefined, post_font_layout: result.font_actions?.length ? design : undefined });
    if (result.issues.some(i => i.severity === 'error')) return result.issues;
    await render(design, state.manifest, output, { signal, timeout: limits.renderTimeout });
    if (limits.renderValidation !== 'full') {
      await record({
        event: 'render_validation',
        label,
        skipped: true,
        reason: 'render_engine_disabled',
        environment: { mode: 'static', text_engine: result.environment?.text_engine || 'sharp/Pango' },
      });
      return result.issues;
    }
    const actual = await renderedValidation(design, output, { limits, signal });
    await record({ event: 'render_validation', label, ...actual });
    return [...result.issues, ...actual.issues];
  }
  async function fallback(error) {
    if (error.fatal || signal.aborted) throw error;
    const reason = { code: error.code || 'v2_failed', message: error.message };
    await record({ event: 'primary_generation_error', ...reason });
    // Only resume a legacy fallback that was already persisted by an older
    // worker. New V2 failures must remain failures, never become V1 success.
    if (!state.fallback_started) {
      await save({ v2_failure: reason });
      await record({ event: 'fallback_blocked', reason, policy: 'v2_only' });
      throw error;
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
    // Do not label resumed historical designs with the currently running code.
    if (!state.design && !state.generator_version) await save({ generator_version: require('./version').snapshot() });
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
    let design = structuredClone(state.repaired_design || state.initial_fitted_design || state.design);
    draftCandidate = structuredClone(design);
    const initialLabel = state.repaired_design ? 'model_repaired' : state.initial_fitted_design ? 'initial_text_fit' : 'initial';
    let issues = await check(design, initialLabel);
    draftIssues = issues;
    let repaired = !!(state.repaired_design || state.initial_fitted_design);
    // Text metrics and safe page-edge trimming belong to the server. Try them
    // before spending the single model repair request.
    if (issues.some(i => i.severity === 'error') && !state.repaired_design && !state.initial_text_fit_used) {
      const fit = await finishTextFit(design, issues, { signal });
      if (fit) {
        await save({ initial_fitted_design: fit.design, initial_text_fit_used: true, initial_text_fit_actions: fit.actions });
        await record({ event: 'repair_actions', mode: 'initial_text_fit', actions: fit.actions, pre_repair_layout: design, post_repair_layout: fit.design });
        design = structuredClone(fit.design); repaired = true;
        issues = await check(design, 'initial_text_fit');
        draftCandidate = structuredClone(design); draftIssues = issues;
      } else {
        await save({ initial_text_fit_used: true, initial_text_fit_actions: [] });
      }
    }
    if (issues.some(i => i.severity === 'error') && !state.repaired_design) {
      const errors = issues.filter(i => i.severity === 'error');
      // Schema-invalid or page-less output cannot be safely repaired as individual pages.
      if (errors.some(e => !e.slide_id || e.code === 'duplicate_slide')) throw failure('design_invalid', '模型设计无法执行单页修复');
      await context.claimRepair('model');
      const ids = [...new Set(errors.map(e => e.slide_id))];
      const result = await generate({ source: state.model_source, settings, manifest: state.manifest, limits, signal,
        repair: { design, ids, errors }, reserve: context.reserve, record });
      if (!result || Object.keys(result).some(k => k !== 'slides') || !Array.isArray(result.slides) || result.slides.length !== ids.length || new Set(result.slides.map(s => s.id)).size !== ids.length || result.slides.some(s => !ids.includes(s.id))) throw failure('repair_page_ids', '模型修正页 ID 与失败页不一致');
      const restoredText = [];
      // The model owns repair geometry, while the server owns the exact copy.
      // Restore every original text element by ID before any fit or validation.
      for (const old of design.slides.filter(s => ids.includes(s.id))) {
        const replacement = result.slides.find(s => s.id === old.id);
        const replacementTexts = new Map((replacement.elements || []).filter(e => e.type === 'text').map(e => [e.id, e]));
        for (const originalText of old.elements.filter(e => e.type === 'text')) {
          const repairedText = replacementTexts.get(originalText.id);
          if (!repairedText) throw failure('repair_content_changed', '模型单页修正删除或重命名了原文本元素');
          if (repairedText.text !== originalText.text) {
            repairedText.text = originalText.text;
            restoredText.push({ slide_id: old.id, element_id: originalText.id });
          }
        }
        const paragraphs = page => (page.elements || []).filter(e => e.type === 'text')
          .flatMap(e => String(e.text).split(/\n+/)).map(text => text.replace(/\s/g, '')).filter(Boolean).sort();
        if (JSON.stringify(paragraphs(old)) !== JSON.stringify(paragraphs(replacement))) throw failure('repair_content_changed', '模型单页修正改变了原始文案');
      }
      const structuralFailures = structuralRepairFailures(design, result.slides, errors);
      await record({ event: 'repair_structure_check', required: errors.filter(e => e.structural_relayout_required).map(e => ({ slide_id: e.slide_id, element_id: e.element_id })), failed: structuralFailures });
      repairStructureFailures = structuralFailures;
      const next = { ...design, slides: design.slides.map(s => result.slides.find(r => r.id === s.id) || s) };
      await save({ repaired_design: next, repair_mode: 'model', repair_structure_failures: structuralFailures });
      await record({ event: 'repair_actions', mode: 'model', restored_text: restoredText, pre_repair_layout: design, post_repair_layout: next });
      design = structuredClone(next); repaired = true;
      issues = await check(design, 'model_repaired');
      draftCandidate = structuredClone(design); draftIssues = issues;
    }
    // A model redesign may leave a small font-metric mismatch. Allow one
    // bounded fit, never another model call or a second server-only repair.
    if (issues.some(i => i.severity === 'error') && state.repair_mode === 'model' && !state.text_fit_used) {
      const fit = await finishTextFit(design, issues, { signal });
      if (fit) {
        // Persist the adjusted design and consumed fit together before checking
        // it so worker recovery cannot repeatedly shrink the same paragraphs.
        await save({ repaired_design: fit.design, text_fit_used: true, text_fit_actions: fit.actions });
        await record({ event: 'repair_actions', mode: 'post_model_text_fit', actions: fit.actions, pre_repair_layout: design, post_repair_layout: fit.design });
        design = structuredClone(fit.design);
        issues = await check(design, 'post_model_text_fit');
        draftCandidate = structuredClone(design); draftIssues = issues;
      }
    }
    if (issues.some(i => i.severity === 'error') || repairStructureFailures.length) {
      const errors = issues.filter(i => i.severity === 'error');
      if (canRenderDraft(issues) || (!errors.length && repairStructureFailures.length)) {
        return deliverDraft(design, issues, repairStructureFailures.length ? 'repair_structure_incomplete' : 'layout_validation_failed');
      }
      await save({ validation_errors: errors, validation_issues: issues });
      throw failure('repair_failed', 'V2 排版修正后仍未通过校验');
    }
    await save({ validated_response: design, validation_issues: issues });
    const renderVerified = limits.renderValidation === 'full';
    return {
      outline: design,
      schema_version: 2,
      generation_mode: 'ai_design_v2',
      generation_status: renderVerified
        ? (repaired ? 'ai_repaired_success' : 'ai_success')
        : (repaired ? 'ai_repaired_success_unverified_render' : 'ai_success_unverified_render'),
      fallback_used: false,
      render_validation: renderVerified ? 'passed' : 'skipped',
      render_validation_reason: renderVerified ? null : 'render_engine_disabled',
    };
  } catch (error) {
    // A bad or incomplete repair must not discard an already renderable V2
    // design. Keep the last copy-safe candidate and expose its flaws as a
    // draft. Fatal environment, schema and asset failures still fail.
    if (!error.fatal && !signal.aborted && draftCandidate && canRenderDraft(draftIssues)) {
      try { return await deliverDraft(draftCandidate, draftIssues, error.code || 'repair_incomplete'); }
      catch (draftError) { error = draftError; }
    }
    await fs.rm(output, { force: true });
    return fallback(error);
  }
}
module.exports = { run };
