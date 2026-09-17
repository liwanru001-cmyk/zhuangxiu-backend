CREATE TABLE IF NOT EXISTS product_ingestion_site_cognition_workflows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  job_id BIGINT UNSIGNED NOT NULL,
  state VARCHAR(48) NOT NULL,
  state_version INT UNSIGNED NOT NULL DEFAULT 1,
  evidence_revision INT UNSIGNED NOT NULL DEFAULT 0,
  rule_id BIGINT UNSIGNED NULL,
  attempt_counters JSON NOT NULL,
  next_allowed_events JSON NOT NULL,
  last_event VARCHAR(80) NULL,
  last_error_code VARCHAR(80) NULL,
  last_error VARCHAR(1000) NULL,
  resume_payload JSON NULL,
  business_summary VARCHAR(1000) NULL,
  started_by VARCHAR(80) NOT NULL,
  lease_expires_at DATETIME NULL,
  entered_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cognition_job (job_id,id),
  KEY idx_cognition_source_state (source_id,state,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_site_cognition_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workflow_id BIGINT UNSIGNED NOT NULL,
  from_state VARCHAR(48) NULL,
  to_state VARCHAR(48) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  outcome VARCHAR(40) NOT NULL,
  payload JSON NULL,
  actor VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cognition_event_workflow (workflow_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_site_cognition_evidence (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workflow_id BIGINT UNSIGNED NOT NULL,
  revision INT UNSIGNED NOT NULL,
  evidence_level VARCHAR(8) NOT NULL,
  evidence_type VARCHAR(60) NOT NULL,
  evidence_key VARCHAR(160) NOT NULL,
  source_url VARCHAR(1000) NULL,
  content JSON NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cognition_evidence (workflow_id,evidence_key,content_hash),
  KEY idx_cognition_evidence_revision (workflow_id,revision,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_site_cognition_ai_calls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workflow_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(48) NOT NULL,
  model VARCHAR(120) NOT NULL,
  prompt_version VARCHAR(80) NOT NULL,
  evidence_revision INT UNSIGNED NOT NULL,
  request_hash CHAR(64) NOT NULL,
  input_manifest JSON NOT NULL,
  raw_output JSON NULL,
  parsed_output JSON NULL,
  validation_errors JSON NULL,
  input_tokens INT UNSIGNED NULL,
  output_tokens INT UNSIGNED NULL,
  total_tokens INT UNSIGNED NULL,
  elapsed_ms INT UNSIGNED NULL,
  status VARCHAR(24) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cognition_ai_workflow (workflow_id,id),
  KEY idx_cognition_ai_request (request_hash,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_site_rule_feedback (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workflow_id BIGINT UNSIGNED NOT NULL,
  rule_id BIGINT UNSIGNED NULL,
  decision ENUM('confirm','business_error','cannot_judge','anchor') NOT NULL,
  error_types JSON NULL,
  note VARCHAR(1000) NULL,
  page_url VARCHAR(1000) NULL,
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_site_rule_feedback (workflow_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_site_rule_test_cases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workflow_id BIGINT UNSIGNED NOT NULL,
  rule_id BIGINT UNSIGNED NOT NULL,
  test_kind ENUM('positive','negative','blind','extraction') NOT NULL,
  page_url VARCHAR(1000) NOT NULL,
  expected_role VARCHAR(40) NULL,
  actual_role VARCHAR(40) NULL,
  passed TINYINT(1) NOT NULL,
  result JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_site_rule_test_workflow (workflow_id,rule_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
