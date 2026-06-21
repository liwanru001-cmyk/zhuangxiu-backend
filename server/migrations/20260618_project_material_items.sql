CREATE TABLE IF NOT EXISTS project_material_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(32) NOT NULL DEFAULT 'other',
  location VARCHAR(80) DEFAULT NULL,
  brand_model VARCHAR(160) DEFAULT NULL,
  quantity DECIMAL(10,2) DEFAULT NULL,
  unit VARCHAR(20) DEFAULT NULL,
  budget_unit_price DECIMAL(12,2) DEFAULT NULL,
  actual_unit_price DECIMAL(12,2) DEFAULT NULL,
  supplier_type VARCHAR(32) NOT NULL DEFAULT 'other',
  arrival_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  confirm_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  note TEXT DEFAULT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  confirmed_by BIGINT UNSIGNED DEFAULT NULL,
  confirmed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_material_project_category (project_id, category, created_at),
  KEY idx_material_arrival (project_id, arrival_status, updated_at),
  KEY idx_material_confirm (project_id, confirm_status, updated_at),
  KEY idx_material_creator (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_material_media (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  material_id BIGINT UNSIGNED NOT NULL,
  media_type VARCHAR(16) NOT NULL DEFAULT 'image',
  media_url VARCHAR(500) NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_material_media (material_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
