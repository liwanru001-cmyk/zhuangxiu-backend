-- 第二阶段：统一项目成员关系。
-- renovation_projects.designer_id 暂时保留，用于兼容旧版本。

CREATE TABLE IF NOT EXISTS project_members (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor') NOT NULL,
    status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '0:待确认 1:有效 2:已移除',
    permissions JSON DEFAULT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_project_user_role (project_id, user_id, role),
    INDEX idx_member_user_role (user_id, role, status),
    INDEX idx_member_project_status (project_id, status),
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO project_members
    (project_id, user_id, role, status, permissions)
SELECT p.id, p.user_id, 'owner', 1,
       JSON_OBJECT('manage_members', true, 'manage_tasks', true, 'view_project', true)
FROM renovation_projects p
ON DUPLICATE KEY UPDATE
    status = 1,
    permissions = VALUES(permissions);

INSERT INTO project_members
    (project_id, user_id, role, status, permissions)
SELECT p.id, p.designer_id, 'designer', 1,
       JSON_OBJECT('manage_tasks', true, 'view_project', true)
FROM renovation_projects p
WHERE p.designer_id IS NOT NULL
ON DUPLICATE KEY UPDATE
    status = 1,
    permissions = VALUES(permissions);
