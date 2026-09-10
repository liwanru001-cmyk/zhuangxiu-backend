'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const JSZip = require('jszip');
const { renderInProcess } = require('../services/presentation-v2/render');
const { imagePlacement } = require('../services/presentation-v2/media');
const { publicManifest } = require('../services/presentation-v2/assets');

test('contain centers the natural aspect ratio including rotated frames', () => {
  const p = imagePlacement({ x: 1, y: 2, w: 4, h: 4, fit: 'contain', rotation: 30 }, { width: 400, height: 200 });
  assert.deepEqual(p, { x: 1, y: 3, w: 4, h: 2 });
  assert.equal(p.x + p.w / 2, 3);
  assert.equal(p.y + p.h / 2, 4);
});
test('rendered crop preserves proportions and duplicate image relationships stay valid', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-media-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.png'), copy = path.join(dir, 'b.png');
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#99AA66' } }).png().toFile(file);
  await fs.copyFile(file, copy);
  const manifest = [{ asset_id: 'a', highres_path: file, width: 400, height: 200 }, { asset_id: 'b', highres_path: copy, width: 400, height: 200 }];
  const slides = ['cover', 'contain', 'cover'].map((fit, i) => ({ id: `s${i}`, design_intent: 'test', elements: [{
    id: 'image', type: 'image', asset_id: i === 0 ? 'a' : 'b', fit, x: 1, y: 1, w: 4, h: 4,
  }] }));
  const out = path.join(dir, 'test.pptx');
  await renderInProcess({ presentation: { title: 'test', background_color: '#FFFFFF' }, slides }, manifest, out);
  const zip = await JSZip.loadAsync(await fs.readFile(out));
  assert.equal(Object.values(zip.files).filter(f => !f.dir && f.name.startsWith('ppt/media/')).length, 1);
  const cover = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(cover, /srcRect l="25000" r="25000" t="0" b="0"/);
  const contain = await zip.file('ppt/slides/slide2.xml').async('string');
  assert.match(contain, /<a:off x="914400" y="1828800"/);
  assert.match(contain, /<a:ext cx="3657600" cy="1828800"/);
  for (const rel of Object.values(zip.files).filter(f => f.name.endsWith('.rels'))) {
    const xml = await rel.async('string');
    const base = path.posix.dirname(path.posix.dirname(rel.name));
    for (const tag of xml.match(/<Relationship\b[^>]*\/>/g) || []) {
      if (/TargetMode="External"/.test(tag)) continue;
      const target = /Target="([^"]+)"/.exec(tag)?.[1];
      assert.ok(zip.file(target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(base, target))), `${rel.name}: ${target}`);
    }
  }
});
test('duplicate content remains scoped to its original asset and space', () => {
  const assets = publicManifest([{ asset_id: 'a', fingerprint: 'same', space_id: 1 }, { asset_id: 'b', fingerprint: 'same', space_id: 2 }]);
  assert.equal(assets[1].duplicate_of, 'a');
  assert.equal(assets[1].asset_id, 'b');
  assert.equal(assets[1].space_id, 2);
});
test('model receives one preview for identical files while keeping both asset IDs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-preview-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const preview = path.join(dir, 'preview.jpg'); await fs.writeFile(preview, 'preview');
  const manifest = ['a', 'b'].map((asset_id, i) => ({ asset_id, space_id: i, fingerprint: 'same', preview_path: preview, vision_preview_provided: true }));
  await require('../services/presentation-v2/model').request({
    source: {}, settings: {}, manifest, limits: require('../services/presentation-v2/config').limits(),
    signal: new AbortController().signal, reserve: async () => {}, record: async () => {},
    env: { PRESENTATION_V2_API_KEY: 'test', PRESENTATION_V2_BASE_URL: 'https://test.invalid' },
    fetchImpl: async (url, options) => {
      const content = JSON.parse(options.body).messages[1].content;
      assert.equal(content.filter(c => c.type === 'image_url').length, 1);
      assert.match(content[1].text, /a, b/);
      const input = JSON.parse(content[0].text);
      assert.equal(input.asset_manifest[1].duplicate_of, 'a');
      assert.match(input.execution.factual_basis, /不得写成已确定方案/);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }));
    },
  });
});
