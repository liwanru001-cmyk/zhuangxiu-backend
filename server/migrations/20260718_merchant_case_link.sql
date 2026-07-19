SET @has_link_title := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'merchant_cases'
    AND COLUMN_NAME = 'link_title'
);
SET @ddl := IF(
  @has_link_title = 0,
  'ALTER TABLE merchant_cases ADD COLUMN link_title VARCHAR(80) DEFAULT NULL AFTER budget_range',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_link_url := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'merchant_cases'
    AND COLUMN_NAME = 'link_url'
);
SET @ddl := IF(
  @has_link_url = 0,
  'ALTER TABLE merchant_cases ADD COLUMN link_url VARCHAR(1000) DEFAULT NULL AFTER link_title',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
