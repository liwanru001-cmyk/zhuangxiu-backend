SET @add_soft_type = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='personal_products' AND COLUMN_NAME='product_type')=0,
 'ALTER TABLE personal_products ADD COLUMN product_type VARCHAR(30) DEFAULT NULL AFTER product_group', 'SELECT 1');
PREPARE stmt FROM @add_soft_type;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
