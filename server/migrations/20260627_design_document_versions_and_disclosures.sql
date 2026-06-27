ALTER TABLE project_design_documents
  ADD COLUMN version_group_id BIGINT UNSIGNED DEFAULT NULL AFTER project_id,
  ADD COLUMN version_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER version_group_id,
  ADD COLUMN is_current TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER version_no,
  ADD COLUMN superseded_by BIGINT UNSIGNED DEFAULT NULL AFTER is_current,
  ADD COLUMN confirmed_at TIMESTAMP NULL DEFAULT NULL AFTER reviewed_at,
  ADD COLUMN voided_at TIMESTAMP NULL DEFAULT NULL AFTER confirmed_at;

UPDATE project_design_documents
SET version_group_id = id
WHERE version_group_id IS NULL;

CREATE TABLE IF NOT EXISTS construction_disclosure_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  disclosure_id BIGINT UNSIGNED NOT NULL,
  design_document_id BIGINT UNSIGNED NOT NULL,
  design_document_version_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(80) DEFAULT NULL,
  snapshot_title VARCHAR(120) NOT NULL,
  snapshot_version_no INT UNSIGNED NOT NULL DEFAULT 1,
  snapshot_file_url VARCHAR(500) NOT NULL,
  snapshot_category VARCHAR(32) NOT NULL DEFAULT 'other',
  snapshot_space_key VARCHAR(32) NOT NULL DEFAULT 'whole_house',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_disclosure_documents (disclosure_id, created_at),
  KEY idx_design_document_disclosures (design_document_id, created_at),
  KEY idx_design_document_version_disclosures (design_document_version_id, created_at),
  KEY idx_disclosure_project (project_id, disclosure_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
