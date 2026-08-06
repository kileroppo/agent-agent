# M2 小G、小R治理验收历史归档

| 字段 | 内容 |
| --- | --- |
| 状态 | 已归档：小G于 2026-07-27 并入小R |
| 创建时间 | 2026-07-23 19:40 CST |
| 交出者 | Codex |
| 接手者 | 审核官、负责人 |
| 关联任务 | [实施计划](../../plans/m2-github-scout-and-intel-researcher-plan.md)、[验收账本](../../reviews/m2-real-small-army/acceptance.md#army-039)、[M2 治理 PRD](../../../tasks/prd-m2-first-batch-agent-governance.md) |
| 截止条件 | 两岗位分别完成审核、受限测试、负责人激活和真实飞书原会话验收，或保留失败证据 |

## 1. 接手目标

- 目标：让小G和小R在不使用凭据、登录态或外部写入能力的前提下完成受控上岗验证。
- 用户约束与不可做事项：只读公开 GitHub/公开网页；不使用 token、Cookie、私有仓库、登录、付费、外发或发布；不得把草案当作已上线。
- 做完的定义：ARMY-039、ARMY-040 有真实飞书原会话结果和可点击来源证据；岗位状态只在负责人确认后变为 `active`。
- 唯一下一步：无；GitHub 公开检索统一由小R承接。
- 允许继续的前提：不得恢复小G活动 Manifest、独立 Profile 映射或路由；旧任务只读保留，重新执行时交给小R。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 小G、小R manifest、岗位卡、独立 Hermes Profile、执行器、路由、一次受限测试执行器和原会话结果格式均已实现；两个 manifest 为 `draft`。 | `agents/github-scout/`、`agents/intel-researcher/`、`apps/ajun-runtime/src/`、[验收账本](../../reviews/m2-real-small-army/acceptance.md#army-039) | 已验证 |
| 本地运行时 | `GET /api/agent-proposals` 已确认小G、小R均为 `active`，验收产物均为 `passed`。 | `curl http://127.0.0.1:4321/api/agent-proposals` | 已验证 |
| 外部平台 | 真实飞书审核、两条公开只读受限测试、负责人激活与 Paperclip 名册同步均成功；小G已在原会话交付 5 个公开 GitHub 项目，小R已在原会话交付带 3 条可点击公开来源的结构化研究报告。 | Paperclip `AGE-150`、`AGE-152`；小G任务 `348b6436-69cf-4aa7-b97c-3fe9ff269562`；小R任务 `fba66ab8-9cbb-42f2-92a6-28b39ad270eb`；运行时激活审计 | 无 |
| 人工确认 | 负责人已激活两岗位，并在真实飞书原会话看到两项交付。 | 运行时审计与飞书原会话结果 | 无 |

## 3. 变更与决策

- 已完成：小G只用公开 GitHub API 搜索仓库或读取 README/公开文件；限流和不可用会转为 `needs_input`。小R只综合已读取公开来源，AI 不可用时返回结构化降级报告。
- 已完成：审核官的独立飞书入口可直接识别“审核小G和小R草案”，将两个仓库 manifest 投影为带稳定草案号的审核记录并生成审核结论；不要求负责人先提供内部编号，也不会启用岗位。
- 关键文件或外部配置位置：`apps/ajun-runtime/src/github-search.js`、`local-github-scout.js`、`hermes-intel-research-advisor.js`、`local-intel-researcher.js`、`feishu-commander.js`、`task-service.js`。
- 已确定的边界与兼容性约束：公开资料报告员继续只做逐页摘要；小R只做主题研究。草案岗位不能执行，飞书回执会如实说明尚未通过审核和受限测试。
- 不要重复创建的产物：不要另建控制台、任务队列、GitHub token、独立飞书应用或任何 Phase 2 监控能力。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `cd apps/ajun-runtime && npm test`：311 passed；`node agents/test/agent-manifest.test.mjs`：6 passed | 无 |
| 运行时 | PASS | 两岗位均为 `active`，验收产物状态均为 `passed` | 无 |
| 外部平台 | PASS | 真实飞书审核 + Paperclip 投影 + 负责人激活；小G、小R均完成受限测试与真实原会话交付 | 无 |
| 人工验收 | PASS | 已在真实飞书原会话收到小G、小R交付 | 无 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：本批历史验收已关闭。小G已并入小R；本文件仅用于追溯，不再作为当前岗位或入口依据。
- 不得复制或展示的信息：任何 GitHub token、Cookie、登录态、私有仓库内容、飞书凭据或授权链接。
- 需要谁确认：审核官先确认最小权限；负责人决定两岗位是否允许受限测试及是否激活；验收者确认真实飞书原会话交付。
- 关闭条件：已满足；ARMY-039、ARMY-040 均记录真实验收证据，岗位状态与实际权限一致。
- 关闭证据链接：[M2 验收账本](../../reviews/m2-real-small-army/acceptance.md#army-039)。
