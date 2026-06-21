-- Project manager profile, first version.

CREATE TABLE IF NOT EXISTS project_manager_profiles (
  user_id BIGINT UNSIGNED NOT NULL,
  service_area VARCHAR(80) DEFAULT NULL,
  project_types JSON DEFAULT NULL,
  management_skills JSON DEFAULT NULL,
  experience_years INT UNSIGNED NOT NULL DEFAULT 0,
  managed_project_count INT UNSIGNED NOT NULL DEFAULT 0,
  management_philosophy TEXT DEFAULT NULL,
  consultation_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
