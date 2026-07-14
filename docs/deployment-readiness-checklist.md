# 部署准备检查清单

Status: Ready for backend/admin/miniprogram pre-deploy

更新时间：2026-07-14

## 本次部署范围

本次不部署原生 App，不构建 Flutter App，也不更新 App 商店包。

需要准备和发布的范围：

- 后端接口：`server/`
- Web 管理后台静态页：`server/public/admin/`
- 小程序代码：通过微信开发者工具上传，服务器不打包小程序源码

## 本次已完成检查

后端：

- 后端 JS/CJS 语法检查通过
- `npm test` 通过，65 个测试全部通过
- 后端部署包 dry-run 已生成：`deploy_artifacts/yinnkhome-backend-predeploy.tar.gz`
- dry-run 包未包含 `server/public`、`uploads`、`logs`、`storage`、原生 App 目录

小程序：

- 小程序 JS 语法检查通过
- 小程序 JSON 配置解析通过，45 个 JSON 文件正常
- 当前接口域名：`https://yinnkhome.com/api`
- 当前上传/资源域名：`https://yinnkhome.com`
- 当前小程序目录约 1.5MB，暂未到必须分包的体量

## 后端部署前确认

生产环境变量：

- `PORT`
- `NODE_ENV=production`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `JWT_SECRET`
- `UPLOAD_DIR`
- `MAX_FILE_SIZE`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX`
- `REDIS_URL`
- `SMS_RATE_LIMIT_ALLOW_MEMORY_FALLBACK=false`
- `ALI_ACCESS_KEY_ID`
- `ALI_ACCESS_KEY_SECRET`
- `ALI_SMS_SIGN_NAME`
- `ALI_SMS_TEMPLATE_CODE`
- `WECHAT_MINIPROGRAM_APPID`
- `WECHAT_MINIPROGRAM_SECRET`

部署前必须确认：

- 生产 `server/.env` 已补齐微信小程序 `appid/secret`
- 微信小程序后台 request 合法域名包含 `https://yinnkhome.com`
- Nginx 已正确反代 `/api` 到后端
- 上传目录 `uploads` 可写
- 日志目录 `logs` 可写
- Redis 可用，生产环境不要启用短信内存降级

## 数据库迁移

部署 workflow 已补入本次新增迁移：

- `migrations/20260713_project_checkin_member_shares.sql`
- `migrations/20260714_wechat_miniprogram_identities.sql`
- `migrations/20260714_wechat_binding_appeals.sql`

上线前建议先备份数据库。迁移失败时优先回滚应用代码，不要直接回滚数据库。

## GitHub Actions 部署路径

后端：

- workflow：`.github/workflows/deploy-backend.yml`
- 触发范围：`server/**`，但不上传 `server/public/**`
- 生产目录默认：`/opt/yinnkhome-backend`

管理后台：

- workflow：`.github/workflows/deploy-admin-static.yml`
- 触发范围：`server/public/admin/**`
- 后端和管理后台同时变更时，后台静态页会等待同 commit 后端部署成功后再发布

小程序：

- 使用微信开发者工具打开 `miniprogram/`
- 上传前先运行开发者工具的编译和代码质量检查
- 体验版先验证登录、同步微信、异常绑定提交、后台异常绑定处理、站内咨询、公司名片分享

## 上线后烟测

后端：

1. `GET https://yinnkhome.com/health`
2. `GET https://yinnkhome.com/api/health`
3. 管理后台登录 `/admin/`
4. 用户管理 tab 可打开
5. 用户管理里的「异常绑定」tab 可打开并筛选

小程序：

1. 手机号登录正常
2. 微信手机号登录正常
3. 老账号点击「同步微信」正常
4. 微信绑定冲突时，小程序提示已提交管理员处理
5. 后台「异常绑定」能看到记录并可标记处理中/已解决/已驳回
6. 商家中心、我的装修公司、公司名片、站内咨询入口可打开
7. 工地打卡分享页面可打开

## 回滚准备

后端：

- workflow 会保留上一个部署目录备份
- 健康检查失败时优先回滚应用代码

管理后台：

- 静态页可用上一版 `server/public/admin` 覆盖恢复

数据库：

- 新增表为兼容性扩展，不影响旧 App 读取
- 如果需要关闭微信绑定能力，先隐藏小程序入口或回滚后端代码，不删除表
