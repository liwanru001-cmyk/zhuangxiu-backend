'use strict';
const fs = require('fs/promises');
async function main() {
  const [mode, input, output] = process.argv.slice(2);
  const payload = JSON.parse(await fs.readFile(input, 'utf8'));
  if (mode === 'v2') await require('../services/presentation-v2/render').renderInProcess(payload.design, payload.manifest, output);
  else if (mode === 'legacy') await require('./generate-ppt-from-plan').generateFromPlan(payload.plan, output, { strict: true, manifest: payload.manifest, maxSlides: payload.maxSlides });
  else throw new Error('Invalid renderer mode');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
