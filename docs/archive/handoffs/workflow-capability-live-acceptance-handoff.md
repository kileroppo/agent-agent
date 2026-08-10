# Business Workflow 与能力治理 live 验收交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-08-10（Asia/Shanghai） |
| 交出者 | Codex 工作台 |
| 接手者 | 产品负责人 / 后续发布执行者 |
| 关联任务 | [ADR-0012](../../adr/0012-workflow-first-capability-policy-and-evaluation.md)、[候选验收记录](../../reviews/workflow-capability-validation-2026-08-10.md) |
| 关闭时间 | 2026-08-10 11:41（Asia/Shanghai） |
| 截止条件 | 已满足：新不可变 release 切换并完成一条真实飞书业务 Workflow 与人工评价 |

## 1. 接手目标

- 目标：让 4321 live 使用候选 Workflow/Policy/能力真相实现，并完成外部和人工验收。
- 用户约束与不可做事项：不读取凭据；不启用 Publisher、Campaign、Cron；不执行付费 Provider 或平台写入。
- 做完的定义：live 指纹指向新 clean release；飞书不再回答“全部可用”；一条质量型任务留下 ExecutionReceipt、验证产物和人工验收。
- 唯一下一步：无。如继续验证其他业务能力，按业务优先级新建验收任务，不重开本交接。
- 允许继续的前提：新任务保持 Publisher/外写默认关闭，需要外部权限时单独授权。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | Workflow/Policy/Receipt/Evaluation、识图恢复、能力真相和人工验收已实现 | 候选验收记录 | 已验证 |
| 本地运行时 | 4321 为 release `7adb3f3d…` / Git `b18c3d2…`，`same_git_head` | `npm run runtime:fingerprint` | 已验证 |
| 外部平台 | 真实飞书 Workflow `#167203DF` 完成；Publisher 仍关闭 | 候选验收记录 | 已验证只读链路 |
| 人工确认 | 原飞书会话评价已写入 `useful` / `accepted` | 任务 `#167203DF` | 已确认 |

## 3. 变更与决策

- 新核心 Module 使用 TypeScript；现有 JavaScript Provider 只经 Adapter 接入。
- Model 不自批；同机低风险能力有界恢复，外部写入与扩权继续走 Paperclip。
- 历史 237 条验证欠账只读分类，不批量重试或改写。
- 当前工作树含此前已有的 Hermes、小R、M5 与文档改动；不得只为发布擅自丢弃或覆盖。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `npm test`、`npm run check:architecture`、TS check | 无 |
| 运行时 | PASS | PID `16240`，live release `7adb3f3d…`，Git `b18c3d2…`，HTTP 200 | Publisher 按边界关闭 |
| 外部平台 | PASS | 真实飞书 `#167203DF`，0 审批，A君/小D/Paperclip healthy | 未验证功能仍按真实状态保留 |
| 人工验收 | PASS | `feedback.sentiment=useful`，`humanAcceptance.status=accepted` | 无 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：本交接无阻塞；245 条历史验证欠账仍需按业务优先级逐条验证，不得批量冒充完成。
- 不得复制或展示的信息：任何 token、Cookie、飞书 Secret、Provider Key、授权链接。
- 需要谁确认：已通过原飞书会话人工评价闭环确认。
- 关闭条件：已全部满足；外部写入仍关闭。
- 关闭证据链接：[最终验收记录](../../reviews/workflow-capability-validation-2026-08-10.md)。
