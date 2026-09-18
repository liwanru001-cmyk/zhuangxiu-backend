CREATE TABLE IF NOT EXISTS product_ingestion_workers (
  worker_id VARCHAR(120) NOT NULL,
  instance_id VARCHAR(120) DEFAULT NULL,
  hostname VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL,
  process_id INT UNSIGNED DEFAULT NULL,
  version_sha CHAR(40) DEFAULT NULL,
  capabilities JSON DEFAULT NULL,
  started_at DATETIME NOT NULL,
  heartbeat_at DATETIME NOT NULL,
  stopped_at DATETIME DEFAULT NULL,
  last_error VARCHAR(1000) DEFAULT NULL,
  PRIMARY KEY (worker_id),
  KEY idx_ingestion_worker_heartbeat (status,heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_worker_commands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  command_type VARCHAR(80) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  worker_id VARCHAR(120) DEFAULT NULL,
  lease_expires_at DATETIME DEFAULT NULL,
  result JSON DEFAULT NULL,
  failure_code VARCHAR(80) DEFAULT NULL,
  last_error VARCHAR(1000) DEFAULT NULL,
  requested_by VARCHAR(80) NOT NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME DEFAULT NULL,
  finished_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_ingestion_command_claim (status,available_at,id),
  KEY idx_ingestion_command_lease (status,lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @addCandidateManualRevision = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='manual_revision') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN manual_revision INT UNSIGNED NOT NULL DEFAULT 0 AFTER review_status',
  'SELECT 1'
);
PREPARE stmt FROM @addCandidateManualRevision;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addDiscoveryCheckpoint = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs'
     AND COLUMN_NAME='discovery_checkpoint') = 0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN discovery_checkpoint JSON DEFAULT NULL AFTER discovered_urls',
  'SELECT 1'
);
PREPARE stmt FROM @addDiscoveryCheckpoint;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
