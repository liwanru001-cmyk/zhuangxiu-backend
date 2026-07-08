-- 首次登录身份引导：已有用户视为已完成，新注册用户默认未完成。

SET @identity_onboarding_completed_existed = (
  SELECT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'identity_onboarding_completed'
  )
);

SET @ddl = (
  SELECT IF(
    @identity_onboarding_completed_existed,
    'SELECT 1',
    'ALTER TABLE users ADD COLUMN identity_onboarding_completed TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER admin_status'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE users
SET identity_onboarding_completed = 1
WHERE identity_onboarding_completed = 0
  AND @identity_onboarding_completed_existed = 0;
