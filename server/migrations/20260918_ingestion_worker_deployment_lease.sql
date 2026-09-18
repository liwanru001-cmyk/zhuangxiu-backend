CREATE TABLE IF NOT EXISTS product_ingestion_worker_lifecycle (
  instance_id VARCHAR(120) NOT NULL,
  region_id VARCHAR(80) NOT NULL,
  desired_state VARCHAR(16) NOT NULL DEFAULT 'running',
  observed_state VARCHAR(32) DEFAULT NULL,
  idle_since DATETIME DEFAULT NULL,
  maintenance_until DATETIME DEFAULT NULL,
  maintenance_reason VARCHAR(255) DEFAULT NULL,
  last_action VARCHAR(32) DEFAULT NULL,
  action_started_at DATETIME DEFAULT NULL,
  last_error VARCHAR(1000) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (instance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @addIngestionMaintenanceUntil = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_worker_lifecycle'
     AND COLUMN_NAME='maintenance_until') = 0,
  'ALTER TABLE product_ingestion_worker_lifecycle ADD COLUMN maintenance_until DATETIME DEFAULT NULL AFTER idle_since',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionMaintenanceUntil;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionMaintenanceReason = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_worker_lifecycle'
     AND COLUMN_NAME='maintenance_reason') = 0,
  'ALTER TABLE product_ingestion_worker_lifecycle ADD COLUMN maintenance_reason VARCHAR(255) DEFAULT NULL AFTER maintenance_until',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionMaintenanceReason;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
