-- Rename merchant publishing rights to Verified Merchant status.
-- Keep legacy permission_* columns for compatibility, but move runtime logic
-- to verified_* columns.

SET @verified_merchant_status_existed = (
  SELECT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'verified_status'
  )
);

SET @ddl = (
  SELECT IF(
    @verified_merchant_status_existed,
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN verified_status ENUM(''pending'', ''approved'', ''rejected'', ''suspended'') NOT NULL DEFAULT ''pending'' AFTER role'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'verified_at'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN verified_at DATETIME DEFAULT NULL AFTER verified_status'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'verified_until'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD COLUMN verified_until DATETIME DEFAULT NULL AFTER verified_at'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE user_roles
SET verified_status = permission_status,
    verified_at = approved_at,
    verified_until = paid_until
WHERE role = 'merchant'
  AND @verified_merchant_status_existed = 0
  AND EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND COLUMN_NAME = 'permission_status'
  )
  AND permission_status IS NOT NULL;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_roles' AND INDEX_NAME = 'idx_user_roles_verified_merchant'
    ),
    'SELECT 1',
    'ALTER TABLE user_roles ADD INDEX idx_user_roles_verified_merchant (role, verified_status, verified_until, user_id)'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
