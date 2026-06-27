const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const storageRoot = path.join(__dirname, '..', 'storage');
const publicPrefix = '/storage';

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
  await fs.copyFile(sourcePath, targetPath);
  return {
    key,
    url: `${publicBaseUrl(req)}${publicPrefix}/${key.replace(/\\/g, '/')}`,
    path: targetPath,
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

async function storeDesignDocument({ req, file, fileType }) {
  const mimeType = file.mimetype || '';
  const folder = `design-documents/project-${req.params.id}`;
  const original = await putLocalFile({
    sourcePath: file.path,
    key: `${folder}/original/${storageName(file)}`,
    req,
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
      const preview = await putLocalImageVariant({
        sourcePath: file.path,
        key: `${folder}/preview/${storageName(file, '-preview').replace(/\.[^.]+$/, '.jpg')}`,
        req,
        width: 1600,
        quality: 82,
      });
      const thumbnail = await putLocalImageVariant({
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
  storeDesignDocument,
};
