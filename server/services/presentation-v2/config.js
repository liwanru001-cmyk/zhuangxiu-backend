'use strict';
function limits(env = process.env) {
  const n = (key, value, max) => {
    const parsed = Number(env[`PRESENTATION_V2_${key}`] ?? value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) throw new Error(`Invalid PRESENTATION_V2_${key}`);
    return Math.floor(parsed);
  };
  return {
    maxSlides: n('MAX_SLIDES', 40, 80), maxElements: n('MAX_ELEMENTS', 40, 100),
    maxAssets: n('MAX_ASSETS', 300, 1000), maxImages: n('MAX_IMAGES', 32, 100),
    previewEdge: n('PREVIEW_EDGE', 768, 1600), previewQuality: n('PREVIEW_QUALITY', 78, 95),
    maxInputBytes: n('MAX_INPUT_BYTES', 250000, 1000000), maxOutputTokens: n('MAX_OUTPUT_TOKENS', 24000, 64000),
    maxTaskAssetBytes: n('MAX_TASK_ASSET_BYTES', 512000000, 1000000000), maxTaskPixels: n('MAX_TASK_PIXELS', 200000000, 500000000),
    maxFileBytes: n('MAX_FILE_BYTES', 30000000, 100000000), maxPixels: n('MAX_PIXELS', 40000000, 100000000),
    callTimeout: n('CALL_TIMEOUT_MS', 180000, 300000), taskTimeout: n('TASK_TIMEOUT_MS', 900000, 1800000),
    renderTimeout: n('RENDER_TIMEOUT_MS', 90000, 180000), maxQueue: n('MAX_QUEUE', 100, 1000),
    fallbackFont: env.PRESENTATION_V2_FALLBACK_FONT || 'Noto Sans CJK SC',
  };
}
const spec = { width: 13.333333, height: 7.5, unit: 'inch', aspect_ratio: '16:9' };
function failure(code, message, fatal = false) { return Object.assign(new Error(message), { code, fatal }); }
module.exports = { limits, spec, failure };
