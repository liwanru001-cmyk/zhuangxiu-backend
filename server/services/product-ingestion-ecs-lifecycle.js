'use strict';

const Ecs = require('@alicloud/ecs20140526');
const OpenApi = require('@alicloud/openapi-client');
const Credential = require('@alicloud/credentials').default;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function createEcsLifecycleController(db, env = process.env, dependencies = {}) {
  const enabled = String(env.INGESTION_ECS_LIFECYCLE_ENABLED || 'false').toLowerCase() === 'true';
  const instanceId = String(env.INGESTION_WORKER_INSTANCE_ID || 'i-wz9iovg5qn2n2hc6yvvu').trim();
  const regionId = String(env.INGESTION_WORKER_REGION_ID || 'cn-shenzhen').trim();
  const role = String(env.INGESTION_ECS_CONTROLLER_RAM_ROLE || 'YinnkhomeIngestionControllerRole').trim();
  const idleSeconds = Math.max(300, Number(env.INGESTION_WORKER_IDLE_STOP_SECONDS || 900));
  const wait = dependencies.sleep || sleep;
  const now = dependencies.now || (() => new Date());
  let client = dependencies.client || null;

  function ecs() {
    if (!client) {
      const credential = new Credential({ type:'ecs_ram_role', roleName:role, disableIMDSv1:true });
      client = new Ecs.default(new OpenApi.Config({ credential, regionId, endpoint:`ecs.${regionId}.aliyuncs.com` }));
    }
    return client;
  }

  async function workCount() {
    const [[jobs], [commands]] = await Promise.all([
      db.query("SELECT COUNT(*) total FROM product_ingestion_jobs WHERE status IN ('discovery_approved','discovering','queued','running')"),
      db.query("SELECT COUNT(*) total FROM product_ingestion_worker_commands WHERE status IN ('queued','running')"),
    ]);
    return Number(jobs[0]?.total || 0) + Number(commands[0]?.total || 0);
  }

  async function describe() {
    const response = await ecs().describeInstances(new Ecs.DescribeInstancesRequest({
      regionId,
      instanceIds:JSON.stringify([instanceId]),
    }));
    const instance = response.body?.instances?.instance?.[0];
    if (!instance) throw new Error(`Fixed ingestion ECS not found: ${instanceId}`);
    return instance.status;
  }

  async function ensureRow() {
    await db.query(
      `INSERT INTO product_ingestion_worker_lifecycle (instance_id,region_id,desired_state)
       VALUES (?,?,'running')
       ON DUPLICATE KEY UPDATE region_id=VALUES(region_id)`,
      [instanceId, regionId]
    );
  }

  function maintenanceActive(state) {
    const until = state?.maintenance_until ? new Date(state.maintenance_until).getTime() : Number.NaN;
    return Number.isFinite(until) && until > now().getTime();
  }

  async function requestStart(observed) {
    if (observed !== 'Stopped') return null;
    await db.query(
      "UPDATE product_ingestion_worker_lifecycle SET last_action='start',action_started_at=NOW(),last_error=NULL WHERE instance_id=?",
      [instanceId]
    );
    await ecs().startInstance(new Ecs.StartInstanceRequest({ instanceId }));
    return 'start';
  }

  async function withLifecycleLock(timeoutSeconds, operation) {
    const connection = await db.getConnection();
    let locked = false;
    try {
      const [rows] = await connection.query(
        "SELECT GET_LOCK('zxw:ingestion-ecs-lifecycle',?) acquired",
        [Math.max(0, Number(timeoutSeconds) || 0)]
      );
      locked = Number(rows[0]?.acquired) === 1;
      if (!locked) {
        const error = new Error('Unable to acquire ingestion ECS lifecycle lock');
        error.code = 'INGESTION_ECS_LIFECYCLE_LOCK_TIMEOUT';
        throw error;
      }
      return await operation();
    } finally {
      if (locked) await connection.query("SELECT RELEASE_LOCK('zxw:ingestion-ecs-lifecycle')").catch(() => {});
      connection.release();
    }
  }

  async function tick() {
    if (!enabled) return { enabled:false };
    await ensureRow();
    const connection = await db.getConnection();
    let locked = false;
    try {
      const [locks] = await connection.query("SELECT GET_LOCK('zxw:ingestion-ecs-lifecycle',0) acquired");
      locked = Number(locks[0]?.acquired) === 1;
      if (!locked) return { enabled:true, skipped:'locked' };

      const pending = await workCount();
      const observed = await describe();
      const [stateRows] = await db.query('SELECT * FROM product_ingestion_worker_lifecycle WHERE instance_id=?', [instanceId]);
      const state = stateRows[0] || {};
      const maintenance = maintenanceActive(state);

      // Work and deployments both start a fresh lifecycle. Never inherit idle
      // time from before the work was queued.
      if (pending > 0 || maintenance) {
        await db.query(
          `UPDATE product_ingestion_worker_lifecycle
           SET observed_state=?,desired_state='running',idle_since=NULL,last_error=NULL
           WHERE instance_id=?`,
          [observed, instanceId]
        );
        const action = await requestStart(observed);
        return { enabled:true, pending, maintenance, observed, action };
      }

      if (observed !== 'Running') {
        await db.query(
          `UPDATE product_ingestion_worker_lifecycle
           SET observed_state=?,desired_state='stopped',idle_since=COALESCE(idle_since,NOW()),
               maintenance_until=NULL,maintenance_reason=NULL,last_error=NULL
           WHERE instance_id=?`,
          [observed, instanceId]
        );
        return { enabled:true, pending, maintenance:false, observed, action:null };
      }

      if (!state.idle_since) {
        await db.query(
          `UPDATE product_ingestion_worker_lifecycle
           SET desired_state='running',observed_state=?,idle_since=NOW(),
               maintenance_until=NULL,maintenance_reason=NULL,last_error=NULL
           WHERE instance_id=?`,
          [observed, instanceId]
        );
        return { enabled:true, pending, maintenance:false, observed, idle_seconds:0 };
      }

      const idle = Math.max(0, Math.floor((now().getTime() - new Date(state.idle_since).getTime()) / 1000));
      if (idle < idleSeconds) {
        await db.query(
          `UPDATE product_ingestion_worker_lifecycle
           SET desired_state='running',observed_state=?,maintenance_until=NULL,
               maintenance_reason=NULL,last_error=NULL
           WHERE instance_id=?`,
          [observed, instanceId]
        );
        return { enabled:true, pending, maintenance:false, observed, idle_seconds:idle };
      }

      // The queue in the shared database is the source of truth. An unhealthy
      // heartbeat must not leave an empty deployment host running forever.
      await db.query(
        `UPDATE product_ingestion_worker_lifecycle
         SET desired_state='stopped',last_action='stop',action_started_at=NOW(),last_error=NULL
         WHERE instance_id=?`,
        [instanceId]
      );
      await ecs().stopInstance(new Ecs.StopInstanceRequest({ instanceId, forceStop:false, stoppedMode:'StopCharging' }));
      return { enabled:true, pending, maintenance:false, observed, action:'stop' };
    } catch (error) {
      await ensureRow().catch(() => {});
      await db.query(
        'UPDATE product_ingestion_worker_lifecycle SET last_error=? WHERE instance_id=?',
        [String(error.message || error).slice(0, 1000), instanceId]
      ).catch(() => {});
      throw error;
    } finally {
      if (locked) await connection.query("SELECT RELEASE_LOCK('zxw:ingestion-ecs-lifecycle')").catch(() => {});
      connection.release();
    }
  }

  async function beginMaintenance({ reason = 'deployment', leaseSeconds = 3600, waitTimeoutMs = 300000 } = {}) {
    if (!enabled) throw new Error('Ingestion ECS lifecycle must be enabled before maintenance can start');
    const boundedLease = Math.max(300, Math.min(7200, Number(leaseSeconds) || 3600));
    const boundedTimeout = Math.max(30000, Math.min(600000, Number(waitTimeoutMs) || 300000));
    await ensureRow();
    let observed;
    let action;
    await withLifecycleLock(15, async () => {
      await db.query(
        `UPDATE product_ingestion_worker_lifecycle
         SET desired_state='running',idle_since=NULL,
             maintenance_until=DATE_ADD(NOW(),INTERVAL ? SECOND),maintenance_reason=?,last_error=NULL
         WHERE instance_id=?`,
        [boundedLease, String(reason).slice(0, 255), instanceId]
      );
      observed = await describe();
      action = await requestStart(observed);
    });
    const deadline = Date.now() + boundedTimeout;
    while (observed !== 'Running' && Date.now() < deadline) {
      await wait(5000);
      observed = await describe();
      // A deployment can begin while an earlier idle shutdown is still in
      // progress. Once it reaches Stopped, re-check under the shared lifecycle
      // lock and start it instead of waiting until the deployment times out.
      if (observed === 'Stopped') {
        await withLifecycleLock(15, async () => {
          observed = await describe();
          const retryAction = await requestStart(observed);
          if (retryAction) action = retryAction;
        });
      }
    }
    if (observed !== 'Running') {
      const error = new Error(`Ingestion worker ECS did not become Running before timeout; observed ${observed}`);
      error.code = 'INGESTION_WORKER_START_TIMEOUT';
      throw error;
    }
    await db.query(
      `UPDATE product_ingestion_worker_lifecycle
       SET observed_state='Running',desired_state='running',idle_since=NULL,last_error=NULL
       WHERE instance_id=?`,
      [instanceId]
    );
    return { instance_id:instanceId, region_id:regionId, observed, action, lease_seconds:boundedLease };
  }

  async function endMaintenance() {
    await ensureRow();
    let pending;
    await withLifecycleLock(15, async () => {
      pending = await workCount();
      await db.query(
        `UPDATE product_ingestion_worker_lifecycle
         SET maintenance_until=NULL,maintenance_reason=NULL,desired_state='running',
             idle_since=IF(? > 0,NULL,NOW()),last_error=NULL
         WHERE instance_id=?`,
        [pending, instanceId]
      );
    });
    return { instance_id:instanceId, pending, idle_timer_restarted:pending === 0 };
  }

  async function status() {
    await ensureRow();
    const [rows] = await db.query(
      'SELECT *,TIMESTAMPDIFF(SECOND,idle_since,NOW()) idle_seconds FROM product_ingestion_worker_lifecycle WHERE instance_id=?',
      [instanceId]
    );
    return { enabled, instance_id:instanceId, region_id:regionId, idle_stop_seconds:idleSeconds, ...rows[0] };
  }

  return { tick, status, workCount, beginMaintenance, endMaintenance };
}

function startEcsLifecycleController(db, env = process.env) {
  const controller = createEcsLifecycleController(db, env);
  if (String(env.INGESTION_ECS_LIFECYCLE_ENABLED || 'false').toLowerCase() !== 'true') {
    return { controller, stop:() => {} };
  }
  const intervalMs = Math.max(30000, Number(env.INGESTION_ECS_LIFECYCLE_INTERVAL_MS || 60000));
  const run = () => controller.tick()
    .then(result => { if (result.action) console.log('Ingestion ECS lifecycle action:', result); })
    .catch(error => console.error('Ingestion ECS lifecycle failed:', error.code || error.message));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { controller, stop:() => clearInterval(timer) };
}

module.exports = { createEcsLifecycleController, startEcsLifecycleController };
