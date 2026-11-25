'use strict';

const windows = new Set(['1', '7', '30']);

function recordToolCall(db, userId, failed) {
  return db.query(
    `INSERT INTO workbuddy_tool_usage_daily (usage_date, user_id, call_count, failure_count)
     VALUES (DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR), ?, 1, ?)
     ON DUPLICATE KEY UPDATE call_count = call_count + 1, failure_count = failure_count + ?`,
    [userId, Number(failed), Number(failed)]
  );
}

async function summarize(db, query = {}) {
  const days = String(query.days ?? '1');
  if (!windows.has(days)) throw Object.assign(new Error('时间范围仅支持今天、近 7 天或近 30 天'), { status: 400 });
  const includeTests = query.includeTests === '1';
  const [[row]] = await db.query(
    `SELECT COUNT(DISTINCT daily.user_id) AS users,
            COALESCE(SUM(daily.call_count), 0) AS calls,
            COALESCE(SUM(daily.failure_count), 0) AS failures
       FROM workbuddy_tool_usage_daily daily
       JOIN users u ON u.id = daily.user_id
      WHERE daily.usage_date BETWEEN DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR) - INTERVAL ? DAY
                                 AND DATE(UTC_TIMESTAMP() + INTERVAL 8 HOUR)
        AND (? = 1 OR COALESCE(u.is_test_account, 0) = 0)`,
    [Number(days) - 1, Number(includeTests)]
  );
  return {
    users: Number(row.users),
    calls: Number(row.calls),
    failures: Number(row.failures),
  };
}

module.exports = { recordToolCall, summarize };
