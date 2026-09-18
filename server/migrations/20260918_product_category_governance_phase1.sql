SET @addSourceCategoryEvidenceType = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_source_categories' AND COLUMN_NAME='evidence_type') = 0,
  "ALTER TABLE product_ingestion_source_categories ADD COLUMN evidence_type VARCHAR(30) NOT NULL DEFAULT 'listing_page' AFTER source_url",
  'SELECT 1'
);
PREPARE stmt FROM @addSourceCategoryEvidenceType;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSourceCategoryEvidencePayload = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_source_categories' AND COLUMN_NAME='evidence_payload') = 0,
  'ALTER TABLE product_ingestion_source_categories ADD COLUMN evidence_payload JSON DEFAULT NULL AFTER evidence_type',
  'SELECT 1'
);
PREPARE stmt FROM @addSourceCategoryEvidencePayload;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSourceCategoryLastSeen = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_source_categories' AND COLUMN_NAME='last_seen_at') = 0,
  'ALTER TABLE product_ingestion_source_categories ADD COLUMN last_seen_at DATETIME DEFAULT NULL AFTER evidence_payload',
  'SELECT 1'
);
PREPARE stmt FROM @addSourceCategoryLastSeen;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS product_ingestion_category_mapping_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_category_id BIGINT UNSIGNED NOT NULL,
  previous_category_ids JSON NOT NULL,
  new_category_ids JSON NOT NULL,
  affected_candidates INT UNSIGNED NOT NULL DEFAULT 0,
  affected_products INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_overrides INT UNSIGNED NOT NULL DEFAULT 0,
  change_reason VARCHAR(300) DEFAULT NULL,
  changed_by VARCHAR(80) NOT NULL,
  changed_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_category_mapping_change_source (source_category_id,id),
  CONSTRAINT fk_category_mapping_change_source FOREIGN KEY (source_category_id) REFERENCES product_ingestion_source_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_candidate_category_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_key CHAR(36) NOT NULL,
  candidate_id BIGINT UNSIGNED NOT NULL,
  previous_category_ids JSON NOT NULL,
  new_category_ids JSON NOT NULL,
  change_reason VARCHAR(300) DEFAULT NULL,
  changed_by VARCHAR(80) NOT NULL,
  changed_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_candidate_category_change_batch (batch_key,id),
  KEY idx_candidate_category_change_candidate (candidate_id,id),
  CONSTRAINT fk_candidate_category_change_candidate FOREIGN KEY (candidate_id) REFERENCES product_ingestion_candidates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
