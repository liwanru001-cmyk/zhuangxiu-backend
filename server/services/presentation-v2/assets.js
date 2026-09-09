'use strict';
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const storage = require('../storage.service');
const { failure } = require('./config');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function candidates(source, settings) {
  const result = [];
  function add(item, scope, role, index) {
    const url = item.original_url && ['image', 'jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(String(item.original_type).toLowerCase()) ? item.original_url : item.url || item.image_url;
    if (!url) return;
    result.push({ source_type: item.source_type || (role === 'product' ? 'scheme_product' : 'design_document'),
      source_id: item.source_type === 'project_floor_plan' ? source.project.id : item.id,
      version_no: item.version_no || 1, image_role: item.image_role || role, space_id: scope,
      title: item.title || item.name || role, category: item.category || role, type: item.type || 'image',
      url: storage.canonicalStorageUri(url), is_primary: !!item.is_primary, order: index,
      legacy_url: storage.canonicalStorageUri(item.url || item.image_url || url),
      vision_preview_provided: false, role,
    });
  }
  if (settings.sections.whole_house_plan) {
    source.whole_house_documents.forEach((item, i) => add(item, 'whole_house', 'plan', i));
    (source.whole_house_renderings || []).forEach((item, i) => add(item, 'whole_house', 'rendering', i));
  }
  for (const choice of settings.spaces.filter(c => c.included)) {
    const space = source.spaces.find(s => s.id === choice.space_id);
    if (!space) throw failure('asset_mapping_error', '空间素材映射异常', true);
    if (settings.sections.space_solutions && choice.show_plan) space.documents.forEach((item, i) => add(item, space.id, 'plan', i));
    if (settings.sections.space_solutions && choice.show_rendering) space.renderings.forEach((item, i) => add(item, space.id, 'rendering', i));
    if ((settings.sections.space_solutions || settings.sections.product_summary) && choice.show_products) {
      space.products.filter(p => !choice.selected_product_ids.length || choice.selected_product_ids.includes(p.id)).forEach((item, i) => {
        add(item, space.id, 'product', i);
        if (settings.product_display?.show_materials) for (const material of item.selection?.materials || []) {
          const url = material.live_material?.swatch_url || material.swatch_url;
          if (!url) continue;
          const part = String(material.part || '整体');
          const identity = material.material_id || material.live_material?.id || hash(storage.canonicalStorageUri(url)).slice(0, 12);
          add({ id: item.id, source_type: 'scheme_product_material', image_role: `${part}:${identity}`, title: `${item.name} · ${part}材质色卡`, image_url: url }, space.id, 'product_material', i);
        }
      });
    }
  }
  return result;
}
function representatives(items) {
  const selected = new Set();
  for (const scope of new Set(items.map(a => a.space_id))) {
    for (const role of ['plan', 'rendering']) {
      const list = items.filter(a => a.space_id === scope && a.role === role && (role !== 'plan' || a.category === 'layout_plan'));
      list.sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.order - b.order || a.source_id - b.source_id);
      if (list[0]) selected.add(list[0]);
    }
  }
  return selected;
}
async function download(url, limits, signal) {
  const signed = storage.signedUrlForStorageUri(url);
  if (!/^https?:\/\//i.test(signed)) throw failure('asset_mapping_error', '素材地址不可读取', true);
  const response = await fetch(signed, { signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
  if (!response.ok) throw failure('asset_unavailable', `素材读取失败 (${response.status})`, true);
  if (Number(response.headers.get('content-length')) > limits.maxFileBytes) throw failure('asset_too_large', '素材文件超出大小限制', true);
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limits.maxFileBytes) throw failure('asset_too_large', '素材文件超出大小限制', true);
      chunks.push(chunk);
    }
  } catch (error) { throw Object.assign(error, { fatal: true }); }
  return Buffer.concat(chunks);
}
async function prepare(source, settings, { directory, limits, signal, fetchAsset = download, checkpoint = async () => {} }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const items = candidates(source, settings);
  if (items.length > limits.maxAssets) throw failure('asset_limit', '素材数量超出任务限制', true);
  const chosen = representatives(items);
  if (chosen.size > limits.maxImages) throw failure('image_limit', '代表图数量超出任务限制，请减少空间数量', true);
  const manifest = []; const fingerprints = new Set(); let totalBytes = 0; let totalPixels = 0;
  for (const item of items) {
    signal.throwIfAborted(); await checkpoint();
    try {
      const bytes = await fetchAsset(item.url, limits, signal);
      const fingerprint = hash(bytes);
      const original = path.join(directory, `${fingerprint}.original`);
      await fs.writeFile(original, bytes, { mode: 0o600, flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const highres = path.join(directory, `${fingerprint}.png`);
      try { await fs.access(highres); } catch {
        const temporary = `${highres}.${crypto.randomUUID()}.png`;
        if (bytes.subarray(0, 5).toString() === '%PDF-') {
          const prefix = temporary.slice(0, -4);
          await execFile(process.env.PRESENTATION_PDFTOPPM || 'pdftoppm', ['-png', '-f', '1', '-singlefile', '-r', '180', '-scale-to', '6000', original, prefix], { timeout: limits.renderTimeout, signal });
        } else {
          await sharp(bytes, { limitInputPixels: limits.maxPixels }).rotate().png().toFile(temporary);
        }
        await fs.rename(temporary, highres);
      }
      const meta = await sharp(highres, { limitInputPixels: limits.maxPixels }).metadata();
      if (!(meta.width > 0 && meta.height > 0)) throw new Error('图片尺寸无效');
      if (!fingerprints.has(fingerprint)) {
        fingerprints.add(fingerprint);
        totalBytes += bytes.length + (await fs.stat(highres)).size; totalPixels += meta.width * meta.height;
        if (totalBytes > limits.maxTaskAssetBytes || totalPixels > limits.maxTaskPixels) throw failure('asset_task_budget', '任务图片总量超出资源限制，请减少所选素材', true);
      }
      const preview = path.join(directory, `${fingerprint}-ai-${limits.previewEdge}-${limits.previewQuality}.jpg`);
      if (chosen.has(item)) {
        try { await fs.access(preview); } catch {
          const temporary = `${preview}.${crypto.randomUUID()}`;
          await sharp(highres).resize({ width: limits.previewEdge, height: limits.previewEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: limits.previewQuality }).toFile(temporary);
          await fs.rename(temporary, preview);
        }
      }
      const asset = { ...item, asset_id: `${item.source_type}:${item.source_id}:${item.image_role}:v${item.version_no}:${fingerprint.slice(0, 20)}`,
        width: meta.width, height: meta.height, aspect_ratio: meta.width / meta.height, fingerprint,
        opaque: !meta.hasAlpha || (await sharp(highres).stats()).channels[3]?.min === 255,
        original_path: original, highres_path: highres, preview_path: chosen.has(item) ? preview : null,
        vision_preview_provided: chosen.has(item), converted_page: bytes.subarray(0, 5).toString() === '%PDF-' ? 1 : null };
      if (manifest.some(a => a.asset_id === asset.asset_id)) throw failure('asset_mapping_error', '素材引用标识重复', true);
      manifest.push(asset);
    } catch (error) { throw Object.assign(error, { fatal: true, code: error.code || 'asset_unavailable' }); }
  }
  return manifest;
}
function publicManifest(manifest) {
  return manifest.map(({ asset_id, source_type, source_id, version_no, image_role, space_id, title, category, width, height, aspect_ratio, vision_preview_provided }) =>
    ({ asset_id, source_type, source_id, version_no, image_role, space_id, title, category, width, height, aspect_ratio, vision_preview_provided }));
}
module.exports = { candidates, representatives, prepare, publicManifest };
