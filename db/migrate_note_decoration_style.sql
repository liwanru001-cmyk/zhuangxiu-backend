-- 为首页风格筛选增加专用字段。仅执行一次。
ALTER TABLE notes
    ADD COLUMN decoration_style VARCHAR(30) DEFAULT '' AFTER category,
    ADD INDEX idx_decoration_style (decoration_style);
