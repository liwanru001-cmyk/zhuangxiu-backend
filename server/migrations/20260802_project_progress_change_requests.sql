CREATE TABLE IF NOT EXISTS project_progress_change_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  entity_type ENUM('task', 'progress_item') NOT NULL,
  target_id BIGINT UNSIGNED DEFAULT NULL,
  action ENUM('create', 'update', 'delete') NOT NULL,
  before_snapshot JSON DEFAULT NULL,
  proposed_payload JSON DEFAULT NULL,
  target_updated_at DATETIME DEFAULT NULL,
  submitted_by BIGINT UNSIGNED NOT NULL,
  submitted_role VARCHAR(32) DEFAULT NULL,
  status ENUM('pending', 'approved', 'rejected', 'cancelled', 'conflict')
    NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED DEFAULT NULL,
  review_note VARCHAR(500) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_progress_change_project_status (project_id, status, created_at),
  KEY idx_progress_change_submitter (submitted_by, status, created_at),
  KEY idx_progress_change_target (project_id, entity_type, target_id, status),
  CONSTRAINT fk_progress_change_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_progress_change_submitter
    FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_progress_change_reviewer
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
