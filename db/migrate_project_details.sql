-- 扩展装修项目资料。仅执行一次。
ALTER TABLE renovation_projects
    ADD COLUMN project_type ENUM('refined', 'rough', 'office', 'commercial')
        NOT NULL DEFAULT 'rough' AFTER status,
    ADD COLUMN house_layout VARCHAR(100) DEFAULT NULL AFTER project_type,
    ADD COLUMN floor_plan_image VARCHAR(500) DEFAULT NULL AFTER house_layout,
    ADD COLUMN renovation_method ENUM('self', 'company', 'independent_designer')
        NOT NULL DEFAULT 'self' AFTER floor_plan_image;
