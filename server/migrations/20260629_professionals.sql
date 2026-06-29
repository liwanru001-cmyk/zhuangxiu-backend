-- Phase 3A: Professional personal business profile.
-- Safe to run repeatedly. This migration only adds new sidecar tables.

CREATE TABLE IF NOT EXISTS professionals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  avatar_url VARCHAR(500) DEFAULT '',
  bio TEXT DEFAULT NULL,
  city VARCHAR(50) DEFAULT '',
  service_area VARCHAR(120) DEFAULT NULL,
  status ENUM('draft', 'active', 'suspended', 'deleted') NOT NULL DEFAULT 'active',
  independent_enabled TINYINT(1) NOT NULL DEFAULT 1,
  consultation_enabled TINYINT(1) NOT NULL DEFAULT 1,
  source ENUM('manual', 'migrated_designer', 'migrated_project_manager') NOT NULL DEFAULT 'manual',
  legacy_role VARCHAR(32) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_professional_user_legacy_role (user_id, legacy_role),
  KEY idx_professional_status_city (status, city),
  KEY idx_professional_user (user_id),
  KEY idx_professional_legacy_role (legacy_role, status),
  CONSTRAINT fk_professional_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS professional_businesses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  professional_id BIGINT UNSIGNED NOT NULL,
  business_catalog_id BIGINT UNSIGNED NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_professional_business_catalog (professional_id, business_catalog_id),
  KEY idx_professional_business_professional (professional_id, status),
  KEY idx_professional_business_catalog (business_catalog_id, status),
  CONSTRAINT fk_professional_business_professional
    FOREIGN KEY (professional_id) REFERENCES professionals(id) ON DELETE CASCADE,
  CONSTRAINT fk_professional_business_catalog
    FOREIGN KEY (business_catalog_id) REFERENCES business_catalog(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
