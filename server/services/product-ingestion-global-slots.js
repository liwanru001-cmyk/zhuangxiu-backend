'use strict';

const crypto = require('crypto');

const localSlots = new Map();

function configuredLimit(env = process.env) {
  const value = Number.parseInt(env.INGESTION_GLOBAL_CONCURRENCY || '2', 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
    const error = new Error('INGESTION_GLOBAL_CONCURRENCY must be an integer between 1 and 8');
    error.code = 'INGESTION_GLOBAL_CONCURRENCY_INVALID';
    throw error;
  }
  return value;
}

function namespace(env = process.env) {
  const identity = String(env.INGESTION_LOCK_NAMESPACE || env.DB_NAME || 'default');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

function lockName(slot, env = process.env) {
  return `zxw:ingestion:${namespace(env)}:${slot}`;
}

function createLocalManager(limit, key) {
  if (!localSlots.has(key)) localSlots.set(key, new Set());
  const held = localSlots.get(key);
  return {
    async acquire() {
      for (let slot = 1; slot <= limit; slot += 1) {
        if (held.has(slot)) continue;
        held.add(slot);
        let released = false;
        return {
          slot,
          backend: 'process-local',
          async release() {
            if (released) return;
            released = true;
            held.delete(slot);
          },
        };
      }
      return null;
    },
  };
}

function createGlobalSlotManager(db, options = {}) {
  const env = options.env || process.env;
  const limit = options.limit || configuredLimit(env);
  if (typeof db?.getConnection !== 'function') {
    if (env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Production ingestion concurrency requires a MySQL connection pool'), {
        code: 'INGESTION_GLOBAL_SLOT_BACKEND_REQUIRED',
      });
    }
    return createLocalManager(limit, namespace(env));
  }

  return {
    async acquire(context = {}) {
      const connection = await db.getConnection();
      try {
        for (let slot = 1; slot <= limit; slot += 1) {
          const name = lockName(slot, env);
          const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
          if (Number(rows[0]?.acquired) !== 1) continue;
          let released = false;
          return {
            slot,
            backend: 'mysql-advisory-lock',
            job_id: Number(context.jobId || 0) || null,
            phase: context.phase || null,
            async release() {
              if (released) return;
              released = true;
              try { await connection.query('SELECT RELEASE_LOCK(?) AS released', [name]); }
              catch (error) { console.error('Failed to release ingestion global slot:', { slot, code: error.code || error.name }); }
              finally { connection.release(); }
            },
          };
        }
      } catch (error) {
        connection.release();
        throw error;
      }
      connection.release();
      return null;
    },
  };
}

module.exports = { configuredLimit, namespace, lockName, createGlobalSlotManager };
