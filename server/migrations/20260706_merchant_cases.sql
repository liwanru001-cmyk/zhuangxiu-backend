CREATE TABLE IF NOT EXISTS merchant_cases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(160) NOT NULL,
  cover_image VARCHAR(500) DEFAULT NULL,
  images JSON DEFAULT NULL,
  description TEXT DEFAULT NULL,
  area_range VARCHAR(80) DEFAULT NULL,
  budget_range VARCHAR(80) DEFAULT NULL,
  city VARCHAR(80) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  sort_order INT NOT NULL DEFAULT 0,
  view_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_merchant_status_sort (merchant_id, status, sort_order, id),
  KEY idx_status_updated (status, updated_at),
  KEY idx_merchant_updated (merchant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merchant_case_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED DEFAULT NULL,
  product_name VARCHAR(160) NOT NULL,
  brand VARCHAR(120) DEFAULT NULL,
  model VARCHAR(120) DEFAULT NULL,
  specification VARCHAR(200) DEFAULT NULL,
  color VARCHAR(80) DEFAULT NULL,
  quantity VARCHAR(80) DEFAULT NULL,
  remark VARCHAR(300) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_case_sort (case_id, sort_order, id),
  KEY idx_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merchant_case_tags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id BIGINT UNSIGNED NOT NULL,
  tag_type VARCHAR(20) NOT NULL,
  tag_value VARCHAR(40) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_case_tag (case_id, tag_type, tag_value),
  KEY idx_tag_lookup (tag_type, tag_value, case_id),
  KEY idx_case_sort (case_id, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @has_product_id := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'merchant_case_items'
    AND COLUMN_NAME = 'product_id'
);
SET @ddl := IF(
  @has_product_id = 0,
  'ALTER TABLE merchant_case_items ADD COLUMN product_id BIGINT UNSIGNED DEFAULT NULL AFTER case_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_product_idx := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'merchant_case_items'
    AND INDEX_NAME = 'idx_product'
);
SET @ddl := IF(
  @has_product_idx = 0,
  'ALTER TABLE merchant_case_items ADD KEY idx_product (product_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
