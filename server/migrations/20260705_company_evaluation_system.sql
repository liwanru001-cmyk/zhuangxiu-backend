CREATE TABLE IF NOT EXISTS company_evaluation_feedback (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED DEFAULT NULL,
  consultation_id BIGINT UNSIGNED DEFAULT NULL,
  reviewer_user_id BIGINT UNSIGNED NOT NULL,
  dimension ENUM('communication', 'materials', 'progress', 'problem_handling') NOT NULL,
  score TINYINT UNSIGNED NOT NULL,
  comment_private VARCHAR(300) DEFAULT NULL,
  source_scene VARCHAR(32) NOT NULL DEFAULT 'project',
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_company_project_user_dimension (company_id, project_id, reviewer_user_id, dimension),
  UNIQUE KEY uk_company_consultation_user_dimension (company_id, consultation_id, reviewer_user_id, dimension),
  KEY idx_company_dimension_status (company_id, dimension, status, created_at),
  KEY idx_project_dimension (project_id, dimension),
  KEY idx_consultation_dimension (consultation_id, dimension),
  CONSTRAINT fk_company_evaluation_feedback_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_company_evaluation_feedback_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_company_evaluation_feedback_reviewer
    FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS company_evaluation_metric_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED DEFAULT NULL,
  dimension ENUM('communication', 'materials', 'progress', 'problem_handling') NOT NULL,
  system_score DECIMAL(3,2) DEFAULT NULL,
  metrics JSON DEFAULT NULL,
  calculated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_company_dimension_calculated (company_id, dimension, calculated_at),
  KEY idx_project_dimension_calculated (project_id, dimension, calculated_at),
  CONSTRAINT fk_company_evaluation_snapshot_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_company_evaluation_snapshot_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
