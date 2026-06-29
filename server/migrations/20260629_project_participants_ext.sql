-- Sidecar participant model for Company / Professional / User project collaboration.
-- This table does not modify project_members or renovation_projects.

CREATE TABLE IF NOT EXISTS project_participants_ext (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  participant_type ENUM('company', 'professional', 'user') NOT NULL,
  participant_id BIGINT NOT NULL,
  role_type ENUM('designer', 'supervisor', 'contractor', 'client', 'pm') NOT NULL,
  company_id BIGINT UNSIGNED DEFAULT NULL,
  professional_id BIGINT UNSIGNED DEFAULT NULL,
  user_id BIGINT UNSIGNED DEFAULT NULL,
  assigned_by_user_id BIGINT UNSIGNED DEFAULT NULL,
  status ENUM('invited', 'active', 'rejected', 'removed') NOT NULL DEFAULT 'invited',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_project_participant_role (project_id, participant_type, participant_id, role_type),
  KEY idx_project_status (project_id, status),
  KEY idx_participant (participant_type, participant_id),
  KEY idx_company (company_id),
  KEY idx_professional (professional_id),
  KEY idx_user (user_id),
  KEY idx_assigned_by (assigned_by_user_id),
  CONSTRAINT fk_project_participants_ext_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_project_participants_ext_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_project_participants_ext_professional
    FOREIGN KEY (professional_id) REFERENCES professionals(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_project_participants_ext_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_project_participants_ext_assigned_by
    FOREIGN KEY (assigned_by_user_id) REFERENCES users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
