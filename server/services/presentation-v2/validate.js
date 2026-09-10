'use strict';
const sharp = require('sharp');
const fs = require('fs/promises');
const execFile = require('util').promisify(require('child_process').execFile);
const { compile } = require('./schema');
const { spec, failure } = require('./config');
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function bounds(e) {
  const angle = (e.rotation || 0) * Math.PI / 180;
  const w = Math.abs(e.w * Math.cos(angle)) + Math.abs(e.h * Math.sin(angle));
  const h = Math.abs(e.w * Math.sin(angle)) + Math.abs(e.h * Math.cos(angle));
  const stroke = (e.type === 'line' ? e.width || 0 : e.type === 'shape' ? e.stroke?.width || 0 : 0) / 144;
  return { x: e.x + (e.w - w) / 2 - stroke, y: e.y + (e.h - h) / 2 - stroke, w: w + 2 * stroke, h: h + 2 * stroke };
}
function displayRect(e, assets) {
  if (e.type !== 'image' || e.fit !== 'contain') return e;
  const asset = assets.get(e.asset_id);
  if (!asset || !asset.width || !asset.height) return e;
  const scale = Math.min(e.w / asset.width, e.h / asset.height);
  const w = asset.width * scale, h = asset.height * scale;
  return { ...e, x: e.x + (e.w - w) / 2, y: e.y + (e.h - h) / 2, w, h };
}
function intersection(a, b) { return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); }
async function resolveFonts(design, fallback, signal) {
  const actions = []; const cache = new Map();
  async function resolve(name) {
    if (!cache.has(name)) {
      const { stdout } = await execFile(process.env.PRESENTATION_FC_MATCH || 'fc-match', ['-f', '%{family}\n', name], { timeout: 5000, signal });
      cache.set(name, stdout.trim().split(',')[0]);
    }
    return cache.get(name);
  }
  const fallbackActual = await resolve(fallback);
  if (fallbackActual.toLowerCase() !== fallback.toLowerCase()) throw failure('font_environment', `服务器缺少指定 fallback 字体：${fallback}`, true);
  for (const page of design.slides) for (const e of page.elements.filter(e => e.type === 'text')) {
    const requested = e.font_family || fallback;
    const actual = await resolve(requested);
    const selected = actual.toLowerCase() === requested.toLowerCase() ? actual : fallbackActual;
    if (e.font_family !== selected) actions.push({ slide_id: page.id, element_id: e.id, type: 'font_resolution', before: e.font_family || null, after: selected });
    e.font_family = selected;
  }
  return actions;
}
async function measure(e) {
  const width = Math.floor((e.w * 72 - 2 * (e.margin || 0)) * 2);
  if (width <= 0) return { height: Infinity, lines: Infinity };
  // Pango shapes actual glyphs and wraps at the actual font. This is a metric
  // preflight, explicitly not a claim of PowerPoint layout equivalence.
  const { info } = await sharp({ text: { text: escape(e.text), font: `${e.font_family} ${e.font_weight === 'bold' ? 'Bold ' : ''}${e.font_size}`,
    width, dpi: 144, rgba: true, wrap: 'word-char', align: e.align === 'center' ? 'centre' : e.align || 'left',
    spacing: Math.round(((e.line_spacing ?? e.font_size * 1.2) - e.font_size * 1.2) * 2),
  } }).png().toBuffer({ resolveWithObject: true });
  const paragraphs = Math.max(0, e.text.split('\n').length - 1);
  return { height: info.height / 144 + (paragraphs * (e.paragraph_spacing || 0) + 2 * (e.margin || 0)) / 72,
    lines: Math.max(1, Math.round(info.height / (2 * (e.line_spacing ?? e.font_size * 1.2)))) };
}
async function validate(design, manifest, options) {
  const { limits, signal } = options;
  const { validate: schemaCheck } = compile(limits);
  if (!schemaCheck(design)) return { issues: [{ severity: 'error', code: 'schema', message: 'JSON Schema 不匹配', details: schemaCheck.errors }], font_actions: [] };
  const issues = [];
  const add = (severity, code, slide, e, message, extra = {}) => issues.push({ severity, code, slide_id: slide.id, element_id: e?.id, message, ...extra });
  const font_actions = await resolveFonts(design, limits.fallbackFont, signal);
  const assets = new Map(manifest.map(a => [a.asset_id, a])); const slideIds = new Set();
  if (design.slides.reduce((n, s) => n + s.elements.length, 0) > 600) issues.push({ severity: 'error', code: 'element_limit', message: '整份 PPT 最多 600 个元素' });
  for (const slide of design.slides) {
    signal.throwIfAborted();
    if (slideIds.has(slide.id)) add('error', 'duplicate_slide', slide, null, '页面 ID 重复');
    slideIds.add(slide.id); const ids = new Set();
    for (const e of slide.elements) {
      signal.throwIfAborted();
      if (ids.has(e.id)) add('error', 'duplicate_element', slide, e, '元素 ID 重复');
      ids.add(e.id);
      const b = bounds(displayRect(e, assets));
      if ((e.type !== 'line' && (e.w <= 0 || e.h <= 0)) || (e.w === 0 && e.h === 0)) add('error', 'invalid_size', slide, e, '元素尺寸无效');
      if (b.x < -0.001 || b.y < -0.001 || b.x + b.w > spec.width + 0.001 || b.y + b.h > spec.height + 0.001) add('error', 'out_of_bounds', slide, e, '元素边界超出页面（已计入旋转和描边）', { bounds: b, page_width: spec.width, page_height: spec.height });
      if (e.type === 'image') {
        const a = assets.get(e.asset_id);
        if (!a) add('error', 'unknown_asset', slide, e, '模型引用了清单外素材');
        else {
          try { await fs.access(a.highres_path); } catch { throw failure('asset_unavailable', '高清素材文件不可读取', true); }
          if (!(a.width > 0 && a.height > 0)) throw failure('asset_mapping_error', '素材尺寸映射异常', true);
          if (Math.min(e.w, e.h) < 0.25) add('warning', 'small_image', slide, e, '图片显示尺寸较小，请人工检查可辨识性');
        }
      }
      if (e.type === 'text' && e.w > 0 && e.h > 0) {
        const measured = await (options.measure || measure)(e);
        if (measured.height > e.h + 0.025) add('error', 'text_overflow', slide, e, '文本尺寸检测超出文本框', { overflow_ratio: measured.height / e.h - 1, measured_height: measured.height, measurement: 'Pango glyph layout', frame: { x: e.x, y: e.y, w: e.w, h: e.h }, page_remaining_height: Math.max(0, spec.height - e.y), layout_hint: '剩余高度仅是页面上限，仍须避开其他元素；不能只增加 h 导致 y+h 越界。' });
        if (e.max_lines && measured.lines > e.max_lines) add('error', 'text_line_limit', slide, e, '超过模型声明的最大行数');
        else if (e.role === 'title' && measured.lines > 2) add('warning', 'title_wrap', slide, e, '标题超过两行，请检查是否符合设计意图');
      }
    }
    for (let i = 0; i < slide.elements.length; i++) for (let j = i + 1; j < slide.elements.length; j++) {
      const a = slide.elements[i], b = slide.elements[j];
      const overlap = intersection(bounds(displayRect(a, assets)), bounds(displayRect(b, assets)));
      if (!overlap || (a.opacity ?? 1) === 0 || (b.opacity ?? 1) === 0) continue;
      if (a.type === 'text' && !a.rotation && !b.rotation && ['image', 'shape'].includes(b.type) && (b.opacity ?? 1) === 1 && (b.type === 'image' || b.shape_type === 'rect') && overlap / (a.w * a.h) >= 0.98) {
        // Contain can leave empty margins; avoid falsely treating its whole frame as opaque.
        if (b.type !== 'image' || assets.get(b.asset_id)?.opaque) add('error', 'text_occluded', slide, a, `文字被后面的元素 ${b.id} 完全遮挡`);
        else add('warning', 'overlap', slide, a, `与 ${b.id} 重叠，需结合图片实际可见区域检查`);
      } else if (a.type === 'text' && b.type === 'text' && ['body', 'product'].includes(a.role) && ['body', 'product'].includes(b.role) && !a.rotation && !b.rotation && a.text.length > 20 && b.text.length > 20 && overlap / Math.min(a.w * a.h, b.w * b.h) > 0.8) {
        add('error', 'text_collision', slide, b, `正文或商品信息与 ${a.id} 大面积重叠`);
      } else if (a.type === 'text' || b.type === 'text') add('warning', 'overlap', slide, b, `与元素 ${a.id} 重叠；可能是有意叠放`);
    }
  }
  return { issues, font_actions, environment: { text_engine: 'sharp/Pango', text_engine_version: sharp.versions.pango, fallback_font: limits.fallbackFont } };
}
function lightRepair(design, issues, options = {}) {
  const errors = issues.filter(i => i.severity === 'error');
  if (!errors.length || errors.some(e => e.code !== 'text_overflow' || !Number.isFinite(e.overflow_ratio) || e.overflow_ratio <= 0 || (!options.measuredFit && e.overflow_ratio > 0.05))) return null;
  const repaired = structuredClone(design); const actions = []; const seen = new Set();
  for (const error of errors) {
    const key = JSON.stringify([error.slide_id, error.element_id]);
    if (seen.has(key)) continue;
    seen.add(key);
    const e = repaired.slides.find(s => s.id === error.slide_id)?.elements.find(e => e.id === error.element_id);
    if (!e || e.type !== 'text') return null;
    const before = e.font_size; const after = Math.max(6, Math.ceil(before * 0.96 * 100) / 100);
    if (after === before) return null;
    e.font_size = after;
    const spacing = {};
    // Explicit point-based spacing must follow the font; otherwise reducing
    // glyphs leaves the original line boxes and may not reduce the overflow.
    for (const key of ['line_spacing', 'paragraph_spacing']) {
      if (e[key] == null) continue;
      const previous = e[key];
      e[key] = Math.max(key === 'line_spacing' ? 6 : 0, Math.ceil(previous * (after / before) * 100) / 100);
      spacing[key] = { before: previous, after: e[key] };
    }
    actions.push({ slide_id: error.slide_id, element_id: e.id, type: 'font_size_adjustment', before, after, spacing, reason: 'text_overflow', max_reduction: 0.04 });
  }
  return { design: repaired, actions };
}
async function finishTextFit(design, issues, options = {}) {
  const errors = issues.filter(i => i.severity === 'error');
  if (!errors.length || errors.some(i => !['text_overflow', 'out_of_bounds'].includes(i.code))) return null;
  const bounded = structuredClone(design), boundaryActions = [];
  for (const error of errors.filter(i => i.code === 'out_of_bounds')) {
    options.signal?.throwIfAborted();
    const e = bounded.slides.find(s => s.id === error.slide_id)?.elements.find(e => e.id === error.element_id);
    // Only remove unused space below top-aligned, unrotated text. Never move
    // content, narrow its width, crop images or hide actual text to pass bounds.
    if (!e || e.type !== 'text' || e.rotation || (e.vertical_align && e.vertical_align !== 'top')
        || e.x < 0 || e.y < 0 || e.x + e.w > spec.width || e.y >= spec.height) continue;
    const available = Math.floor((spec.height - e.y) * 1000) / 1000;
    if (e.h <= available || e.h - available > e.h * 0.05) continue;
    const measured = await (options.measure || measure)(e);
    if (!Number.isFinite(measured.height) || measured.height + 0.01 > available) continue;
    const before = e.h;
    e.h = available;
    boundaryActions.push({ slide_id: error.slide_id, element_id: e.id, type: 'text_box_boundary_adjustment',
      before, after: available, measured_height: measured.height, max_reduction: 0.05, reason: 'remove_unused_space_outside_page' });
  }
  const fit = { design: bounded, actions: [...boundaryActions] };
  const minimumByRole = { title: 24, subtitle: 14, body: 12, caption: 10, product: 11, decoration: 6 };
  for (const error of errors.filter(i => i.code === 'text_overflow')) {
    options.signal?.throwIfAborted();
    const slide = fit.design.slides.find(s => s.id === error.slide_id);
    const index = slide?.elements.findIndex(e => e.id === error.element_id);
    if (!slide || index < 0) continue;
    const e = slide.elements[index];
    if (e.type !== 'text' || e.rotation || (e.vertical_align && e.vertical_align !== 'top')) continue;
    const original = { font_size: e.font_size, line_spacing: e.line_spacing, paragraph_spacing: e.paragraph_spacing, h: e.h };
    const preferred = e.font_size;
    // Keep the fit bounded so the server preserves the model's design rather
    // than solving overflow by making text arbitrarily small.
    const minimum = Math.min(preferred, Math.max(minimumByRole[e.role] || 12, Math.round(preferred * 0.88 * 100) / 100));
    let bottom = spec.height;
    for (let otherIndex = 0; otherIndex < slide.elements.length; otherIndex++) {
      const other = slide.elements[otherIndex];
      if (otherIndex === index || (other.opacity ?? 1) === 0) continue;
      const ob = bounds(other);
      const background = otherIndex < index && ['shape', 'image'].includes(other.type)
        && ob.x <= e.x && ob.y <= e.y && ob.x + ob.w >= e.x + e.w && ob.y + ob.h >= bottom;
      if (background) continue;
      const horizontal = Math.max(0, Math.min(e.x + e.w, ob.x + ob.w) - Math.max(e.x, ob.x));
      if (horizontal > 0 && ob.y >= e.y + 0.025) bottom = Math.min(bottom, ob.y);
    }
    const available = Math.floor((bottom - e.y) * 1000) / 1000;
    if (!(available > 0)) continue;
    const heightIsSafe = height => {
      const expanded = bounds({ ...e, h: height });
      if (expanded.x < 0 || expanded.y < 0 || expanded.x + expanded.w > spec.width || expanded.y + expanded.h > spec.height) return false;
      if (height <= e.h + 0.001) return true;
      const strip = { x: e.x, y: e.y + e.h, w: e.w, h: height - e.h };
      return !slide.elements.some((other, otherIndex) => {
        if (otherIndex === index || (other.opacity ?? 1) === 0) return false;
        const ob = bounds(other);
        if (otherIndex < index && ['image', 'shape'].includes(other.type)
            && ob.x <= expanded.x && ob.y <= expanded.y && ob.x + ob.w >= expanded.x + expanded.w && ob.y + ob.h >= expanded.y + expanded.h) return false;
        return intersection(strip, ob) > 0;
      });
    };
    let selected;
    const candidates = [];
    for (let size = preferred; size >= minimum; size = Math.round((size - 0.25) * 100) / 100) candidates.push(Math.max(minimum, size));
    if (candidates.at(-1) !== minimum) candidates.push(minimum);
    for (const size of [...new Set(candidates)]) {
      const candidate = { ...e, font_size: size };
      for (const key of ['line_spacing', 'paragraph_spacing']) {
        if (original[key] != null) candidate[key] = Math.max(key === 'line_spacing' ? 6 : 0, Math.round(original[key] * size / original.font_size * 100) / 100);
      }
      const measured = await (options.measure || measure)(candidate);
      const height = Math.min(available, Math.max(e.h, Math.ceil((measured.height + 0.01) * 1000) / 1000));
      if (Number.isFinite(measured.height) && measured.height <= available + 0.025 && heightIsSafe(height)) {
        selected = { candidate, measured, height };
        break;
      }
    }
    if (!selected) continue;
    Object.assign(e, selected.candidate);
    if (e.font_size !== original.font_size) fit.actions.push({ slide_id: slide.id, element_id: e.id, type: 'font_size_adjustment',
      before: original.font_size, after: e.font_size, minimum, reason: 'largest_readable_font_that_fits' });
    if (selected.height !== original.h) {
      e.h = selected.height;
      fit.actions.push({ slide_id: slide.id, element_id: e.id, type: 'text_box_height_adjustment', before: original.h,
        after: e.h, measured_height: selected.measured.height, available_height: available, reason: 'measured_text_height' });
    }
  }
  return fit.actions.length ? fit : null;
}
module.exports = { validate, bounds, intersection, measure, lightRepair, finishTextFit, resolveFonts };
