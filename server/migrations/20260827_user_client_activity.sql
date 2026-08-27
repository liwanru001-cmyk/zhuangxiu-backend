ALTER TABLE users
  ADD COLUMN last_client_type VARCHAR(32) DEFAULT NULL AFTER likes_received,
  ADD COLUMN last_device_brand VARCHAR(64) DEFAULT NULL AFTER last_client_type,
  ADD COLUMN last_device_model VARCHAR(128) DEFAULT NULL AFTER last_device_brand,
  ADD COLUMN last_os_name VARCHAR(32) DEFAULT NULL AFTER last_device_model,
  ADD COLUMN last_os_version VARCHAR(64) DEFAULT NULL AFTER last_os_name,
  ADD COLUMN last_app_version VARCHAR(64) DEFAULT NULL AFTER last_os_version,
  ADD COLUMN last_build_number VARCHAR(32) DEFAULT NULL AFTER last_app_version,
  ADD COLUMN last_client_at DATETIME DEFAULT NULL AFTER last_build_number,
  ADD INDEX idx_users_last_client_at (last_client_at);
