SET @has_content_delta := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'merchant_cases'
    AND COLUMN_NAME = 'content_delta'
);

SET @ddl := IF(
  @has_content_delta = 0,
  'ALTER TABLE merchant_cases ADD COLUMN content_delta JSON DEFAULT NULL AFTER description',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
