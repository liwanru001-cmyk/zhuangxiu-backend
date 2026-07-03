SET @project_space_images_exists = (
  SELECT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_space_images'
  )
);

SET @project_space_images_created_at_exists = (
  SELECT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_space_images'
      AND COLUMN_NAME = 'created_at'
  )
);

SET @ddl = (
  SELECT IF(
    @project_space_images_exists AND NOT @project_space_images_created_at_exists,
    'ALTER TABLE project_space_images ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
    'SELECT 1'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
