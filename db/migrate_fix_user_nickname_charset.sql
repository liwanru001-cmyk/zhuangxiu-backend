-- 修复新用户默认昵称可能因历史迁移编码错误而产生乱码。
ALTER TABLE users
    MODIFY nickname VARCHAR(50)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    NOT NULL DEFAULT '装修小达人';
