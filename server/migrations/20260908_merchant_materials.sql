-- Additive migration: apply and verify before switching the backend.
CREATE TABLE IF NOT EXISTS merchant_materials (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 merchant_user_id INT NOT NULL,
 brand VARCHAR(120) NOT NULL,
 kind VARCHAR(30) NOT NULL,
 series VARCHAR(120) NOT NULL,
 name VARCHAR(120) NOT NULL,
 code VARCHAR(80) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'active',
 description VARCHAR(1000) NOT NULL DEFAULT '',
 image_urls JSON NOT NULL,
 revision INT UNSIGNED NOT NULL DEFAULT 1,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_material_owner_brand_code (merchant_user_id, brand, code),
 KEY idx_material_owner_status (merchant_user_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
