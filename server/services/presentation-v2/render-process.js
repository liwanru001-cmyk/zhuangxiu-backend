'use strict';
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const execFile = require('util').promisify(require('child_process').execFile);
async function renderProcess(mode, payload, output, { signal, timeout = 90000 } = {}) {
  const input = `${output}.${randomUUID()}.json`;
  try {
    await fs.writeFile(input, JSON.stringify(payload), { mode: 0o600 });
    await execFile(process.execPath, ['--max-old-space-size=512', path.join(__dirname, '../../scripts/presentation-render-worker.js'), mode, input, output], { signal, timeout, maxBuffer: 1024 * 1024 });
  } finally { await fs.rm(input, { force: true }); }
}
module.exports = { renderProcess };
