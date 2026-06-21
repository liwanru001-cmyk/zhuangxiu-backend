-- 标准装修事项库：用于项目进度管理从库中选择事项，并给验收助理提供事项上下文。
CREATE TABLE IF NOT EXISTS renovation_work_item_templates (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    template_key VARCHAR(80) NOT NULL,
    stage_id TINYINT UNSIGNED NOT NULL,
    title VARCHAR(120) NOT NULL,
    required_level VARCHAR(16) NOT NULL DEFAULT 'recommended',
    requires_inspection TINYINT(1) NOT NULL DEFAULT 0,
    inspection_template_key VARCHAR(64) DEFAULT NULL,
    default_responsible_role VARCHAR(32) DEFAULT NULL,
    suggested_timing VARCHAR(120) DEFAULT NULL,
    description TEXT DEFAULT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_work_item_template_key (template_key),
    INDEX idx_work_item_stage (stage_id, sort_order, is_active),
    INDEX idx_work_item_required (required_level, is_active),
    INDEX idx_work_item_inspection (requires_inspection, inspection_template_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
