SET @add_ingestion_current_stage = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='current_stage')=0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN current_stage VARCHAR(32) DEFAULT NULL AFTER last_error',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_current_stage; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_ingestion_current_url = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='current_url')=0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN current_url VARCHAR(1000) DEFAULT NULL AFTER current_stage',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_current_url; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_ingestion_checkpoint = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='checkpoint_index')=0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN checkpoint_index INT UNSIGNED NOT NULL DEFAULT 0 AFTER current_url',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_checkpoint; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_ingestion_heartbeat = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='heartbeat_at')=0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN heartbeat_at DATETIME DEFAULT NULL AFTER checkpoint_index',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_heartbeat; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_ingestion_failure_code = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='failure_code')=0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN failure_code VARCHAR(80) DEFAULT NULL AFTER heartbeat_at',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_failure_code; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE product_ingestion_jobs
SET checkpoint_index=pages_fetched
WHERE status='running' AND checkpoint_index=0 AND pages_fetched>0;
