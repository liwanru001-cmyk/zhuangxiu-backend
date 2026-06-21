-- 公开发布内容补充装修阶段和发布身份。

ALTER TABLE notes
    ADD COLUMN stage_id TINYINT UNSIGNED DEFAULT NULL AFTER source_type,
    ADD COLUMN publish_role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor')
        DEFAULT NULL AFTER stage_id,
    ADD INDEX idx_note_stage (stage_id),
    ADD INDEX idx_note_publish_role (publish_role);
