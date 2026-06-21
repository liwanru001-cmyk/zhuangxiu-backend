-- 用户笔记可见性状态：
-- 0 待审核，1 正常公开，2 管理员隐藏/驳回，3 仅自己可见，4 用户删除。

ALTER TABLE notes
    MODIFY COLUMN status TINYINT DEFAULT 0
        COMMENT '0:待审核 1:正常 2:隐藏/驳回 3:仅自己可见 4:用户删除';
