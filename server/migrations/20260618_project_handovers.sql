CREATE TABLE IF NOT EXISTS project_handovers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  stage_id TINYINT UNSIGNED DEFAULT NULL,
  title VARCHAR(120) NOT NULL,
  content TEXT NOT NULL,
  target_user_id BIGINT UNSIGNED DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_by BIGINT UNSIGNED NOT NULL,
  confirmed_by BIGINT UNSIGNED DEFAULT NULL,
  confirmed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_handover_project_stage (project_id, stage_id, created_at),
  KEY idx_handover_target (target_user_id, status, updated_at),
  KEY idx_handover_creator (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_handover_media (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  handover_id BIGINT UNSIGNED NOT NULL,
  media_type VARCHAR(16) NOT NULL DEFAULT 'image',
  media_url VARCHAR(500) NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_handover_media (handover_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
