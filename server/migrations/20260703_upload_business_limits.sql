SET @avatar_changed_at_exists = (
  SELECT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'avatar_changed_at'
  )
);

SET @ddl = (
  SELECT IF(
    @avatar_changed_at_exists,
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN avatar_changed_at DATETIME DEFAULT NULL AFTER avatar'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
