'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function configuration(env = process.env) {
  const tokenVersion = Number.parseInt(env.ADMIN_TOKEN_VERSION || '', 10);
  return {
    username: String(env.ADMIN_USERNAME || '').trim(),
    passwordHash: String(env.ADMIN_PASSWORD_HASH || '').trim(),
    tokenVersion,
    jwtSecret: String(env.JWT_SECRET || ''),
    expiresIn: String(env.ADMIN_JWT_EXPIRES_IN || '8h').trim(),
  };
}

function assertConfiguration(env = process.env) {
  const config = configuration(env);
  const missing = [];
  if (!config.username) missing.push('ADMIN_USERNAME');
  if (!/^\$2[aby]\$\d{2}\$/.test(config.passwordHash)) missing.push('ADMIN_PASSWORD_HASH');
  if (!Number.isSafeInteger(config.tokenVersion) || config.tokenVersion < 1) missing.push('ADMIN_TOKEN_VERSION');
  if (config.jwtSecret.length < 32) missing.push('JWT_SECRET (at least 32 characters)');
  if (!config.expiresIn) missing.push('ADMIN_JWT_EXPIRES_IN');
  if (missing.length) {
    const error = new Error(`Missing or invalid administrator authentication configuration: ${missing.join(', ')}`);
    error.code = 'ADMIN_AUTH_NOT_CONFIGURED';
    throw error;
  }
  return config;
}

async function authenticate(username, password, env = process.env) {
  const config = assertConfiguration(env);
  const passwordMatches = await bcrypt.compare(String(password || ''), config.passwordHash);
  return constantTimeEqual(username, config.username) && passwordMatches;
}

function issueToken(env = process.env) {
  const config = assertConfiguration(env);
  return jwt.sign(
    {
      role: 'admin',
      adminUsername: config.username,
      adminTokenVersion: config.tokenVersion,
    },
    config.jwtSecret,
    { expiresIn: config.expiresIn }
  );
}

function verifyToken(token, env = process.env) {
  const config = assertConfiguration(env);
  const decoded = jwt.verify(token, config.jwtSecret);
  if (decoded.role !== 'admin') {
    const error = new Error('Administrator role is required');
    error.code = 'ADMIN_FORBIDDEN';
    throw error;
  }
  if (decoded.adminUsername !== config.username
      || decoded.adminTokenVersion !== config.tokenVersion) {
    const error = new Error('Administrator token has been revoked');
    error.code = 'ADMIN_TOKEN_REVOKED';
    throw error;
  }
  return decoded;
}

module.exports = {
  configuration,
  assertConfiguration,
  authenticate,
  issueToken,
  verifyToken,
};
