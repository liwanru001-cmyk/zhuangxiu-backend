-- Unified consultation target layer.
-- This is a sidecar table and does not modify designer_consultations.

CREATE TABLE IF NOT EXISTS consultation_targets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  consultation_id BIGINT UNSIGNED DEFAULT NULL,
  requester_user_id BIGINT UNSIGNED DEFAULT NULL,
  target_type ENUM('company', 'professional', 'user') NOT NULL,
  target_id BIGINT NOT NULL,
  business_catalog_id BIGINT UNSIGNED DEFAULT NULL,
  business_group VARCHAR(80) DEFAULT NULL,
  source_page ENUM('marketplace', 'profile', 'project') DEFAULT NULL,
  message TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_consultation_id (consultation_id),
  KEY idx_requester_created (requester_user_id, created_at),
  KEY idx_target (target_type, target_id, created_at),
  KEY idx_business_catalog (business_catalog_id),
  CONSTRAINT fk_consultation_targets_consultation
    FOREIGN KEY (consultation_id) REFERENCES designer_consultations(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_consultation_targets_requester
    FOREIGN KEY (requester_user_id) REFERENCES users(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_consultation_targets_business_catalog
    FOREIGN KEY (business_catalog_id) REFERENCES business_catalog(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
