const db = require('../config/db');
const {
  refreshAllCompanyEvaluationSnapshots,
} = require('../controllers/marketplace.controller');

const JOB_NAME = 'company_evaluation_daily_snapshot';
const TIME_ZONE = 'Asia/Shanghai';
const DEFAULT_RUN_HOUR = 3;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

function shanghaiClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
  };
}

async function claimRun(snapshotDate, runHour) {
  await db.query(
    `INSERT IGNORE INTO scheduled_job_runs (job_name, status)
     VALUES (?, 'idle')`,
    [JOB_NAME]
  );
  const [rows] = await db.query(
    `SELECT last_run_date FROM scheduled_job_runs
     WHERE job_name = ? LIMIT 1`,
    [JOB_NAME]
  );
  const hasNeverRun = !rows[0]?.last_run_date;
  const { hour } = shanghaiClock();
  if (!hasNeverRun && hour < runHour) return false;

  const [result] = await db.query(
    `UPDATE scheduled_job_runs
     SET status = 'running', last_started_at = NOW(), last_error = NULL
     WHERE job_name = ?
       AND (last_run_date IS NULL OR last_run_date < ?)
       AND (status <> 'running' OR last_started_at < DATE_SUB(NOW(), INTERVAL 6 HOUR))`,
    [JOB_NAME, snapshotDate]
  );
  return result.affectedRows === 1;
}

async function runIfDue() {
  const { date } = shanghaiClock();
  const configuredHour = Number(process.env.COMPANY_EVALUATION_DAILY_HOUR);
  const runHour = Number.isInteger(configuredHour) && configuredHour >= 0 && configuredHour <= 23
    ? configuredHour
    : DEFAULT_RUN_HOUR;
  if (!(await claimRun(date, runHour))) return;

  try {
    const result = await refreshAllCompanyEvaluationSnapshots(date);
    const failureMessage = result.failures.length
      ? `${result.failures.length}/${result.total} companies failed; first: ${result.failures[0].error}`
      : null;
    await db.query(
      `UPDATE scheduled_job_runs
       SET last_run_date = ?, last_completed_at = NOW(),
           status = 'success', last_error = ?
       WHERE job_name = ?`,
      [date, failureMessage?.slice(0, 1000) || null, JOB_NAME]
    );
    console.log(`✅ 公司四维评价每日快照完成: ${result.refreshed}/${result.total}`);
    if (failureMessage) {
      console.warn(`⚠️ 公司四维评价部分失败（次日重试）: ${failureMessage}`);
    }
  } catch (err) {
    await db.query(
      `UPDATE scheduled_job_runs
       SET status = 'failed', last_error = ?
       WHERE job_name = ?`,
      [String(err.message || err).slice(0, 1000), JOB_NAME]
    );
    console.error('❌ 公司四维评价每日快照失败:', err.message);
  }
}

function startCompanyEvaluationScheduler() {
  const initialTimer = setTimeout(() => {
    runIfDue().catch((err) => {
      console.error('❌ 公司四维评价定时检查失败:', err.message);
    });
  }, 30 * 1000);
  initialTimer.unref?.();

  const interval = setInterval(() => {
    runIfDue().catch((err) => {
      console.error('❌ 公司四维评价定时检查失败:', err.message);
    });
  }, CHECK_INTERVAL_MS);
  interval.unref?.();
}

module.exports = {
  shanghaiClock,
  runIfDue,
  startCompanyEvaluationScheduler,
};
