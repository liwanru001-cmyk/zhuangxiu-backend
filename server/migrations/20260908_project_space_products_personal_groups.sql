SET @add_product_group = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='personal_products' AND COLUMN_NAME='product_group')=0,
 'ALTER TABLE personal_products ADD COLUMN product_group VARCHAR(30) DEFAULT NULL AFTER name', 'SELECT 1');
PREPARE stmt FROM @add_product_group;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
