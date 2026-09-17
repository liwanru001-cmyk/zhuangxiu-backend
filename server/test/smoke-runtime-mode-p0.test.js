'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runtimeMode, isSmokeMode } = require('../services/startup-mode');

test('deployment smoke mode is explicit and defaults to normal operation', () => {
  assert.equal(runtimeMode({}), 'normal');
  assert.equal(isSmokeMode({}), false);
  assert.equal(isSmokeMode({ APP_RUNTIME_MODE: 'smoke' }), true);
  assert.equal(isSmokeMode({ APP_RUNTIME_MODE: 'SMOKE' }), true);
});

test('product ingestion route initialization performs no recovery queries in smoke mode', async () => {
  const previous = process.env.APP_RUNTIME_MODE;
  process.env.APP_RUNTIME_MODE = 'smoke';
  let queries = 0;
  const db = {
    query: async () => { queries += 1; throw new Error('smoke mode must not query during route initialization'); },
    getConnection: async () => { throw new Error('smoke mode must not acquire a migration connection'); },
  };
  try {
    require('../routes/admin-product-ingestion.routes')(db);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 0);
  } finally {
    if (previous === undefined) delete process.env.APP_RUNTIME_MODE;
    else process.env.APP_RUNTIME_MODE = previous;
  }
});

test('deployment smoke command and every startup side-effect gate use smoke mode', () => {
  const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
  const dbSource = fs.readFileSync(require.resolve('../config/db'), 'utf8');
  const routeSource = fs.readFileSync(require.resolve('../routes/admin-product-ingestion.routes'), 'utf8');
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy-backend.yml'), 'utf8');
  assert.match(workflow, /APP_RUNTIME_MODE=smoke PORT="\$smoke_port" node app\.js/);
  assert.match(appSource, /if \(isSmokeMode\(\)\).*background schedulers and workers are disabled/s);
  assert.match(dbSource, /if \(!isSmokeMode\(\)\).*ensureAppTables/s);
  assert.match(routeSource, /if\(!isSmokeMode\(\)\).*recoverInterrupted/s);
});

test('deployment stores database backups outside the application and strips legacy public copies', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy-backend.yml'), 'utf8');
  assert.match(workflow, /private_root="\$\{APP_DIR\}\.private"/);
  assert.match(workflow, /db_backup_dir="\$private_root\/db-backups"/);
  assert.match(workflow, /rm -rf "\$staging_dir\/storage\/db-backups"/);
  assert.doesNotMatch(workflow, /db_backup_dir="\$staging_dir\/storage\/db-backups"/);
});
