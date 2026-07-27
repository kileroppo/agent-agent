# ADR-0007：飞书总管回归 Hermes 原生会话，以 MCP 接入军团真相

| 字段 | 内容 |
| --- | --- |
| 状态 | 已接受，已实施 |
| 日期 | 2026-07-26 |
| 决策人 | A 君 |
| 关联 PRD | `tasks/prd-agent-army-master.md`、`tasks/prd-m2-authorization-connectors.md`、`tasks/prd-m2-first-batch-agent-governance.md` |
| 替代关系 | 在 A君日常对话路径上替代 ADR-0006 的“官方 Channel SDK 直接进入规则总管”；独立员工入口、飞书官方工具和应急回退仍保留 |

## 背景

官方 Channel SDK 入口已经证明了消息、卡片、原会话回复、重启恢复和群内 @ 的可靠性，但它把普通文本直接交给 A君规则总管。结果是飞书里缺少 Hermes 已经具备的连续会话、上下文压缩、Profile 记忆、工具选择、委派和后台完成回话，用户每一轮都更像在调用接口，而不是持续和一个 Agent 协作。

当前 Hermes 已原生具备飞书 Gateway、持久会话、Profile 级记忆、MCP、本地工具、子任务委派和原会话后台回话。继续在 A君中复制短期记忆、长期记忆、项目记忆或通用工具路由，会形成第二套 Agent 运行时。

## 决策

1. **飞书普通对话由 Hermes 原生 Gateway 处理。** 同一飞书聊天映射到同一 Hermes Session；自然追问、上下文压缩、会话恢复和后台完成回话由 Hermes 负责。
2. **记忆分三层，但不新建三套存储。**
   - 短期记忆：Hermes Session 与压缩摘要；
   - 长期记忆：每个 Hermes Profile 的 `MEMORY.md`、`USER.md` 与运行时记忆工具；
   - 项目记忆：A君任务存储、业务 checkpoint 和 Paperclip 组织真相，通过工具按需读取。
3. **A君以本机 MCP Server 向 Hermes 暴露军团工具。** 第一批工具覆盖能力、军团状态、员工状态、任务列表/详情/创建、暂停/继续、审批列表/处理。MCP 只连接本机 loopback A君运行时，不保存凭据，不创建第二套任务队列。
4. **所有 Hermes Profile 可复用同一个 MCP Server。** 每个员工仍由自己的 Profile、岗位 Prompt、模型和最小权限决定能看到和调用哪些工具；工具桥不把所有岗位合并成一个 Agent。
5. **Paperclip 仍是唯一组织级控制面。** 组织、岗位、跨员工/长任务、预算、组织级审批和审计仍以 Paperclip 为准；MCP 只是对既有真相的受控访问层。
6. **高风险决定失败关闭。** 暂停或继续先生成既有审批；批准前，MCP 必须通过当前 Hermes 会话向真人再次确认，未确认、超时或会话离开时不执行。用户明确拒绝时直接安全关闭审批与未执行任务，不再要求“批准这次拒绝”。
7. **官方 Channel SDK 保留为回退与独立员工入口。** Hermes 原生入口真实验收失败时恢复原转发环境即可回到已验证入口；不删除现有官方 SDK 能力，也不修改飞书应用权限。
8. **治理员工也使用独立 Hermes 运行时身份。** 创建官、任务协调官、审核官、架构师、运维官和技术专家各有独立 Home/Profile/Session/Memory、岗位 Prompt、Skill/MCP 与飞书 Gateway；Paperclip 用官方 `hermes_local` Adapter 唤醒同一 Profile。Manifest 是配置源，A君只提供最小任务与执行适配，不为每名员工复制运行时。

## 对话与任务边界

```text
飞书消息
→ Hermes 原生飞书 Gateway
→ Hermes Session / Profile / Memory
→ 模型按需调用 Agent Army MCP
→ A君本机任务与能力适配
→ Paperclip（仅组织级治理条件）
→ 业务 Agent / 工具
→ Hermes 回原飞书会话
```

- 闲聊、追问、解释和上下文承接留在 Hermes 会话，不创建军团任务；
- 查询状态先调用只读 MCP 工具，不能凭模型记忆编造；
- 用户明确要求执行且能力已上岗时才创建任务；
- 长任务的业务 checkpoint 仍由业务 Agent/A君保存，Hermes 只保存会话和运行历史；
- 飞书消息仍是展示与交互界面，不是任务完成真相。

## 迁移与回滚

1. 在独立 Git worktree 和独立 Hermes Profile 验证 MCP 工具、模型调用和连续对话；
2. 全量回归 A君现有任务、审批、恢复和飞书适配；
3. 将同一改动迁回正式工作树并重启 A君；
4. 给当前 A君 Hermes Profile 配置 MCP 与岗位指令；
5. 备份 Hermes Gateway 启动配置，移除“所有文本转发到旧总管”的单一环境项并重启；
6. 真实飞书依次验证自然追问、员工状态、任务创建、长任务回话和审批失败关闭；
7. 任一关键场景失败就恢复备份环境项并重启，不改应用权限、不删除旧入口。

上述迁移于 2026-07-26 完成。隔离 worktree/Profile、正式工作树、Hermes CLI、当前飞书应用和回滚备份均已验证；结果登记在 ARMY-041。

2026-07-27 扩展完成六名治理员工的本机执行链；六项 Paperclip 岗位终验各只有一个 run，回写均归属员工身份，技术专家还完成真实隔离修复、测试、恢复检查与安全带回。六名员工随后完成老板真实飞书逐个私聊；独立会话、岗位边界回复和创建官跨 Gateway 重启连续追问均通过 ARMY-042。

## 验收标准

- 同一飞书会话连续两轮能承接指代和追问，重启 Gateway 后仍可继续；
- “小D目前在干嘛”读取真实任务且不创建新任务；
- “你能做什么”来自当前上岗能力，不凭 Prompt 写死；
- 一条低风险真实任务仅创建一次，能在原会话收到真实终态；
- 高风险或暂停/继续不会绕过 Paperclip/A君审批，拒绝或超时不执行；
- MCP、Hermes Session、A君任务和 Paperclip 之间没有第二套长期任务真相；
- 回归失败能在一次本机重启内恢复原官方 Channel SDK 路径。

## 后果

- 飞书体验接近 Hermes 本身，不再为每种自然追问增加规则分支；
- A君继续专注军团事实、执行适配和恢复，不再承担通用 Agent 记忆与对话运行时；
- Hermes 升级时要验证原生飞书 Gateway 与 MCP 兼容，但业务工具不再写入 Hermes 安装目录补丁；
- 多用户细粒度会话授权仍需在引入第二位真实使用者前补充；当前范围仅限本机所有者的既有白名单入口。

## 复用依据

- Hermes 现有 Gateway、Session、Profile、Memory、MCP、委派与后台回话能力；
- Model Context Protocol 官方 TypeScript SDK 的稳定 v1、本地 `stdio` 传输和 elicitation；
- A君现有 `TaskService`、审批、恢复、Paperclip 投影与业务 Agent，不重写任务执行；
- 飞书官方 Channel SDK 入口继续作为回退和独立员工接线。
