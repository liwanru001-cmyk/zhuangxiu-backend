# 装筱窝 AI PPT v2：实施与验收

## 范围与执行路径

新提交的异步任务使用 `_generation_version=2`（服务器覆盖，客户端不能降版本）。旧任务与旧同步目录/导出接口保留原逻辑，历史 JSON 无须迁移。

第一阶段 v2：原始 source/settings 快照 → 可引用素材清单/Preview → 字体环境自检 → 多模态 Qwen → Schema/字体/几何/文字/遮挡验证 → 生成 PPTX → 保存文件。真实 PPTX/PDF 渲染验证暂时关闭，后续迁移到独立渲染环境后启用。

整份任务只允许一轮修正：仅轻微文字溢出时服务器最多缩字 4%；否则一次模型调用集中重设计失败页。服务器修正失败后不再请求模型，模型修正失败后不再服务器修正。warning 不触发修正。无法定位失败页的非法整体 JSON 直接降级，禁止重生成整套 v2。

降级从最初的 source/settings 独立重新生成旧目录，最多一次模型请求。旧流程使用快照中的高清文件，禁止读取 v2 文案或补旧模板页面。项目权限、关键文件、存储和渲染环境等基础问题直接失败。

## 文件分工

- `server/services/presentation-v2/assets.js`：来源化 ID、内容 SHA256、素材快照、代表图、原图和 Preview 缓存。
- `schema.js/config.js`：严格 JSON Schema、执行单位和资源限制。
- `model.js`：Qwen 多模态请求、失败页重设计、原始响应和 usage 记录。
- `validate.js`：字体解析、Pango 字形测量、旋转边界、遮挡分类、受控轻修正。
- `render.js/render-process.js`：PptxGenJS 通用绘制、隔离子进程；`full` 模式支持 LibreOffice/PDF.js 检查。
- `pipeline.js`：单轮修正和独立 legacy 路径。
- `job-store.js`：持久化额度、截止时间、事件与结果。
- `presentation-jobs.js`：原队列接入、跨进程并发锁、授权复核、文件完成状态。
- Flutter `project_presentation.dart`、设置页与列表页：v1/v2 结果读取和降级提示。

## 素材与模型输入

每空间（含独立全屋范围）最多一张 `layout_plan` 和一张效果图。只在已有素材范围中选择，缺少平面方案不拿施工图凑数。效果图优先现有 `is_primary`，再按原有排序和 ID。设计资料目前没有独立封面字段，不新增虚构封面状态。

统一引用由来源、业务 ID、角色、版本及内容指纹组成。不同来源的同号 ID 不冲突。Preview 标识与原图标识属于同一素材；模型仅见 Preview，PPT 使用高清文件。PDF 本轮仍只转换第一页。CAD 等原格式使用既有可打印转换件，不扩展新的 CAD 转换系统。

缓存位于私有结果目录的 `assets/project-<id>/`，按内容哈希及 Preview 参数命名，跨任务复用转换和压缩结果。记录关联的文件不可随意清理，否则历史重放将失败。原始文件和转换结果都保留在私有目录，下载依然通过项目授权路由。

未发送图片的素材标记 `vision_preview_provided=false`；修正请求只发送失败页涉及的代表图，并按这次实际发送情况重置标记。商品价格继续遵守展示开关和单品的价格展示授权。所选材质色卡在开启材质展示时进入可用素材清单，不额外发送视觉图片。v2 输入移除旧 template_id，界面不再显示固定暖色模板选择。

## 数据库与任务预算

不修改现有业务主键、不强制更新旧 Schema。首次使用时幂等创建：

- `project_presentation_runs`：`model_requests`、`initial_used`、`model_repair_used`、`legacy_used`、`repair_used`、`fallback_used`、`deadline_at`、状态快照、最终结果。
- `project_presentation_events`：逐次请求（不含密钥或图片 Base64）、原始模型响应、usage、验证/修正前后设计、环境、降级原因及失败链。

外部调用前通过受 worker token、租约和截止时间约束的原子 UPDATE 占用额度。初始/模型修正/legacy 每阶段最多一次，整任务最多三次。超时和未知结果也消耗次数。网络库没有自动重试。恢复和用户“重试”不重置这些额度、截止时间或恢复次数。

未知初始调用结果不会重复请求；可转 legacy。已保存设计/修正结果/旧目录优先复用。已持久化降级意图可在恢复后继续；若 legacy 调用结果未知且已占用额度，则明确失败。

数据库命名锁使多进程 worker 全局最多一个生成任务执行；提交命名锁与队列容量检查限制排队量。渲染在独立 Node 子进程运行，内存和超时受限。正文测量与素材处理逐项执行，并检查总任务取消信号。

文件存在并保存成功后才写完成状态。第一阶段静态模式结果为 `ai_success_unverified_render` 或 `ai_repaired_success_unverified_render`，并保存 `render_validation=skipped` 和原因；完整渲染模式使用 `ai_success` 或 `ai_repaired_success`。降级和失败分别为 `legacy_fallback_success`、`failed`。原队列仍使用 `queued/running/completed/failed` 保持旧客户端兼容。

