CREATE TABLE IF NOT EXISTS product_ingestion_worker_alerts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  alert_key VARCHAR(190) NOT NULL,
  alert_type VARCHAR(80) NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'warning',
  instance_id VARCHAR(120) DEFAULT NULL,
  job_id BIGINT UNSIGNED DEFAULT NULL,
  message VARCHAR(1000) NOT NULL,
  details JSON DEFAULT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  first_seen_at DATETIME NOT NULL,
  last_seen_at DATETIME NOT NULL,
  resolved_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ingestion_worker_alert_key (alert_key),
  KEY idx_ingestion_worker_alert_status (status,last_seen_at),
  KEY idx_ingestion_worker_alert_job (job_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
