-- 问问大家：记录希望由哪类用户回答。

ALTER TABLE notes
    ADD COLUMN question_audience
        ENUM('owner', 'designer', 'merchant', 'project_manager', 'project_supervisor', 'user', 'all')
        DEFAULT NULL AFTER publish_role,
    ADD INDEX idx_note_question_audience (question_audience);
