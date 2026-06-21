-- 将业主申请改为按具体项目发送。执行前请备份数据库。
-- 旧申请没有项目归属，迁移时关联到该业主最新创建的项目。

ALTER TABLE designer_requests
    ADD COLUMN project_id BIGINT UNSIGNED NULL AFTER designer_id;

UPDATE designer_requests r
JOIN (
    SELECT p.user_id, MAX(p.id) AS project_id
    FROM renovation_projects p
    GROUP BY p.user_id
) latest ON latest.user_id = r.owner_id
SET r.project_id = latest.project_id
WHERE r.project_id IS NULL;

DELETE FROM designer_requests WHERE project_id IS NULL;

ALTER TABLE designer_requests
    ADD INDEX idx_request_owner (owner_id);

ALTER TABLE designer_requests
    DROP INDEX uk_owner_designer,
    MODIFY project_id BIGINT UNSIGNED NOT NULL,
    ADD UNIQUE KEY uk_project_designer (project_id, designer_id),
    ADD INDEX idx_request_project (project_id),
    ADD CONSTRAINT fk_designer_request_project
        FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE;
