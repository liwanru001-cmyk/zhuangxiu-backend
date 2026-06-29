-- Phase 1-2: platform business catalog and company marketplace.
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS business_catalog (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id BIGINT UNSIGNED DEFAULT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL,
  level TINYINT UNSIGNED NOT NULL DEFAULT 1,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_business_catalog_code (code),
  KEY idx_business_catalog_parent (parent_id, status, sort_order),
  KEY idx_business_catalog_status_level (status, level, sort_order),
  CONSTRAINT fk_business_catalog_parent
    FOREIGN KEY (parent_id) REFERENCES business_catalog(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_user_id BIGINT UNSIGNED DEFAULT NULL,
  name VARCHAR(120) NOT NULL,
  logo_url VARCHAR(500) DEFAULT '',
  intro TEXT DEFAULT NULL,
  service_area VARCHAR(120) DEFAULT NULL,
  city VARCHAR(50) DEFAULT '',
  address VARCHAR(255) DEFAULT '',
  contact_phone VARCHAR(30) DEFAULT '',
  status ENUM('draft', 'active', 'suspended', 'deleted') NOT NULL DEFAULT 'active',
  source ENUM('manual', 'migrated_merchant', 'admin_created') NOT NULL DEFAULT 'manual',
  legacy_merchant_user_id BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_company_status_city (status, city),
  KEY idx_company_owner (owner_user_id),
  KEY idx_company_legacy_merchant (legacy_merchant_user_id),
  FULLTEXT KEY ft_company_search (name, intro),
  CONSTRAINT fk_company_owner
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_company_legacy_merchant
    FOREIGN KEY (legacy_merchant_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS company_businesses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  business_catalog_id BIGINT UNSIGNED NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_company_business_catalog (company_id, business_catalog_id),
  KEY idx_company_business_company (company_id, status),
  KEY idx_company_business_catalog (business_catalog_id, status),
  CONSTRAINT fk_company_business_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_company_business_catalog
    FOREIGN KEY (business_catalog_id) REFERENCES business_catalog(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO business_catalog (parent_id, code, name, level, sort_order, status)
VALUES
  (NULL, 'renovation_market', '装修市场', 1, 10, 'active')
ON DUPLICATE KEY UPDATE
  parent_id = VALUES(parent_id),
  name = VALUES(name),
  level = VALUES(level),
  sort_order = VALUES(sort_order),
  status = VALUES(status);

INSERT INTO business_catalog (parent_id, code, name, level, sort_order, status)
SELECT root.id, item.code, item.name, 2, item.sort_order, 'active'
FROM business_catalog root
JOIN (
  SELECT 'find_renovation' AS code, '找装修' AS name, 10 AS sort_order
  UNION ALL SELECT 'choose_materials', '选建材', 20
  UNION ALL SELECT 'choose_home', '选家居', 30
) item
WHERE root.code = 'renovation_market'
ON DUPLICATE KEY UPDATE
  parent_id = VALUES(parent_id),
  name = VALUES(name),
  level = VALUES(level),
  sort_order = VALUES(sort_order),
  status = VALUES(status);

INSERT INTO business_catalog (parent_id, code, name, level, sort_order, status)
SELECT parent.id, item.code, item.name, 3, item.sort_order, 'active'
FROM business_catalog parent
JOIN (
  SELECT 'find_renovation' AS parent_code, 'whole_renovation' AS code, '整装公司' AS name, 10 AS sort_order
  UNION ALL SELECT 'find_renovation', 'design_studio', '设计工作室', 20
  UNION ALL SELECT 'find_renovation', 'supervision_service', '监理服务', 30
  UNION ALL SELECT 'choose_materials', 'tile_floor', '瓷砖地板', 10
  UNION ALL SELECT 'choose_materials', 'paint_wall', '涂料墙面', 20
  UNION ALL SELECT 'choose_materials', 'ceiling_door_window', '吊顶门窗', 30
  UNION ALL SELECT 'choose_materials', 'water_electric_waterproof', '水电防水', 40
  UNION ALL SELECT 'choose_materials', 'whole_house_custom', '全屋定制', 50
  UNION ALL SELECT 'choose_materials', 'lighting', '灯具照明', 60
  UNION ALL SELECT 'choose_materials', 'smart_home', '智能家居', 70
  UNION ALL SELECT 'choose_home', 'furniture', '家具', 10
  UNION ALL SELECT 'choose_home', 'soft_decoration', '软装', 20
  UNION ALL SELECT 'choose_home', 'appliance', '电器', 30
) item ON item.parent_code = parent.code
ON DUPLICATE KEY UPDATE
  parent_id = VALUES(parent_id),
  name = VALUES(name),
  level = VALUES(level),
  sort_order = VALUES(sort_order),
  status = VALUES(status);
