# 上下文、记忆与成本治理发布交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 原治理已上线；Provider 总账核对与统一网关为源码候选，未切 live |
| 创建时间 | 2026-08-13 13:23 CST |
| 交出者 | Codex 工作台 |
| 接手者 | Agent军团技术负责人 |
| 关联任务 | [上下文、记忆与成本治理](../../architecture/context-memory-and-cost-governance.md) |
| 截止条件 | 新策略进入不可变运行版本并完成一轮真实任务成本对比，或负责人决定保持源码候选 |

## 1. 接手目标

- 目标：保留已上线的预算与上下文治理，并把所有 StepFun 调用收口为可归属、可限额、可与 Provider 总账核对的入口。
- 用户约束与不可做事项：不无脑保存全部 Agent 结果、聊天或上下文；不得跳过历史清理预览，不得把源码测试写成节省目标已实现。
- 做完的定义：11 个 Profile 对账无漂移，运行服务指向含本次改动的不可变版本，历史清理仍先 dry-run，一条真实任务能看到新增效率指标。
- 唯一下一步：负责人确认是否授权安装 LiteLLM Proxy 与 Postgres、创建独立虚拟密钥、轮换 StepFun 共享密钥，并对 Hermes/Paperclip 做小流量网关切换；未授权前不得安装、改密钥、改 Base URL 或重启服务。
- 允许继续的前提：先拿到上述明确授权和回滚窗口；迁移期间不得为了验收额外制造付费调用。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 预算硬停、上下文胶囊、服务端等待、记忆准入、四级留存和效率指标已实现 | [架构说明](../../architecture/context-memory-and-cost-governance.md) | 已验证 |
| 本地运行时 | 2026-08-16 只读核对：A君 4321 运行不可变 release `b440d83ac641…`，PID `98174`，git head `2eada79d…`；与当前源码不同，本轮 Token 加强尚未切 live | `npm run runtime:fingerprint -- --port 4321`、端口与 HTTP 回读 | 旧 live 可达；新源码未发布 |
| Hermes Profile | 11 个隔离 Profile 二次 dry-run 为 0 drift；正式 A君 根 Home 也已键级同步为 20 轮、1 次重试、硬停止、最近 8 段和 30 天策略 | Profile dry-run、根 Home 安全键级回读 | 已验证 |
| 外部平台 | 5 个常驻 Gateway 静默排空后逐一重启，均产生新 PID 和本轮飞书连接时间；A君 Telegram 也已重连 | Gateway state、launchd 与连接时间回读 | 运行层已验证，未做真人消息验收 |
| 人工确认 | 负责人已授权上线；尚未用一条正常业务任务确认节省比例和结果质量 | 本交接单 | 待真实任务对比 |

### 2026-08-16 Token 归属加强

- 已实现：本地账本明确声明只覆盖受管 Hermes Profile；未接 Provider 总账时不再允许输出“成本正常”。
- 已实现：Provider 总量输入与受管账本的调用、Token 差额核对；差额只标记为账外调用，不伪造任务归属。
- 已实现：受管运行事件可记录输入、输出、缓存、推理 Token、Provider 尝试、限流、凭据别名和调用类型；`model_call_*` 缺少关键归属时拒绝落库。
- 已实现：Paperclip 受控 StepFun 媒体调用写入固定模型、凭据别名、调用类型和费用事件 Token。
- 未实现/live 未验证：StepFun 账户总量自动采集、共享密钥轮换、统一模型网关、Hermes/Paperclip Base URL 切换和服务重启。

## 3. 变更与决策

- 已完成：11 岗位分档最大轮次；API 重试 1 次；工具循环硬停止；最近 8 段保护；`TaskContextCapsule`；记忆写入准入；7/30/365 天分级留存；服务端最长 240 秒等待；账单效率指标。
- 关键文件：`agents/*/manifest.json`、`apps/ajun-runtime/src/task-context-capsule.js`、`apps/ajun-runtime/src/governance-hermes-runtime.js`、`apps/ajun-runtime/src/task-run-event-store.js`、`apps/ajun-runtime/src/task-usage.js`。
- 边界：事件清理默认 `dry-run`；只有 `AGENT_ARMY_EVENT_RETENTION_MODE=apply` 才删除。Profile 同步必须显式 `--apply`。
- 不要重复创建：第二套记忆库、第二套任务摘要存储或新的 Agent 结果归档系统。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | Token/账本/运行事件/Paperclip/UI/日期范围定向测试 59 项通过；`npm run check --workspace=ajun-runtime`；`git diff --check` | 未执行全仓库测试 |
| 运行时 | PARTIAL | 当前不可变 release `b440d83ac641…` 的 4321 HTTP 200；PID `98174`；源码关系为 `different_git_head` | 本轮 Token 加强未发布、未重启、未做 HTTP 回读 |
| 数据安全 | PASS | 历史事件删除开关未启用，仍为 `dry-run`；11 Profile 的 30 天 Session prune dry-run 候选均为 0 | 后续出现真实过期数据时仍应先复核预览 |
| 外部平台 | NOT CHANGED | 本轮未调用 StepFun、未安装网关、未改密钥或 Base URL、未重启服务 | Provider 自动总账和统一入口仍未接入 |
| 人工验收 | NOT CHECKED | 源码候选已能识别模拟的 827 次 / 27,781,756 Token 账外差额 | live 真实总账、调用归属和拦截效果 |

## 5. 风险、权限与关闭

- 当前风险：共享 StepFun 密钥仍允许其他程序绕过 A君/Hermes/Paperclip；源码告警不能阻止绕过调用。主工作区有大量其他未提交改动，本轮只修改 Token 治理相关路径且未提交、未发布。
- 不得复制或展示：Hermes 配置中的凭据、Session 正文、聊天原文和本机私密路径。
- 需要谁确认：负责人需要明确授权统一网关安装、Postgres、虚拟密钥创建、共享密钥轮换和小流量切换窗口。
- 关闭条件：所有 StepFun 客户端只持有独立虚拟密钥；共享直连密钥停用；Provider 总量与网关账本同窗对平；超预算调用在 Provider 前被拒绝；live 指纹和 HTTP 回读确认新 release。
- 关闭证据链接：不可变 release manifest 位于 `work/runtime-releases/context-memory-cost-20260813/ajun-runtime-release-v1-81ba1cfe9421f8dde16151b2333ca21e24c1b8546412c79a0f29ab1ed0f1afeb/release-manifest.json`；最终关闭时再补一条真实任务成本对比。
