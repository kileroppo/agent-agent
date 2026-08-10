# 历史能力验证批次业务 E2E 交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-10（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | A君 / 负责人 |
| 关联任务 | [Business Workflow 与能力治理 live 验收记录](../../reviews/workflow-capability-validation-2026-08-10.md) |
| 截止条件 | 5 类能力均产生新的成功任务、可验证产物；研究/内容质量完成人工抽查 |

## 1. 接手目标

- 目标：按 live `validationCampaign` 将剩余 10 条历史失败逐类复验，不改写历史终态。
- 用户约束与不可做事项：不自动发布、不恢复 M5 Campaign、不启动 Publisher、不绕过预算 Policy、不无限重试。
- 做完的定义：小R、小拆、小创、失败恢复、隔离修复五类均有新的当前证据；质量型产物完成人工抽查。
- 唯一下一步：负责人明确允许一次有费用上限、无发布动作的模型型复验后，A君复用任务 `#10E4F814` 的已确认转录，以 `visualMode=off` 创建一条小拆纯文本精华提炼任务。
- 允许继续的前提：预算 Policy 返回自动允许或负责人完成所需审批；不得以本交接单代替费用授权。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 10 条任务已聚合为 5 类，每类具备自动方法、标准、人工检查和失败处置 | `apps/ajun-runtime/src/workflow/validation-campaign.ts` | 已验证 |
| 本地运行时 | release `08a5db91…`，PID `80387`；live 显示 `taskCount=10`、`groupCount=5`、`ownerActionable=0` | `runtime:fingerprint`、`GET /api/overview` | 已验证 |
| 外部平台 | 本轮未调用 Provider，Publisher、Campaign、Cron 与平台写入保持关闭 | 当前运行时与验收记录 | 未验证 |
| 人工确认 | 恢复/修复代码层无需人工内容验收；研究/视频/创作结果仍需抽查 | `validationCampaign.groups[].humanCheck` | 待确认 |

## 3. 变更与决策

- 已完成：92 条旧任务由后续成功产物、正式委派或已激活岗位证据消债；32 条受控验收失败归档；剩余 10 条不再冒充当前待办。
- 关键文件：`workflow/backlog-classification.ts`、`workflow/validation-campaign.ts`、`task-validation-overview.ts`。
- 边界：模型能力先走岗位 Manifest 与预算 Policy；本机暂时故障只恢复一次、重试一次；仍不可用才提示用户。
- 不要重复创建：不得重复运行旧 M5 StepFun 批次；不得重新创建已成功的小D确认稿任务。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 根目录 `npm test`；`npm run check:architecture`；恢复/修复专项 53 项通过 | 模型输出业务质量 |
| 运行时 | PASS | release 冻结双冒烟；A君、小D只读健康探针 200；live 验证批次 10/5 | 新业务任务终态 |
| 外部平台 | NOT CHECKED | 本轮零 Provider、零发布 | Provider 可用性、外部来源实时可读性 |
| 人工验收 | NOT CHECKED | 尚未生成本批次的新质量产物 | 研究结论、视频提炼、内容草稿质量 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：历史错误只能说明当时失败；代码和健康检查通过不能替代新的业务 E2E。
- 不得复制或展示的信息：Provider Secret、飞书凭据、Cookie、原始私有素材路径。
- 需要谁确认：负责人确认模型型复验的费用范围，并对三类质量产物抽查。
- 关闭条件：live `validationCampaign.taskCount=0`，或每条保留为明确接受的外部/人工风险且验收记录同步。
- 关闭证据链接：[Business Workflow 与能力治理 live 验收记录](../../reviews/workflow-capability-validation-2026-08-10.md)。
