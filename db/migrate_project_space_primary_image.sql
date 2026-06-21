-- 效果图支持选择一张作为空间默认展示图。

DROP PROCEDURE IF EXISTS add_project_space_primary_image;

DELIMITER //
CREATE PROCEDURE add_project_space_primary_image()
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'project_space_images'
          AND COLUMN_NAME = 'is_primary'
    ) THEN
        ALTER TABLE project_space_images
            ADD COLUMN is_primary TINYINT UNSIGNED NOT NULL DEFAULT 0
                AFTER image_url;
    END IF;
END//
DELIMITER ;

CALL add_project_space_primary_image();
DROP PROCEDURE add_project_space_primary_image;

CREATE TEMPORARY TABLE first_project_space_renderings AS
SELECT first_rendering.space_id, first_rendering.image_id
FROM (
    SELECT space_id, MIN(id) AS image_id
    FROM project_space_images
    WHERE image_type = 'rendering'
    GROUP BY space_id
) first_rendering
LEFT JOIN (
    SELECT DISTINCT space_id
    FROM project_space_images
    WHERE image_type = 'rendering' AND is_primary = 1
) selected ON selected.space_id = first_rendering.space_id
WHERE selected.space_id IS NULL;

UPDATE project_space_images image
JOIN first_project_space_renderings first_rendering
    ON first_rendering.image_id = image.id
SET image.is_primary = 1;

DROP TEMPORARY TABLE first_project_space_renderings;
