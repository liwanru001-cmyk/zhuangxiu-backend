-- 项目级标准事项选择状态：用于记录不适用、稍后确认，避免缺失提醒重复出现。
CREATE TABLE IF NOT EXISTS project_work_item_template_status (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    template_key VARCHAR(80) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    note VARCHAR(300) DEFAULT NULL,
    updated_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_project_template_status (project_id, template_key),
    INDEX idx_project_template_status (project_id, status),
    INDEX idx_template_key_status (template_key, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
