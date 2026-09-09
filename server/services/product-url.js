// Request middleware restores signed image URLs to stable storage identifiers.
// Catalog validation must accept those identifiers for this application's bucket.
function isProductUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  if (url.username || url.password) return false;
  if (['http:', 'https:'].includes(url.protocol)) return true;
  const bucket = String(process.env.OSS_BUCKET || '').trim();
  return Boolean(bucket) && url.protocol === 'oss:' && url.hostname === bucket
    && !url.port && !url.search && !url.hash && url.pathname.length > 1
    && !/[\s\\]/.test(value);
}

module.exports = { isProductUrl };
