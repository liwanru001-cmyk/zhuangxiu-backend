ALTER TABLE project_members
  MODIFY role ENUM('owner', 'owner_member', 'designer', 'merchant', 'project_manager', 'project_supervisor')
  NOT NULL;

ALTER TABLE project_member_requests
  MODIFY member_role ENUM('owner_member', 'designer', 'project_manager', 'project_supervisor', 'merchant')
  NOT NULL;
