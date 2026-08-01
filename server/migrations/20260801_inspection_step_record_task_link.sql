-- Give every inspection step record a formal renovation-task link.
-- Existing progress-item records inherit the task already linked to that item.

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_step_records'
     AND COLUMN_NAME = 'task_id') = 0,
  'ALTER TABLE project_inspection_step_records ADD COLUMN task_id BIGINT UNSIGNED DEFAULT NULL AFTER stage_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE project_inspection_step_records record
JOIN project_progress_items item
  ON item.id = record.progress_item_id
 AND item.project_id = record.project_id
SET record.task_id = item.task_id
WHERE record.task_id IS NULL
  AND item.task_id IS NOT NULL;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_step_records'
     AND INDEX_NAME = 'idx_step_records_task') = 0,
  'CREATE INDEX idx_step_records_task ON project_inspection_step_records (task_id, updated_at)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
