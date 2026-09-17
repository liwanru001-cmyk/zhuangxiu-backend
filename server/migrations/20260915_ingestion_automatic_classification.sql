SET @allowIngestionSourceGroupNull = IF(
  (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_sources' AND COLUMN_NAME='product_group') = 'NO',
  'ALTER TABLE product_ingestion_sources MODIFY product_group VARCHAR(30) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @allowIngestionSourceGroupNull;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @allowIngestionSourceTypeNull = IF(
  (SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_sources' AND COLUMN_NAME='product_type') = 'NO',
  'ALTER TABLE product_ingestion_sources MODIFY product_type VARCHAR(30) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @allowIngestionSourceTypeNull;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addClassificationSuggestion = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates' AND COLUMN_NAME='classification_suggestion') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN classification_suggestion JSON DEFAULT NULL AFTER generated_fields',
  'SELECT 1'
);
PREPARE stmt FROM @addClassificationSuggestion;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addClassificationOverride = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates' AND COLUMN_NAME='classification_override') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN classification_override JSON DEFAULT NULL AFTER classification_suggestion',
  'SELECT 1'
);
PREPARE stmt FROM @addClassificationOverride;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addCandidateAssignmentType = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidate_categories' AND COLUMN_NAME='assignment_type') = 0,
  "ALTER TABLE product_ingestion_candidate_categories ADD COLUMN assignment_type VARCHAR(20) NOT NULL DEFAULT 'manual' AFTER assigned_at",
  'SELECT 1'
);
PREPARE stmt FROM @addCandidateAssignmentType;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS product_ingestion_candidate_classification_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  candidate_id BIGINT UNSIGNED NOT NULL,
  previous_product_group VARCHAR(30) DEFAULT NULL,
  previous_product_type VARCHAR(30) DEFAULT NULL,
  new_product_group VARCHAR(30) NOT NULL,
  new_product_type VARCHAR(30) NOT NULL,
  changed_by VARCHAR(80) NOT NULL,
  changed_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_candidate_classification_history (candidate_id,id),
  CONSTRAINT fk_candidate_classification_history FOREIGN KEY (candidate_id) REFERENCES product_ingestion_candidates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
