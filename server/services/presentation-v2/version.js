'use strict';
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
let cached;
function snapshot() {
  if (!cached) {
    const hash = createHash('sha256');
    for (const file of ['pipeline.js', 'model.js', 'validate.js', 'render.js', 'media.js', 'assets.js', 'schema.js', 'config.js']) {
      try { hash.update(file).update(fs.readFileSync(path.join(__dirname, file))); }
      catch { return { code: 'unrecorded', reason: 'version_files_unavailable' }; }
    }
    cached = { code: hash.digest('hex').slice(0, 16), recorded_at: new Date().toISOString() };
  }
  return { ...cached };
}
module.exports = { snapshot };
