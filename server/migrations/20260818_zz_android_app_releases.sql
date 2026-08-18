ALTER TABLE desktop_app_releases
  MODIFY COLUMN platform ENUM('windows', 'macos', 'android') NOT NULL;

ALTER TABLE desktop_release_upload_sessions
  MODIFY COLUMN platform ENUM('windows', 'macos', 'android') NOT NULL;

ALTER TABLE desktop_app_releases
  ADD COLUMN download_count BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER status;
