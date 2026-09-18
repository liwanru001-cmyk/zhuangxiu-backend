'use strict';

require('dotenv').config();

const os = require('os');
const crypto = require('crypto');
const db = require('./config/db');
const { assertRuntimeRole, INGESTION_WORKER_ROLE } = require('./services/runtime-role');
const { fetchHtml } = require('./services/product-ingestion-fetch');
const { createHybridFetcher } = require('./services/product-ingestion-rendered-fetch');
const { createGlobalSlotManager } = require('./services/product-ingestion-global-slots');
const { createRunner } = require('./services/product-ingestion-runner');
const { createRecoveryControl } = require('./services/product-ingestion-recovery-control');
const { createSiteRuleControl } = require('./services/product-ingestion-site-rule-sandbox');
const { createSiteCognitionControl } = require('./services/product-ingestion-site-cognition');
const { createOfficialBrandMaterials } = require('./services/official-brand-materials');
const { createMaterialOnboarding } = require('./services/product-ingestion-material-onboarding');
const { createWorkerDispatcher } = require('./services/product-ingestion-worker-dispatch');
const { initializeEcsRamRoleCredentials } = require('./services/ecs-ram-role-credentials');

assertRuntimeRole(INGESTION_WORKER_ROLE);

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const workerId = String(process.env.INGESTION_WORKER_ID || `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`).slice(0, 120);
const instanceId = String(process.env.ALIBABA_CLOUD_ECS_INSTANCE_ID || '').slice(0, 120) || null;
const releaseSha = String(process.env.RELEASE_SHA || '').slice(0, 40) || null;
const pollMs = Math.max(500, Math.min(30000, Number(process.env.INGESTION_WORKER_POLL_MS || 1500)));
const heartbeatMs = Math.max(5000, Math.min(60000, Number(process.env.INGESTION_WORKER_HEARTBEAT_MS || 15000)));
const singletonLockName = `zxw:product-ingestion-worker:${process.env.DB_NAME || 'default'}`;

let stopping = false;
let singletonConnection = null;
let heartbeatTimer = null;

async function acquireSingleton() {
  singletonConnection = await db.getConnection();
  const [rows] = await singletonConnection.query('SELECT GET_LOCK(?, 0) acquired', [singletonLockName]);
  if (Number(rows[0]?.acquired) !== 1) {
    singletonConnection.release();
    singletonConnection = null;
    const error = new Error('Another product ingestion worker already owns the singleton lock');
    error.code = 'INGESTION_WORKER_ALREADY_RUNNING';
    throw error;
  }
}

async function workerHeartbeat(status = 'online', lastError = null) {
  await db.query(
    `INSERT INTO product_ingestion_workers
     (worker_id,instance_id,hostname,status,process_id,version_sha,capabilities,started_at,heartbeat_at,stopped_at,last_error)
     VALUES (?,?,?,?,?,?,?,NOW(),NOW(),NULL,?)
     ON DUPLICATE KEY UPDATE instance_id=VALUES(instance_id),hostname=VALUES(hostname),status=VALUES(status),
       process_id=VALUES(process_id),version_sha=VALUES(version_sha),capabilities=VALUES(capabilities),
       heartbeat_at=NOW(),stopped_at=IF(VALUES(status)='stopped',NOW(),NULL),last_error=VALUES(last_error)`,
    [workerId, instanceId, os.hostname(), status, process.pid, releaseSha,
      JSON.stringify({ chromium:true, site_cognition:true, discovery:true, extraction:true, ai_rules:true, max_workers:1,
        load_1m:Number(os.loadavg()[0].toFixed(2)),memory_available_mb:Math.round(os.freemem()/1024/1024),
        process_uptime_seconds:Math.round(process.uptime()),db_tunnel:'connected' }),
      lastError ? String(lastError).slice(0, 1000) : null]
  );
}

function createRuntime() {
  const hybridFetch = createHybridFetcher({ fetchHtml });
  const globalSlots = createGlobalSlotManager(db, { limit:1 });
  const siteRules = createSiteRuleControl(db, { fetchHtml:hybridFetch });
  let runner;
  const cognition = createSiteCognitionControl(db, {
    siteRules,
    fetchHtml:hybridFetch,
    renderedFetchHtml:hybridFetch,
    globalSlots,
    onFullCrawlReady:(jobId, options = {}) => setImmediate(() => options.resume_mode === 'extraction' ? runner.start(jobId) : runner.startDiscovery(jobId)),
  });
  runner = createRunner(db, {
    fetchHtml:hybridFetch,
    globalSlots,
    startSiteCognition:jobId => cognition.startForJob(jobId, 'system:worker'),
    onFullCrawlStarted:jobId => cognition.markFullCrawlStarted(jobId),
    onFullCrawlFinished:(jobId, outcome, details) => cognition.markFullCrawlFinished(jobId, outcome, details),
  });
  const recovery = createRecoveryControl(db, {
    resumeRecoveredDiscovery:(jobId, urls, attemptId) => runner.resumeRecoveredDiscovery(jobId, urls, attemptId),
    fetchHtml:hybridFetch,
  });
  const officialMaterials = createOfficialBrandMaterials(db);
  const materialOnboarding = createMaterialOnboarding(db, { fetchHtml:hybridFetch, officialMaterials });
  return { hybridFetch, globalSlots, siteRules, cognition, runner, recovery, officialMaterials, materialOnboarding };
}

