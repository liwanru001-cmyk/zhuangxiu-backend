-- 允许一个业主创建多个工地。可重复执行前先确认 uk_user_id 是否存在。
CREATE INDEX idx_renovation_owner ON renovation_projects (user_id, created_at);
ALTER TABLE renovation_projects DROP INDEX user_id;
