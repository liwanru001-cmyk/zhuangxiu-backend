-- 第一阶段：支持一个账号拥有多个身份。
-- users.role 暂时保留，作为当前身份兼容字段。

ALTER TABLE users
    MODIFY role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor')
    NOT NULL DEFAULT 'owner';

CREATE TABLE IF NOT EXISTS user_roles (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor') NOT NULL,
    is_default TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_role (user_id, role),
    INDEX idx_role_user (role, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO user_roles (user_id, role, is_default)
SELECT id, role, 1 FROM users;
