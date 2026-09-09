'use strict';
const PptxGenJS = require('pptxgenjs');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const execFile = require('util').promisify(require('child_process').execFile);
const { spec, failure } = require('./config');
const hex = color => color.replace('#', '');
const transparency = opacity => Math.round((1 - (opacity ?? 1)) * 100);
async function renderInProcess(design, manifest, output, { signal } = {}) {
  const assets = new Map(manifest.map(a => [a.asset_id, a]));
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'AI_V2', width: spec.width, height: spec.height }); pptx.layout = 'AI_V2';
  pptx.author = '装筱窝'; pptx.title = design.presentation.title;
  for (const page of design.slides) {
    signal?.throwIfAborted();
    const slide = pptx.addSlide();
    slide.background = { color: hex(page.background_color || design.presentation.background_color) };
    slide.addNotes(`design_intent: ${page.design_intent}`);
    for (const e of page.elements) {
      const position = { x: e.x, y: e.y, w: e.w, h: e.h, rotate: ((e.rotation || 0) % 360 + 360) % 360, objectName: e.id };
      if (e.type === 'text') slide.addText(e.text, { ...position, fontFace: e.font_family, fontSize: e.font_size,
        bold: e.font_weight === 'bold', color: hex(e.color), transparency: transparency(e.opacity),
        align: e.align || 'left', valign: e.vertical_align === 'middle' ? 'mid' : e.vertical_align || 'top',
        margin: e.margin ?? 0, lineSpacing: e.line_spacing ?? e.font_size * 1.2, paraSpaceAfter: e.paragraph_spacing ?? 0,
        breakLine: false, lang: 'zh-CN',
      });
      if (e.type === 'image') {
        const a = assets.get(e.asset_id);
        if (!a) throw failure('unknown_asset', '模型引用了清单外的素材');
        slide.addImage({ path: a.highres_path,
          ...position, sizing: { type: e.fit, w: e.w, h: e.h },
          rotate: position.rotate, objectName: e.id, transparency: transparency(e.opacity), altText: a.title });
      }
      if (e.type === 'shape') slide.addShape(pptx.ShapeType[e.shape_type], { ...position,
        fill: { color: hex(e.fill), transparency: transparency(e.opacity) },
        line: e.stroke ? { color: hex(e.stroke.color), width: e.stroke.width, transparency: transparency((e.opacity ?? 1) * (e.stroke.opacity ?? 1)) } : { transparency: 100 },
      });
      if (e.type === 'line') slide.addShape(pptx.ShapeType.line, { ...position, line: { color: hex(e.color), width: e.width, transparency: transparency(e.opacity) } });
    }
  }
  await pptx.writeFile({ fileName: output });
  signal?.throwIfAborted();
}
async function renderedValidation(design, output, options) {
  const { signal, limits } = options;
  const executable = process.env.PRESENTATION_SOFFICE;
  if (!executable) throw failure('render_environment', '未配置 PPT 渲染验证引擎 PRESENTATION_SOFFICE', true);
  const dir = await fs.mkdtemp(path.join(path.dirname(output), 'validation-'));
  try {
    await execFile(executable, [`-env:UserInstallation=${pathToFileURL(path.join(dir, 'profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, output], { timeout: limits.renderTimeout, signal, maxBuffer: 1024 * 1024 });
    const bytes = await fs.readFile(path.join(dir, `${path.basename(output, '.pptx')}.pdf`));
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise;
    const issues = [];
    const normalize = value => value.normalize('NFKC').replace(/\s/g, '');
    if (doc.numPages !== design.slides.length) issues.push({ severity: 'error', code: 'render_page_count', message: '渲染页数与设计不一致' });
    for (let i = 0; i < Math.min(doc.numPages, design.slides.length); i++) {
      signal.throwIfAborted();
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      const positioned = content.items.filter(item => typeof item.str === 'string');
      const pageText = positioned.map(item => normalize(item.str)).join('');
      let cursor = 0;
      const spans = []; let offset = 0;
      for (const item of positioned) { const length = normalize(item.str).length; spans.push({ item, from: offset, to: offset + length }); offset += length; }
      const actual = new Map();
      for (const c of normalize(content.items.map(item => item.str || '').join(''))) actual.set(c, (actual.get(c) || 0) + 1);
      for (const element of design.slides[i].elements.filter(e => e.type === 'text' && (e.opacity ?? 1) > 0)) {
        let missing = 0;
        for (const c of normalize(element.text)) {
          if ((actual.get(c) || 0) > 0) actual.set(c, actual.get(c) - 1); else missing++;
        }
        const target = normalize(element.text);
        const start = pageText.indexOf(target, cursor);
        if (start >= 0) {
          cursor = start + target.length;
          if (!element.rotation) {
            const tokens = spans.filter(span => span.to > start && span.from < cursor).map(span => span.item);
            const pageHeight = page.view[3] - page.view[1];
            const left = Math.min(...tokens.map(item => item.transform[4]));
            const right = Math.max(...tokens.map(item => item.transform[4] + item.width));
            const top = Math.min(...tokens.map(item => pageHeight - item.transform[5] - item.height * 0.8));
            const bottom = Math.max(...tokens.map(item => pageHeight - item.transform[5] + item.height * 0.2));
            // A small glyph-bearing tolerance avoids rejecting harmless font overshoot.
            if (tokens.length && (left < element.x * 72 - 3 || right > (element.x + element.w) * 72 + 3 || top < element.y * 72 - 3 || bottom > (element.y + element.h) * 72 + 3)) {
              issues.push({ severity: 'error', code: 'render_text_overflow', slide_id: design.slides[i].id, element_id: element.id, message: '实际 PDF 文本边界超出文本框', measured_bounds_pt: { left, right, top, bottom } });
            }
          }
        }
        if (missing) issues.push({ severity: 'error', code: 'render_text_missing', slide_id: design.slides[i].id, element_id: element.id, message: `实际渲染缺少 ${missing} 个文本字符` });
      }
    }
    await doc.destroy();
    return { issues, environment: { engine: 'LibreOffice PDF + PDF.js', text_check: 'rendered_page_character_coverage_and_unrotated_text_bounds', limitation: '字符覆盖检查不能单独证明文字未被裁切或遮挡；结合文字尺寸、几何与遮挡检查。' } };
  } catch (error) {
    if (error.fatal || signal.aborted) throw error;
    if (options.preflight || ['ENOENT', 'EACCES', 'ENOSPC', 'EIO'].includes(error.code)) throw failure('render_environment', `PPT 渲染验证不可执行：${error.message}`, true);
    return { issues: [{ severity: 'error', code: 'render_failed', message: `设计无法完成实际渲染：${error.message}` }], environment: { engine: 'LibreOffice PDF + PDF.js' } };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function render(design, manifest, output, options = {}) {
  return require('./render-process').renderProcess('v2', { design, manifest }, output, options);
}
async function preflight({ directory, limits, signal }) {
  const output = path.join(directory, `font-preflight-${require('crypto').randomUUID()}.pptx`);
  const design = { presentation: { title: '字体验证', background_color: '#FFFFFF' }, slides: [{ id: 'preflight', design_intent: '验证实际渲染字体', elements: [{ id: 'text', type: 'text', role: 'body', text: '装筱窝中文渲染验证 ABC 123', x: 1, y: 1, w: 10, h: 1, font_family: limits.fallbackFont, font_size: 20, color: '#000000' }] }] };
  try {
    const validation = require('./validate');
    await validation.resolveFonts(design, limits.fallbackFont, signal);
    const measured = await validation.measure(design.slides[0].elements[0]);
    if (!Number.isFinite(measured.height) || measured.height <= 0) {
      throw failure('font_environment', '静态文字测量引擎无法处理中文字体', true);
    }
    await render(design, [], output, { signal, timeout: limits.renderTimeout });
    const outputStat = await fs.stat(output);
    if (outputStat.size <= 0) throw failure('render_environment', '静态 PPTX 生成结果为空', true);
    if (limits.renderValidation !== 'full') {
      return {
        mode: 'static',
        text_engine: 'sharp/Pango',
        fallback_font: limits.fallbackFont,
        pptx_generation: 'passed',
        render_validation: 'skipped',
        render_validation_reason: 'render_engine_disabled',
      };
    }
    const result = await renderedValidation(design, output, { limits, signal, preflight: true });
    if (result.issues.some(i => i.severity === 'error')) throw failure('font_render_environment', '实际渲染引擎无法完整显示中文，请检查服务端字体环境', true);
    return result.environment;
  } finally { await fs.rm(output, { force: true }); }
}
module.exports = { render, renderInProcess, renderedValidation, preflight };