## 默认资源限制

| 资源 | 默认值 |
|---|---:|
| 模型请求 | 3 次，持久化硬限制 |
| 修正/降级 | 各 1 次，持久化硬限制 |
| 页数/每页元素/总元素 | 40 / 40 / 600 |
| 素材/视觉图片 | 300 / 32 |
| Preview 长边/JPEG 质量 | 768 / 78 |
| 模型文字输入 | 250,000 UTF-8 bytes（不是 Token 实测值） |
| 每次模型最大输出 | 24,000 tokens |
| 单文件/单图解码像素 | 30 MB / 40 MP |
| 每任务素材文件总量/总像素 | 512 MB / 200 MP（相同内容不重复累计） |
| 单模型调用/渲染/总任务 | 180 秒 / 90 秒 / 900 秒 |
| 排队加执行任务数 | 100 |

参数写在 `.env.example`。任务保存 limits 快照，恢复不会因新配置扩大已创建任务的额度。文件体积/页面/时间限制均为第一版工程上限，可依据真实项目调整；不是审美模板。

## 部署准备

1. 安装锁定依赖：`npm ci`。PDF.js 固定为已验证的 `5.4.149`；不要未经验证扩大版本范围。CI 当前使用 Node 22。
2. MySQL 账号需要创建两张新表的权限；首次发布前可在测试环境触发建表并检查。
3. 第一阶段配置 `PRESENTATION_V2_RENDER_VALIDATION=static`，服务器只需预装 Fontconfig 和中文字体（默认 `Noto Sans CJK SC`）。部署脚本只检查环境，禁止安装操作系统软件包。未来独立渲染环境配置 `full`、`PRESENTATION_SOFFICE` 和 Poppler。
4. v2 使用北京业务空间专属 OpenAI 兼容地址和 `qwen3.8-max`。生产部署在原 `PRESENTATION_AI_MODEL` 为 Qwen 时复用现有同地域 Key，并把值固化为 `PRESENTATION_V2_*`；也可用同名 GitHub Actions Secrets 显式覆盖。不得使用只允许编程工具的 Token Plan/Coding Plan Key。
5. 保留原 `PRESENTATION_AI_*` 供 legacy 使用。设置稳定私有 `PRESENTATION_RESULTS_DIR`，禁止放入公开 storage 目录。
6. 本地可用 bundled LibreOffice 验收完整渲染模式，不使用桌面版 LibreOffice。
7. 线上先执行静态环境自检和最小视觉模型探针，再用一个授权真实项目联调。模型效果、账单及版面质量以实际试跑为准。

## 验证命令

```sh
cd server
npm test
# 可选：启动临时、无 TCP 的隔离 MySQL，测试原子计数及完整 worker；不访问业务库。
PRESENTATION_MYSQL_TEST=1 node --test test/presentation-v2-mysql.test.js
# 静态模式检查字体与 PPTX 生成；不调用模型。
npm run check:presentation-v2
# 独立渲染环境可额外运行完整渲染样张验证。
PRESENTATION_V2_RENDER_VALIDATION=full node scripts/verify-presentation-v2.js tmp/presentation-v2-proof
```

```sh
cd zhuangxiu_app
flutter test --no-pub test/project_presentation_v2_model_test.dart
dart analyze lib/models/project_presentation.dart lib/screens/project_presentation_list_screen.dart
```

## 验证能力与边界

Pango 使用实际字体字形测量文本，支持宽度换行、字号、粗细、行距、段距、内边距及对齐。它不等同于 PowerPoint 的排版引擎。第一阶段因此明确记录为未经过真实渲染验证，不能把静态通过统计为完整渲染通过。未来 `full` 模式由 LibreOffice 转为 PDF，检查页数、文本字符覆盖和未旋转文本框的实际文字边界。

警告不证明版面错误，也不会触发修正。复杂图像的主体是否被裁掉、半透明遮挡后的可读性、旋转文本的精确字形覆盖等仍需人工审阅，不能宣称算法保证所有 PowerPoint 客户端完全一致。

本轮无真实 Qwen 凭证联调，未测真实模型视觉质量与 Token 增幅。之前“约 4 倍 Token”的预算仍只是估算，新增 usage 事件用于后续同项目对照。

## 本次本地验收结果

- 后端普通测试、隔离 MySQL 原子额度与完整 worker 测试均通过。
- Flutter v1/v2 读取与降级提示测试通过；Dart 检查未发现 error/warning，列表页仍有一条原有的 if 花括号风格提示。
- bundled LibreOffice 的中文字体预检、两页渲染样张和故意制造的文字溢出检测通过；两页 PNG 已目视检查。
- 未发布到生产环境，未调用真实 Qwen，未修改现有业务库数据。
