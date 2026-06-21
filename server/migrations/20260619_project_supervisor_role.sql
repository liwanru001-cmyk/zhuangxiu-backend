ALTER TABLE users
  MODIFY role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor')
  NOT NULL DEFAULT 'owner';

ALTER TABLE user_roles
  MODIFY role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor')
  NOT NULL;

ALTER TABLE notes
  MODIFY publish_role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor')
  DEFAULT NULL,
  MODIFY question_audience ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor', 'user', 'all')
  DEFAULT NULL;

ALTER TABLE project_members
  MODIFY role ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor')
  NOT NULL;

ALTER TABLE project_member_requests
  MODIFY member_role ENUM('designer', 'project_manager', 'project_supervisor', 'merchant')
  NOT NULL;

ALTER TABLE designer_consultations
  MODIFY target_role ENUM('designer', 'project_manager', 'project_supervisor', 'merchant')
  NOT NULL DEFAULT 'designer';
