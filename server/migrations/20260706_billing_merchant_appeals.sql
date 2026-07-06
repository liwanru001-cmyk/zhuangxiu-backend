-- Merchant billing appeals MVP: user appeal -> admin review -> entitlement restore

CREATE TABLE IF NOT EXISTS billing_appeals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  appeal_no VARCHAR(64) NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  appeal_type VARCHAR(64) NOT NULL DEFAULT 'merchant_display_restore',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  entitlement_id BIGINT UNSIGNED DEFAULT NULL,
  reason_code VARCHAR(64) DEFAULT NULL,
  reason_label VARCHAR(128) DEFAULT NULL,
  content VARCHAR(300) NOT NULL,
  result_reason VARCHAR(300) DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  reviewed_by BIGINT UNSIGNED DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_appeal_no (appeal_no),
  KEY idx_appeal_subject (subject_type, subject_id, status, created_at),
  KEY idx_appeal_status (status, created_at),
  KEY idx_appeal_entitlement (entitlement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
