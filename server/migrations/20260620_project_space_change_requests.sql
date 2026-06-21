CREATE TABLE IF NOT EXISTS project_space_change_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  requester_id BIGINT UNSIGNED NOT NULL,
  action_type VARCHAR(32) NOT NULL,
  payload JSON NOT NULL,
  status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0:待确认 1:已同意 2:已拒绝',
  reviewer_id BIGINT UNSIGNED DEFAULT NULL,
  review_message VARCHAR(300) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_space_change_project (project_id, status, updated_at),
  KEY idx_space_change_requester (requester_id, status, updated_at),
  CONSTRAINT fk_space_change_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_space_change_requester
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_space_change_reviewer
    FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
