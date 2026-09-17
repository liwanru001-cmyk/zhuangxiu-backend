SET @addIngestionJobMode = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='job_mode') = 0,
  "ALTER TABLE product_ingestion_jobs ADD COLUMN job_mode VARCHAR(24) NOT NULL DEFAULT 'detail_capture' AFTER status",
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionJobMode;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SET @addIngestionDiscoveredUrls = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='discovered_urls') = 0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN discovered_urls JSON DEFAULT NULL AFTER seed_urls',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionDiscoveredUrls;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionDiscoverySummary = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='discovery_summary') = 0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN discovery_summary JSON DEFAULT NULL AFTER discovered_urls',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionDiscoverySummary;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionDiscoveryApprovedBy = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='discovery_approved_by') = 0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN discovery_approved_by VARCHAR(80) DEFAULT NULL AFTER discovery_summary',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionDiscoveryApprovedBy;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionDiscoveryApprovedAt = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_jobs' AND COLUMN_NAME='discovery_approved_at') = 0,
  'ALTER TABLE product_ingestion_jobs ADD COLUMN discovery_approved_at DATETIME DEFAULT NULL AFTER discovery_approved_by',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionDiscoveryApprovedAt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
