ALTER TABLE project_action_notifications
  MODIFY item_id BIGINT UNSIGNED NULL,
  MODIFY event_type ENUM('assigned', 'feedback', 'case_share_request', 'project_event', 'consultation') NOT NULL,
  MODIFY delivery_status ENUM('pending', 'sent', 'failed', 'read') NOT NULL DEFAULT 'pending';
