-- 装修不凡 App 数据库初始化脚本
-- 数据库: zhuangxiu_app
-- 创建时间: 2026-06-07

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone CHAR(11) NOT NULL UNIQUE,
    password_hash VARCHAR(255) DEFAULT NULL,
    nickname VARCHAR(50) NOT NULL DEFAULT '装修小达人',
    avatar VARCHAR(255) DEFAULT '',
    bio VARCHAR(200) DEFAULT '',
    city VARCHAR(50) DEFAULT '',
    role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor') NOT NULL DEFAULT 'owner',
    admin_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved',
    followers_count INT UNSIGNED DEFAULT 0,
    following_count INT UNSIGNED DEFAULT 0,
    likes_received INT UNSIGNED DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_phone (phone),
    INDEX idx_city (city),
    INDEX idx_admin_status (admin_status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用户拥有的身份；users.role 暂时保存当前使用身份。
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

-- 笔记表
CREATE TABLE IF NOT EXISTS notes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    source_type VARCHAR(30) NOT NULL DEFAULT 'legacy' COMMENT 'site_photos, complaint, site_check_in, question, good_item, inspiration, legacy',
    stage_id TINYINT UNSIGNED DEFAULT NULL,
    publish_role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor') DEFAULT NULL,
    question_audience ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor', 'user', 'all') DEFAULT NULL,
    category VARCHAR(50) DEFAULT '',
    decoration_style VARCHAR(30) DEFAULT '',
    location VARCHAR(100) DEFAULT '',
    city VARCHAR(50) DEFAULT '',
    status TINYINT DEFAULT 0 COMMENT '0:待审核 1:正常 2:隐藏/驳回 3:仅自己可见 4:用户删除',
    likes_count INT UNSIGNED DEFAULT 0,
    comments_count INT UNSIGNED DEFAULT 0,
    collections_count INT UNSIGNED DEFAULT 0,
    views_count INT UNSIGNED DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_source_type (source_type),
    INDEX idx_note_feed_source_status_created (source_type, status, created_at),
    INDEX idx_note_feed_city_status_created (city, status, created_at),
    INDEX idx_note_feed_style_status_created (decoration_style, status, created_at),
    INDEX idx_note_stage (stage_id),
    INDEX idx_note_publish_role (publish_role),
    INDEX idx_note_question_audience (question_audience),
    INDEX idx_decoration_style (decoration_style),
    INDEX idx_status (status),
    INDEX idx_city (city),
    INDEX idx_created (created_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 笔记图片表
CREATE TABLE IF NOT EXISTS note_images (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    note_id BIGINT UNSIGNED NOT NULL,
    url VARCHAR(500) NOT NULL,
    sort_order INT UNSIGNED DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    INDEX idx_note_id (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 笔记视频表
CREATE TABLE IF NOT EXISTS note_videos (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    note_id BIGINT UNSIGNED NOT NULL,
    url VARCHAR(500) NOT NULL,
    cover_url VARCHAR(500) DEFAULT '',
    duration INT UNSIGNED DEFAULT 0 COMMENT '秒',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    INDEX idx_note_id (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 标签表
CREATE TABLE IF NOT EXISTS tags (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    notes_count INT UNSIGNED DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 笔记-标签关联表
CREATE TABLE IF NOT EXISTS note_tags (
    note_id BIGINT UNSIGNED NOT NULL,
    tag_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (note_id, tag_id),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 关注关系表
CREATE TABLE IF NOT EXISTS follows (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    follower_id BIGINT UNSIGNED NOT NULL,
    following_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_follow (follower_id, following_id),
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 点赞表
CREATE TABLE IF NOT EXISTS likes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    note_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_like (user_id, note_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 收藏表
CREATE TABLE IF NOT EXISTS collections (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    note_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_collection (user_id, note_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 浏览历史
CREATE TABLE IF NOT EXISTS note_view_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    note_id BIGINT UNSIGNED NOT NULL,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_note_history (user_id, note_id),
    INDEX idx_user_viewed (user_id, viewed_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    note_id BIGINT UNSIGNED NOT NULL,
    reply_to BIGINT UNSIGNED DEFAULT NULL,
    content VARCHAR(1000) NOT NULL,
    likes_count INT UNSIGNED DEFAULT 0,
    status TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    FOREIGN KEY (reply_to) REFERENCES comments(id) ON DELETE CASCADE,
    INDEX idx_note_id (note_id),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 短信验证码表
CREATE TABLE IF NOT EXISTS sms_codes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone CHAR(11) NOT NULL,
    code CHAR(6) NOT NULL,
    ip VARCHAR(45) NOT NULL,
    used TINYINT DEFAULT 0,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_phone (phone),
    INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 装修项目表
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
    pace_mode ENUM('normal', 'accelerated', 'relaxed', 'paused')
        NOT NULL DEFAULT 'normal',
    pace_updated_at DATETIME DEFAULT NULL,
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

-- 项目成员关系。designer_id 暂时保留用于兼容旧客户端。
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

-- 项目空间及效果图/实景图
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

-- 业主主动申请设计师
CREATE TABLE IF NOT EXISTS designer_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_id BIGINT UNSIGNED NOT NULL,
    designer_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NOT NULL,
    status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0:待处理 1:同意 2:拒绝',
    message VARCHAR(300) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_project_designer (project_id, designer_id),
    INDEX idx_designer_status (designer_id, status),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (designer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 设计师主动邀请业主管理工地
CREATE TABLE IF NOT EXISTS designer_project_invitations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    designer_id BIGINT UNSIGNED NOT NULL,
    owner_id BIGINT UNSIGNED NOT NULL,
    member_role VARCHAR(32) NOT NULL DEFAULT 'designer',
    status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0:待处理 1:同意 2:拒绝',
    message VARCHAR(300) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_inviter_owner_role (designer_id, owner_id, member_role),
    INDEX idx_owner_role_status (owner_id, member_role, status),
    FOREIGN KEY (designer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 装修任务表
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

-- 项目进度事项：按项目阶段组织，支持最多三级父子事项
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

-- 项目进度验收
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
    FOREIGN KEY (progress_item_id) REFERENCES project_progress_items(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS project_progress_proposals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    submitted_by BIGINT UNSIGNED NOT NULL,
    pace_mode ENUM('normal', 'accelerated', 'relaxed') NOT NULL,
    planned_start DATE NOT NULL,
    note VARCHAR(500) DEFAULT NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    reviewed_by BIGINT UNSIGNED DEFAULT NULL,
    reviewed_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_progress_proposal_project (project_id, status, updated_at),
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 标准装修事项库：项目进度管理从这里选择适用事项
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

-- 项目待处理事项
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

CREATE TABLE IF NOT EXISTS help_faqs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    question VARCHAR(120) NOT NULL,
    answer TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_help_faq_active_sort (is_active, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO help_faqs (question, answer, sort_order, is_active)
SELECT '如何修改装修阶段？', '进入装修日志后，在项目进度或阶段相关入口中查看当前阶段。阶段变更涉及项目进度，建议由业主和项目成员确认后操作。', 10, 1
WHERE NOT EXISTS (SELECT 1 FROM help_faqs);

INSERT INTO help_faqs (question, answer, sort_order, is_active)
SELECT '工地打卡会公开吗？', '默认不会自动公开到装修圈。只有你主动发布或选择分享的内容，才会作为公开内容展示。', 20, 1
WHERE (SELECT COUNT(*) FROM help_faqs) < 2;

INSERT INTO help_faqs (question, answer, sort_order, is_active)
SELECT '如何更换绑定的设计师？', '进入我的工地或项目成员管理，先解除原设计师关系，再邀请新的设计师加入项目。', 30, 1
WHERE (SELECT COUNT(*) FROM help_faqs) < 3;

CREATE TABLE IF NOT EXISTS user_feedback (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED DEFAULT NULL,
    content TEXT NOT NULL,
    contact VARCHAR(80) DEFAULT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_feedback_status_time (status, created_at),
    INDEX idx_user_feedback_user (user_id, created_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 初始标签数据
INSERT IGNORE INTO tags (name, notes_count) VALUES
('全屋定制', 0), ('装修避坑', 0), ('奶油风', 0), ('客厅改造', 0),
('水电改造', 0), ('验收', 0), ('小户型', 0), ('空间设计', 0),
('瓷砖选购', 0), ('建材', 0), ('装修风格', 0), ('流行趋势', 0),
('省钱攻略', 0), ('预算控制', 0), ('无主灯', 0), ('灯光设计', 0),
('智能家装', 0), ('老房改造', 0), ('软装搭配', 0), ('收纳整理', 0);
