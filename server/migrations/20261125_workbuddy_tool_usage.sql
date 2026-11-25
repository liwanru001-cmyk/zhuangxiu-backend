CREATE TABLE IF NOT EXISTS workbuddy_tool_usage_daily (
  usage_date DATE NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  call_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  failure_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (usage_date, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
