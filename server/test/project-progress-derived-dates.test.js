const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recomputeProjectProgressDerivedDates: recomputeDates,
} = require('../services/progress-derived-dates');

test('progress dates roll up from deepest children to task', async () => {
  const updates = [];
  const executor = {
    async query(sql, params) {
      if (/SELECT id, task_id, parent_id, planned_start, planned_end/.test(sql)) {
        return [[
          { id: 1, task_id: 10, parent_id: null, planned_start: '2026-07-01', planned_end: '2026-07-02' },
          { id: 2, task_id: 10, parent_id: 1, planned_start: '2026-07-03', planned_end: '2026-07-04' },
          { id: 3, task_id: 10, parent_id: 2, planned_start: '2026-08-03', planned_end: '2026-08-05' },
          { id: 4, task_id: 10, parent_id: 2, planned_start: '2026-08-01', planned_end: '2026-08-08' },
          { id: 5, task_id: 10, parent_id: null, planned_start: '2026-09-01', planned_end: '2026-09-02' },
        ]];
      }
      updates.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };

  await recomputeDates(executor, 9);

  const itemUpdates = updates.filter(({ sql }) => /UPDATE project_progress_items/.test(sql));
  assert.deepEqual(itemUpdates.map(({ params }) => params), [
    ['2026-08-01', '2026-08-08', 2, 9],
    ['2026-08-01', '2026-08-08', 1, 9],
  ]);
  const taskUpdate = updates.find(({ sql }) => /UPDATE renovation_tasks/.test(sql));
  assert.deepEqual(taskUpdate.params, ['2026-08-01', '2026-09-02', 10, 9]);
});

test('a parent without remaining children keeps its current dates', async () => {
  const updates = [];
  const executor = {
    async query(sql, params) {
      if (/SELECT id, task_id, parent_id, planned_start, planned_end/.test(sql)) {
        return [[{
          id: 1,
          task_id: 10,
          parent_id: null,
          planned_start: '2026-08-01',
          planned_end: '2026-08-08',
        }]];
      }
      updates.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };

  await recomputeDates(executor, 9);

  assert.equal(updates.some(({ sql }) => /UPDATE project_progress_items/.test(sql)), false);
  assert.deepEqual(updates[0].params, ['2026-08-01', '2026-08-08', 10, 9]);
});
