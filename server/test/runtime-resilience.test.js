const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const db = require('../config/db');

const {
  ProjectEventType,
  emitProjectEvent,
} = require('../services/project-event.service');
const {
  checkRuntimeSchema,
  requiredColumns,
} = require('../services/runtime-schema.service');

after(async () => {
  await db.end();
});

test('project notification failure does not fail the completed business action', async () => {
  const executor = {
    async query() {
      const error = new Error('notification table unavailable');
      error.code = 'ER_NO_SUCH_TABLE';
      throw error;
    },
  };

  const result = await emitProjectEvent(
    ProjectEventType.INSPECTION_STEP_SUBMITTED,
    {
      projectId: 9,
      actorId: 7,
      targetUserIds: [8],
      entityType: 'inspection_step',
      entityId: 31,
      title: '成员已提交核对记录',
    },
    executor
  );

  assert.deepEqual(result, { inserted: 0, failed: true });
});

test('runtime schema check reports every missing critical column', async () => {
  const executor = {
    async query() {
      return [[
        { TABLE_NAME: 'project_action_notifications', COLUMN_NAME: 'item_id' },
      ]];
    },
  };

  const result = await checkRuntimeSchema(executor);
  const expectedCount = Object.values(requiredColumns)
    .reduce((total, columns) => total + columns.length, 0) - 1;
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, expectedCount);
  assert.ok(
    result.missing.includes('project_inspection_step_records.task_id')
  );
  assert.ok(
    result.missing.includes('project_progress_change_requests.submitted_role')
  );
});

test('runtime schema check passes when the critical contract is complete', async () => {
  const rows = Object.entries(requiredColumns).flatMap(([table, columns]) =>
    columns.map((column) => ({ TABLE_NAME: table, COLUMN_NAME: column }))
  );
  const result = await checkRuntimeSchema({
    async query() {
      return [rows];
    },
  });

  assert.deepEqual(result, { ok: true, missing: [] });
});
