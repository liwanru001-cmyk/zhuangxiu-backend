const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const OSS = require('ali-oss');

const storageRoot = path.join(__dirname, '..', 'storage');
const publicPrefix = '/api/storage';

function storageDriver() {
  return String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();
}

function useOss() {
  return storageDriver() === 'oss';
}

function hasOssConfig() {
  return Boolean(
    process.env.OSS_REGION &&
    process.env.OSS_BUCKET &&
    process.env.OSS_ACCESS_KEY_ID &&
    process.env.OSS_ACCESS_KEY_SECRET
  );
}

function requiredOssConfig() {
  const config = {
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    endpoint: process.env.OSS_ENDPOINT || undefined,
    secure: true,
    timeout: Number(process.env.OSS_REQUEST_TIMEOUT_MS || 300000),
  };
  const missing = ['region', 'bucket', 'accessKeyId', 'accessKeySecret'].filter(
    (key) => !config[key]
  );
  if (missing.length) {
    throw new Error(`OSS storage is enabled but missing configuration: ${missing.join(', ')}`);
  }
  return config;
}

let ossClient;
function getOssClient() {
  if (!ossClient) ossClient = new OSS(requiredOssConfig());
  return ossClient;
}

function ossStorageUri(key) {
  return `oss://${requiredOssConfig().bucket}/${key}`;
}

function parseOssStorageUri(value) {
  const match = /^oss:\/\/([^/]+)\/(.+)$/.exec(String(value || ''));
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

function signedUrlForStorageUri(value, expires) {
  const object = parseOssStorageUri(value);
  if (!object || !hasOssConfig()) return value;
  const config = requiredOssConfig();
  if (object.bucket !== config.bucket) return value;
  return getOssClient().signatureUrl(object.key, {
    expires: Number(expires || process.env.OSS_SIGNED_URL_EXPIRES || 1800),
  });
}

function signStorageUrisInString(value) {
  if (typeof value !== 'string' || !value.includes('oss://')) return value;
  return value.replace(/oss:\/\/[^/\s"'\\]+\/[^\s"'\\]+/g, (uri) =>
    signedUrlForStorageUri(uri)
  );
}

function signStorageUrisDeep(value) {
  if (typeof value === 'string') return signStorageUrisInString(value);
  if (Array.isArray(value)) return value.map(signStorageUrisDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, signStorageUrisDeep(item)])
    );
  }
  return value;
}

function publicBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function normalizeExt(file) {
  return path.extname(file.originalname || file.filename || '').toLowerCase() || '.bin';
}

