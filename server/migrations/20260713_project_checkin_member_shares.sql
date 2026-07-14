CREATE TABLE IF NOT EXISTS project_checkin_shares (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  checkin_id BIGINT UNSIGNED NOT NULL,
  shared_with_user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_checkin_user (checkin_id, shared_with_user_id),
  KEY idx_shared_user (shared_with_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE project_checkin_shares ADD COLUMN shared_by BIGINT UNSIGNED DEFAULT NULL AFTER shared_with_user_id',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'project_checkin_shares'
    AND COLUMN_NAME = 'shared_by'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE project_checkin_shares ADD COLUMN share_note VARCHAR(200) DEFAULT NULL AFTER shared_by',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'project_checkin_shares'
    AND COLUMN_NAME = 'share_note'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE project_checkin_shares ADD KEY idx_checkin_recipient (checkin_id, shared_with_user_id)',
    'SELECT 1'
  )
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'project_checkin_shares'
    AND INDEX_NAME = 'idx_checkin_recipient'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
