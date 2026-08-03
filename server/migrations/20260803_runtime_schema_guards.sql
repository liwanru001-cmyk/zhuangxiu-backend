-- Runtime schema required by member inspection records and owner-confirmed
-- project progress changes. This migration is intentionally idempotent.

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_step_records'
     AND COLUMN_NAME = 'task_id') = 0,
  'ALTER TABLE project_inspection_step_records ADD COLUMN task_id BIGINT UNSIGNED DEFAULT NULL AFTER stage_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_step_records'
     AND INDEX_NAME = 'idx_step_records_task') = 0,
  'CREATE INDEX idx_step_records_task ON project_inspection_step_records (task_id, updated_at)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS project_progress_change_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  entity_type ENUM('task', 'progress_item') NOT NULL,
  target_id BIGINT UNSIGNED DEFAULT NULL,
  action ENUM('create', 'update', 'delete') NOT NULL,
  before_snapshot JSON DEFAULT NULL,
  proposed_payload JSON DEFAULT NULL,
  target_updated_at DATETIME DEFAULT NULL,
  submitted_by BIGINT UNSIGNED NOT NULL,
  submitted_role VARCHAR(32) DEFAULT NULL,
  status ENUM('pending', 'approved', 'rejected', 'cancelled', 'conflict')
    NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED DEFAULT NULL,
  review_note VARCHAR(500) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_progress_change_project_status (project_id, status, created_at),
  KEY idx_progress_change_submitter (submitted_by, status, created_at),
  KEY idx_progress_change_target (project_id, entity_type, target_id, status),
  CONSTRAINT fk_progress_change_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_progress_change_submitter
    FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_progress_change_reviewer
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE project_action_notifications
  MODIFY item_id BIGINT UNSIGNED NULL,
  MODIFY event_type ENUM(
    'assigned', 'feedback', 'case_share_request', 'project_event', 'consultation'
  ) NOT NULL,
  MODIFY delivery_status ENUM('pending', 'sent', 'failed', 'read')
    NOT NULL DEFAULT 'pending';
