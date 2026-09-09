SET @add_selection_details = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'project_scheme_products'
     AND COLUMN_NAME = 'selection_details') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN selection_details JSON DEFAULT NULL AFTER selected_spec',
  'SELECT 1'
);
PREPARE stmt FROM @add_selection_details;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
