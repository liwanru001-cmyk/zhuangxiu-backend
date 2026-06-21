-- 为四种发布内容增加稳定的来源标识。
-- 取值：site_photos、complaint、site_check_in、question。
-- legacy 用于兼容迁移前已经存在的笔记。

ALTER TABLE notes
    ADD COLUMN source_type VARCHAR(30) NOT NULL DEFAULT 'legacy'
        COMMENT 'site_photos, complaint, site_check_in, question, legacy'
        AFTER content,
    ADD INDEX idx_source_type (source_type);
