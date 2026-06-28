CREATE TABLE IF NOT EXISTS project_progress_item_adjustments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  progress_item_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(24) NOT NULL DEFAULT 'updated',
  changed_fields JSON DEFAULT NULL,
  changed_by BIGINT UNSIGNED NOT NULL,
  changed_role VARCHAR(32) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_progress_adjustment_item (project_id, progress_item_id, created_at),
  KEY idx_progress_adjustment_actor (changed_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
