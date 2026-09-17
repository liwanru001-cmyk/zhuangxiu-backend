CREATE TABLE IF NOT EXISTS product_ingestion_recovery_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id BIGINT UNSIGNED NULL,
  candidate_id BIGINT UNSIGNED NULL,
  evidence_pack_id VARCHAR(80) NOT NULL,
  strategy_id VARCHAR(100) NULL,
  schema_version VARCHAR(50) NOT NULL,
  status VARCHAR(40) NOT NULL,
  evidence_pack JSON NOT NULL,
  ai_strategy JSON NULL,
  safety_plan JSON NULL,
  execution_result JSON NULL,
  validation_result JSON NULL,
  outcome_class VARCHAR(80) NULL,
  risk_level VARCHAR(20) NOT NULL DEFAULT 'low',
  review_decision VARCHAR(20) NULL,
  review_note VARCHAR(500) NULL,
  reviewed_by VARCHAR(80) NULL,
  reviewed_at DATETIME NULL,
  failure_code VARCHAR(80) NULL,
  last_error VARCHAR(1000) NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_recovery_evidence_pack (evidence_pack_id),
  KEY idx_recovery_job_status (job_id, status),
  KEY idx_recovery_candidate (candidate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @add_ingestion_recovery_mode = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_sources' AND COLUMN_NAME='recovery_mode')=0,
  'ALTER TABLE product_ingestion_sources ADD COLUMN recovery_mode VARCHAR(20) NOT NULL DEFAULT ''off'' AFTER manual_review_required',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_recovery_mode; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_risk_level = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='risk_level')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN risk_level VARCHAR(20) NOT NULL DEFAULT ''low'' AFTER outcome_class',
  'SELECT 1'
);
PREPARE stmt FROM @add_recovery_risk_level; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_review_decision = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='review_decision')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN review_decision VARCHAR(20) NULL AFTER risk_level',
  'SELECT 1'
);
PREPARE stmt FROM @add_recovery_review_decision; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_review_note = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='review_note')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN review_note VARCHAR(500) NULL AFTER review_decision',
  'SELECT 1'
);
PREPARE stmt FROM @add_recovery_review_note; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_reviewed_by = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='reviewed_by')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN reviewed_by VARCHAR(80) NULL AFTER review_note',
  'SELECT 1'
);
PREPARE stmt FROM @add_recovery_reviewed_by; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_reviewed_at = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='reviewed_at')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN reviewed_at DATETIME NULL AFTER reviewed_by',
  'SELECT 1'
);
PREPARE stmt FROM @add_recovery_reviewed_at; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS product_ingestion_recovery_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  attempt_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  action_id VARCHAR(80) NULL,
  event_payload JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_recovery_event_attempt (attempt_id, id),
  CONSTRAINT fk_recovery_event_attempt FOREIGN KEY (attempt_id)
    REFERENCES product_ingestion_recovery_attempts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
