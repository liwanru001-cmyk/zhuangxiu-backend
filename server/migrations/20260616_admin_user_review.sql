-- Web 管理后台用户审核状态。

ALTER TABLE users
  ADD COLUMN admin_status ENUM('pending', 'approved', 'rejected')
    NOT NULL DEFAULT 'approved' AFTER role,
  ADD INDEX idx_admin_status (admin_status, created_at);

