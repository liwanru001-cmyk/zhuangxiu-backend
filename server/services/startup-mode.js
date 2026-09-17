'use strict';

function runtimeMode(env = process.env) {
  return String(env.APP_RUNTIME_MODE || 'normal').trim().toLowerCase();
}

function isSmokeMode(env = process.env) {
  return runtimeMode(env) === 'smoke';
}

module.exports = { runtimeMode, isSmokeMode };
