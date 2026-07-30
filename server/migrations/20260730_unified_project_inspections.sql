-- Idempotent schema migration for the formal main-inspection/check-item model.
-- Historical step-record data is intentionally NOT migrated here.

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'title') = 0,
  'ALTER TABLE project_inspections ADD COLUMN title VARCHAR(160) DEFAULT NULL AFTER stage_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'template_id') = 0,
  'ALTER TABLE project_inspections ADD COLUMN template_id BIGINT UNSIGNED DEFAULT NULL AFTER title',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'template_code') = 0,
  'ALTER TABLE project_inspections ADD COLUMN template_code VARCHAR(64) DEFAULT NULL AFTER template_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'client_request_id') = 0,
  'ALTER TABLE project_inspections ADD COLUMN client_request_id VARCHAR(64) DEFAULT NULL AFTER template_code',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'algorithm_version') = 0,
  'ALTER TABLE project_inspections ADD COLUMN algorithm_version VARCHAR(40) DEFAULT NULL AFTER client_request_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'calculation_summary') = 0,
  'ALTER TABLE project_inspections ADD COLUMN calculation_summary JSON DEFAULT NULL AFTER algorithm_version',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'row_version') = 0,
  'ALTER TABLE project_inspections ADD COLUMN row_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER calculation_summary',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'calculated_at') = 0,
  'ALTER TABLE project_inspections ADD COLUMN calculated_at TIMESTAMP NULL DEFAULT NULL AFTER row_version',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND COLUMN_NAME = 'task_id' AND IS_NULLABLE = 'NO') > 0,
  'ALTER TABLE project_inspections MODIFY COLUMN task_id BIGINT UNSIGNED DEFAULT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_inspections'
     AND INDEX_NAME = 'uk_inspection_client_request') = 0,
  'CREATE UNIQUE INDEX uk_inspection_client_request ON project_inspections (project_id, client_request_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_step_records'
     AND COLUMN_NAME = 'inspection_id') = 0,
  'ALTER TABLE project_inspection_step_records ADD COLUMN inspection_id BIGINT UNSIGNED DEFAULT NULL AFTER progress_item_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_step_records'
     AND INDEX_NAME = 'idx_step_records_inspection') = 0,
  'CREATE INDEX idx_step_records_inspection ON project_inspection_step_records (inspection_id, updated_at)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS project_inspection_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inspection_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  template_item_id BIGINT UNSIGNED DEFAULT NULL,
  item_key VARCHAR(160) NOT NULL,
  title VARCHAR(160) NOT NULL,
  standard_text TEXT DEFAULT NULL,
  check_method TEXT DEFAULT NULL,
  failure_action TEXT DEFAULT NULL,
  risk_level VARCHAR(16) NOT NULL DEFAULT 'normal',
  require_photo TINYINT(1) NOT NULL DEFAULT 0,
  result VARCHAR(24) NOT NULL DEFAULT 'pending',
  description VARCHAR(500) DEFAULT NULL,
  responsible_user_id BIGINT UNSIGNED DEFAULT NULL,
  checked_by BIGINT UNSIGNED DEFAULT NULL,
  checked_at TIMESTAMP NULL DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  source_step_record_id BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_inspection_item_key (inspection_id, item_key),
  KEY idx_inspection_items_parent (inspection_id, sort_order, id),
  KEY idx_inspection_items_project (project_id, result, updated_at),
  KEY idx_inspection_items_responsible (responsible_user_id, result, updated_at),
  KEY idx_inspection_items_source_step (source_step_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_inspection_item_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inspection_item_id BIGINT UNSIGNED NOT NULL,
  source_step_image_id BIGINT UNSIGNED DEFAULT NULL,
  image_url VARCHAR(500) NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inspection_item_images (inspection_item_id, id),
  UNIQUE KEY uk_inspection_item_source_image (source_step_image_id),
  KEY idx_inspection_item_image_uploader (uploaded_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_item_images'
     AND COLUMN_NAME = 'source_step_image_id') = 0,
  'ALTER TABLE project_inspection_item_images ADD COLUMN source_step_image_id BIGINT UNSIGNED DEFAULT NULL AFTER inspection_item_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_inspection_item_images'
     AND INDEX_NAME = 'uk_inspection_item_source_image') = 0,
  'CREATE UNIQUE INDEX uk_inspection_item_source_image ON project_inspection_item_images (source_step_image_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