function storageName(file, suffix = '') {
  const extension = normalizeExt(file);
  const baseName = path.basename(file.filename || `file-${Date.now()}`, path.extname(file.filename || ''));
  return `${baseName}${suffix}${extension}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function isImageFile(fileType, mimeType) {
  return fileType === 'image' || String(mimeType || '').startsWith('image/');
}

async function putLocalFile({ sourcePath, key, req }) {
  const targetPath = path.join(storageRoot, key);
  await ensureDir(path.dirname(targetPath));
  if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
    await fs.copyFile(sourcePath, targetPath);
  }
  return {
    key,
    url: `${publicBaseUrl(req)}${publicPrefix}/${key.replace(/\\/g, '/')}`,
    path: targetPath,
  };
}

async function putFile({ sourcePath, key, req, contentType }) {
  if (!useOss()) return putLocalFile({ sourcePath, key, req });
  const headers = {
    ...(contentType ? { 'Content-Type': contentType } : {}),
    'Cache-Control': process.env.OSS_CACHE_CONTROL || 'private, max-age=1800',
  };
  const { size } = await fs.stat(sourcePath);
  const multipartThreshold = Number(process.env.OSS_MULTIPART_THRESHOLD || 5 * 1024 * 1024);
  if (size >= multipartThreshold) {
    await getOssClient().multipartUpload(key, sourcePath, {
      parallel: Number(process.env.OSS_MULTIPART_PARALLEL || 1),
      partSize: Number(process.env.OSS_MULTIPART_PART_SIZE || 1024 * 1024),
      headers,
    });
  } else {
    await getOssClient().put(key, sourcePath, { headers });
  }
  return { key, url: ossStorageUri(key), path: null };
}

async function persistUploadedFile({ req, file, folder }) {
  if (!file) return null;
  const cleanFolder = String(folder || 'uploads').replace(/^\/+|\/+$/g, '');
  const key = `${cleanFolder}/${path.basename(file.filename)}`;
  const stored = await putFile({
    sourcePath: file.path,
    key,
    req,
    contentType: file.mimetype,
  });
  file.storageKey = stored.key;
  file.storageUrl = stored.url;
  return stored;
}

function uploadedFileUrl(req, file, localPath) {
  if (file?.storageUrl) return file.storageUrl;
  return `${publicBaseUrl(req)}${localPath}`;
}

async function checkStorageConnection() {
  if (!useOss()) return { driver: 'local', ok: true };
  const result = await getOssClient().getBucketInfo();
  return {
    driver: 'oss',
    ok: Boolean(result?.bucket || result?.res?.status === 200),
    bucket: requiredOssConfig().bucket,
  };
}

async function putLocalImageVariant({ sourcePath, key, req, width, quality }) {
  const targetPath = path.join(storageRoot, key);
  await ensureDir(path.dirname(targetPath));
  await sharp(sourcePath)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toFile(targetPath);
  return {
    key,
    url: `${publicBaseUrl(req)}${publicPrefix}/${key.replace(/\\/g, '/')}`,
    path: targetPath,
  };
}

async function putImageVariant({ sourcePath, key, req, width, quality }) {
  if (!useOss()) {
    return putLocalImageVariant({ sourcePath, key, req, width, quality });
  }
  const temporaryDir = path.join(storageRoot, '.tmp');
  await ensureDir(temporaryDir);
  const temporaryPath = path.join(
    temporaryDir,
    `${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`
  );
  try {
    await sharp(sourcePath)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toFile(temporaryPath);
    return await putFile({
      sourcePath: temporaryPath,
      key,
      req,
      contentType: 'image/jpeg',
    });
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function storeDesignDocument({ req, file, fileType }) {
  const mimeType = file.mimetype || '';
  const folder = `design-documents/project-${req.params.id}`;
  const original = await putFile({
    sourcePath: file.path,
    key: `${folder}/original/${storageName(file)}`,
    req,
    contentType: mimeType,
  });
  const result = {
    fileUrl: original.url,
    storageKey: original.key,
    previewUrl: null,
    thumbnailUrl: null,
    previewStatus: 'none',
    previewType: 'none',
  };

  if (isImageFile(fileType, mimeType)) {
    try {
      const preview = await putImageVariant({
        sourcePath: file.path,
        key: `${folder}/preview/${storageName(file, '-preview').replace(/\.[^.]+$/, '.jpg')}`,
        req,
        width: 1600,
        quality: 82,
      });
      const thumbnail = await putImageVariant({
        sourcePath: file.path,
        key: `${folder}/thumb/${storageName(file, '-thumb').replace(/\.[^.]+$/, '.jpg')}`,
        req,
        width: 420,
        quality: 72,
      });
      result.previewUrl = preview.url;
      result.thumbnailUrl = thumbnail.url;
      result.previewStatus = 'ready';
      result.previewType = 'image';
    } catch (_) {
      result.previewStatus = 'failed';
      result.previewType = 'image';
    }
  } else if (fileType === 'pdf') {
    result.previewUrl = original.url;
    result.previewStatus = 'ready';
    result.previewType = 'pdf';
  }

  return result;
}

module.exports = {
  storageRoot,
  storageDriver,
  useOss,
  hasOssConfig,
  putFile,
  persistUploadedFile,
  uploadedFileUrl,
  checkStorageConnection,
  parseOssStorageUri,
  signedUrlForStorageUri,
  signStorageUrisDeep,
  storeDesignDocument,
};
