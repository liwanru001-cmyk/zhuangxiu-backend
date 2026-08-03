const fs = require('fs/promises');
const storageService = require('../services/storage.service');

function requestFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') {
    return Object.values(req.files).flat();
  }
  return [];
}

function persistUploadedFiles(folder) {
  return async (req, res, next) => {
    if (!storageService.useOss()) return next();
    const files = requestFiles(req);
    try {
      await Promise.all(
        files.map((file) =>
          storageService.persistUploadedFile({ req, file, folder })
        )
      );
      res.once('finish', () => {
        Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {}))).catch(() => {});
      });
      return next();
    } catch (err) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return next(err);
    }
  };
}

module.exports = persistUploadedFiles;
