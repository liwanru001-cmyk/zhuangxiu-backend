SET @schema_name = DATABASE();
SET @has_merchant_profiles = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'merchant_profiles'
);
SET @has_companies = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'companies'
);

SET @sql = (
  SELECT IF(
    @has_merchant_profiles > 0 AND COUNT(*) = 0,
    'ALTER TABLE merchant_profiles ADD COLUMN longitude DECIMAL(10,7) NULL AFTER address',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'merchant_profiles'
    AND COLUMN_NAME = 'longitude'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    @has_merchant_profiles > 0 AND COUNT(*) = 0,
    'ALTER TABLE merchant_profiles ADD COLUMN latitude DECIMAL(10,7) NULL AFTER longitude',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'merchant_profiles'
    AND COLUMN_NAME = 'latitude'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    @has_merchant_profiles > 0 AND COUNT(*) = 0,
    'ALTER TABLE merchant_profiles ADD COLUMN map_provider VARCHAR(32) NULL AFTER latitude',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'merchant_profiles'
    AND COLUMN_NAME = 'map_provider'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    @has_companies > 0 AND COUNT(*) = 0,
    'ALTER TABLE companies ADD COLUMN longitude DECIMAL(10,7) NULL AFTER address',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'companies'
    AND COLUMN_NAME = 'longitude'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    @has_companies > 0 AND COUNT(*) = 0,
    'ALTER TABLE companies ADD COLUMN latitude DECIMAL(10,7) NULL AFTER longitude',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'companies'
    AND COLUMN_NAME = 'latitude'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    @has_companies > 0 AND COUNT(*) = 0,
    'ALTER TABLE companies ADD COLUMN map_provider VARCHAR(32) NULL AFTER latitude',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @schema_name
    AND TABLE_NAME = 'companies'
    AND COLUMN_NAME = 'map_provider'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
