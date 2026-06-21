-- Designer consultations, internal app first version.
-- No phone, WeChat, or external contact fields are collected.

CREATE TABLE IF NOT EXISTS designer_consultations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  designer_id BIGINT UNSIGNED NOT NULL,
  target_role ENUM('designer', 'project_manager', 'project_supervisor', 'merchant') NOT NULL DEFAULT 'designer',
  user_id BIGINT UNSIGNED NOT NULL,
  content TEXT NOT NULL,
  project_city VARCHAR(80) DEFAULT NULL,
  renovation_stage VARCHAR(80) DEFAULT NULL,
  has_project TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_designer_status (designer_id, status, created_at),
  KEY idx_consultation_target_role (designer_id, target_role, status, created_at),
  KEY idx_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
