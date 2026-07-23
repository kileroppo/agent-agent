# M2 小G、小R治理验收交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-07-23 19:40 CST |
| 交出者 | Codex |
| 接手者 | 审核官、负责人 |
| 关联任务 | [实施计划](../../plans/m2-github-scout-and-intel-researcher-plan.md)、[验收账本](../../reviews/m2-real-small-army/acceptance.md#army-039)、[M2 治理 PRD](../../../tasks/prd-m2-first-batch-agent-governance.md) |
| 截止条件 | 两岗位分别完成审核、受限测试、负责人激活和真实飞书原会话验收，或保留失败证据 |

## 1. 接手目标

- 目标：让小G和小R在不使用凭据、登录态或外部写入能力的前提下完成受控上岗验证。
- 用户约束与不可做事项：只读公开 GitHub/公开网页；不使用 token、Cookie、私有仓库、登录、付费、外发或发布；不得把草案当作已上线。
- 做完的定义：ARMY-039、ARMY-040 有真实飞书原会话结果和可点击来源证据；岗位状态只在负责人确认后变为 `active`。
- 唯一下一步：审核官核对两个 manifest 的只读权限、工具清单和质量门禁，决定是否允许各自建立受限测试实例。
- 允许继续的前提：审核结论可追踪；受限测试不含真实凭据或外部写入；负责人明确决定是否激活。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 小G、小R manifest、岗位卡、独立 Hermes Profile、执行器、路由、原会话结果格式和 ARMY-039/040 均已实现；两个 manifest 为 `draft`。 | `agents/github-scout/`、`agents/intel-researcher/`、`apps/ajun-runtime/src/`、[验收账本](../../reviews/m2-real-small-army/acceptance.md#army-039) | 已验证 |
| 本地运行时 | 重启 `ai.agent-army.ajun-runtime` 后，`/api/overview` 显示小G和小R，均为 `draft`，端口 4321 由该服务监听。 | `curl http://127.0.0.1:4321/api/overview` | 已验证 |
| 外部平台 | 未调用真实 GitHub、真实飞书或 Paperclip 审批；不含任何凭据。 | ARMY-039、ARMY-040 | 未验证 |
| 人工确认 | 尚未进行审核、受限测试或负责人激活。 | 本交接单 | 待确认 |

## 3. 变更与决策

- 已完成：小G只用公开 GitHub API 搜索仓库或读取 README/公开文件；限流和不可用会转为 `needs_input`。小R只综合已读取公开来源，AI 不可用时返回结构化降级报告。
- 关键文件或外部配置位置：`apps/ajun-runtime/src/github-search.js`、`local-github-scout.js`、`hermes-intel-research-advisor.js`、`local-intel-researcher.js`、`feishu-commander.js`、`task-service.js`。
- 已确定的边界与兼容性约束：公开资料报告员继续只做逐页摘要；小R只做主题研究。草案岗位不能执行，飞书回执会如实说明尚未通过审核和受限测试。
- 不要重复创建的产物：不要另建控制台、任务队列、GitHub token、独立飞书应用或任何 Phase 2 监控能力。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `cd apps/ajun-runtime && npm test`：300 passed；`node agents/test/agent-manifest.test.mjs`：6 passed | 真实网络和飞书 |
| 运行时 | PASS | 重启 LaunchAgent 后 `/api/overview` 返回两岗位 `draft` | 草案不会执行，符合治理边界 |
| 外部平台 | NOT CHECKED | 未做真实 GitHub/飞书/Paperclip 调用 | ARMY-039、ARMY-040 |
| 人工验收 | NOT CHECKED | 未开始 | 审核、受限测试、负责人激活、真实飞书原会话结果 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：未完成审核和负责人激活前，任务会停在 `waiting_for_agent_activation`，不能把它说成可交付。
- 不得复制或展示的信息：任何 GitHub token、Cookie、登录态、私有仓库内容、飞书凭据或授权链接。
- 需要谁确认：审核官先确认最小权限；负责人决定两岗位是否允许受限测试及是否激活；验收者确认真实飞书原会话交付。
- 关闭条件：ARMY-039、ARMY-040 记录真实验收证据，岗位状态与实际权限一致。
- 关闭证据链接：[M2 验收账本](../../reviews/m2-real-small-army/acceptance.md#army-039)。
