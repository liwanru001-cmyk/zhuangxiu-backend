-- 项目效果图与实景图管理。

CREATE TABLE IF NOT EXISTS project_spaces (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(50) NOT NULL,
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    is_default TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_project_space_name (project_id, name),
    INDEX idx_space_project_sort (project_id, sort_order, id),
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_space_images (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    space_id BIGINT UNSIGNED NOT NULL,
    image_type ENUM('rendering', 'site_photo') NOT NULL,
    image_url VARCHAR(500) NOT NULL,
    is_primary TINYINT UNSIGNED NOT NULL DEFAULT 0,
    source_type ENUM('manual_upload', 'site_check_in', 'designer_upload')
        NOT NULL DEFAULT 'manual_upload',
    stage_id TINYINT UNSIGNED DEFAULT NULL,
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_space_image_type (space_id, image_type, sort_order, id),
    FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
