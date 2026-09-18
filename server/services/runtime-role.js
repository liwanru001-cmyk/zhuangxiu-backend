'use strict';

const API_ROLE = 'api';
const INGESTION_WORKER_ROLE = 'ingestion-worker';

function runtimeRole(env = process.env) {
  return String(env.APP_RUNTIME_ROLE || API_ROLE).trim().toLowerCase();
}

function isApiRole(env = process.env) {
  return runtimeRole(env) === API_ROLE;
}

function isIngestionWorkerRole(env = process.env) {
  return runtimeRole(env) === INGESTION_WORKER_ROLE;
}

function assertRuntimeRole(expected, env = process.env) {
  const actual = runtimeRole(env);
  if (actual !== expected) {
    const error = new Error(`APP_RUNTIME_ROLE must be ${expected}; got ${actual}`);
    error.code = 'APP_RUNTIME_ROLE_INVALID';
    throw error;
  }
  return actual;
}

module.exports = {
  API_ROLE,
  INGESTION_WORKER_ROLE,
  runtimeRole,
  isApiRole,
  isIngestionWorkerRole,
  assertRuntimeRole,
};
