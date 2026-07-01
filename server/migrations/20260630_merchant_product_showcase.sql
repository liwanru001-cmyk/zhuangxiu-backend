CREATE TABLE IF NOT EXISTS merchant_product_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_user_id BIGINT UNSIGNED NOT NULL,
  parent_id BIGINT UNSIGNED DEFAULT NULL,
  name VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_merchant_parent_sort (merchant_user_id, parent_id, sort_order, id),
  KEY idx_parent (parent_id),
  KEY idx_status (merchant_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merchant_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_user_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED DEFAULT NULL,
  name VARCHAR(120) NOT NULL,
  cover_url VARCHAR(500) DEFAULT NULL,
  image_urls JSON DEFAULT NULL,
  summary VARCHAR(300) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  brand VARCHAR(120) DEFAULT NULL,
  spec VARCHAR(200) DEFAULT NULL,
  price_text VARCHAR(80) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_merchant_status_sort (merchant_user_id, status, sort_order, id),
  KEY idx_category (category_id),
  KEY idx_merchant_category (merchant_user_id, category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
