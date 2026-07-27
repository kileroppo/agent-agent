# M2 Hermes 原生飞书总管迁移计划

| 字段 | 内容 |
| --- | --- |
| 状态 | 已完成 |
| 日期 | 2026-07-26 |
| 决策 | [ADR-0007](../adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md) |
| 验收 | [ARMY-041](../reviews/m2-real-small-army/acceptance.md) |

## 目标

不新建记忆数据库、不复制 Hermes 或 Paperclip，把 A君当前飞书入口迁到 Hermes 原生会话；所有 Hermes Profile 通过同一个本机 MCP 工具桥按岗位边界使用军团事实和任务能力。

## 实施顺序

1. **隔离验证**：从当前脏工作树建立独立 Git worktree，完整带入当前未提交基线；原工作树和运行入口不变。
2. **工具薄切片**：实现本机 MCP Server 与 loopback Client，先覆盖状态、员工、任务和审批；不接凭据、不复制任务数据。
3. **自动检查**：MCP 协议测试、确认失败关闭测试和 A君全量回归必须通过。
4. **Hermes Profile 验证**：克隆既有 Profile，配置 `stdio` MCP；验证工具发现、只读查询、连续对话和重启恢复。
5. **正式迁移**：把隔离分支的最小差异带回正式工作树，重启 A君；备份 Hermes Gateway 配置后停止旧文本转发，启用原生会话。
6. **真实飞书验收**：依次验证自然追问、真实员工状态、低风险任务、后台完成回话和审批失败关闭。
7. **收口**：同步 README、架构、契约、集成说明、验收账本和交接单；没有真实飞书证据前不得写“迁移完成”。

## 变更范围

- `apps/ajun-runtime/src/agent-army-client.js`
- `apps/ajun-runtime/src/agent-army-mcp-server.js`
- `apps/ajun-runtime/src/server.js`
- 对应 MCP/Client 自动检查与依赖
- Hermes Profile 的 MCP 配置和岗位指令
- Gateway 启动配置中的单一转发环境项

## 不做

- 不开发新的聊天 UI；
- 不开发新的短期、长期或项目记忆数据库；
- 不复制 Paperclip 的组织、预算、审批或任务队列；
- 不删除官方 Channel SDK、独立员工入口或现有飞书应用；
- 不在仓库、文档或日志中保存凭据、用户标识和授权链接。

## 验证阶梯

| 层级 | 必须证据 |
| --- | --- |
| 自动化 | MCP 聚焦测试与 A君全量测试全部通过 |
| 本机协议 | Hermes 能发现 9 个 MCP 工具并完成只读调用 |
| 本机运行 | 正式 A君进程从正式工作树加载新端点；Hermes Gateway 使用目标 Profile |
| 外部平台 | 真实飞书同会话、重启恢复、任务终态和审批失败关闭 |
| 人工体验 | 用户确认自然追问和上下文承接已接近 Hermes 内部体验 |

## 完成结果

- 隔离分支 `experiment/hermes-native-feishu` 与独立 `ajun-canary` Profile 先完成工具发现、连续对话、退出后恢复和只读查询；
- 正式 Hermes Gateway 已接管当前 `A君·军团总管`；后续扩展已把创建官、任务协调官、审核官、架构师、运维官和技术专家也切换为各自独立 Gateway，官方 Channel SDK 继续保留卡片、群聊与应急回退；
- Hermes 可发现 9 个 Agent Army MCP 工具；聚焦协议检查 9/9、A君全量自动检查 347/347；
- 真实飞书在 Gateway 重启前后承接“小D/她”的指代且不建任务；
- 一次误判审批通过 `/deny` 失败关闭，任务未执行、无产物；真实语言回归修复后，只读健康检查单次成功，最终返回 3 个健康组件、`verified: true` 和“无需恢复动作”；
- 正式切换前的 Hermes、Gateway 与 A君启动配置均有本机备份，官方 SDK 回退路径保留。

### 2026-07-27 治理员工扩展

- 六名治理员工都以 AgentManifest 驱动独立 Profile、岗位 Skill/MCP、飞书 Gateway 与 Paperclip `hermes_local` Adapter；没有复制 Hermes 记忆或 Paperclip 控制面。
- 本机岗位终验为 `AGE-383`、`AGE-387`、`AGE-388`、`AGE-396`、`AGE-386`、`AGE-393`；每项只有一个 run，完成评论均归属对应员工。
- 技术专家终验真实修改一个白名单文件，测试和恢复检查通过后才带回主工程；没有完整证据时仍失败关闭为 `waiting_test`。
- 老板已在飞书逐个私聊六名治理员工；六人均按岗位回复且会话指纹互相隔离。创建官完成 Gateway 重启后原会话追问并记住验收代号，真实私聊门禁已通过。

## 回滚

- 切换前保存 Hermes Gateway 启动配置的本机备份；
- 失败时只恢复旧转发环境项并重启 Gateway；
- A君新增 MCP 端点可留存，不影响官方 SDK 入口；
- 不通过修改飞书权限、重建应用或删除 Profile 回滚。
