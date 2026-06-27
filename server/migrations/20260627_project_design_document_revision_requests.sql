CREATE TABLE IF NOT EXISTS project_design_document_revision_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  design_document_id BIGINT UNSIGNED NOT NULL,
  design_document_version_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL DEFAULT 1,
  requested_by BIGINT UNSIGNED NOT NULL,
  assignee_id BIGINT UNSIGNED DEFAULT NULL,
  reason VARCHAR(500) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_design_revision_project (project_id, created_at),
  KEY idx_design_revision_group (design_document_id, created_at),
  KEY idx_design_revision_version (design_document_version_id, created_at),
  KEY idx_design_revision_assignee (assignee_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
