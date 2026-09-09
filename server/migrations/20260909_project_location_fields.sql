SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE renovation_projects ADD COLUMN project_city VARCHAR(80) DEFAULT NULL AFTER client_name',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'renovation_projects'
    AND COLUMN_NAME = 'project_city'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE renovation_projects ADD COLUMN project_address VARCHAR(255) DEFAULT NULL AFTER project_city',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'renovation_projects'
    AND COLUMN_NAME = 'project_address'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
