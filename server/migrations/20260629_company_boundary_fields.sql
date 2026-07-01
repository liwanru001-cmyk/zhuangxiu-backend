-- Phase 4: company public display fields and company member role boundary.
-- Safe to run after 20260629_business_catalog_companies.sql and
-- 20260629_company_members.sql.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS license_url VARCHAR(500) DEFAULT '' AFTER contact_phone,
  ADD COLUMN IF NOT EXISTS verification_status ENUM('unverified', 'pending', 'verified', 'rejected') NOT NULL DEFAULT 'unverified' AFTER license_url,
  ADD COLUMN IF NOT EXISTS paid_display_status ENUM('none', 'active', 'expired', 'suspended') NOT NULL DEFAULT 'none' AFTER verification_status,
  ADD COLUMN IF NOT EXISTS paid_display_starts_at DATETIME DEFAULT NULL AFTER paid_display_status,
  ADD COLUMN IF NOT EXISTS paid_display_ends_at DATETIME DEFAULT NULL AFTER paid_display_starts_at,
  ADD COLUMN IF NOT EXISTS rating_avg DECIMAL(3,2) NOT NULL DEFAULT 0.00 AFTER paid_display_ends_at,
  ADD COLUMN IF NOT EXISTS review_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER rating_avg,
  ADD COLUMN IF NOT EXISTS case_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER review_count;

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
