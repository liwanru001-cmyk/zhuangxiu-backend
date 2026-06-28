SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'renovation_projects'
        AND COLUMN_NAME = 'lifecycle_status'
    ),
    'SELECT 1',
    'ALTER TABLE renovation_projects ADD COLUMN lifecycle_status VARCHAR(16) NOT NULL DEFAULT ''active'' AFTER status'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'renovation_projects'
        AND COLUMN_NAME = 'archived_at'
    ),
    'SELECT 1',
    'ALTER TABLE renovation_projects ADD COLUMN archived_at TIMESTAMP NULL DEFAULT NULL AFTER lifecycle_status'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'renovation_projects'
        AND COLUMN_NAME = 'archived_by'
    ),
    'SELECT 1',
    'ALTER TABLE renovation_projects ADD COLUMN archived_by BIGINT UNSIGNED DEFAULT NULL AFTER archived_at'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'renovation_projects'
        AND COLUMN_NAME = 'deleted_at'
    ),
    'SELECT 1',
    'ALTER TABLE renovation_projects ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER archived_by'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'renovation_projects'
        AND COLUMN_NAME = 'deleted_by'
    ),
    'SELECT 1',
    'ALTER TABLE renovation_projects ADD COLUMN deleted_by BIGINT UNSIGNED DEFAULT NULL AFTER deleted_at'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'renovation_projects'
        AND INDEX_NAME = 'idx_renovation_projects_lifecycle'
    ),
    'SELECT 1',
    'CREATE INDEX idx_renovation_projects_lifecycle ON renovation_projects (lifecycle_status, user_id, updated_at)'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
