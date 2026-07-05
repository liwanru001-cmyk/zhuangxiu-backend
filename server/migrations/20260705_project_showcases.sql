CREATE TABLE IF NOT EXISTS project_showcases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(120) NOT NULL DEFAULT '',
  description TEXT DEFAULT NULL,
  cover_image VARCHAR(500) DEFAULT NULL,
  visibility ENUM('private', 'participants', 'public') NOT NULL DEFAULT 'private',
  status ENUM('draft', 'published', 'hidden') NOT NULL DEFAULT 'draft',
  visible_fields JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_project_showcase_project (project_id),
  KEY idx_project_showcase_owner (owner_user_id),
  KEY idx_project_showcase_status_visibility (status, visibility),
  CONSTRAINT fk_project_showcase_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_showcase_owner
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_showcase_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  showcase_id BIGINT UNSIGNED NOT NULL,
  source_type ENUM('floor_plan', 'project_space_image', 'manual') NOT NULL DEFAULT 'manual',
  source_id BIGINT UNSIGNED DEFAULT NULL,
  image_url VARCHAR(500) NOT NULL,
  caption VARCHAR(120) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_cover TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_project_showcase_images_showcase (showcase_id, sort_order, id),
  CONSTRAINT fk_project_showcase_images_showcase
    FOREIGN KEY (showcase_id) REFERENCES project_showcases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
