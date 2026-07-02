-- Track explicit Verified Merchant applications from the merchant profile page.

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'verified_applied_at'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN verified_applied_at DATETIME DEFAULT NULL AFTER verified_until'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND INDEX_NAME = 'idx_user_roles_verified_application'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD INDEX idx_user_roles_verified_application (role, verified_applied_at, verified_status, user_id)'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
