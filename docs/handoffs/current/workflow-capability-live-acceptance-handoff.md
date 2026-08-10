# Business Workflow 与能力治理 live 验收交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-10（Asia/Shanghai） |
| 交出者 | Codex 工作台 |
| 接手者 | 产品负责人 / 后续发布执行者 |
| 关联任务 | [ADR-0012](../../adr/0012-workflow-first-capability-policy-and-evaluation.md)、[候选验收记录](../../reviews/workflow-capability-validation-2026-08-10.md) |
| 截止条件 | 新不可变 release 切换并完成一条真实飞书业务 Workflow 与人工评价 |

## 1. 接手目标

- 目标：让 4321 live 使用候选 Workflow/Policy/能力真相实现，并完成外部和人工验收。
- 用户约束与不可做事项：不读取凭据；不启用 Publisher、Campaign、Cron；不执行付费 Provider 或平台写入。
- 做完的定义：live 指纹指向新 clean release；飞书不再回答“全部可用”；一条质量型任务留下 ExecutionReceipt、验证产物和人工验收。
- 唯一下一步：在保留当前混合工作树改动归属的前提下，形成可审计 clean Git 身份并冻结新的 A君不可变 release。
- 允许继续的前提：变更范围完成审查，根 `npm test` 与架构/类型检查保持通过，4321 当前无进行中任务和待审批。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | Workflow/Policy/Receipt/Evaluation、识图恢复、能力真相和人工验收已实现 | 候选验收记录 | 已验证 |
| 本地运行时 | 4322 候选通过；4321 仍是旧 release `2f8309d7…` | `npm run runtime:fingerprint` | 部分验证 |
| 外部平台 | 本轮未发飞书测试消息，Publisher 未运行 | 候选验收记录 | 未验证 |
| 人工确认 | 用户已要求继续实施，尚未验收新 live 结果 | 当前会话 | 待确认 |

## 3. 变更与决策

- 新核心 Module 使用 TypeScript；现有 JavaScript Provider 只经 Adapter 接入。
- Model 不自批；同机低风险能力有界恢复，外部写入与扩权继续走 Paperclip。
- 历史 237 条验证欠账只读分类，不批量重试或改写。
- 当前工作树含此前已有的 Hermes、小R、M5 与文档改动；不得只为发布擅自丢弃或覆盖。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `npm test`、`npm run check:architecture`、TS check | 无 |
| 运行时 | PARTIAL | 4322 PASS；4321 different_git_head | 新 release 未切换 |
| 外部平台 | NOT CHECKED | 未发送消息 | 飞书文案与真实任务待验证 |
| 人工验收 | NOT CHECKED | 尚无新 Workflow 评价 | 需负责人评价一条结果 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：没有可发布的 clean Git 身份；直接从混合脏工作树冻结会混入未审查变更。
- 不得复制或展示的信息：任何 token、Cookie、飞书 Secret、Provider Key、授权链接。
- 需要谁确认：产品负责人确认新 live 的飞书文案和业务结果；发布执行者确认 clean release 范围。
- 关闭条件：新 release 指纹通过、真实飞书 Workflow 通过、人工评价写回 Evaluation，且外部写入仍关闭。
- 关闭证据链接：更新本交接与候选验收记录。
