CREATE TABLE IF NOT EXISTS company_evaluation_daily_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  dimension ENUM('communication', 'materials', 'progress', 'problem_handling') NOT NULL,
  snapshot_date DATE NOT NULL,
  composite_score DECIMAL(3,2) DEFAULT NULL,
  system_score DECIMAL(3,2) DEFAULT NULL,
  user_score DECIMAL(3,2) DEFAULT NULL,
  feedback_count INT UNSIGNED NOT NULL DEFAULT 0,
  metrics JSON DEFAULT NULL,
  calculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_company_dimension_date (company_id, dimension, snapshot_date),
  KEY idx_company_snapshot_date (company_id, snapshot_date),
  CONSTRAINT fk_company_daily_evaluation_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  job_name VARCHAR(100) NOT NULL,
  last_run_date DATE DEFAULT NULL,
  last_started_at DATETIME DEFAULT NULL,
  last_completed_at DATETIME DEFAULT NULL,
  status ENUM('idle', 'running', 'success', 'failed') NOT NULL DEFAULT 'idle',
  last_error VARCHAR(1000) DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (job_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
