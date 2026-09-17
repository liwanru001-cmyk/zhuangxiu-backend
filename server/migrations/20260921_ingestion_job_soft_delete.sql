SET @add_ingestion_job_deleted_at = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='deleted_at')=0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN deleted_at DATETIME DEFAULT NULL AFTER finished_at, ADD COLUMN deleted_by VARCHAR(80) DEFAULT NULL AFTER deleted_at, ADD COLUMN delete_reason VARCHAR(500) DEFAULT NULL AFTER deleted_by, ADD KEY idx_ingestion_job_deleted (deleted_at,id)',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_job_deleted_at; EXECUTE stmt; DEALLOCATE PREPARE stmt;
