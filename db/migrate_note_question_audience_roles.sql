-- 问问大家：让提问对象和系统身份标签保持一致。

ALTER TABLE notes
    MODIFY COLUMN question_audience
        ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor', 'user', 'all')
        DEFAULT NULL;
