# 音视频转录 Agent Hermes / 飞书接线交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 接线验收完成，待定义岗位能力 |
| 创建时间 | 2026-07-22 20:48 CST |
| 交出者 | Codex |
| 接手者 | A 君 / 项目负责人 |
| 关联任务 | 新建“音视频转录 Agent”、独立 Hermes Profile 与飞书 bot |
| 截止条件 | 已完成独立 Profile 凭据配置，并通过私聊、群内 @ 两条真实收发验收；岗位能力仍等待负责人后续定义 |

## 1. 接手目标

- 目标：让 `av-transcriber` 拥有独立 Hermes 数据目录和独立飞书应用，仅用于当前接线测试。
- 用户约束与不可做事项：当前不配置转录能力，不承接正式任务；不复制小D Profile 的凭据、会话或数据；不把消息收发证明写成转录能力已上线。
- 做完的定义：Profile 使用独立凭据启动网关；私聊收到测试消息并回到原聊天；将 bot 加入测试群后，群内 @ 收到并回复；重复事件不重复回话。
- 唯一下一步：负责人提供角色能力、执行规则和允许调用的工具，随后再把 Agent 从 `draft` 推进到可承接正式任务的配置。
- 允许继续的前提：凭据只在本机隔离 Profile 中配置；不把 secret、token、Cookie、用户标识或聊天内容写入仓库、日志或对话。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 已新增 `av-transcriber` Manifest、Prompt、README 与 Hermes 映射；状态均为 `draft`，工具白名单为空 | `agents/av-transcriber/`、`integrations/hermes/profiles/av-transcriber.profile.json` | 已验证 |
| 本地运行时 | Hermes Profile 已创建于 `/Users/pengaro/.hermes/profiles/av-transcriber`；无技能；独立模型配置已生效；网关以飞书 WebSocket 长连接运行 | `hermes profile show av-transcriber`；Profile `logs/gateway.log` | 已验证 |
| 外部平台 | 飞书应用创建成功，名称为“音视频转录 Agent”，App ID 已写入不含密钥的 Profile 映射；机器人能力已启用 | 飞书开放平台 `/app/cli_aaea06d08bf85cba/baseinfo`、`/bot` | 已验证 |
| 外部平台 | 一键创建自动订阅 `im.message.receive_v1`，并明确开通私聊、群内 @ 机器人消息权限；同时自动带入其他文档/会议相关事件，最小化删除未确认持久生效 | 飞书开放平台 `/app/cli_aaea06d08bf85cba/event` | 部分验证 |
| 人工确认 | 负责人已确认创建应用 | 当前会话确认消息 | 已确认 |
| 私聊验收 | 新 bot 收到私聊测试消息并生成原会话回复 | Profile `logs/gateway.log`：`Inbound dm message received` → `response ready` → `Sending response` | 已验证 |
| 群聊验收 | 测试群内真实 @ 新 bot 后收到并生成群内回复 | Profile `logs/gateway.log`：`Inbound group message received` → `response ready` → `Sending response` | 已验证 |

## 3. 变更与决策

- 已完成：独立 profile 创建；飞书智能体应用创建；bot 能力和消息事件准备；模型配置；独立网关启动；私聊和群内 @ 真实收发验收；仓库版本化占位配置。
- 关键文件或外部配置位置：`agents/av-transcriber/manifest.json`；`agents/av-transcriber/prompts/system.md`；`integrations/hermes/profiles/av-transcriber.profile.json`；本机 `/Users/pengaro/.hermes/profiles/av-transcriber/.env`。
- 已确定的边界：此 Agent 仍是 `draft`，`toolAllowlist` 为空；没有角色能力、执行规则、生产模型或正式任务入口。
- 不要重复创建的产物：不要再创建第二个 Hermes Profile 或第二个飞书应用；继续使用已有 App ID 对应的应用。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `node --test agents/test/agent-manifest.test.mjs`；JSON 解析；`git diff --check` | 未覆盖真实新 Agent 网关 |
| 运行时 | PASS | 独立模型配置已生效；Profile Gateway 以飞书 WebSocket 长连接运行；日志显示 `feishu connected` | Agent 仍为 `draft`，未配置岗位能力 |
| 外部平台 | PASS | 新 bot 收到私聊及群内 @ 消息，并各自生成原会话回复 | 未证明额外自动订阅事件已删除 |
| 人工验收 | PASS | 私聊、群聊 @ 两条真实消息均完成收发 | 仅为接线验收，不代表转录能力已上线 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：Agent 仍没有转录岗位能力、工具白名单和正式任务规则；飞书一键创建带入的额外事件未证明已删除。
- 不得复制或展示的信息：App Secret、模型 API key、用户 `open_id`、群聊 ID、Cookie、聊天正文和本机 `.env` 内容。
- 需要谁确认：负责人提供下一阶段的角色能力、执行规则和调用能力；不通过聊天传 secret。
- 关闭条件：接线验收已满足；岗位仍保持 `draft`，直到能力定义与正式任务验收。
- 关闭证据链接：本机 Profile 日志中的私聊与群聊收发链路记录。
