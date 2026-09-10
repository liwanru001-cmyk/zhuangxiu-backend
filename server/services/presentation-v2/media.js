'use strict';
const JSZip = require('jszip');
const { createHash } = require('crypto');
const path = require('path').posix;
const fs = require('fs/promises');

function imagePlacement(element, asset) {
  if (!(asset.width > 0 && asset.height > 0)) throw new Error('图片缺少原始尺寸');
  if (element.fit === 'contain') {
    const scale = Math.min(element.w / asset.width, element.h / asset.height);
    const w = asset.width * scale, h = asset.height * scale;
    return { x: element.x + (element.w - w) / 2, y: element.y + (element.h - h) / 2, w, h };
  }
  // PptxGenJS uses the outer w/h as the SOURCE aspect ratio, then sizing.w/h
  // as the destination frame. Passing the frame for both stretches the image.
  return { x: element.x, y: element.y, w: asset.width / 144, h: asset.height / 144,
    sizing: { type: 'cover', w: element.w, h: element.h } };
}

async function deduplicateMedia(file, signal) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const canonical = new Map(), aliases = new Map();
  for (const entry of Object.values(zip.files)) {
    signal?.throwIfAborted();
    if (entry.dir || !entry.name.startsWith('ppt/media/')) continue;
    const bytes = await entry.async('nodebuffer');
    const key = path.extname(entry.name) + createHash('sha256').update(bytes).digest('hex');
    if (canonical.has(key)) aliases.set(entry.name, canonical.get(key));
    else canonical.set(key, entry.name);
  }
  if (!aliases.size) return;
  for (const entry of Object.values(zip.files).filter(e => e.name.endsWith('.rels'))) {
    signal?.throwIfAborted();
    const base = path.dirname(path.dirname(entry.name));
    const xml = await entry.async('string');
    zip.file(entry.name, xml.replace(/<Relationship\b[^>]*\/>/g, tag => {
      if (/TargetMode="External"/.test(tag)) return tag;
      return tag.replace(/Target="([^"]+)"/, (attribute, target) => {
        const resolved = target.startsWith('/') ? target.slice(1) : path.normalize(path.join(base, target));
        const replacement = aliases.get(resolved);
        return replacement ? `Target="${path.relative(base, replacement)}"` : attribute;
      });
    }));
  }
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace(/<Override\b[^>]*\/>/g, tag => {
    const name = /PartName="\/([^"]+)"/.exec(tag)?.[1];
    return aliases.has(name) ? '' : tag;
  }));
  for (const name of aliases.keys()) zip.remove(name);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  signal?.throwIfAborted();
  await fs.writeFile(file, buffer);
}
module.exports = { imagePlacement, deduplicateMedia };
