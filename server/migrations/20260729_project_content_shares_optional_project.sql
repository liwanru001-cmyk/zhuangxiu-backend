ALTER TABLE project_content_shares
  DROP FOREIGN KEY fk_project_content_share_project;

ALTER TABLE project_content_shares
  MODIFY COLUMN project_id BIGINT UNSIGNED NULL;

ALTER TABLE project_content_shares
  ADD CONSTRAINT fk_project_content_share_project
    FOREIGN KEY (project_id) REFERENCES renovation_projects(id) ON DELETE CASCADE;
