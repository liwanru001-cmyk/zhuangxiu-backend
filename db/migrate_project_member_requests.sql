-- 通用项目成员申请，替代按角色分别建申请表。

CREATE TABLE IF NOT EXISTS project_member_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    owner_id BIGINT UNSIGNED NOT NULL,
    target_user_id BIGINT UNSIGNED NOT NULL,
    member_role ENUM('designer', 'project_manager', 'project_supervisor', 'merchant') NOT NULL,
    status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0:待处理 1:同意 2:拒绝',
    message VARCHAR(300) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_project_target_role (project_id, target_user_id, member_role),
    INDEX idx_target_role_status (target_user_id, member_role, status),
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
