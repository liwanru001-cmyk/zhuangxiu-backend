-- 项目进度事项关联标准装修事项库，用于判断已加入、未加入和验收模板推荐。
ALTER TABLE project_progress_items
    ADD COLUMN template_key VARCHAR(80) DEFAULT NULL AFTER parent_id,
    ADD COLUMN requires_inspection TINYINT(1) NOT NULL DEFAULT 0 AFTER is_key_node,
    ADD COLUMN inspection_template_key VARCHAR(64) DEFAULT NULL AFTER requires_inspection,
    ADD INDEX idx_progress_item_template (project_id, template_key);
