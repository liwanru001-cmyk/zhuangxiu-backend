SET @has_case_link_title := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'merchant_products'
    AND COLUMN_NAME = 'case_link_title'
);
SET @ddl := IF(
  @has_case_link_title = 0,
  'ALTER TABLE merchant_products ADD COLUMN case_link_title VARCHAR(80) NULL AFTER content_delta',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_case_link_url := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'merchant_products'
    AND COLUMN_NAME = 'case_link_url'
);
SET @ddl := IF(
  @has_case_link_url = 0,
  'ALTER TABLE merchant_products ADD COLUMN case_link_url VARCHAR(500) NULL AFTER case_link_title',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
