-- 项目进度事项：按项目阶段组织，支持最多三级父子事项。

CREATE TABLE IF NOT EXISTS project_progress_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    stage_id TINYINT UNSIGNED NOT NULL,
    task_id BIGINT UNSIGNED DEFAULT NULL,
    parent_id BIGINT UNSIGNED DEFAULT NULL,
    template_key VARCHAR(80) DEFAULT NULL,
    title VARCHAR(100) NOT NULL,
    planned_start DATE DEFAULT NULL,
    planned_end DATE DEFAULT NULL,
    actual_finish DATE DEFAULT NULL,
    status ENUM('pending', 'in_progress', 'completed', 'delayed')
        NOT NULL DEFAULT 'pending',
    remark VARCHAR(1000) DEFAULT NULL,
    is_key_node TINYINT(1) NOT NULL DEFAULT 0,
    requires_inspection TINYINT(1) NOT NULL DEFAULT 0,
    inspection_template_key VARCHAR(64) DEFAULT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_progress_item_project_stage (project_id, stage_id, sort_order, id),
    INDEX idx_progress_item_task (task_id, sort_order, id),
    INDEX idx_progress_item_parent (parent_id, sort_order, id),
    INDEX idx_progress_item_template (project_id, template_key),
    INDEX idx_progress_item_creator (created_by, created_at),
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES renovation_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES project_progress_items(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
