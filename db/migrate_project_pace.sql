-- 项目进度节奏管理。

DROP PROCEDURE IF EXISTS add_project_pace_columns;

DELIMITER //
CREATE PROCEDURE add_project_pace_columns()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'renovation_projects'
          AND COLUMN_NAME = 'pace_mode'
    ) THEN
        ALTER TABLE renovation_projects
            ADD COLUMN pace_mode ENUM('normal', 'accelerated', 'relaxed', 'paused')
                NOT NULL DEFAULT 'normal' AFTER status,
            ADD COLUMN pace_updated_at DATETIME DEFAULT NULL AFTER pace_mode;
    END IF;
END//
DELIMITER ;

CALL add_project_pace_columns();
DROP PROCEDURE add_project_pace_columns;

