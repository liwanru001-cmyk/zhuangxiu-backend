# 验收步骤记录迁移规则

## 目标

将历史 `project_inspection_step_records` 整理为：

```text
验收主记录 project_inspections
└── 检查项 project_inspection_items
```

历史表暂不删除，只增加 `inspection_id` 关联字段，作为审计和回滚依据。

## 分组规则

同一个 `project_id + stage_id + progress_item_id` 组成一条验收主记录。

- 有 `progress_item_id` 时，主记录继承进度事项标题及任务。
- 没有 `progress_item_id` 时，按项目阶段建立主记录，允许 `task_id` 为空。
- 主记录使用固定 `client_request_id`，重复执行迁移不会重复创建。

## 检查项规则

- 相同分组内，以 `step_key` 识别同一个检查项。
- 同一检查项有多次历史记录时，最新一条作为当前结果。
- 所有历史记录仍保留，并统一写入对应主记录的 `inspection_id`。
- 最新记录的图片复制到检查项图片表，保留原图片编号，重复迁移不会重复复制。

状态映射：

| 历史状态 | 检查项结果 |
|---|---|
| `recorded` | `passed` |
| `rework` | `failed` |
| `pending_owner_view` | `pending` |
| `pending_member_check` | `pending` |

主记录状态：

- 任一检查项需要整改：`rework`
- 否则任一检查项待处理：`pending`
- 全部已记录：`passed`

## 执行方式

先运行预演，只输出数量和分组，不修改数据：

```bash
node scripts/migrate-inspection-step-records.js
```

核对预演结果并完成数据库备份后，再执行：

```bash
node scripts/migrate-inspection-step-records.js --apply
```

整个迁移在单个事务中执行；任意一条失败会整体回滚。

## 上线顺序

1. 备份数据库。
2. 部署新增字段和新表。
3. 运行预演并保存输出。
4. 执行迁移。
5. 核对主记录数、检查项数和未关联历史记录数。
6. 部署 App/桌面版新页面。
7. 观察一个发布周期后，再决定是否停止旧步骤写入接口。

迁移完成后，普通接口不再返回已关联的旧步骤记录；传
`include_migrated=1` 仍可用于审计查询。
