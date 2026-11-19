SET @ddl = IF(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='merchant_cases' AND column_name='admin_hidden'), 'SELECT 1', 'ALTER TABLE merchant_cases ADD COLUMN admin_hidden TINYINT(1) NOT NULL DEFAULT 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='merchant_cases' AND column_name='admin_hidden_reason'), 'SELECT 1', 'ALTER TABLE merchant_cases ADD COLUMN admin_hidden_reason VARCHAR(500) DEFAULT NULL');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS merchant_case_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  case_id BIGINT UNSIGNED NOT NULL,
  reporter_user_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_case_reporter (case_id, reporter_user_id),
  KEY idx_case_reports (case_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS phone_location_cache (
  phone_hash CHAR(64) NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'aliyun_market',
  status ENUM('pending', 'success', 'not_found', 'failed') NOT NULL DEFAULT 'pending',
  province VARCHAR(64) DEFAULT NULL,
  city VARCHAR(64) DEFAULT NULL,
  carrier VARCHAR(64) DEFAULT NULL,
  number_segment CHAR(7) DEFAULT NULL,
  queried_at DATETIME DEFAULT NULL,
  next_retry_at DATETIME DEFAULT NULL,
  error_code VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_hash),
  KEY idx_phone_location_status_retry (status, next_retry_at),
  KEY idx_phone_location_region (province, city)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


SET @addExtractedSnapshotUrl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates' AND COLUMN_NAME='extracted_snapshot_url')=0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN extracted_snapshot_url VARCHAR(1000) DEFAULT NULL AFTER raw_snapshot_url',
  'SELECT 1'
);
PREPARE stmt FROM @addExtractedSnapshotUrl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @addRawHtmlBytes = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates' AND COLUMN_NAME='raw_html_bytes')=0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN raw_html_bytes INT UNSIGNED NOT NULL DEFAULT 0 AFTER raw_content_type',
  'SELECT 1'
);
PREPARE stmt FROM @addRawHtmlBytes; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @addExtractedPayloadBytes = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates' AND COLUMN_NAME='extracted_payload_bytes')=0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN extracted_payload_bytes INT UNSIGNED NOT NULL DEFAULT 0 AFTER extracted_snapshot_url',
  'SELECT 1'
);
PREPARE stmt FROM @addExtractedPayloadBytes; EXECUTE stmt; DEALLOCATE PREPARE stmt;

