-- 装修圈信息流补充发布来源和筛选索引。
-- source_type 是 VARCHAR 字段，新来源不需要改列类型；这里更新注释并补充常用筛选索引。

ALTER TABLE notes
    MODIFY COLUMN source_type VARCHAR(30) NOT NULL DEFAULT 'legacy'
        COMMENT 'site_photos, complaint, site_check_in, question, good_item, inspiration, legacy';

CREATE INDEX idx_note_feed_source_status_created
    ON notes (source_type, status, created_at);

CREATE INDEX idx_note_feed_city_status_created
    ON notes (city, status, created_at);

CREATE INDEX idx_note_feed_style_status_created
    ON notes (decoration_style, status, created_at);
