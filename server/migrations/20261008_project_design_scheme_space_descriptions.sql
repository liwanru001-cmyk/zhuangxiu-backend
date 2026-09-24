CREATE TABLE IF NOT EXISTS project_design_scheme_spaces (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scheme_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  space_id BIGINT UNSIGNED NOT NULL,
  design_description TEXT NOT NULL,
  updated_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_scheme_space (scheme_id, space_id),
  KEY idx_scheme_space_project (project_id, space_id),
  CONSTRAINT fk_scheme_space_scheme FOREIGN KEY (scheme_id) REFERENCES project_design_schemes(id) ON DELETE CASCADE,
  CONSTRAINT fk_scheme_space_space FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
