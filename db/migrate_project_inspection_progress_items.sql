-- 验收记录关联具体进度事项，用于通过验收驱动事项完成状态。

ALTER TABLE project_inspections
    ADD COLUMN progress_item_id BIGINT UNSIGNED DEFAULT NULL AFTER task_id,
    ADD COLUMN responsible_user_id BIGINT UNSIGNED DEFAULT NULL AFTER submitted_by,
    ADD INDEX idx_inspection_progress_item (progress_item_id, updated_at),
    ADD INDEX idx_inspection_responsible (responsible_user_id, status, updated_at),
    ADD CONSTRAINT fk_inspection_progress_item
        FOREIGN KEY (progress_item_id) REFERENCES project_progress_items(id)
        ON DELETE SET NULL,
    ADD CONSTRAINT fk_inspection_responsible
        FOREIGN KEY (responsible_user_id) REFERENCES users(id)
        ON DELETE SET NULL;
