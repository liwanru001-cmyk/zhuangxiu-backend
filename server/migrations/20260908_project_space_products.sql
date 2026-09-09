CREATE TABLE IF NOT EXISTS project_design_schemes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  version_no INT NOT NULL DEFAULT 1,
  title VARCHAR(100) NOT NULL DEFAULT '当前方案',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_project_scheme_version (project_id, version_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS project_scheme_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  scheme_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  space_id BIGINT UNSIGNED NOT NULL,
  merchant_product_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL DEFAULT 1,
  unit VARCHAR(20) NOT NULL DEFAULT '件',
  selected_spec VARCHAR(500) NOT NULL DEFAULT '',
  customer_unit_price DECIMAL(12,2) DEFAULT NULL,
  note VARCHAR(1000) NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_scheme_space (scheme_id, space_id, sort_order),
  KEY idx_selection_project (project_id, space_id),
  CONSTRAINT fk_selection_space FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE RESTRICT,
  CONSTRAINT fk_selection_scheme FOREIGN KEY (scheme_id) REFERENCES project_design_schemes(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
