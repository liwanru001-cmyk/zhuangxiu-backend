# 部署准备检查清单

Status: Draft

更新时间：2026-07-06

## 本次已完成

后端验证：

- `node -c server/app.js` 通过
- `node --check server/public/admin/admin.js` 通过
- `node --check server/public/admin/modules/billing.js` 通过
- `node --test server/test/*.test.js` 通过，40 个测试全部通过

App 验证：

- `dart analyze lib/screens/marketplace_screen.dart` 通过
- `flutter test` 通过，90 个测试全部通过
- `flutter build web --release` 通过
- Web 产物目录：`zhuangxiu_app/build/web`
- Web 产物大小：约 48M
- Web 部署包：`deploy_artifacts/zhuangxiu_app_web_20260706_204357.tar.gz`

## 后端部署前确认

环境变量：

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
- `SMS_RATE_LIMIT_MAX`
- `FEATURE_INSPECTION_KB`

文件与目录：

- `server/.env` 已按生产环境配置
- `server/uploads` 目录存在且可写
- `server/logs` 目录存在且可写
- PM2 配置使用 `server/ecosystem.config.cjs`

启动命令：

```bash
cd server
npm install --omit=dev
pm2 start ecosystem.config.cjs --env production
```

健康检查：

- `GET /health`
- `GET /api/health`

## App Web 部署前确认

构建命令：

```bash
cd zhuangxiu_app
flutter build web --release
```

部署目录：

- 将 `zhuangxiu_app/build/web` 发布到 Web 静态站点目录

需要确认：

- Web 域名是否正确反代 `/api` 到后端
- 静态资源是否开启 gzip/br 压缩
- `index.html` 是否支持前端路由回退
- 上传文件域名与 `mediaUrl` 解析是否一致

## Billing / 商户管理上线前确认

数据库：

- 已执行 `db/migrate_billing_merchant_mvp.sql`
- `billing_*` 表存在
- 商户展示套餐初始数据存在

后台：

- `/admin/billing` 可访问
- 商户列表可查
- 订单记录可查
- 异常处理可查
- 手动开通、暂停、恢复、关闭入口可用

支付：

- 当前真实微信 / 支付宝 SDK 未接入
- 线上只能使用已有的手动支付 / 手动开通能力
- 未接真实支付前，不要开放真实在线支付入口

## 上线后烟测

1. 打开 App 首页。
2. 进入「找装修」。
3. 点击「区域」筛选，确认下拉显示全城、附近、热门区域。
4. 点击「类型」筛选，确认显示装修业务分类。
5. 进入「找商家」。
6. 点击「区域」筛选，确认交互一致。
7. 点击「类型」筛选，确认显示建材、家居及子品类。
8. 打开后台 `/admin/billing`。
9. 查看商户管理、订单记录、异常处理。
10. 点击右上角「操作说明」，确认弹窗可打开和关闭。

## 回滚准备

Web：

- 保留上一版 Web 包
- 回滚时恢复上一版静态目录

后端：

- 保留当前运行版本
- 如部署后接口异常，先回滚应用代码，不直接回滚数据库

数据库：

- 本次准备工作不执行 migration
- 真正执行 migration 前必须先备份数据库
