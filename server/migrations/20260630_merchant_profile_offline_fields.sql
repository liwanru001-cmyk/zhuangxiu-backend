SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'shop_name'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN shop_name VARCHAR(120) DEFAULT NULL AFTER user_id'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'logo_url'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN logo_url VARCHAR(500) DEFAULT NULL AFTER shop_name'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'cover_url'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN cover_url VARCHAR(500) DEFAULT NULL AFTER logo_url'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'address'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN address VARCHAR(255) DEFAULT NULL AFTER service_area'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'contact_phone'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN contact_phone VARCHAR(40) DEFAULT NULL AFTER address'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'business_hours'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN business_hours VARCHAR(120) DEFAULT NULL AFTER contact_phone'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'category_group'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN category_group VARCHAR(20) DEFAULT NULL AFTER business_hours'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'after_sales_promise'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN after_sales_promise TEXT DEFAULT NULL AFTER brand_intro'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'license_url'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN license_url VARCHAR(500) DEFAULT NULL AFTER after_sales_promise'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_profiles' AND COLUMN_NAME = 'authorization_url'
    ),
    'SELECT 1',
    'ALTER TABLE merchant_profiles ADD COLUMN authorization_url VARCHAR(500) DEFAULT NULL AFTER license_url'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
