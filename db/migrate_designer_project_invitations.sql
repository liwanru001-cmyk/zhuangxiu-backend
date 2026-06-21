-- 设计师与业主双向申请工地管理关系。
-- 可重复执行。

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

SET @has_member_role := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND COLUMN_NAME = 'member_role'
);
SET @ddl := IF(
    @has_member_role = 0,
    'ALTER TABLE designer_project_invitations ADD COLUMN member_role VARCHAR(32) NOT NULL DEFAULT ''designer'' AFTER owner_id',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_role_unique := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND INDEX_NAME = 'uk_inviter_owner_role'
);
SET @ddl := IF(
    @has_role_unique = 0,
    'ALTER TABLE designer_project_invitations ADD UNIQUE KEY uk_inviter_owner_role (designer_id, owner_id, member_role)',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_old_unique := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND INDEX_NAME = 'uk_designer_owner'
);
SET @ddl := IF(
    @has_old_unique > 0,
    'ALTER TABLE designer_project_invitations DROP INDEX uk_designer_owner',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_owner_role_index := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND INDEX_NAME = 'idx_owner_role_status'
);
SET @ddl := IF(
    @has_owner_role_index = 0,
    'CREATE INDEX idx_owner_role_status ON designer_project_invitations (owner_id, member_role, status)',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
