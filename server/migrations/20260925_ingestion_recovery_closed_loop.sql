SET @add_recovery_parent_attempt = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='parent_attempt_id')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN parent_attempt_id BIGINT UNSIGNED NULL AFTER candidate_id, ADD KEY idx_recovery_parent (parent_attempt_id)', 'SELECT 1');
PREPARE stmt FROM @add_recovery_parent_attempt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_attempt_no = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='attempt_no')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN attempt_no TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER parent_attempt_id', 'SELECT 1');
PREPARE stmt FROM @add_recovery_attempt_no; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_readiness = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='readiness')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN readiness JSON NULL AFTER safety_plan', 'SELECT 1');
PREPARE stmt FROM @add_recovery_readiness; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_evidence_request = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='evidence_request')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN evidence_request JSON NULL AFTER readiness', 'SELECT 1');
PREPARE stmt FROM @add_recovery_evidence_request; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_evidence_result = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='evidence_acquisition_result')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN evidence_acquisition_result JSON NULL AFTER evidence_request', 'SELECT 1');
PREPARE stmt FROM @add_recovery_evidence_result; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_reintegration = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='reintegration_result')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN reintegration_result JSON NULL AFTER validation_result', 'SELECT 1');
PREPARE stmt FROM @add_recovery_reintegration; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_recovery_next_action = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_recovery_attempts' AND COLUMN_NAME='next_action')=0,
  'ALTER TABLE product_ingestion_recovery_attempts ADD COLUMN next_action VARCHAR(60) NULL AFTER status', 'SELECT 1');
PREPARE stmt FROM @add_recovery_next_action; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE product_ingestion_recovery_attempts SET status='awaiting_business_review',next_action='business_review' WHERE status='shadow_ready' AND review_decision IS NULL;
UPDATE product_ingestion_recovery_attempts SET status='ready_to_execute',next_action='execute_existing_data' WHERE status='shadow_ready' AND review_decision='reasonable';
UPDATE product_ingestion_recovery_attempts SET status='system_review',next_action='system_review' WHERE status='shadow_ready' AND review_decision='unsure';
UPDATE product_ingestion_recovery_attempts SET status='manual_review',next_action='human_takeover' WHERE status='shadow_ready' AND review_decision='unreasonable';
UPDATE product_ingestion_recovery_attempts SET status='no_improvement',next_action='revise_or_manual' WHERE status='validation_failed';
UPDATE product_ingestion_recovery_attempts SET status='execution_failed',next_action='retry_or_manual' WHERE status='failed';
UPDATE product_ingestion_recovery_attempts SET status='reintegrating',next_action='wait_for_reintegration' WHERE status='validated';
UPDATE product_ingestion_recovery_attempts SET next_action='revise_or_manual' WHERE status='plan_rejected' AND next_action IS NULL;
