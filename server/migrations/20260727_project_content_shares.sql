CREATE TABLE IF NOT EXISTS project_content_shares (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  shared_by BIGINT UNSIGNED NOT NULL,
  content_type ENUM('merchant_product', 'merchant_case', 'company_case') NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  share_note VARCHAR(200) DEFAULT NULL,
  shared_to_all TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_project_content_share (project_id, created_at, id),
  KEY idx_shared_by (shared_by, created_at),
  KEY idx_content (content_type, content_id),
  CONSTRAINT fk_project_content_share_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_content_share_user
    FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_content_share_recipients (
  share_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (share_id, user_id),
  KEY idx_content_share_recipient (user_id, created_at),
  CONSTRAINT fk_content_share_recipient_share
    FOREIGN KEY (share_id) REFERENCES project_content_shares(id) ON DELETE CASCADE,
  CONSTRAINT fk_content_share_recipient_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_content_share_reads (
  project_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  last_read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  KEY idx_content_share_read_user (user_id, last_read_at),
  CONSTRAINT fk_content_share_read_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_content_share_read_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
