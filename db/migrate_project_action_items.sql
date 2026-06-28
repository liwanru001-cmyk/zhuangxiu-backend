-- 项目待处理事项、多人指派、媒体附件、处理反馈和推送队列。

CREATE TABLE IF NOT EXISTS project_action_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    content VARCHAR(1000) NOT NULL,
    due_date DATE NOT NULL,
    status ENUM('pending', 'completed', 'incomplete', 'rejected')
        NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_action_item_project_status (project_id, status, due_date),
    INDEX idx_action_item_creator (created_by, created_at),
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_action_item_assignees (
    item_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (item_id, user_id),
    INDEX idx_action_assignee_user (user_id, created_at),
    FOREIGN KEY (item_id) REFERENCES project_action_items(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_action_item_feedback (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id BIGINT UNSIGNED NOT NULL,
    submitted_by BIGINT UNSIGNED NOT NULL,
    result ENUM('completed', 'incomplete', 'rejected') NOT NULL,
    content VARCHAR(1000) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_action_feedback_item (item_id, created_at),
    FOREIGN KEY (item_id) REFERENCES project_action_items(id) ON DELETE CASCADE,
    FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_action_item_media (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id BIGINT UNSIGNED NOT NULL,
    feedback_id BIGINT UNSIGNED DEFAULT NULL,
    media_type ENUM('image', 'video') NOT NULL,
    media_url VARCHAR(500) NOT NULL,
    uploaded_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_action_media_item (item_id, feedback_id, id),
    FOREIGN KEY (item_id) REFERENCES project_action_items(id) ON DELETE CASCADE,
    FOREIGN KEY (feedback_id) REFERENCES project_action_item_feedback(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_action_notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id BIGINT UNSIGNED DEFAULT NULL,
    recipient_id BIGINT UNSIGNED NOT NULL,
    event_type ENUM('assigned', 'feedback', 'case_share_request', 'project_event') NOT NULL,
    delivery_status ENUM('pending', 'sent', 'failed', 'read') NOT NULL DEFAULT 'pending',
    payload JSON DEFAULT NULL,
    sent_at DATETIME DEFAULT NULL,
    read_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_action_notification_delivery (delivery_status, created_at),
    INDEX idx_action_notification_recipient (recipient_id, created_at),
    FOREIGN KEY (item_id) REFERENCES project_action_items(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
