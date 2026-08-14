SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_material_items'
     AND COLUMN_NAME = 'arrival_date') = 0,
  'ALTER TABLE project_material_items ADD COLUMN arrival_date DATE DEFAULT NULL AFTER arrival_status',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
