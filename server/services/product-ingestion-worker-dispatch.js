'use strict';

function parsed(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function createWorkerDispatcher(db) {
  return {
    async enqueue(commandType, payload = {}, actor = 'system:api') {
      const type = String(commandType || '').trim();
      if (!/^[a-z][a-z0-9_]{2,79}$/.test(type)) {
        const error = new Error('Worker 命令类型不正确');
        error.status = 400;
        throw error;
      }
      const [result] = await db.query(
        `INSERT INTO product_ingestion_worker_commands
         (command_type,payload,status,available_at,requested_by)
         VALUES (?,?,'queued',NOW(),?)`,
        [type, JSON.stringify(payload || {}), String(actor).slice(0, 80)]
      );
      return { command_id:Number(result.insertId), command_type:type, status:'queued' };
    },

    async claim(workerId, leaseSeconds = 300) {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          `SELECT * FROM product_ingestion_worker_commands
           WHERE (status='queued' AND available_at<=NOW())
              OR (status='running' AND lease_expires_at<NOW())
           ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
        );
        const row = rows[0];
        if (!row) { await connection.commit(); return null; }
        await connection.query(
          `UPDATE product_ingestion_worker_commands
           SET status='running',worker_id=?,lease_expires_at=DATE_ADD(NOW(),INTERVAL ? SECOND),
               started_at=COALESCE(started_at,NOW()),failure_code=NULL,last_error=NULL
           WHERE id=?`,
          [workerId, Math.max(30, Number(leaseSeconds) || 300), row.id]
        );
        await connection.commit();
        return { ...row, id:Number(row.id), payload:parsed(row.payload, {}), worker_id:workerId };
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally { connection.release(); }
    },

    async complete(id, result = null) {
      await db.query(
        `UPDATE product_ingestion_worker_commands
         SET status='completed',result=?,finished_at=NOW(),lease_expires_at=NULL
         WHERE id=? AND status='running'`,
        [result == null ? null : JSON.stringify(result), Number(id)]
      );
    },

    async fail(id, error) {
      await db.query(
        `UPDATE product_ingestion_worker_commands
         SET status='failed',failure_code=?,last_error=?,finished_at=NOW(),lease_expires_at=NULL
         WHERE id=? AND status='running'`,
        [String(error?.code || 'WORKER_COMMAND_FAILED').slice(0, 80), String(error?.message || error).slice(0, 1000), Number(id)]
      );
    },

    async status() {
      const [rows] = await db.query(
        `SELECT worker_id,instance_id,hostname,status,process_id,version_sha,capabilities,
                started_at,heartbeat_at,stopped_at,last_error,
                TIMESTAMPDIFF(SECOND,heartbeat_at,NOW()) heartbeat_age_seconds
         FROM product_ingestion_workers ORDER BY heartbeat_at DESC LIMIT 10`
      );
      return rows.map(row => ({ ...row, process_id:Number(row.process_id || 0) || null,
        heartbeat_age_seconds:Number(row.heartbeat_age_seconds || 0), capabilities:parsed(row.capabilities, {}) }));
    },
  };
}

module.exports = { createWorkerDispatcher };
