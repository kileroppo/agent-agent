# 飞书集成

当前 `A君·军团总管` 使用 Hermes 原生飞书 Gateway，不暴露公网回调地址。同一聊天由 Hermes Session 承接上下文、Profile 记忆和工具选择，军团事实与任务通过本机 Agent Army MCP 读取 A君/Paperclip；不在飞书层保存第二套任务真相。真实私聊连续追问、Gateway 重启恢复、拒绝不执行和低风险健康任务已通过 [ARMY-041](../../docs/reviews/m2-real-small-army/acceptance.md)。

创建官、任务协调官、审核官、架构师、运维官和技术专家也已分别完成老板真实私聊。六个 Profile 各自只产生自己的 Feishu Session，统一验收代号在老板消息和员工回复中均命中；创建官在 Gateway 重启后沿用同一会话继续追问。自动复验只读取会话数量、角色消息计数、代号命中和哈希后的会话指纹，不输出用户/会话标识或对话正文：`cd apps/ajun-runtime && npm run acceptance:governance-feishu`。

官方 Channel SDK 没有删除：它继续承载尚未迁移的独立员工应用，并保留为 A君和员工入口的应急回退；官方一键创建能力负责最小权限员工应用，官方 CLI 只负责已经获准的飞书内容动作。Hermes 负责总管和已迁移员工的连续对话体验，A君负责军团事实与执行适配，Paperclip 负责组织级审批与审计。当前取舍见 [ADR-0007](../../docs/adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md)，既有官方接线证据见 [ADR-0006](../../docs/adr/0006-prefer-official-feishu-agent-stack.md)。

目前 A君、小R和小办分别由自己的 Hermes Profile Gateway 接收飞书消息；A君运行时把这三个应用标记为外部接管，不再为它们启动官方 SDK 长连接。其他已配置员工仍可走官方 SDK。两条路径都只读取本机私有应用配置和允许人员、群聊名单，不在仓库保存凭据。

本机 `A君运行台 → 员工接线` 已为小R和小办提供脱敏状态。两个独立应用均已创建、发布，并完成“老板私聊派活 → 独立 Hermes 模型调用 → Agent Army MCP 创建并读取任务 → 同一私聊返回真实产物 → 基于上文继续追问”的外部验收。每个员工使用独立 App、Hermes Profile、Session、SOUL 和最小 MCP 作用域。读取接口只返回是否已配置、模型/通道状态、所需事件与权限，不返回任何凭据；通道由 Hermes 接管后，页面隐藏凭据表单并要求受控迁移，避免配置只写一侧或出现双连接。

本机与私人云迁移使用 `AGENT_ARMY_EMPLOYEE_FEISHU_OWNER` 做唯一接管：归属不匹配的一侧只显示待命，不读取应用密钥、不建立重复长连接。当前正式归属仍为 `local`；只有按 [混合在线部署顺序](../../ops/hybrid-online/README.md#飞书入口唯一接管) 完成切换后，才允许云端接管。

## 已完成的测试环境准备

- 已创建并发布一个仅供 M1 使用的传统飞书个人版机器人应用；
- 机器人能力已启用；
- 仅订阅 `im.message.receive_v1`；
- 使用长连接接收事件；
- 仅开通 `im:message` 与读取用户发给机器人的单聊消息所需权限；
- 外部群与外部用户单聊均关闭；
- 当前一键智能体应用保留但不作为 M1 入口；后续新员工应用会采用官方最小权限创建流程，而不是复制 M1 的人工配置；
- `ajun-canary` 隔离 Profile 已完成 MCP 与连续会话验证，但不启动第二个同应用 Gateway；正式 Gateway 才连接当前 A君应用。

## 凭据配置边界

真实值只能由应用所有者手动写入隔离 Profile 的本地环境文件，例如：

```text
~/.hermes/profiles/xiaod/.env
```

变量名见 [`.env.example`](./.env.example)。不要将真实 App ID、App Secret、用户标识或 token 写入仓库、文档、测试输出或聊天记录。

`FEISHU_ALLOWED_USERS` 只能填写获授权人员的用户 `open_id`（常见前缀为 `ou_`），不能填写单聊会话 ID（前缀为 `oc_`）。白名单变化后必须重启隔离 Gateway 才会生效。

## 启动前门禁

1. 从新传统机器人应用的“凭证与基础信息”手动获取 App ID、App Secret，写入隔离 Profile，并保留允许用户白名单；
2. 设置小D专用模型配置，避免从终端或默认 Profile 继承密钥；
3. 使用隔离 Profile 启动 Gateway 并验证长连接成功；
4. 从飞书发送一条无敏感内容的测试消息，验证消息接收、身份准入和幂等创建；
5. 关闭 Gateway 或保留受控本机服务，再记录验收结果。

对应角色映射见 [小D Hermes Profile](../hermes/profiles/xiaod.profile.json)，M1 平台证据见 [验收记录](../../docs/reviews/m1-xiaod-feishu-closure/acceptance.md)。
