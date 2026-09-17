SET @add_ingestion_parent_job = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='parent_job_id')=0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN parent_job_id BIGINT UNSIGNED DEFAULT NULL AFTER source_id, ADD KEY idx_ingestion_parent_job (parent_job_id)',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_parent_job; EXECUTE stmt; DEALLOCATE PREPARE stmt;
