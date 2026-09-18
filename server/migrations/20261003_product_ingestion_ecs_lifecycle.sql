CREATE TABLE IF NOT EXISTS product_ingestion_worker_lifecycle (
  instance_id VARCHAR(120) NOT NULL,
  region_id VARCHAR(80) NOT NULL,
  desired_state VARCHAR(16) NOT NULL DEFAULT 'running',
  observed_state VARCHAR(32) DEFAULT NULL,
  idle_since DATETIME DEFAULT NULL,
  last_action VARCHAR(32) DEFAULT NULL,
  action_started_at DATETIME DEFAULT NULL,
  last_error VARCHAR(1000) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (instance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
