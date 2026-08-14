SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_material_items'
     AND COLUMN_NAME = 'deleted_at') = 0,
  'ALTER TABLE project_material_items ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL, ADD COLUMN deleted_by BIGINT UNSIGNED DEFAULT NULL, ADD KEY idx_material_deleted (project_id, deleted_at)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_handovers'
     AND COLUMN_NAME = 'deleted_at') = 0,
  'ALTER TABLE project_handovers ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL, ADD COLUMN deleted_by BIGINT UNSIGNED DEFAULT NULL, ADD KEY idx_handover_deleted (project_id, deleted_at)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
