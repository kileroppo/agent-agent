# 上下文、记忆与成本治理发布交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已上线，待真实任务成本对比 |
| 创建时间 | 2026-08-13 13:23 CST |
| 交出者 | Codex 工作台 |
| 接手者 | Agent军团技术负责人 |
| 关联任务 | [上下文、记忆与成本治理](../../architecture/context-memory-and-cost-governance.md) |
| 截止条件 | 新策略进入不可变运行版本并完成一轮真实任务成本对比，或负责人决定保持源码候选 |

## 1. 接手目标

- 目标：把已经通过测试的预算、上下文胶囊、记忆准入和分级留存策略安全切到 live。
- 用户约束与不可做事项：不无脑保存全部 Agent 结果、聊天或上下文；不得跳过历史清理预览，不得把源码测试写成节省目标已实现。
- 做完的定义：11 个 Profile 对账无漂移，运行服务指向含本次改动的不可变版本，历史清理仍先 dry-run，一条真实任务能看到新增效率指标。
- 唯一下一步：选择一条正常业务任务，在新策略下完成一次真实执行，并把输入 Token、模型调用次数和业务结果与同类旧任务比较；不要为了验收额外制造付费调用。
- 允许继续的前提：任务本身确有业务价值，且涉及外发、发布、付费或真实账号写入时仍按原审批边界执行。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 预算硬停、上下文胶囊、服务端等待、记忆准入、四级留存和效率指标已实现 | [架构说明](../../architecture/context-memory-and-cost-governance.md) | 已验证 |
| 本地运行时 | A君 4321 已运行不可变 release `81ba1cfe9421…`，PID `50805`；manifest 绑定 clean commit `d22d021a…`，主服务与只读恢复 smoke 均通过 | release manifest、launchd、端口与 HTTP 回读 | 已验证 |
| Hermes Profile | 11 个隔离 Profile 二次 dry-run 为 0 drift；正式 A君 根 Home 也已键级同步为 20 轮、1 次重试、硬停止、最近 8 段和 30 天策略 | Profile dry-run、根 Home 安全键级回读 | 已验证 |
| 外部平台 | 5 个常驻 Gateway 静默排空后逐一重启，均产生新 PID 和本轮飞书连接时间；A君 Telegram 也已重连 | Gateway state、launchd 与连接时间回读 | 运行层已验证，未做真人消息验收 |
| 人工确认 | 负责人已授权上线；尚未用一条正常业务任务确认节省比例和结果质量 | 本交接单 | 待真实任务对比 |

## 3. 变更与决策

- 已完成：11 岗位分档最大轮次；API 重试 1 次；工具循环硬停止；最近 8 段保护；`TaskContextCapsule`；记忆写入准入；7/30/365 天分级留存；服务端最长 240 秒等待；账单效率指标。
- 关键文件：`agents/*/manifest.json`、`apps/ajun-runtime/src/task-context-capsule.js`、`apps/ajun-runtime/src/governance-hermes-runtime.js`、`apps/ajun-runtime/src/task-run-event-store.js`、`apps/ajun-runtime/src/task-usage.js`。
- 边界：事件清理默认 `dry-run`；只有 `AGENT_ARMY_EVENT_RETENTION_MODE=apply` 才删除。Profile 同步必须显式 `--apply`。
- 不要重复创建：第二套记忆库、第二套任务摘要存储或新的 Agent 结果归档系统。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `npm run check`、`npm run test:affected`、`npm test`、`git diff --check` | 无 |
| 运行时 | PASS | 不可变 release `81ba1cfe9421…`；4321 HTTP 200；11 Profile 0 drift；正式 A君 根 Home 策略回读一致；5 个 Gateway 新 PID、`running`、`active_agents=0` | 不替代真实业务结果验收 |
| 数据安全 | PASS | 历史事件删除开关未启用，仍为 `dry-run`；11 Profile 的 30 天 Session prune dry-run 候选均为 0 | 后续出现真实过期数据时仍应先复核预览 |
| 外部平台 | PARTIAL | 5 个常驻 Gateway 本轮均重新连接飞书，A君同时重新连接 Telegram | 未发送真人测试消息，未执行发布、外发或付费业务 |
| 人工验收 | NOT CHECKED | live 已出现输入 Token 归因、记忆写入、历史检索和预算硬停指标；尚未进行同类真实任务前后对比 | 输入 Token -30%、模型调用 -20%、通过率不下降 |

## 5. 风险、权限与关闭

- 当前风险：旧 7 日账本已有模型调用和推理占比告警；新策略能观测但尚不能证明已经达到节省目标。主工作区仍有其他未提交改动，本次通过独立 clean worktree 和 scoped commit 隔离发布。
- 不得复制或展示：Hermes 配置中的凭据、Session 正文、聊天原文和本机私密路径。
- 需要谁确认：负责人只需在下一条正常业务任务完成后确认结果是否可用；不需要为了本轮上线再做额外配置确认。
- 关闭条件：live 指纹确认使用新 release；11 Profile 二次 dry-run 无漂移；历史清理预览已核对；一轮真实任务的效率指标和业务结果完成记录。
- 关闭证据链接：不可变 release manifest 位于 `work/runtime-releases/context-memory-cost-20260813/ajun-runtime-release-v1-81ba1cfe9421f8dde16151b2333ca21e24c1b8546412c79a0f29ab1ed0f1afeb/release-manifest.json`；最终关闭时再补一条真实任务成本对比。
