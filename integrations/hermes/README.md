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

所有常驻与按需岗位共用同一套中文交互和飞书移动端排版规则。新消息到达后只在用户原消息上显示一个处理图标，最终回复后移除，不再另发“已收到”气泡。运行中补充要求时，Gateway 用中文说明实际处理方式，并提供“下一步单独处理 / 查看当前设置 / 停止当前任务”快捷按钮；按钮点击会直接执行对应命令。飞书发送前按内容调整密度：多个分区和长条目增加留白，短回答与短列表保持紧凑；手机端容易变形的宽表或长单元格表转为分组列表，短小对比表仍保留。

上述行为由仓库补丁维护，Hermes 升级后须重新执行并验证：

```bash
node integrations/hermes/scripts/patch-hermes-chinese-busy-notice.mjs
node integrations/hermes/scripts/patch-hermes-chinese-provider-errors.mjs
node integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs
```

治理员工清单不再维护第二份硬编码名单，而是自动发现所有 `active + hermes-profile + paperclip-hermes` Manifest。配置器按 `interaction.directFeishu` 调和生命周期：`required` 才执行 `enable + kickstart`；`disabled` 必须执行 `bootout + disable`，反复运行也不得重新拉起。新增符合契约的员工后可沿用同一配置和真实飞书验收命令。

当前 Hermes 飞书 WebSocket SDK 在 INFO 级别会记录包含短期连接参数的完整 URL。本机安装已把该 SDK 日志级别收紧到 WARNING，并用六个 Gateway 二次重启验证新日志不再出现连接 URL。兼容补丁保存在 `patches/feishu-ws-log-level-warning.patch`；升级 Hermes 后先检查上游是否已经修复，只有仍为 INFO 时才重放补丁并复验，避免盲目覆盖新版本。

治理员工配置由 `apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs` 从 AgentManifest 生成。新增员工时先增加 Manifest、Prompt 和映射文件，再运行同一配置器；它负责独立 Profile、MCP 环境作用域、Paperclip Agent/Adapter、官方 Paperclip Skills 和 launchd Gateway，不需要复制一套运行时。真实凭据只留在各 Profile 环境中。

维护已有 Profile 的 SOUL、MCP 作用域和飞书工具白名单时，先使用最小范围
dry-run。该路径不安装技能、不调用 MCP、不修改或停止 Gateway，也不读取或
备份 `.env`：

```bash
node apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs \
  --dry-run --only content-creator,reviewer
```

实际同步必须同时提供 `--apply` 和 `--confirm-profile-sync`。脚本逐 Profile
备份 `config.yaml` 与 `SOUL.md`，任一岗位失败时按相反顺序恢复已处理岗位；
备份目录和回滚提示会出现在结果中。没有维护窗口和人工核对时不要执行：

```bash
node apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs \
  --apply --confirm-profile-sync --only content-creator,reviewer
```

## 岗位技能白名单

`scripts/reconcile-hermes-skill-whitelist.mjs` 以所有 `active + hermes-profile`
岗位的 `runtimeCapabilities.skills` 为唯一真相，自动发现新增岗位。命令默认
只读检查漂移，适合启动前预检；只有显式传入 `--apply` 才会把当前仍处于
enabled 状态的未声明技能加入 Hermes 的全局 disabled 集合。

收敛器不会安装、卸载、删除或启用任何技能，也不会读取或输出 Secret。
声明技能尚未安装或已被禁用时只报告，不会替创建官、架构师或其他岗位扩权。
共享技能包仍保留原位。

```bash
# 全岗位启动前只读检查；发现漂移时退出码为 2
node integrations/hermes/scripts/reconcile-hermes-skill-whitelist.mjs

# 只检查小D
node integrations/hermes/scripts/reconcile-hermes-skill-whitelist.mjs --agent xiaod

# 维护窗口人工核对 dry-run 后，才可显式执行；不会安装缺失技能
node integrations/hermes/scripts/reconcile-hermes-skill-whitelist.mjs --agent xiaod --apply
```

## Agent Army MCP

正式与隔离 Profile 可复用同一个 `stdio` MCP Server。每个正式岗位都包含只读 `agent_manual`：A君可以查询任一岗位或全部使用说明书，其他员工只能查询自己的说明书。其余工具继续按 Manifest 取最小子集，包括能力、军团状态、员工状态、任务读写、多人任务、审批、Paperclip 指派和受控岗位执行。Server 只访问本机 A君运行时和不可变 release 内的 Manifest，不读取飞书凭据，不维护会话数据库，也不复制 Paperclip 队列。

- 状态、能力和追问只读，不创建任务；
- 使用说明书问题只调用 `agent_manual`，不创建业务任务；A君传 `all` 可取全员，独立员工越权查询其他岗位时失败关闭；
- 用户明确要求执行时才创建任务，并使用稳定请求引用防重；
- 同一交办含 2–3 项明确工作时，A君使用一个 `mission_create` 总任务；独立员工 Profile 通过环境作用域只能创建本岗位任务，不能创建多人总任务或替其他岗位派活；
- 批准必须经过 Hermes 当前会话的 elicitation；明确拒绝直接安全关闭，批准超时或离开会话时失败关闭；
- 健康报告等结构化产物按白名单脱敏返回，不透传原始日志或未知字段；
- 每个员工 Profile 仍按自己的 Manifest、Prompt 和最小权限决定可用工具，不因共享 Server 合并岗位。

## Profile 作用域注意事项

本机验证发现，单独设置 `HERMES_PROFILE=xiaod` 不足以让所有 Hermes CLI 命令切换到隔离 Profile；通用状态命令仍可能读取默认环境。小D的启动与验收必须显式使用其独立 Profile 目录作为 Hermes Home，不能把通用 `hermes status` 的输出当作小D Profile 的凭据或模型证明。
