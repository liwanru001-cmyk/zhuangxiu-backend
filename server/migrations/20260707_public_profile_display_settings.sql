-- Public profile display roles are user-controlled and independent from current app role.

CREATE TABLE IF NOT EXISTS user_public_profile_settings (
  user_id BIGINT UNSIGNED NOT NULL,
  primary_display_role VARCHAR(32) DEFAULT NULL,
  display_roles JSON DEFAULT NULL,
  role_sort JSON DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
