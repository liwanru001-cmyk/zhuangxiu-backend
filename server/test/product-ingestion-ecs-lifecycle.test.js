'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEcsLifecycleController } = require('../services/product-ingestion-ecs-lifecycle');

function database({ jobs = 0, commands = 0, state = {}, worker = { status:'online', age:1 } } = {}) {
  const writes = [];
  let jobCount = jobs;
  let commandCount = commands;
  const mutableState = { ...state };
  const query = async (sql, params = []) => {
    writes.push({ sql, params });
    if (sql.includes('COUNT(*) total FROM product_ingestion_jobs')) return [[{ total:jobCount }]];
    if (sql.includes('COUNT(*) total FROM product_ingestion_worker_commands')) return [[{ total:commandCount }]];
    if (sql.includes('SELECT * FROM product_ingestion_worker_lifecycle')) return [[{ ...mutableState }]];
    if (sql.includes('FROM product_ingestion_workers')) return [[worker]];
    if (sql.includes('idle_since=NULL')) mutableState.idle_since = null;
    if (sql.includes('idle_since=NOW()') || sql.includes('idle_since=IF(')) mutableState.idle_since = new Date('2026-09-18T04:00:00Z');
    if (sql.includes('maintenance_until=DATE_ADD')) {
      mutableState.maintenance_until = new Date('2026-09-18T05:00:00Z');
      mutableState.maintenance_reason = params[1];
    }
    if (sql.includes('maintenance_until=NULL')) {
      mutableState.maintenance_until = null;
      mutableState.maintenance_reason = null;
    }
    return [{ affectedRows:1 }];
  };
  return {
    writes,
    state:mutableState,
    setJobs(value) { jobCount = value; },
    setCommands(value) { commandCount = value; },
    query,
    getConnection:async () => ({
      query:async sql => sql.includes('GET_LOCK') ? [[{ acquired:1 }]] : [[{ released:1 }]],
      release() {},
    }),
  };
}

const env = {
  INGESTION_ECS_LIFECYCLE_ENABLED:'true',
  INGESTION_WORKER_INSTANCE_ID:'i-fixed',
  INGESTION_WORKER_REGION_ID:'cn-test',
  INGESTION_ECS_CONTROLLER_RAM_ROLE:'ControllerRole',
  INGESTION_WORKER_IDLE_STOP_SECONDS:'900',
};

function ecsClient(statuses) {
  const queue = Array.isArray(statuses) ? [...statuses] : [statuses];
  let current = queue[0];
  return {
    starts:0,
    stops:0,
    async describeInstances() {
      current = queue.length ? queue.shift() : current;
      return { body:{ instances:{ instance:[{ status:current }] } } };
    },
    async startInstance() { this.starts += 1; },
    async stopInstance() { this.stops += 1; },
  };
}

test('queued work clears stale idle time before starting the fixed ECS', async () => {
  const db = database({ jobs:1, state:{ idle_since:new Date('2026-09-18T03:00:00Z') } });
  const client = ecsClient('Stopped');
  const controller = createEcsLifecycleController(db, env, { client, now:() => new Date('2026-09-18T04:00:00Z') });

  const result = await controller.tick();

  assert.equal(result.action, 'start');
  assert.equal(client.starts, 1);
  assert.equal(db.state.idle_since, null);
  assert.ok(db.writes.some(write => write.sql.includes("desired_state='running',idle_since=NULL")));
});

test('idle countdown starts again only after the last queued job disappears', async () => {
  const db = database({ jobs:1, state:{ idle_since:new Date('2026-09-18T03:00:00Z') } });
  const client = ecsClient(['Running', 'Running']);
  const controller = createEcsLifecycleController(db, env, { client, now:() => new Date('2026-09-18T04:00:00Z') });

  await controller.tick();
  db.setJobs(0);
  const result = await controller.tick();

  assert.equal(result.idle_seconds, 0);
  assert.equal(client.stops, 0);
  assert.ok(db.state.idle_since instanceof Date);
});

test('active deployment maintenance starts and keeps the worker running without queued work', async () => {
  const db = database({ state:{ maintenance_until:new Date('2026-09-18T04:30:00Z'), idle_since:new Date('2026-09-18T03:00:00Z') } });
  const client = ecsClient('Stopped');
  const controller = createEcsLifecycleController(db, env, { client, now:() => new Date('2026-09-18T04:00:00Z') });

  const result = await controller.tick();

  assert.equal(result.maintenance, true);
  assert.equal(result.action, 'start');
  assert.equal(db.state.idle_since, null);
});

test('beginMaintenance waits for Running and endMaintenance restarts the idle timer', async () => {
  const db = database();
  const client = ecsClient(['Stopped', 'Starting', 'Running']);
  const controller = createEcsLifecycleController(db, env, { client, sleep:async () => {} });

  const prepared = await controller.beginMaintenance({ reason:'github-deploy:abc', leaseSeconds:1800 });
  const released = await controller.endMaintenance();

  assert.equal(prepared.observed, 'Running');
  assert.equal(prepared.action, 'start');
  assert.equal(client.starts, 1);
  assert.equal(released.idle_timer_restarted, true);
  assert.equal(db.state.maintenance_until, null);
  assert.ok(db.state.idle_since instanceof Date);
});

test('beginMaintenance restarts an instance that was already Stopping', async () => {
  const db = database();
  const client = ecsClient(['Stopping', 'Stopped', 'Stopped', 'Starting', 'Running']);
  const controller = createEcsLifecycleController(db, env, { client, sleep:async () => {} });

  const prepared = await controller.beginMaintenance({ reason:'github-deploy:def' });

  assert.equal(prepared.observed, 'Running');
  assert.equal(prepared.action, 'start');
  assert.equal(client.starts, 1);
});

test('fixed ECS controller stops an empty idle host even after a failed deployment heartbeat', async () => {
  const db = database({
    state:{ idle_since:new Date('2026-09-18T03:44:00Z') },
    worker:{ status:'degraded', age:3600 },
  });
  const client = ecsClient('Running');
  const controller = createEcsLifecycleController(db, env, { client, now:() => new Date('2026-09-18T04:00:00Z') });

  const result = await controller.tick();

  assert.equal(result.action, 'stop');
  assert.equal(client.stops, 1);
  assert.equal(typeof client.createInstance, 'undefined');
});
