ALTER TABLE project_handovers
  ADD COLUMN version_no INT UNSIGNED NOT NULL DEFAULT 1 AFTER target_user_id;

CREATE TABLE IF NOT EXISTS project_design_handover_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  design_handover_id BIGINT UNSIGNED NOT NULL,
  related_stage_id TINYINT UNSIGNED DEFAULT NULL,
  importance VARCHAR(16) NOT NULL DEFAULT 'normal',
  check_type VARCHAR(24) NOT NULL DEFAULT 'progress_note',
  source_section VARCHAR(80) NOT NULL,
  summary VARCHAR(500) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_design_handover_items_stage (project_id, related_stage_id, check_type, importance),
  KEY idx_design_handover_items_handover (design_handover_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_inspection_design_checks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  inspection_id BIGINT UNSIGNED NOT NULL,
  design_handover_id BIGINT UNSIGNED NOT NULL,
  design_handover_item_id BIGINT UNSIGNED DEFAULT NULL,
  snapshot_source_title VARCHAR(120) NOT NULL,
  snapshot_version_no INT UNSIGNED NOT NULL DEFAULT 1,
  snapshot_summary VARCHAR(500) NOT NULL,
  check_result VARCHAR(24) NOT NULL DEFAULT 'pending',
  checked_by BIGINT UNSIGNED DEFAULT NULL,
  checked_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inspection_design_checks (inspection_id, created_at),
  KEY idx_project_design_checks (project_id, design_handover_id, created_at),
  KEY idx_design_check_item (design_handover_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

