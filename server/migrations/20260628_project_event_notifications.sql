ALTER TABLE project_action_notifications
  MODIFY item_id BIGINT UNSIGNED NULL,
  MODIFY event_type ENUM('assigned', 'feedback', 'case_share_request', 'project_event') NOT NULL,
  MODIFY delivery_status ENUM('pending', 'sent', 'failed', 'read') NOT NULL DEFAULT 'pending';

SET @has_read_at := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'project_action_notifications'
    AND COLUMN_NAME = 'read_at'
);

SET @add_read_at := IF(
  @has_read_at = 0,
  'ALTER TABLE project_action_notifications ADD COLUMN read_at DATETIME DEFAULT NULL',
  'SELECT 1'
);

PREPARE stmt FROM @add_read_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
