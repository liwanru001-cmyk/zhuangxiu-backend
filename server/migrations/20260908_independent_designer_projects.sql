ALTER TABLE renovation_projects ADD COLUMN created_by BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE renovation_projects ADD COLUMN creation_source VARCHAR(24) NOT NULL DEFAULT 'owner';
ALTER TABLE renovation_projects ADD COLUMN preparation_stage VARCHAR(24) NOT NULL DEFAULT 'construction';
ALTER TABLE renovation_projects ADD COLUMN client_name VARCHAR(80) DEFAULT NULL;
ALTER TABLE renovation_projects MODIFY COLUMN user_id BIGINT UNSIGNED NULL;
ALTER TABLE renovation_projects MODIFY COLUMN start_date DATE NULL;
CREATE TABLE IF NOT EXISTS project_owner_invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  invited_by BIGINT UNSIGNED NOT NULL,
  target_user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_owner_invitation_target (target_user_id, status),
  KEY idx_owner_invitation_project (project_id, status),
  FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
