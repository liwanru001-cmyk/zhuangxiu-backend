CREATE TABLE IF NOT EXISTS content_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  target_type VARCHAR(32) NOT NULL,
  reported_user_id BIGINT UNSIGNED NOT NULL,
  consultation_id BIGINT UNSIGNED DEFAULT NULL,
  message_id BIGINT UNSIGNED DEFAULT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  report_count INT UNSIGNED NOT NULL DEFAULT 1,
  latest_category VARCHAR(32) NOT NULL,
  latest_description VARCHAR(1000) DEFAULT NULL,
  message_snapshot TEXT DEFAULT NULL,
  context_snapshot JSON DEFAULT NULL,
  assigned_admin VARCHAR(80) DEFAULT NULL,
  handled_at DATETIME DEFAULT NULL,
  resolution VARCHAR(32) DEFAULT NULL,
  resolution_note VARCHAR(1000) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report_queue (status, updated_at),
  KEY idx_reported_user (reported_user_id, status),
  KEY idx_report_message (message_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS content_report_occurrences (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id BIGINT UNSIGNED NOT NULL,
  reporter_user_id BIGINT UNSIGNED NOT NULL,
  category VARCHAR(32) NOT NULL,
  description VARCHAR(1000) DEFAULT NULL,
  app_platform VARCHAR(32) DEFAULT NULL,
  app_version VARCHAR(64) DEFAULT NULL,
  client_report_id VARCHAR(80) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_report_client (reporter_user_id, client_report_id),
  KEY idx_occurrence_report (report_id, created_at),
  KEY idx_occurrence_reporter (reporter_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS content_report_evidence (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurrence_id BIGINT UNSIGNED NOT NULL,
  image_url VARCHAR(1000) NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_evidence_occurrence (occurrence_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS content_report_actions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id BIGINT UNSIGNED NOT NULL,
  admin_name VARCHAR(80) NOT NULL,
  action VARCHAR(32) NOT NULL,
  note VARCHAR(1000) DEFAULT NULL,
  duration_minutes INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_action_report (report_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id BIGINT UNSIGNED NOT NULL,
  blocked_user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  KEY idx_blocked_user (blocked_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS consultation_user_preferences (
  consultation_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  receive_messages TINYINT(1) NOT NULL DEFAULT 1,
  cleared_before DATETIME DEFAULT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (consultation_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_moderation_restrictions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  restriction_type VARCHAR(24) NOT NULL,
  reason VARCHAR(1000) DEFAULT NULL,
  report_id BIGINT UNSIGNED DEFAULT NULL,
  starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_restriction_active (user_id, restriction_type, revoked_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE consultation_messages ADD COLUMN deleted_at DATETIME DEFAULT NULL;
ALTER TABLE consultation_messages ADD COLUMN deleted_by VARCHAR(80) DEFAULT NULL;
ALTER TABLE consultation_messages ADD COLUMN deletion_reason VARCHAR(1000) DEFAULT NULL;
