# 上下文、记忆与成本治理发布交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-13 13:23 CST |
| 交出者 | Codex 工作台 |
| 接手者 | Agent军团技术负责人 |
| 关联任务 | [上下文、记忆与成本治理](../../architecture/context-memory-and-cost-governance.md) |
| 截止条件 | 新策略进入不可变运行版本并完成一轮真实任务成本对比，或负责人决定保持源码候选 |

## 1. 接手目标

- 目标：把已经通过测试的预算、上下文胶囊、记忆准入和分级留存策略安全切到 live。
- 用户约束与不可做事项：不无脑保存全部 Agent 结果、聊天或上下文；不得跳过历史清理预览，不得把源码测试写成节省目标已实现。
- 做完的定义：11 个 Profile 对账无漂移，运行服务指向含本次改动的不可变版本，历史清理仍先 dry-run，一条真实任务能看到新增效率指标。
- 唯一下一步：负责人明确授权发布后，先从当前源码生成受控不可变 release，再重新运行 11 个 Profile 的 `--dry-run`；差异仍符合预期时才执行 `--apply` 并核对运行指纹。
- 允许继续的前提：当前混合工作区的发布范围已经锁定，不会把无关未提交改动带入 release；Profile 写入和服务重启已获授权。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 预算硬停、上下文胶囊、服务端等待、记忆准入、四级留存和效率指标已实现 | [架构说明](../../architecture/context-memory-and-cost-governance.md) | 已验证 |
| 本地运行时 | 11 个 Profile dry-run 均显示可收敛；写入数和 Gateway 动作均为 0 | `configure-governance-hermes-runtime.mjs --dry-run --only ...` | 已验证 |
| 外部平台 | 当前 live Profile 仍是旧策略，源码尚未进入不可变 release | Profile dry-run 差异 | 未验证 |
| 人工确认 | 负责人尚未批准 live apply 和重启 | 本交接单 | 待确认 |

## 3. 变更与决策

- 已完成：11 岗位分档最大轮次；API 重试 1 次；工具循环硬停止；最近 8 段保护；`TaskContextCapsule`；记忆写入准入；7/30/365 天分级留存；服务端最长 240 秒等待；账单效率指标。
- 关键文件：`agents/*/manifest.json`、`apps/ajun-runtime/src/task-context-capsule.js`、`apps/ajun-runtime/src/governance-hermes-runtime.js`、`apps/ajun-runtime/src/task-run-event-store.js`、`apps/ajun-runtime/src/task-usage.js`。
- 边界：事件清理默认 `dry-run`；只有 `AGENT_ARMY_EVENT_RETENTION_MODE=apply` 才删除。Profile 同步必须显式 `--apply`。
- 不要重复创建：第二套记忆库、第二套任务摘要存储或新的 Agent 结果归档系统。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `npm run check`、`npm run test:affected`、`npm test`、`git diff --check` | 无 |
| 运行时 | PARTIAL | 11 Profile dry-run；11 Profile 的 30 天 Session prune dry-run 均为 0 条 | 尚未 apply、重启和核对指纹 |
| 外部平台 | NOT CHECKED | 未改 Paperclip/飞书或执行真实业务任务 | 新策略下的真实任务行为 |
| 人工验收 | NOT CHECKED | 尚未进行成本基线对比 | 输入 Token -30%、模型调用 -20%、通过率不下降 |

## 5. 风险、权限与关闭

- 当前风险：工作区存在大量其他未提交改动；直接打包可能扩大发布范围。
- 不得复制或展示：Hermes 配置中的凭据、Session 正文、聊天原文和本机私密路径。
- 需要谁确认：Agent军团技术负责人确认 scoped release、Profile apply 和服务重启。
- 关闭条件：live 指纹确认使用新 release；11 Profile 二次 dry-run 无漂移；历史清理预览已核对；一轮真实任务的效率指标和业务结果完成记录。
- 关闭证据链接：完成后补充不可变 release manifest、Profile 对账摘要和验收记录。
