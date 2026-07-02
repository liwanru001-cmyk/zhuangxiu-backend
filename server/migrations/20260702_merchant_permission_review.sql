-- Separate merchant identity from approved merchant permission.

SET @merchant_permission_status_existed = (
  SELECT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'permission_status'
  )
);

SET @ddl = (
  SELECT IF(
    @merchant_permission_status_existed,
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN permission_status ENUM(''pending'', ''approved'', ''rejected'', ''suspended'') NOT NULL DEFAULT ''pending'' AFTER is_default'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'approved_at'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN approved_at DATETIME DEFAULT NULL AFTER permission_status'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'paid_until'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN paid_until DATETIME DEFAULT NULL AFTER approved_at'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'review_note'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN review_note VARCHAR(255) DEFAULT NULL AFTER paid_until'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND INDEX_NAME = 'idx_user_roles_permission'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD INDEX idx_user_roles_permission (role, permission_status, paid_until, user_id)'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE user_roles
SET permission_status = 'approved',
    approved_at = COALESCE(approved_at, NOW())
WHERE role = 'merchant'
  AND permission_status = 'pending'
  AND @merchant_permission_status_existed = 0;
