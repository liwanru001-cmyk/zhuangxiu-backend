-- Extend consultation records from designer-only to multi-role targets.

ALTER TABLE designer_consultations
  ADD COLUMN target_role ENUM('designer', 'project_manager', 'project_supervisor', 'merchant')
    NOT NULL DEFAULT 'designer' AFTER designer_id,
  ADD INDEX idx_consultation_target_role (designer_id, target_role, status, created_at);
