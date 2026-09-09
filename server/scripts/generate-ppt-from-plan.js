#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const PptxGenJS = require('pptxgenjs');
const sharp = require('sharp');
const storage = require('../services/storage.service');

const execFileAsync = promisify(execFile);
const colors = {
  background: 'FAF7F2',
  text: '2D2521',
  secondary: '766A63',
  accent: 'C26749',
  line: 'DDD3CC',
  soft: 'EFE8E2',
  white: 'FFFFFF',
};

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function safeFileName(value) {
  return String(value || '设计方案')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

async function fetchFile(url, destination) {
  const parsed = new URL(storage.signedUrlForStorageUri(storage.canonicalStorageUri(url)));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('资料地址协议不支持');
  const response = await fetch(parsed);
  if (!response.ok) throw new Error(`资料下载失败：${response.status}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function materializeImage(source, directory, index) {
  const input = path.join(directory, `source-${index}`);
  const output = path.join(directory, `image-${index}.png`);
  await fetchFile(source.url || source.image_url, input);
  if ((source.type || '').toLowerCase() === 'pdf' || String(source.url || '').toLowerCase().includes('.pdf')) {
    const prefix = output.slice(0, -4);
    await execFileAsync('pdftoppm', ['-png', '-f', '1', '-singlefile', '-r', '180', input, prefix]);
  } else {
    await sharp(input).rotate().png().toFile(output);
  }
  return output;
}

function addFooter(pptx, slide, page, total) {
  slide.addText('装筱窝设计方案汇报', {
    x: 0.68, y: 7.12, w: 3.2, h: 0.18,
    fontFace: 'Arial Unicode MS', fontSize: 8, color: 'A3978F', margin: 0,
  });
  slide.addText(`${page} / ${total}`, {
    x: 11.6, y: 7.08, w: 1.0, h: 0.2,
    fontFace: 'Arial Unicode MS', fontSize: 8, color: 'A3978F', align: 'right', margin: 0,
  });
}

function addPageTitle(pptx, slide, title, subtitle = '') {
  slide.background = { color: colors.background };
  slide.addText(title, {
    x: 0.72, y: 0.43, w: 11.9, h: 0.45,
    fontFace: 'Arial Unicode MS', fontSize: 25, bold: true, color: colors.text, margin: 0,
    breakLine: false, fit: 'shrink',
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.74, y: 1.01, w: 11.7, h: 0.28,
      fontFace: 'Arial Unicode MS', fontSize: 11, color: colors.secondary, margin: 0,
      fit: 'shrink',
    });
  }
  slide.addShape(pptx.ShapeType.line, {
    x: 0.72, y: 1.38, w: 11.9, h: 0,
    line: { color: colors.accent, width: 1.2 },
  });
}

function addImageContain(slide, imagePath, x, y, w, h, altText) {
  slide.addShape('rect', {
    x, y, w, h,
    line: { color: colors.line, width: 0.6 },
    fill: { color: colors.white },
  });
  slide.addImage({
    path: imagePath, x, y, w, h,
    sizing: { type: 'contain', w, h },
    altText,
  });
}

function addMissingImage(slide, x, y, w, h, label) {
  slide.addShape('rect', { x, y, w, h, line: { color: colors.line }, fill: { color: colors.soft } });
  slide.addText(label, {
    x, y: y + h / 2 - 0.2, w, h: 0.4,
    align: 'center', fontFace: 'Arial Unicode MS', fontSize: 14, color: '968A82', margin: 0,
  });
}

function addCover(pptx, plan) {
  const slide = pptx.addSlide();
  slide.background = { color: colors.background };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.24, h: 7.5,
    line: { color: colors.accent, transparency: 100 }, fill: { color: colors.accent },
  });
  slide.addText(plan.presentation.title, {
    x: 0.95, y: 2.22, w: 10.8, h: 0.75,
    fontFace: 'Arial Unicode MS', fontSize: 38, bold: true, color: colors.text, margin: 0,
    fit: 'shrink',
  });
  slide.addText(plan.presentation.subtitle, {
    x: 0.98, y: 3.22, w: 9.8, h: 0.4,
    fontFace: 'Arial Unicode MS', fontSize: 18, color: colors.accent, margin: 0,
  });
  slide.addText(`项目编号 ${plan.project.code}    客户 ${plan.project.client_name}`, {
    x: 0.98, y: 4.72, w: 8.8, h: 0.34,
    fontFace: 'Arial Unicode MS', fontSize: 12, color: colors.secondary, margin: 0,
  });
  return slide;
}

function addOverview(pptx, plan) {
  const slide = pptx.addSlide();
  addPageTitle(pptx, slide, '项目概况', `${plan.project.name} · ${plan.project.stage} · ${plan.project.owner_status}`);
  const rows = [
    ['项目名称', plan.project.name],
    ['客户称呼', plan.project.client_name],
    ['项目编号', plan.project.code],
    ['空间数量', `${plan.spaces.length}个`],
  ];
  rows.forEach((row, index) => {
    const y = 1.85 + index * 0.72;
    slide.addText(row[0], { x: 0.8, y, w: 1.2, h: 0.3, fontFace: 'Arial Unicode MS', fontSize: 11, color: colors.secondary, margin: 0 });
    slide.addText(row[1], { x: 2.05, y, w: 3.7, h: 0.32, fontFace: 'Arial Unicode MS', fontSize: 15, bold: true, color: colors.text, margin: 0, fit: 'shrink' });
    slide.addShape(pptx.ShapeType.line, { x: 0.8, y: y + 0.45, w: 4.8, h: 0, line: { color: colors.line, width: 0.7 } });
  });
  slide.addText('当前资料', { x: 6.35, y: 1.82, w: 2, h: 0.38, fontFace: 'Arial Unicode MS', fontSize: 18, bold: true, color: colors.text, margin: 0 });
  slide.addText(plan.presentation.summary, { x: 6.35, y: 2.34, w: 5.6, h: 1.2, fontFace: 'Arial Unicode MS', fontSize: 15, color: colors.text, margin: 0, breakLine: false, valign: 'top', fit: 'shrink' });
  slide.addText('待补充信息', { x: 6.35, y: 4.05, w: 2, h: 0.35, fontFace: 'Arial Unicode MS', fontSize: 16, bold: true, color: colors.accent, margin: 0 });
  slide.addText(plan.presentation.missing_information.map(value => ({ text: value, options: { bullet: { indent: 16 } } })), {
    x: 6.35, y: 4.52, w: 5.6, h: 1.4, fontFace: 'Arial Unicode MS', fontSize: 13, color: colors.secondary,
    breakLine: true, paraSpaceAfterPt: 11, margin: 0.03,
  });
  return slide;
}

function addSpaceIndex(pptx, plan) {
  const slide = pptx.addSlide();
  addPageTitle(pptx, slide, '空间规划一览', '当前项目已建立的空间');
  plan.spaces.forEach((space, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 0.95 + column * 6.0;
    const y = 1.78 + row * 0.78;
    slide.addText(String(index + 1).padStart(2, '0'), { x, y, w: 0.55, h: 0.32, fontFace: 'Arial Unicode MS', fontSize: 12, bold: true, color: colors.accent, margin: 0 });
    slide.addText(space.name, { x: x + 0.62, y, w: 2.0, h: 0.34, fontFace: 'Arial Unicode MS', fontSize: 16, bold: true, color: colors.text, margin: 0 });
    slide.addText(space.summary, { x: x + 2.45, y: y + 0.02, w: 3.0, h: 0.3, fontFace: 'Arial Unicode MS', fontSize: 10, color: colors.secondary, margin: 0, fit: 'shrink' });
    slide.addShape(pptx.ShapeType.line, { x, y: y + 0.48, w: 5.45, h: 0, line: { color: colors.line, width: 0.6 } });
  });
  return slide;
}

function addDocumentSlide(pptx, title, subtitle, imagePath) {
  const slide = pptx.addSlide();
  addPageTitle(pptx, slide, title, subtitle);
  if (imagePath) addImageContain(slide, imagePath, 0.78, 1.62, 11.75, 5.2, title);
  else addMissingImage(slide, 0.78, 1.62, 11.75, 5.2, '图纸读取失败');
  return slide;
}

function addProductSlide(pptx, space, product, imagePath, index, total) {
  const slide = pptx.addSlide();
  addPageTitle(pptx, slide, `${space.name}选品`, `${index + 1} / ${total} · ${product.brand || '品牌待补充'}`);
  if (imagePath) addImageContain(slide, imagePath, 0.78, 1.68, 5.3, 4.95, product.name);
  else addMissingImage(slide, 0.78, 1.68, 5.3, 4.95, '暂无产品图片');
  slide.addText(product.name, { x: 6.55, y: 1.77, w: 5.65, h: 0.52, fontFace: 'Arial Unicode MS', fontSize: 23, bold: true, color: colors.text, margin: 0, fit: 'shrink' });
  slide.addText(product.specification || '规格待补充', { x: 6.55, y: 2.44, w: 5.65, h: 0.62, fontFace: 'Arial Unicode MS', fontSize: 12, color: colors.secondary, margin: 0, fit: 'shrink' });
  slide.addText('本项目选用', { x: 6.55, y: 3.28, w: 2, h: 0.35, fontFace: 'Arial Unicode MS', fontSize: 14, bold: true, color: colors.accent, margin: 0 });
  slide.addText(product.configuration || '配置待补充', { x: 6.55, y: 3.76, w: 5.3, h: 0.38, fontFace: 'Arial Unicode MS', fontSize: 17, bold: true, color: colors.text, margin: 0, fit: 'shrink' });
  if (product.materials?.length) {
    slide.addText(product.materials.join('\n'), { x: 6.55, y: 4.35, w: 5.4, h: 0.86, fontFace: 'Arial Unicode MS', fontSize: 11, color: colors.secondary, margin: 0, breakLine: false, fit: 'shrink' });
  }
  slide.addText(`数量：${product.quantity || '待补充'}`, { x: 6.55, y: 5.45, w: 2.5, h: 0.34, fontFace: 'Arial Unicode MS', fontSize: 14, bold: true, color: colors.text, margin: 0 });
  if (product.show_price && product.customer_quote != null) {
    slide.addText(`客户报价：¥${product.customer_quote}`, { x: 9.2, y: 5.45, w: 2.8, h: 0.34, fontFace: 'Arial Unicode MS', fontSize: 14, bold: true, color: colors.accent, margin: 0 });
  }
  if (product.note) slide.addText(`搭配说明：${product.note}`, { x: 6.55, y: 6.02, w: 5.4, h: 0.45, fontFace: 'Arial Unicode MS', fontSize: 11, color: colors.secondary, margin: 0, fit: 'shrink' });
  return slide;
}

function addRequirements(pptx, plan, outlineItem) {
  const slide = pptx.addSlide();
  addPageTitle(pptx, slide, outlineItem.title || '客户需求与设计方向', outlineItem.subtitle || '本次方案依据');
  const items = [
    ['居住成员', plan.project.resident_info],
    ['生活习惯', plan.project.lifestyle_notes],
    ['风格偏好', plan.project.style_preference],
    ['重点空间', plan.project.key_spaces],
    ['特别需求', plan.project.special_needs],
  ].filter(item => item[1]);
  if (!items.length) {
    slide.addText('当前项目尚未填写客户需求，可在项目资料中补充后重新生成。', {
      x: 0.9, y: 2.05, w: 11.2, h: 0.5, fontFace: 'Arial Unicode MS', fontSize: 17,
      color: colors.secondary, margin: 0,
    });
    return slide;
  }
  items.forEach((item, index) => {
    const y = 1.78 + index * 0.9;
    slide.addText(item[0], { x: 0.9, y, w: 1.35, h: 0.32, fontFace: 'Arial Unicode MS', fontSize: 12, bold: true, color: colors.accent, margin: 0 });
    slide.addText(item[1], { x: 2.35, y, w: 9.6, h: 0.48, fontFace: 'Arial Unicode MS', fontSize: 15, color: colors.text, margin: 0, fit: 'shrink' });
  });
  return slide;
}

function addProductSummary(pptx, plan, outlineItem) {
  const slide = pptx.addSlide();
  addPageTitle(pptx, slide, outlineItem.title || '方案选品汇总', outlineItem.subtitle || '按空间汇总本次选用产品');
  const rows = plan.spaces.flatMap(space => (space.products || []).map(product => ({ space: space.name, ...product })));
  if (!rows.length) {
    slide.addText('本次汇报未选择空间产品。', { x: 0.9, y: 2.0, w: 11.2, h: 0.4, fontFace: 'Arial Unicode MS', fontSize: 17, color: colors.secondary, margin: 0 });
    return slide;
  }
  const visible = rows.slice(0, 12);
  const tableRows = [
    [
      { text: '空间', options: { bold: true } },
      { text: '产品', options: { bold: true } },
      { text: '品牌 / 配置', options: { bold: true } },
      { text: '数量', options: { bold: true } },
    ],
    ...visible.map(item => [item.space, item.name, [item.brand, item.configuration].filter(Boolean).join(' · '), item.quantity]),
  ];
  slide.addTable(tableRows, {
    x: 0.75, y: 1.65, w: 11.85, h: 4.9,
    border: { type: 'solid', color: colors.line, pt: 0.7 },
    fill: colors.white, color: colors.text, fontFace: 'Arial Unicode MS', fontSize: 10,
    margin: 0.08, rowH: 0.36, colW: [1.5, 3.0, 5.5, 1.2],
  });
  if (rows.length > visible.length) {
    slide.addText(`另有 ${rows.length - visible.length} 项产品，请在各空间页面查看。`, { x: 0.8, y: 6.72, w: 6, h: 0.24, fontFace: 'Arial Unicode MS', fontSize: 9, color: colors.secondary, margin: 0 });
  }
  return slide;
}

function addEnding(pptx, plan, outlineItem) {
  const slide = pptx.addSlide();
  slide.background = { color: colors.background };
  slide.addText(outlineItem.title || '方案沟通与下一步', { x: 1.0, y: 2.25, w: 11.0, h: 0.72, fontFace: 'Arial Unicode MS', fontSize: 34, bold: true, color: colors.text, align: 'center', margin: 0, fit: 'shrink' });
  slide.addText(outlineItem.narrative || '请结合现场条件、预算和供应情况确认方案细节。', { x: 1.8, y: 3.35, w: 9.4, h: 0.8, fontFace: 'Arial Unicode MS', fontSize: 16, color: colors.secondary, align: 'center', margin: 0, fit: 'shrink' });
  slide.addText(plan.project.name, { x: 4.2, y: 5.25, w: 4.9, h: 0.35, fontFace: 'Arial Unicode MS', fontSize: 13, color: colors.accent, align: 'center', margin: 0 });
  return slide;
}

async function generateFromPlan(plan, outputPath) {
  required(plan.project?.name, '汇报JSON缺少项目名称');
  required(plan.presentation?.title, '汇报JSON缺少标题');
  if (!Array.isArray(plan.spaces)) throw new Error('汇报JSON缺少空间列表');

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-project-ppt-'));
  const imageCache = new Map();
  let imageIndex = 1;
  async function imageFor(source) {
    if (!source?.url && !source?.image_url) return null;
    const key = source.url || source.image_url;
    if (imageCache.has(key)) return imageCache.get(key);
    try {
      const imagePath = await materializeImage(source, tempDirectory, imageIndex++);
      imageCache.set(key, imagePath);
      return imagePath;
    } catch (error) {
      console.warn(`WARN: ${source.title || source.name || key}: ${error.message}`);
      imageCache.set(key, null);
      return null;
    }
  }

  try {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = '装筱窝';
    pptx.company = '装筱窝';
    pptx.subject = '设计方案汇报';
    pptx.title = plan.presentation.title;
    pptx.lang = 'zh-CN';
    pptx.theme = { headFontFace: 'Arial Unicode MS', bodyFontFace: 'Arial Unicode MS', lang: 'zh-CN' };
    pptx.defineSlideMaster({
      title: 'ZXW',
      background: { color: colors.background },
      objects: [],
      slideNumber: { x: 11.6, y: 7.08, color: 'A3978F', fontFace: 'Arial Unicode MS', fontSize: 8 },
    });

    const slides = [];
    const outline = Array.isArray(plan.outline) && plan.outline.length
      ? plan.outline
      : [
        { type: 'cover' }, { type: 'project_profile' }, { type: 'whole_house_plan' },
        ...plan.spaces.map(space => ({ type: 'space_solution', space_id: space.id })),
        { type: 'product_summary' }, { type: 'ending' },
      ];
    for (const item of outline) {
      if (item.type === 'cover') slides.push(addCover(pptx, plan));
      else if (item.type === 'project_profile') slides.push(addOverview(pptx, plan));
      else if (item.type === 'client_requirements') slides.push(addRequirements(pptx, plan, item));
      else if (item.type === 'whole_house_plan') {
        for (const document of plan.whole_house_documents || []) {
          slides.push(addDocumentSlide(pptx, item.title || '全屋平面方案', item.narrative || document.title, await imageFor(document)));
        }
      } else if (item.type === 'space_solution') {
        const space = plan.spaces.find(value => Number(value.id) === Number(item.space_id));
        if (!space) continue;
        for (const document of space.documents || []) {
          slides.push(addDocumentSlide(pptx, `${space.name}平面方案`, item.narrative || document.title, await imageFor(document)));
        }
        for (const rendering of space.renderings || []) {
          slides.push(addDocumentSlide(pptx, `${space.name}效果表现`, item.narrative || rendering.title || '空间效果图', await imageFor(rendering)));
        }
        for (let index = 0; index < (space.products || []).length; index++) {
          const product = space.products[index];
          slides.push(addProductSlide(pptx, space, product, await imageFor(product), index, space.products.length));
        }
      } else if (item.type === 'product_summary') slides.push(addProductSummary(pptx, plan, item));
      else if (item.type === 'ending') slides.push(addEnding(pptx, plan, item));
    }
    if (!slides.length) throw new Error('汇报目录没有可生成的页面');
    slides.forEach((slide, index) => addFooter(pptx, slide, index + 1, slides.length));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await pptx.writeFile({ fileName: outputPath, compression: true });
    return { outputPath, slideCount: slides.length };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function generate(planPath, outputPath) {
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  return generateFromPlan(plan, outputPath);
}

if (require.main === module) {
  const planPath = path.resolve(process.argv[2] || 'tmp/ai-project-ppt/project-3-plan.json');
  const defaultName = `${safeFileName(path.basename(planPath, '.json'))}-${Date.now()}.pptx`;
  const outputPath = path.resolve(process.argv[3] || path.join('storage', 'generated-presentations', defaultName));
  generate(planPath, outputPath)
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { generate, generateFromPlan, safeFileName, fetchFile };
