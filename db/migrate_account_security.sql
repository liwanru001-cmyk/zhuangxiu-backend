-- 账号安全：为现有用户增加独立密码。
-- NULL 表示尚未设置个人密码，测试阶段仍可使用 TEST_LOGIN_PASSWORD。

ALTER TABLE users
    ADD COLUMN password_hash VARCHAR(255) DEFAULT NULL AFTER phone;
