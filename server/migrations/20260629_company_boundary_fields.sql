-- Phase 4: company public display fields and company member role boundary.
-- Safe to run after 20260629_business_catalog_companies.sql and
-- 20260629_company_members.sql.

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'license_url'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN license_url VARCHAR(500) DEFAULT '''' AFTER contact_phone'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'verification_status'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN verification_status ENUM(''unverified'', ''pending'', ''verified'', ''rejected'') NOT NULL DEFAULT ''unverified'' AFTER license_url'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'paid_display_status'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN paid_display_status ENUM(''none'', ''active'', ''expired'', ''suspended'') NOT NULL DEFAULT ''none'' AFTER verification_status'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'paid_display_starts_at'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN paid_display_starts_at DATETIME DEFAULT NULL AFTER paid_display_status'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'paid_display_ends_at'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN paid_display_ends_at DATETIME DEFAULT NULL AFTER paid_display_starts_at'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'rating_avg'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN rating_avg DECIMAL(3,2) NOT NULL DEFAULT 0.00 AFTER paid_display_ends_at'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'review_count'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN review_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER rating_avg'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'companies' AND COLUMN_NAME = 'case_count'
    ),
    'SELECT 1',
    'ALTER TABLE companies ADD COLUMN case_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER review_count'
  )
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE company_members
  MODIFY member_role ENUM(
    'owner',
    'admin',
    'designer',
    'supervisor',
    'project_manager',
    'staff',
    'customer_service',
    'merchant_staff'
  ) NOT NULL;

UPDATE company_members
SET member_role = 'staff'
WHERE member_role = 'merchant_staff';

ALTER TABLE company_members
  MODIFY member_role ENUM(
    'owner',
    'admin',
    'designer',
    'supervisor',
    'project_manager',
    'staff',
    'customer_service'
  ) NOT NULL;
