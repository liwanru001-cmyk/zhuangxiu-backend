'use strict';
// Deterministic render smoke test; never contacts a model or production DB.
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { limits } = require('../services/presentation-v2/config');
const { validate } = require('../services/presentation-v2/validate');
const { render, renderedValidation, preflight } = require('../services/presentation-v2/render');
async function main() {
  const directory = path.resolve(process.argv[2] || 'tmp/presentation-v2-proof');
  await fs.mkdir(directory, { recursive: true });
  const image = path.join(directory, 'original.png');
  await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#A78C6B' } }).png().toFile(image);
  const title = { id: 'title', type: 'text', role: 'title', text: '装筱窝 · 设计方案', x: 0.7, y: 0.45, w: 11.8, h: 0.65, font_size: 28, font_weight: 'bold', color: '#292724' };
  const design = { schema_version: 2, presentation: { title: 'v2 渲染验收样张', design_concept: '自然、克制', visual_direction: '大图与清晰的文字层级', background_color: '#F3F0EA' }, slides: [
    { id: 'slide-1', design_intent: '检查标题、图片、正文和透明形状', elements: [title,
      { id: 'photo', type: 'image', asset_id: 'fixture:1', fit: 'cover', x: 0.7, y: 1.5, w: 8, h: 5 },
      { id: 'body', type: 'text', role: 'body', text: '这是一份渲染验证样张。\n检查中文字体、段落间距与图片尺寸。', x: 9.2, y: 1.6, w: 3.3, h: 2, font_size: 18, color: '#555555', paragraph_spacing: 8 },
      { id: 'rule', type: 'line', x: 9.2, y: 4, w: 3, h: 0, width: 1, color: '#A78C6B' },
      { id: 'shape', type: 'shape', shape_type: 'ellipse', x: 10, y: 4.6, w: 1.3, h: 1.3, fill: '#A78C6B', opacity: 0.5 },
    ] },
    { id: 'slide-2', background_color: '#FFFFFF', design_intent: '检查 contain、旋转与文字叠放', elements: [
      { id: 'photo', type: 'image', asset_id: 'fixture:1', fit: 'contain', x: 1, y: 1.5, w: 7, h: 5, rotation: 3 },
      { ...title, text: '完整图片与图上文字', font_size: 25 },
      { id: 'text', type: 'text', role: 'body', text: '一次验证，一轮修正。', x: 8.7, y: 2.7, w: 3.7, h: 1, font_size: 20, color: '#292724' },
    ] },
  ] };
  const manifest = [{ asset_id: 'fixture:1', title: '图片占位测试', width: 1600, height: 1000, highres_path: image }];
  const options = { limits: limits(), signal: AbortSignal.timeout(180000) };
  await preflight({ ...options, directory });
  const result = await validate(design, manifest, options);
  if (result.issues.some(i => i.severity === 'error')) throw new Error(JSON.stringify(result));
  const output = path.join(directory, 'v2-proof.pptx');
  await render(design, manifest, output, options);
  const actual = await renderedValidation(design, output, options);
  await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify({ result, actual }, null, 2));
  if (actual.issues.some(i => i.severity === 'error')) throw new Error(JSON.stringify(actual));
  const invalid = structuredClone(design); invalid.slides = [invalid.slides[0]]; invalid.slides[0].elements = [{ ...title, font_family: options.limits.fallbackFont, h: 0.1 }];
  const invalidPath = path.join(directory, 'intentional-overflow.pptx');
  await render(invalid, [], invalidPath, options);
  const detected = await renderedValidation(invalid, invalidPath, options);
  if (!detected.issues.some(i => i.severity === 'error')) throw new Error('真实渲染未检出故意制造的文字溢出');
  await fs.rm(invalidPath, { force: true });
  console.log(JSON.stringify({ output, checks: result, rendered: actual }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
