# M1 小D飞书运行环境交接

> 已被 [`m1-xiaod-media-routing-acceptance-handoff.md`](./m1-xiaod-media-routing-acceptance-handoff.md) 替代。旧单保留用于追溯早期文本链路与环境配置过程；继续M1时以新单的运行快照、唯一下一步和验收门禁为准。

| 字段 | 内容 |
| --- | --- |
| 状态 | 接手中 |
| 创建时间 | 2026-07-19 Asia/Shanghai |
| 交出者 | 当前实施者 |
| 接手者 | 后续 M1 实施/验收者 |
| 关联任务 | `tasks/prd-m1-xiaod-feishu-closure.md` |
| 截止条件 | 小D首条受控媒体任务的真实交付结果已写入验收记录 |

## Continue with this

- Goal: 在不影响默认 Hermes 环境的前提下，把已验证的飞书文本入口接入小D媒体业务任务并完成首条交付。
- User constraints: 飞书仅限最小权限测试；真实凭据不得进入仓库、文档、日志或聊天；外发、扩权和高成本动作需要明确授权。
- Done means: 验收记录能区分文本对话闭环与媒体业务交付；仅在媒体→任务→产物→飞书交付真实通过后，才完成 M1。
- Exact next action: 已发现媒体附件曾进入通用 Hermes 模型会话，模型错误尝试下载/替换转写模型；已增加本机强制路由。重启小D网关后，在“`小D · M1机器人测试`”重新发送一条短、无敏感的音频文件或视频文件（非语音条），确认先回复任务编号，再验证转录与飞书交付。
- Continue only when: 不在聊天中提供任何凭据；白名单仅含获授权测试用户；Gateway 使用隔离 Profile 启动。

## Project truth

- Repository root: `/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent`
- Branch/worktree: 当前目录不是 Git 仓库，分支与 HEAD 不适用。
- Dirty baseline before this task: 不适用；不得覆盖现有文件的未知修改。
- Unrelated user changes to preserve: 全部现有工作区内容，除本交接规范与交接单外。

## Work surfaces

| Surface | Location | Role | Current truth status |
| --- | --- | --- | --- |
| Live implementation | `apps/xiaod-media-transcriber/` | 小D业务应用和产物真相 | 已在 `4318` 以隔离 `HERMES_HOME` 启动；健康检查通过，尚未运行真实媒体 |
| Agent/runtime mapping | `agents/xiaod/`、`integrations/hermes/` | 岗位定义与隔离运行时映射 | 契约检查已通过；Gateway 正在运行，文本消息闭环已验证 |
| External/operator surface | 飞书个人版传统机器人测试应用 | 消息入口与最小权限验证 | 已发布，凭据已配置；文本消息链路已通过 |

## Completed and decided

- Completed scope: 隔离 `xiaod` Hermes Profile 已创建；传统飞书机器人测试应用已发布；仅保留 `im.message.receive_v1`，外部群和外部用户单聊均关闭；旧智能体应用保留，待后续单独验证。
- Durable decisions and invariants: M1 采用传统飞书机器人 + Hermes + 小D业务应用，以复用既有适配器并缩小验证范围；Paperclip 延后至 M2；飞书用户默认白名单；不能以通用 `hermes status` 作为小D独立环境的证明；一键智能体应用的单独验证或额外桥接不进入 M1 范围，不能把这项范围选择理解为不兼容结论。
- Important changed files: `agents/xiaod/prompts/system.md`、`apps/xiaod-media-transcriber/src/feishu-media-intake.js`、`apps/xiaod-media-transcriber/scripts/submit-feishu-media.mjs`、`docs/reviews/m1-xiaod-feishu-closure/acceptance.md`。
- Existing artifacts to read instead of duplicating here: `tasks/prd-m1-xiaod-feishu-closure.md`、`docs/reviews/m1-xiaod-feishu-closure/acceptance.md`、`integrations/feishu/README.md`、`integrations/hermes/README.md`。

## Verification ledger

| Layer | Verdict | Command or evidence | Notes |
| --- | --- | --- | --- |
| Code | PASS | `node --test agents/test/agent-manifest.test.mjs` | 3/3 小D契约检查通过 |
| Runtime identity | PASS | 独立 Home 前台 Gateway 进程与安全日志摘要 | 已建立飞书长连接；未读取 `.env` |
| Live behavior | NOT CHECKED | 无 | 未发送测试消息 |
| Release readiness | PARTIAL | 飞书测试应用版本 `1.0.1` 已发布 | 仅限最小测试环境，M1 业务闭环未完成 |

## Live runtime snapshot

Checked at: `2026-07-19 Asia/Shanghai`

| Service role | URL/port | Listener/process | Process cwd | Config source |
| --- | --- | --- | --- | --- |
| 小D Hermes Gateway | 已停止 | 无 | 不适用 | `~/.hermes/profiles/xiaod/.env`，仅由所有者手动维护 |
| 小D业务应用 | 未检查 | 未检查 | 未检查 | `apps/xiaod-media-transcriber/.env`（不读取） |

## Commands already run

```text
hermes profile show xiaod
启动前确认隔离 Profile 已创建，Gateway 状态为 stopped；该命令不反映后续前台运行模式。

node --test agents/test/agent-manifest.test.mjs
3/3 通过。

HERMES_HOME=/Users/pengaro/.hermes/profiles/xiaod hermes gateway run
前台 Gateway 曾启动；安全日志摘要确认飞书长连接已建立，未发现错误标记或入站消息。该次无入站现象尚未定位；已停止，待使用现有传统机器人凭据重新验证。
```

## Open risks and gates

- Blocker or risk: 文本消息链路已通过，媒体入口已实现但尚未由真实飞书媒体驱动；不得通过读取 `.env`、放宽白名单或把语音条误当文件入口来解决。
- External state that may have changed: 飞书测试应用名称仍可能为账户默认名称；不影响最小消息验证，但人工测试前应确认或更名。
- Human confirmation required: 所有者已确认传统机器人凭据已配置；继续前仅需确认白名单仍仅含获授权测试用户。
- Dangerous or destructive action not yet authorized: 任何外发、公开发布、扩权；所有者已同意使用一条短、无敏感媒体完成 M1 受控验证。

## Recommended skills

- `project-execution-loop` — 启动隔离 Gateway 与消息验证时，区分配置、运行时和外部平台证据。
- `web-access:web-access` — 需要在飞书网页端操作或验证消息时使用。
