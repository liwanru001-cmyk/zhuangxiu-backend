CREATE TABLE IF NOT EXISTS company_reviews (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT NOT NULL,
  project_id BIGINT DEFAULT NULL,
  reviewer_user_id BIGINT DEFAULT NULL,
  rating TINYINT UNSIGNED NOT NULL DEFAULT 5,
  content TEXT,
  status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_company_status (company_id, status, created_at),
  KEY idx_project (project_id),
  KEY idx_reviewer (reviewer_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
