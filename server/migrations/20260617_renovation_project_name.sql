ALTER TABLE renovation_projects
  ADD COLUMN project_name VARCHAR(80) NOT NULL DEFAULT '装修项目' AFTER user_id;
