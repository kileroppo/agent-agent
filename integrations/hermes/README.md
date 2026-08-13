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

所有常驻与按需岗位共用同一套中文交互和飞书移动端排版规则。新消息到达后只在用户原消息上显示一个处理图标，最终回复后移除，不再另发“已收到”气泡。运行中补充要求时，Gateway 用中文说明实际处理方式，并提供“下一步单独处理 / 查看当前设置 / 停止当前任务”快捷按钮；按钮点击会直接执行对应命令。飞书发送前会先归一化 Agent 原文自带的空行，再按内容调整密度：标题、首项和普通项目分别成为相邻的原生 post 行，形成统一的小行距；章节之间才加入一个独立间隔行；较长编号步骤可在项目之间分段，普通圆点列表无论长短都保持一致；模型压在同一行或使用 `1)` / `2)` 写法的长编号列表会转成分段列表，金额小数不参与识别；加粗只保留给章节标题和列表开头的“标签：”，正文中的模型临时强调会还原，工具标识继续使用代码样式；手机端容易变形的宽表或长单元格表转为分组列表，短小对比表仍保留。

布局主链不再通过原文空行或逐条文本正则决定间距。`runtime/agent_army_feishu_layout.py` 复用 Hermes 已安装的 `markdown-it-py`，先把 Markdown 解析为文档标题、章节标题、正文、圆点项、编号项、表格、代码块和引用等语义块，再按块关系生成飞书原生行；同一语义内容无论 Agent 多写、少写空行，行结构都相同。文本修复层只保留编号压行、异常粗体和移动端宽表等输入兼容，不参与章节间距决策；该路径不增加模型调用、延迟或 token 费用。

飞书任务卡只服务于三类需要持续承载的业务信息：有生命周期的任务进度、后端真实支持
的审批/暂停/继续，以及经校验的最终交付入口。普通问答、身份或能力说明、秒级查询、
常规健康检查继续回复简洁文字；任务建立后先等待 5 秒，若已进入终态就只发最终文字，
仍在执行、等待审批或确有交付入口时才建立卡片。不得为“让更多 Agent 看起来一致”而
发卡，不得从模型回复文字猜测任务号、故障类型或按钮能力。

卡片策略以 AgentManifest 的 `interaction.taskCardPolicy` 为唯一声明，缺失必须按
`disabled` 处理：

| 策略 | 岗位 | 使用边界 |
| --- | --- | --- |
| `routed-task` | A君 | 正式派发且 5 秒后仍未完成的任务；岗位转派只更新原会话卡片，不在下游重复发卡 |
| `durable-task` | 小D、小R、小办 | 转写/媒体、持续调研、PPT/文档等有任务真相的持续工作；普通问答和快速结果不用卡片 |
| `incident-only` | 运维官 | 仅结构化标记的故障、恢复或审批任务；正常巡检和健康摘要保持文字 |
| `disabled` | 其他岗位 | 不建立独立卡片；作为执行人时显示在 A君或原始发起会话已有卡片中 |

所有启用岗位复用同一 `agent.army/task-card/v1` 渲染与 A君 任务真相，不新增队列、
会话库或审批系统。同一 `agentId + profileId + chatId + taskId` 只允许一个可信
`message_id` 锚点，后续状态使用飞书消息卡片 PATCH 原地更新；身份不匹配、旧 revision、
未知策略和过期按钮都失败关闭。运行中的卡片把“查看任务详情”和“刷新任务状态”分成两个
明确动作：详情直接在当前飞书卡片内展开/收起，不依赖手机无法访问的本机回环链接；刷新只
拉取最新权威状态。终态卡片直接展示只读详情并移除全部按钮；业务动作仍只从当前任务投影
的真实可用动作生成，交付链接只接受经校验的飞书 HTTPS 地址。回调使用
`event.context.open_message_id`，先写入 A君/Paperclip 权威真相，再返回最新卡片。

