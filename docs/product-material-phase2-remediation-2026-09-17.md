# 产品与材料采集系统第二阶段修复记录

日期：2026-09-17

范围：只处理采集全局并发、生产依赖漏洞、迁移 checksum 和生产环境契约。未扩充 `/health`，未实施可观测性、优雅停机或 CORS 改造。

## 1. 采集全局并发

- 新增 MySQL advisory-lock 全局槽位，默认并发数为 2，允许范围为 1–8。
- 站点认知、URL 发现和产品提取共用同一组槽位，因此多进程或多实例不会各自突破上限。
- 锁由独占数据库连接持有，任务结束或连接断开时释放。
- 没有可用槽位时，任务保持原排队状态并延迟重试，不会被错误标记为失败。
- 锁命名空间默认取数据库名；如多个部署有意共用同一数据库，可用 `INGESTION_LOCK_NAMESPACE` 显式固定。

## 2. 生产依赖漏洞

升级并锁定：

- Express `4.22.3`；
- Multer `2.4.0`；
- mysql2 `3.24.4`；
- Sharp `0.35.4`；
- `qs` `6.16.0` override；
- `image-size` `2.0.4` override，保持 PPTXGenJS 4.x 不降级。

`npm audit --omit=dev` 从 3 个高危、4 个中危降为 0。新增真实 multipart 上传和 Sharp 图像转换兼容测试，避免只更新锁文件而未验证运行时行为。

## 3. 迁移 checksum

- 对 `schema_migrations` 中每个已执行迁移强制比较当前 SQL 文件 SHA-256。
- checksum 不一致时抛出 `MIGRATION_CHECKSUM_MISMATCH`，在任何待执行迁移运行前终止。
- 历史迁移视为不可变；结构调整必须新增迁移文件，不能修改旧文件。
- checksum 基于文件精确字节，换行符变化也会被识别为漂移。

## 4. 生产环境契约

新增 `npm run check:production-contract -- --connectivity`，部署时在迁移之前执行。检查：

- Node.js 主版本与 CI 均为 22；
- 管理员认证、数据库和采集并发配置；
- 采集 AI 密钥、模型、HTTPS 地址和端点；
- Chromium 路径和实际启动；
- Redis URL、禁止生产内存降级，以及只读 `PING`；
- OSS 配置和只读 bucket metadata（仅 OSS 模式）；
- `fc-match` 和指定中文 fallback 字体。

生产契约失败会阻断部署，不执行数据库迁移。检查不写生产业务数据。

## 验证与剩余边界

- 全量 Node 测试、依赖树检查、`npm audit --omit=dev`、JS 语法、工作流 YAML 和发布清单需全部通过后才能形成候选提交。
- 本阶段没有部署生产、没有执行生产数据库迁移、没有修改生产数据。
- `/health` 扩充、结构化可观测性、优雅停机和 CORS 收敛仍属于后续生产强化项。