async function executeCommand(runtime, command) {
  const payload = command.payload || {};
  const actor = String(payload.actor || command.requested_by || 'system:worker').slice(0, 80);
  switch (command.command_type) {
    case 'site_cognition_start': return runtime.cognition.startForJob(payload.job_id, actor);
    case 'site_cognition_retry': return runtime.cognition.retryHandoff(payload.workflow_id, actor);
    case 'site_cognition_ai_budget': return runtime.cognition.approveAiBudget(payload.workflow_id, payload.body || {}, actor);
    case 'site_cognition_feedback': return runtime.cognition.feedback(payload.workflow_id, payload.body || {}, actor);
    case 'site_rule_sandbox': return runtime.siteRules.runSandbox(payload.rule_id, actor);
    case 'recovery_try_existing_data': return runtime.recovery.executeLocal(payload.attempt_id, payload.body || {}, actor);
    case 'recovery_acquire_evidence': return runtime.recovery.acquireEvidence(payload.attempt_id, payload.body || {}, actor);
    case 'recovery_retry_plan': return runtime.recovery.retryPlan(payload.attempt_id, payload.body || {}, actor);
    case 'historical_failure_shadow': return runtime.runner.planHistoricalFailure(payload.job_id, payload.options || {});
    case 'official_material_catalog_scan': return runtime.officialMaterials.scanCatalog(payload.catalog_id, payload.body || {}, actor);
    case 'official_material_product_subset_scan': return runtime.officialMaterials.scanProductSubset(payload.catalog_id, payload.body || {}, actor);
    case 'material_onboarding_prepare': return runtime.materialOnboarding.prepare(payload.body || {}, actor);
    case 'material_onboarding_text_revision': return runtime.materialOnboarding.createTextOnlyRevision(payload.catalog_id, payload.body || {}, actor);
    case 'material_onboarding_approve_scan': return runtime.materialOnboarding.approveAndScan(payload.catalog_id, payload.body || {}, actor);
    default: {
      const error = new Error(`Unsupported worker command: ${command.command_type}`);
      error.code = 'INGESTION_WORKER_COMMAND_UNSUPPORTED';
      throw error;
    }
  }
}

async function recover(runtime) {
  await db.query("UPDATE product_ingestion_worker_commands SET status='queued',worker_id=NULL,lease_expires_at=NULL,failure_code='WORKER_INTERRUPTED',last_error='Worker 中断，命令已返回队列' WHERE status='running'");
  await runtime.siteRules.recoverInterruptedRuns();
  await runtime.recovery.recoverInterruptedAttempts();
  await runtime.cognition.recoverInterrupted();
  await runtime.runner.recoverInterruptedJobs();
}

async function nextRunnableJob() {
  const [rows] = await db.query(
    `SELECT id,status,current_stage,scope_snapshot FROM product_ingestion_jobs
     WHERE status IN ('discovery_approved','queued') AND scope_snapshot IS NOT NULL
     ORDER BY id LIMIT 20`
  );
  for (const row of rows) {
    let scope = row.scope_snapshot;
    if (typeof scope === 'string') { try { scope = JSON.parse(scope); } catch (_) { scope = {}; } }
    const resumeAt = Date.parse(scope?.full_crawl_rate_limit_resume_at || '');
    if (row.status === 'queued' && Number.isFinite(resumeAt) && resumeAt > Date.now()) continue;
    return { id:Number(row.id), status:row.status };
  }
  return null;
}

async function shutdown(reason = 'signal') {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await workerHeartbeat('stopped', reason).catch(() => {});
  if (singletonConnection) {
    await singletonConnection.query('SELECT RELEASE_LOCK(?) released', [singletonLockName]).catch(() => {});
    singletonConnection.release();
    singletonConnection = null;
  }
  await db.end().catch(() => {});
}

async function main() {
  await initializeEcsRamRoleCredentials();
  await db.schemaReady;
  await acquireSingleton();
  await workerHeartbeat();
  heartbeatTimer = setInterval(() => workerHeartbeat().catch(error => console.error('Worker heartbeat failed:', error.code || error.message)), heartbeatMs);
  heartbeatTimer.unref?.();
  const runtime = createRuntime();
  const dispatcher = createWorkerDispatcher(db);
  await recover(runtime);
  console.log('Product ingestion worker ready', { worker_id:workerId, instance_id:instanceId, poll_ms:pollMs });

  while (!stopping) {
    let worked = false;
    try {
      const command = await dispatcher.claim(workerId);
      if (command) {
        worked = true;
        try { await dispatcher.complete(command.id, await executeCommand(runtime, command)); }
        catch (error) { await dispatcher.fail(command.id, error); console.error('Worker command failed:', { command_id:command.id, type:command.command_type, code:error.code || error.name, message:error.message }); }
      }
      const job = await nextRunnableJob();
      if (job) {
        worked = true;
        if (job.status === 'discovery_approved') await runtime.runner.runDiscovery(job.id);
        else await runtime.runner.run(job.id);
      }
    } catch (error) {
      console.error('Product ingestion worker loop failed:', { code:error.code || error.name, message:error.message });
      await workerHeartbeat('degraded', error.message).catch(() => {});
      await sleep(Math.max(3000, pollMs));
    }
    if (!worked) await sleep(pollMs);
  }
}

process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.on('unhandledRejection', error => console.error('Unhandled worker rejection:', error));

main().catch(async error => {
  console.error('Product ingestion worker failed to start:', { code:error.code || error.name, message:error.message });
  await shutdown(error.message);
  process.exitCode = 1;
});
