# M2 第一批 Agent 创建与治理闭环交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 实施中：本机治理闭环已验证，等待真实飞书与 Hermes 业务验收 |
| 创建时间 | 2026-07-20 CST |
| 关联 PRD | `tasks/prd-m2-first-batch-agent-governance.md` |
| 关联计划 | `docs/plans/m2-first-batch-agent-governance-plan.md` |

## Continue with this

- Goal: 用一个低风险新岗位证明“飞书创建需求 → AgentProposal 草案 → Paperclip 审核 → A君/Hermes 受限测试 → 飞书调用上线”的闭环。
- Exact next action: 为已存在的 `publicreport` Hermes 隔离 Profile 配置独立模型身份，再从飞书发送一条公开网页链接创建请求，得到一份可验证报告后才可激活候选岗位。
- Continue only when: 测试仍保持公开、只读、无生产账号；不得把模型配置、密钥或飞书用户信息写入仓库、日志或验收记录。

## 已确认决策

- 小D是首个已有业务闭环的 Agent，保持飞书直达；
- 简单、低风险、单 Agent 请求不强制进入 Paperclip；
- Paperclip 只在创建审核、跨 Agent、预算、审批、长任务或审计需要时介入；
- 自然语言创建请求只生成 `draft`，必须经人工审核、受限测试和真实验收才能 `active`；
- A君仅提供本机能力、授权、健康、恢复与执行适配；治理 Agent 不读取凭据、不自行扩权。

## 验证账本

| 层级 | 当前事实 | 未完成 |
| --- | --- | --- |
| 文档与契约 | 第一批 PRD、计划、`AgentProposalContract`、治理 SOP 已写入 | 真实飞书与 Hermes 业务验收待补 |
| 本机运行时 | 创建草案、状态机、受限测试实例、公开网页能力与防内网读取已验证 | 候选 Agent 的真实业务产物待验收 |
| 外部平台 | Paperclip 审核任务与批准记录已真实创建；Hermes 隔离 Profile 已创建 | 真实飞书创建消息与候选 Agent 上线未验证 |

## 风险与关闭条件

- 风险：当前 Paperclip 本机版本、飞书原生多 Agent 入口与 Hermes Profile 自动创建能力均需实测，不能从文档推断可用；
- 关闭条件：首个新 Agent 经审核、受限测试、真实飞书调用和产物验证后上线；失败、拒绝和权限不足路径也有可验证记录；小D回归通过。
