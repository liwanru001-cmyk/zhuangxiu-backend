-- 项目进度验收。

CREATE TABLE IF NOT EXISTS project_inspections (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    task_id BIGINT UNSIGNED NOT NULL,
    progress_item_id BIGINT UNSIGNED DEFAULT NULL,
    stage_id TINYINT UNSIGNED NOT NULL,
    submitted_by BIGINT UNSIGNED NOT NULL,
    member_role VARCHAR(32) NOT NULL DEFAULT 'owner',
    responsible_user_id BIGINT UNSIGNED DEFAULT NULL,
    status ENUM('pending', 'passed', 'rework') NOT NULL DEFAULT 'pending',
    description VARCHAR(500) DEFAULT NULL,
    review_remark VARCHAR(500) DEFAULT NULL,
    reviewed_by BIGINT UNSIGNED DEFAULT NULL,
    reviewed_at DATETIME DEFAULT NULL,
    submission_round INT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_inspection_project_status (project_id, status, updated_at),
    INDEX idx_inspection_task (task_id, updated_at),
    INDEX idx_inspection_progress_item (progress_item_id, updated_at),
    INDEX idx_inspection_responsible (responsible_user_id, status, updated_at),
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES renovation_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (responsible_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_inspection_images (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    inspection_id BIGINT UNSIGNED NOT NULL,
    image_url VARCHAR(500) NOT NULL,
    submission_round INT UNSIGNED NOT NULL DEFAULT 1,
    uploaded_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_inspection_image_round (inspection_id, submission_round, id),
    FOREIGN KEY (inspection_id) REFERENCES project_inspections(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
