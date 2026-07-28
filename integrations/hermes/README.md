# Hermes 集成

本目录保存仓库中的 Hermes 映射基线，不保存 Hermes 真实 Profile、会话、密钥或个人配置。

`profiles/*.profile.json` 是 AgentManifest 到 Hermes 的平台无关映射契约，目前不是可以直接导入 Hermes CLI 的原生配置文件。真实字段必须经过当前 Hermes 版本的隔离验证后，由适配器生成或校验。

M1 约束：

- 每个 Agent 使用独立 Profile；
- 飞书用户准入默认白名单；
- Kanban 保存执行任务和运行历史；
- 业务 checkpoint 与产物仍由业务应用存储；
- 不读取或复用个人默认 Profile；
- REST/插件接口不暴露公网。

M2 当前总管路径见 [ADR-0007](../../docs/adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md)：飞书消息先进入 Hermes 原生 Session；Hermes 负责上下文、压缩、Profile 记忆和工具选择，再按需调用本机 Agent Army MCP。A君仍保存任务、业务 checkpoint 与受控执行真相，Paperclip 仍保存组织级任务、预算、审批和审计。

当前常驻 Gateway 固定为 A君、小D、小R、小办和运维官。创建官、审核官、架构师和技术专家保留独立 Hermes Home、Profile、SOUL、模型选择与岗位作用域 MCP，由 Paperclip 官方 `hermes_local` Adapter 按需执行，不再保持独立飞书 Gateway。任务协调官已并入 A君并退役；小G的 GitHub 能力已并入小R。

治理员工清单不再维护第二份硬编码名单，而是自动发现所有 `active + hermes-profile + paperclip-hermes` Manifest。配置器按 `interaction.directFeishu` 调和生命周期：`required` 才执行 `enable + kickstart`；`disabled` 必须执行 `bootout + disable`，反复运行也不得重新拉起。新增符合契约的员工后可沿用同一配置和真实飞书验收命令。

当前 Hermes 飞书 WebSocket SDK 在 INFO 级别会记录包含短期连接参数的完整 URL。本机安装已把该 SDK 日志级别收紧到 WARNING，并用六个 Gateway 二次重启验证新日志不再出现连接 URL。兼容补丁保存在 `patches/feishu-ws-log-level-warning.patch`；升级 Hermes 后先检查上游是否已经修复，只有仍为 INFO 时才重放补丁并复验，避免盲目覆盖新版本。

治理员工配置由 `apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs` 从 AgentManifest 生成。新增员工时先增加 Manifest、Prompt 和映射文件，再运行同一配置器；它负责独立 Profile、MCP 环境作用域、Paperclip Agent/Adapter、官方 Paperclip Skills 和 launchd Gateway，不需要复制一套运行时。真实凭据只留在各 Profile 环境中。

## Agent Army MCP

正式与隔离 Profile 可复用同一个 `stdio` MCP Server。当前按岗位从 13 个工具中取最小子集：能力、军团状态、员工状态、任务列表、任务详情、单任务创建、老板多人总任务创建、暂停/继续、审批列表、审批处理、Paperclip 指派读取/完成和技术修复执行。Server 只访问 `127.0.0.1` 的 A君运行时，不读取飞书凭据，不维护会话数据库，也不复制 Paperclip 队列。

- 状态、能力和追问只读，不创建任务；
- 用户明确要求执行时才创建任务，并使用稳定请求引用防重；
- 同一交办含 2–3 项明确工作时，A君使用一个 `mission_create` 总任务；独立员工 Profile 通过环境作用域只能创建本岗位任务，不能创建多人总任务或替其他岗位派活；
- 批准必须经过 Hermes 当前会话的 elicitation；明确拒绝直接安全关闭，批准超时或离开会话时失败关闭；
- 健康报告等结构化产物按白名单脱敏返回，不透传原始日志或未知字段；
- 每个员工 Profile 仍按自己的 Manifest、Prompt 和最小权限决定可用工具，不因共享 Server 合并岗位。

## Profile 作用域注意事项

本机验证发现，单独设置 `HERMES_PROFILE=xiaod` 不足以让所有 Hermes CLI 命令切换到隔离 Profile；通用状态命令仍可能读取默认环境。小D的启动与验收必须显式使用其独立 Profile 目录作为 Hermes Home，不能把通用 `hermes status` 的输出当作小D Profile 的凭据或模型证明。