卡片元数据保存在各 `HERMES_HOME` 的 Profile 私有 `0600` 账本中；A君、小D、小R、
小办和运维官之间不得共享锚点。初发结果未知停在 `anchor_uncertain`，不会盲目重发；
已有账本不可读或 provider 返回后无法更新账本时失败关闭，不补发第二张卡。单一
supervisor 最大并发 3，按任务年龄使用 2/15/60 秒退避且无固定超时。未收到 Hermes
可信锚点回执的 MCP/HTTP 任务继续保留终态 watcher，调用方声明
`anchorEstablished` 不能自行关闭回告。

### 卡片灰度与回滚

活动 Gateway 共用 `~/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py`，但使用
独立 `HERMES_HOME`、launchd 环境和卡片账本。升级源码先运行聚焦测试，再对共享安装执行
一次 `patch-feishu-agent-proposal-router.mjs`；启用和回滚必须按 Profile 分开，不复制五份
adapter。当前运行标签与 Home 为：

| 岗位 | launchd 标签 | `HERMES_HOME` |
| --- | --- | --- |
| A君 | `ai.hermes.gateway` | `~/.hermes` |
| 小D | `com.xiaod.hermes.gateway.retryfix` | `~/.hermes/profiles/xiaod` |
| 小R | `ai.hermes.gateway-intel-researcher` | `~/.hermes/profiles/intel-researcher` |
| 小办 | `ai.hermes.gateway-office-assistant` | `~/.hermes/profiles/office-assistant` |
| 运维官 | `ai.hermes.gateway-operator` | `~/.hermes/profiles/operator` |

Gateway 与岗位 MCP 统一使用 `AGENT_ARMY_TASK_CARD_POLICY`；旧
`AGENT_ARMY_FEISHU_TASK_CARD_POLICY` 只保留为 Gateway 兼容别名。Profile 同步从 Manifest
把该策略写入 MCP 环境，launchd 必须写入同值，避免“任务投影允许、Gateway 仍关闭”或反向
漂移。A君旧 `AJUN_FEISHU_DYNAMIC_TASK_CARD=true` 只作为 `routed-task` 兼容入口，其他岗位不得
复用这个 A君专用变量。Agent 使用 `AGENT_ARMY_FEISHU_AGENT_ID`（A君旧安装兼容
`AJUN_FEISHU_ENTRY_AGENT_ID`），Profile 使用 `AGENT_ARMY_PROFILE_ID`；卡片状态与动作
只访问独立的回环 `AGENT_ARMY_TASK_CARD_BASE_URL`。会话 ID 由结构化接线传递，不能从
卡片文案推断；非 A君 Profile 即使误留 Commander URL，也必须拒绝进入 A君文本路由。
删除或设为 `disabled` 后重载目标 Gateway 即为单 Profile 回滚；不要删除账本，因为其中可能
已经保存飞书可见锚点。

A君当前仍是历史根 Home `~/.hermes`，而 Manifest Profile 同步器的 `ajun` 目标是
`~/.hermes/profiles/ajun`。在二者完成正式迁移前，不得用 `--only ajun` 的 apply 结果声称
活动 A君 已同步；A君继续走已通过真实验收的 Commander 与旧开关兼容路径。其他四个活动
Gateway 才与同步器的 Profile 目录一一对应。

灰度顺序固定为 A君回归 → 小D → 小R → 小办 → 运维官；上一个 Profile 完成“连接恢复、
单卡出现、原卡刷新、终态收起按钮、账本 `0600`”后才启用下一个。任一 Profile 异常时
只关闭该 Profile 的卡片开关并重载对应 Gateway，文字回复和其他四个 Gateway 保持运行；
不要用停掉共享 adapter 或全部 Gateway 作为常规回滚。实际结果登记在
[飞书任务卡分岗位灰度验收](../../docs/reviews/m2-real-small-army/feishu-task-card-rollout-acceptance.md)。

