# M2 Hermes 原生飞书总管迁移交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-07-26 CST |
| 交出者 | Codex |
| 接手者 | 当前实施会话 |
| 关联任务 | [ADR-0007](../../adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md)、[迁移计划](../../plans/m2-hermes-native-feishu-migration-plan.md)、[ARMY-041](../../reviews/m2-real-small-army/acceptance.md) |
| 关闭时间 | 2026-07-26 CST |

## 1. 接手目标

- 目标：让飞书 A君 使用 Hermes 原生会话、记忆、工具和后台完成能力，同时保持 A君/Paperclip 的军团真相边界。
- 用户约束与不可做事项：先复用现有实现；用 Git 隔离验证再迁移；最终面向所有 Agent 复用；不新建三套记忆；不丢现有能力。
- 做完的定义：代码、Hermes Profile、正式本机运行和真实飞书均通过 ARMY-041；回滚可用；文档与账本同步。
- 唯一下一步：无；按正常使用观察长期体验，如需改变数据真相或多用户授权另开交接单。
- 允许继续的前提：保持 Hermes、A君和 Paperclip 的现有真相边界，不在 Hermes 安装目录复制业务任务逻辑。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 正式工作树实现 9 个军团 MCP 工具；A君全量 347 项通过 | `apps/ajun-runtime/`、本交接验证账本 | 已验证 |
| 本地运行时 | 正式 A君监听本机端口并从正式工作树加载；Paperclip 可读；6 个员工入口保持连接 | 本机 listener/cwd 与运行概览 | 已验证 |
| Hermes | 当前飞书 Gateway 使用原生 Session、Profile、Memory 与 MCP；旧文本转发环境项已移除 | Hermes CLI、Gateway 日志与 Session 记录 | 已验证 |
| 外部平台 | 当前 `A君·军团总管` 已完成连续追问、重启恢复、只读状态、审批拒绝和低风险任务终态 | ARMY-041 | 已验证 |
| 人工确认 | 用户已授权完成隔离验证、迁移和最终结果 | 当前会话 | 已确认 |

## 3. 变更与决策

- 已完成：创建 `experiment/hermes-native-feishu` 隔离分支/worktree；实现 MCP Client、Server、受控任务/审批端点和协议测试；在 `ajun-canary` 验证后迁入正式入口；修复并列否定约束误触发审批与健康报告误套小D文案；完成真实飞书闭环。
- 关键文件或外部配置位置：见迁移计划；Hermes Profile 和 Gateway 启动配置只保存在本机，不写入凭据。
- 已确定的边界与兼容性约束：Hermes 保存会话和长期记忆；A君/业务 Agent 保存项目任务与 checkpoint；Paperclip 保存组织级真相；MCP 只访问 loopback。
- 不要重复创建的产物：会话数据库、向量记忆库、组织任务队列、飞书聊天 UI、第二套审批系统。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | MCP Client/Server：9/9；`npm test`：347/347 | 无 |
| 运行时 | PASS | Hermes 发现 9 个工具；A君、Hermes Gateway 与 6 个员工入口均从预期配置运行 | 无 |
| 外部平台 | PASS | 同会话指代、Gateway 重启恢复、状态查询不建任务、拒绝不执行、健康报告终态均有真实飞书回执 | 无 |
| 人工验收 | PASS | 最终飞书回复给出 `healthy`、3 个组件、`verified: true` 和“无需恢复动作” | 长期使用感受继续观察，不阻塞关闭 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：无迁移阻塞。Hermes 安装目录已有未提交飞书适配补丁，后续升级不得覆盖；同一飞书应用不能同时启动两个 Gateway；多用户细粒度授权不在当前单所有者范围。
- 不得复制或展示的信息：任何 app secret、token、Cookie、用户/群标识、授权链接和真实 `.env`。
- 需要谁确认：无待确认项；后续长期体验变化按新任务处理。
- 关闭条件：已满足。ARMY-041 全部通过并同步文档。
- 关闭证据链接：[ARMY-041](../../reviews/m2-real-small-army/acceptance.md)。
