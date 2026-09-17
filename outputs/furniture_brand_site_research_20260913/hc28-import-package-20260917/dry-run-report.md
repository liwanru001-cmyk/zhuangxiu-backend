# HC28 导入 dry-run 报告

- 生成时间：2026-09-17
- 模式：只读；未连接生产数据库；未发起采集；未发布产品
- 原始文件 SHA-256：`fe1c4f7c53b76d978a77d470d5f1b42b68763e9f50692853137421a573d8fb8e`

## 结论

PASS

## 校验结果

- PASS：product_id 唯一（10 records）
- PASS：内容指纹完整且唯一（10 fingerprints）
- PASS：来源与素材 URL 白名单（745 URLs; allowed_hosts=['hc28study.oss-cn-beijing.aliyuncs.com', 'www.hc28maison.com']; bad=0）
- PASS：variant_id 唯一（111 variants）
- PASS：原始质量审计无错误（errors=0）

## 数据规模

- 产品：10
- 变体：111
- 产品/变体图片：239
- 材质代码：476

## 生产导入前置条件

- 当前包明确标记为 `no_crawl_no_publish`，只允许落入待审核候选。
- 仓库现有管理 API 没有“从本地金标准批量创建候选”的导入端点；dry-run 不会伪造生产写入。
- 需要先通过受控导入适配器把本包转换为生产候选记录，再由管理 Web 审核后发布。