上述行为由仓库补丁维护，Hermes 升级后须重新执行并验证：

```bash
node integrations/hermes/scripts/patch-hermes-chinese-busy-notice.mjs
node integrations/hermes/scripts/patch-hermes-chinese-provider-errors.mjs
node integrations/hermes/scripts/patch-feishu-agent-proposal-router.mjs
node integrations/hermes/scripts/patch-hermes-agent-army-task-card-events.mjs
node integrations/hermes/scripts/patch-hermes-platform-notification-isolation.mjs
node integrations/hermes/scripts/patch-hermes-display-setting-scope.mjs
node integrations/hermes/scripts/patch-hermes-chinese-slash-confirm.mjs
node integrations/hermes/scripts/patch-hermes-business-error-envelope.mjs
```

全部 8 个可执行补丁当前锁定 Hermes `0.19.0` 与 Git
`fd39696ccfbb1221ac9fdb6119f629f9821e195d`。每个补丁在写文件前都会同时校验
目标相对路径、`pyproject.toml` 版本和 Hermes Git 身份；任一不匹配就失败关闭，不对新版
源码猜锚点。升级 Hermes 时必须先在仓库更新锁定基线、Host Interface 测试和真实源码
夹具，不能通过跳过校验继续安装。这些维护 CLI 只支持单写者执行；不得并行对同一 Hermes
安装运行多个补丁命令。

`runtime/agent_army_feishu_task_card.py` 是正式的任务卡 Adapter Module：它集中持有
Profile 私有锚点账本、投影轮询、可信 MCP 结果解析、卡片回调校验、渲染与最终通知抑制。
`patch-feishu-agent-proposal-router.mjs` 只原子安装该 Module、迁移旧 V1/V2/V3 内嵌方法并
在 `FeishuAdapter` 类加载结束后安装一个版本化 Seam；已迁移文件重复执行不再追加代码。
`patch-hermes-agent-army-task-card-events.mjs` 必须随后执行，它只在 Gateway 的工具完成回调
处接入该 Module 暴露的可信事件 Interface，不在 Gateway 中维护工具白名单或解析模型文本。
正式执行这两个命令仍属于 Hermes 安装维护，需要维护窗口、聚焦测试和后续 Gateway 重载；
本仓库源码验证本身不代表活动安装或真实飞书已生效。

`patch-hermes-display-setting-scope.mjs` 修复 Hermes Gateway 嵌套执行器中的
Python 名字作用域回归：平台通知逻辑不得在 `run_sync()` 后半段重新局部导入
`resolve_display_setting`，否则流式设置会在第一次模型调用前触发
`UnboundLocalError`。补丁会把该导入固定到 `run_sync()` 入口并可重复执行；
升级 Hermes 后须先运行对应测试，再重放补丁和重启 Gateway。

`patch-feishu-agent-proposal-router.mjs` 还会保留处理图标的兼容请求体，并把
飞书拒绝添加或删除图标的结果提升为脱敏警告，只记录错误码和归类，不记录消息、
用户或授权链接。`patch-hermes-business-error-envelope.mjs` 同时覆盖 Agent 结果层
和平台最外层异常回执；未知异常只向用户返回中文说明与错误编号，不再暴露 Python
异常详情或建议清空会话。

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
- `completion_delivery=dynamic_card` 只表示投递意图，不是卡片已发出的证据；只有服务端收到 Hermes 可信锚点回执后才抑制该任务的文本 watcher，否则必须保留终态回告。

## Profile 作用域注意事项

本机验证发现，单独设置 `HERMES_PROFILE=xiaod` 不足以让所有 Hermes CLI 命令切换到隔离 Profile；通用状态命令仍可能读取默认环境。小D的启动与验收必须显式使用其独立 Profile 目录作为 Hermes Home，不能把通用 `hermes status` 的输出当作小D Profile 的凭据或模型证明。
