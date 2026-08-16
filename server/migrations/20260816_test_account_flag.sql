SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
     AND COLUMN_NAME = 'is_test_account') = 0,
  'ALTER TABLE users ADD COLUMN is_test_account TINYINT(1) NOT NULL DEFAULT 0 AFTER admin_status, ADD INDEX idx_test_account (is_test_account, admin_status)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The owner confirmed that every existing account except these two is a test account.
UPDATE users
SET is_test_account = CASE
  WHEN phone IN ('18664659126', '18106678185') THEN 0
  ELSE 1
END;
