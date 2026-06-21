-- 已有数据库升级：增加角色、装修项目和装修任务。
-- 仅执行一次；全新数据库直接使用 init.sql。

ALTER TABLE users
    ADD COLUMN role ENUM('owner', 'designer', 'merchant')
    NOT NULL DEFAULT 'owner' AFTER city;

CREATE TABLE IF NOT EXISTS renovation_projects (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    project_code CHAR(10) NOT NULL,
    designer_id BIGINT UNSIGNED DEFAULT NULL,
    house_area DECIMAL(8,2) NOT NULL,
    start_date DATE NOT NULL,
    total_days INT UNSIGNED NOT NULL DEFAULT 82,
    current_stage TINYINT UNSIGNED NOT NULL DEFAULT 1,
    status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1:进行中 2:已完成 3:暂停',
    project_type ENUM('refined', 'rough', 'office', 'commercial') NOT NULL DEFAULT 'rough',
    house_layout VARCHAR(100) DEFAULT NULL,
    floor_plan_image VARCHAR(500) DEFAULT NULL,
    renovation_method ENUM('self', 'company', 'independent_designer') NOT NULL DEFAULT 'self',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (designer_id) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY uk_project_code (project_code),
    INDEX idx_renovation_owner (user_id, created_at),
    INDEX idx_designer_id (designer_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS renovation_tasks (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    stage_id TINYINT UNSIGNED NOT NULL,
    task_name VARCHAR(100) NOT NULL,
    is_key TINYINT UNSIGNED NOT NULL DEFAULT 0,
    planned_start DATE NOT NULL,
    planned_end DATE NOT NULL,
    actual_start DATE DEFAULT NULL,
    actual_end DATE DEFAULT NULL,
    status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0:未开始 1:进行中 2:完成 3:延期',
    remark VARCHAR(500) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    INDEX idx_project_stage (project_id, stage_id),
    INDEX idx_planned_dates (planned_start, planned_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
