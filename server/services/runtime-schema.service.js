const db = require('../config/db');

const requiredColumns = Object.freeze({
  project_action_notifications: ['item_id', 'event_type', 'payload'],
  project_inspection_step_records: [
    'task_id',
    'progress_item_id',
    'inspection_id',
    'member_role',
  ],
  project_inspections: [
    'title',
    'template_code',
    'client_request_id',
    'algorithm_version',
    'calculation_summary',
    'row_version',
    'calculated_at',
  ],
  project_inspection_items: [
    'id',
    'inspection_id',
    'project_id',
    'item_key',
    'result',
  ],
  project_inspection_item_images: [
    'id',
    'inspection_item_id',
    'image_url',
    'uploaded_by',
  ],
  project_progress_change_requests: [
    'id',
    'project_id',
    'entity_type',
    'target_id',
    'proposed_payload',
    'submitted_by',
    'submitted_role',
    'status',
  ],
});

async function checkRuntimeSchema(executor = db) {
  const [rows] = await executor.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (?)`,
    [Object.keys(requiredColumns)]
  );
  const actual = new Map();
  for (const row of rows) {
    if (!actual.has(row.TABLE_NAME)) actual.set(row.TABLE_NAME, new Set());
    actual.get(row.TABLE_NAME).add(row.COLUMN_NAME);
  }
  const missing = [];
  for (const [table, columns] of Object.entries(requiredColumns)) {
    for (const column of columns) {
      if (!actual.get(table)?.has(column)) missing.push(`${table}.${column}`);
    }
  }
  return { ok: missing.length === 0, missing };
}

module.exports = { checkRuntimeSchema, requiredColumns };
