CREATE TABLE IF NOT EXISTS personal_products (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 user_id BIGINT UNSIGNED NOT NULL,
 name VARCHAR(120) NOT NULL,
 cover_url VARCHAR(1000) NOT NULL DEFAULT '',
 brand VARCHAR(120) NOT NULL DEFAULT '',
 spec VARCHAR(500) NOT NULL DEFAULT '',
 price_text VARCHAR(80) NOT NULL DEFAULT '',
 source_url VARCHAR(1000) NOT NULL DEFAULT '',
 description VARCHAR(2000) NOT NULL DEFAULT '',
 deleted_at DATETIME DEFAULT NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY idx_personal_owner (user_id, deleted_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
SET @add_personal_product = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products' AND COLUMN_NAME='personal_product_id')=0,
 'ALTER TABLE project_scheme_products ADD COLUMN personal_product_id BIGINT UNSIGNED DEFAULT NULL, ADD KEY idx_selection_personal (personal_product_id)', 'SELECT 1');
PREPARE stmt FROM @add_personal_product;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
ALTER TABLE project_scheme_products MODIFY merchant_product_id BIGINT UNSIGNED DEFAULT NULL;
