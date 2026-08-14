SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_material_items'
     AND COLUMN_NAME = 'merchant_product_id') = 0,
  'ALTER TABLE project_material_items ADD COLUMN merchant_product_id BIGINT UNSIGNED DEFAULT NULL AFTER arrival_date',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_material_items'
     AND INDEX_NAME = 'idx_material_product') = 0,
  'ALTER TABLE project_material_items ADD KEY idx_material_product (merchant_product_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
