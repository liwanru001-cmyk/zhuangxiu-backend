-- Designer profile, first version.
-- Run against the app database before restarting the deployed backend.

CREATE TABLE IF NOT EXISTS designer_profiles (
  user_id BIGINT UNSIGNED NOT NULL,
  service_city VARCHAR(80) DEFAULT NULL,
  styles JSON DEFAULT NULL,
  experience_years INT UNSIGNED NOT NULL DEFAULT 0,
  case_count INT UNSIGNED NOT NULL DEFAULT 0,
  design_philosophy TEXT DEFAULT NULL,
  verified_status TINYINT(1) NOT NULL DEFAULT 0,
  consultation_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
