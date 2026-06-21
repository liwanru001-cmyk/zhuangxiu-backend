const fs = require('fs');
const path = require('path');

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

function safeChmod(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    console.error(`设置权限失败 ${targetPath}:`, error.message);
  }
}

function ensureUploadDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  safeChmod(dirPath, DIR_MODE);
  return dirPath;
}

function flattenUploadedFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return Object.values(files).flat();
}

function setUploadedFilePermissions(req, res, next) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...flattenUploadedFiles(req.files),
  ];
  for (const file of files) {
    if (!file?.path) continue;
    safeChmod(path.dirname(file.path), DIR_MODE);
    safeChmod(file.path, FILE_MODE);
  }
  next();
}

module.exports = {
  DIR_MODE,
  FILE_MODE,
  ensureUploadDir,
  setUploadedFilePermissions,
};
