-- Phase 3B: Company members sidecar model.
-- Safe to run repeatedly. This migration does not modify project_members.

CREATE TABLE IF NOT EXISTS company_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  professional_id BIGINT UNSIGNED DEFAULT NULL,
  member_role ENUM(
    'owner',
    'admin',
    'designer',
    'supervisor',
    'project_manager',
    'merchant_staff',
    'customer_service'
  ) NOT NULL,
  title VARCHAR(80) DEFAULT '',
  status ENUM('pending', 'active', 'rejected', 'removed') NOT NULL DEFAULT 'pending',
  joined_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_company_user_role (company_id, user_id, member_role),
  KEY idx_company_member_status (company_id, status),
  KEY idx_user_company_status (user_id, status),
  KEY idx_professional_company (professional_id, company_id),
  CONSTRAINT fk_company_member_company
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_company_member_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_company_member_professional
    FOREIGN KEY (professional_id) REFERENCES professionals(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
