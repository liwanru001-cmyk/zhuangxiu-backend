ALTER TABLE renovation_projects
    ADD COLUMN project_code CHAR(10) NULL AFTER user_id;

UPDATE renovation_projects
SET project_code = CONCAT(
    CHAR(65 + MOD(id, 26)),
    CHAR(65 + MOD(FLOOR(id / 26), 26)),
    LPAD(id, 8, '0')
)
WHERE project_code IS NULL OR project_code = '';

ALTER TABLE renovation_projects
    MODIFY project_code CHAR(10) NOT NULL,
    ADD UNIQUE KEY uk_project_code (project_code);
