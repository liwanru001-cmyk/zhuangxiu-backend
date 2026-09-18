'use strict';

require('dotenv').config();

const db = require('../config/db');
const { createEcsLifecycleController } = require('../services/product-ingestion-ecs-lifecycle');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find(value => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const action = process.argv[2];
  if (!['prepare', 'release', 'status'].includes(action)) {
    throw new Error('Usage: node scripts/manage-product-ingestion-worker-deployment.js <prepare|release|status> [options]');
  }

  await db.schemaReady;
  const controller = createEcsLifecycleController(db);
  let result;
  if (action === 'prepare') {
    const releaseSha = option('release-sha', 'unknown');
    result = await controller.beginMaintenance({
      reason:`github-deploy:${releaseSha}`,
      leaseSeconds:Number(option('lease-seconds', '3600')),
      waitTimeoutMs:Number(option('wait-timeout-ms', '300000')),
    });
  } else if (action === 'release') {
    result = await controller.endMaintenance();
  } else {
    result = await controller.status();
  }
  process.stdout.write(`WORKER_DEPLOYMENT_RESULT=${JSON.stringify({ ok:true, action, ...result })}\n`);
}

if (require.main === module) {
  main()
    .catch(error => {
      process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.end().catch(() => {}));
}

module.exports = { main, option };
