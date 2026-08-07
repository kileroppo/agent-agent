# M2 飞书 Agent 入口与 Paperclip 总控交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-07-20 20:14 CST |
| 交出者 | Codex |
| 接手者 | M2 实施负责人 |
| 关联任务 | `tasks/prd-agent-army-master.md`、`tasks/prd-m2-authorization-connectors.md` |
| 截止条件 | 2026-07-24 已完成 A君 官方飞书入口的私聊、卡片、重启恢复、原会话与真实群聊 @ 验收；旧 Hermes 总管入口已停止 |

## 关闭记录（2026-07-24 19:55 CST）

- 结果：现用 `A君·军团总管` 已补齐群内 @ 权限、发布并加入真实验收群；旧同名应用已改名为 `A君·军团总管（旧版）`。
- 自动化：`cd apps/ajun-runtime && npm test` 为 333 通过、0 失败。
- 运行时：A君 重启后由当前仓库 `apps/ajun-runtime/src/server.js` 监听本机 `4321`，官方飞书长连接恢复为已连接。
- 外部平台：真实群聊 @ 在白名单加载后只建立一条任务并回复一次；停止旧 Hermes 总管 LaunchAgent 后再次复验，官方入口仍独立建立一条任务并回复一次。
- 关闭证据：[ARMY-032 验收账本](../../reviews/m2-real-small-army/acceptance.md)。
- 唯一下一步：本交接不再继续；多人协作群内员工接力另按 ARMY-033 执行，不重启旧总管入口。
- 继续条件：只有 ARMY-032 出现新的真实回归失败时，才创建新交接单并链接本单；不得把旧快照中的待办当作当前状态。

## 原始交接快照（已被上方关闭记录取代）

- Goal: 把飞书作为用户日常调用 Agent 的入口，把 Paperclip 作为组织、任务、heartbeat、预算、审批与审计的唯一总控；A君作为可扩展的本机能力底座，只保留连接授权、内容获取、组件健康、执行适配、结果诊断和恢复。
- User constraints: 小D转录已经可用，不重做它；截图是飞书原生聊天侧栏，不单独做一模一样的目录页；新造轮子前先查有没有现成能力；不要用文档替代实际推进。
- Done means: 用户能从飞书中现有的 Agent 会话发起至少一种真实业务请求；小D的既有转录流程不被改坏；简单单 Agent 请求不被强制插入 Paperclip，符合组织级治理条件的任务能以最小信封进入其管理链路。
- Exact next action: 先查飞书官方对机器人/应用会话的真实能力，并核对本仓库小D现有飞书接入，确定“把小D作为飞书会话入口”所需的最小接线；不得克隆截图中的会话侧栏。
- Continue only when: 使用官方资料和现有代码确认可行入口；若需要新建飞书应用、进入管理后台、发消息或改权限，先取得所有者对该外部操作的明确授权。

## Project truth

- Repository root: `/Users/pengaro/Documents/work/codeDevelop/ideaSpace/agent-agent`
- Branch/worktree: `main`；当前目录为主工作树。
- HEAD: `6670268`
- Dirty baseline before this handoff: 工作树已有广泛未提交修改和新增目录；本交接单不得覆盖或回滚其中任何内容。
- Unrelated user changes to preserve: 除本交接单和 `docs/handoffs/README.md` 的入口链接外，所有现有改动均视为需保留。

## Work surfaces

| Surface | Location | Role | Current truth status |
| --- | --- | --- | --- |
| Live implementation | `apps/ajun-runtime/` | A君本地执行适配、结果和恢复；含 Paperclip heartbeat 回调 | 已在本机运行 |
| Live implementation | `apps/xiaod-media-transcriber/` | 小D已有媒体转录、整理和飞书交付能力 | 已有真实交付记录；本轮未重测 |
| Control plane | Paperclip `http://127.0.0.1:3100` | 组织、任务、heartbeat、预算、审批与审计唯一总控 | 已完成一条本机低风险任务闭环 |
| User entry | 飞书原生 Agent 会话列表 | 用户选择不同 Agent 并对话的实际界面，不是本仓库网页要复刻的 UI | 具体多 Agent 接入方式待官方资料与本地接入核对 |
| Prototype/reference | A君历史任务页 | 仅作历史参考，不是军团组织或飞书侧栏替代品 | 不得继续扩成第二个控制台 |

## Completed and decided

- Completed scope: Paperclip `2026.707.0` 以私有 loopback 模式运行；`A君本机健康官` 通过内置 HTTP Adapter 完成 `AGE-18` 的“任务分配 → heartbeat → A君低风险检查 → 回报同一任务 → done”闭环。重复 heartbeat 按任务 ID 去重。
- Durable decisions and invariants: Paperclip 是唯一军团总控，但不是每条飞书消息的必经中转；低风险、单 Agent、可立即完成的请求直达 Hermes，跨 Agent、长任务、预算、审批、暂停/终止或统一审计需求才以事件幂等键进入 Paperclip 最小任务信封；飞书是日常派活与交付入口；A君不是第二套组织图、任务队列、排程、预算、审批或审计后台，其页面只承担授权、组件健康、恢复和脱敏诊断；新增本机能力必须经由能力、连接、内容、执行和恢复契约扩展；小D是已可用的业务 Agent，后续只接入口与治理，不重写转录能力。
- Important changed files: `apps/ajun-runtime/src/paperclip-heartbeat.js`、`apps/ajun-runtime/src/paperclip-bridge.js`、`apps/ajun-runtime/src/server.js`、`apps/ajun-runtime/test/paperclip-heartbeat.test.js`；相关 M2 文档见下列入口。
- Existing artifacts to read instead of duplicating here: `docs/handoffs/current/m2-authorization-connectors-planning-handoff.md`（M2总接手事实）、`tasks/prd-agent-army-master.md`、`tasks/prd-m2-authorization-connectors.md`、`docs/plans/m2-army-runtime-skeleton-plan.md`、`integrations/feishu/README.md`。

## Verification ledger

| Layer | Verdict | Command or evidence | Notes |
| --- | --- | --- | --- |
| Code | PASS | `cd apps/ajun-runtime && npm test`，2026-07-20 20:14 CST：38/38 passed | 覆盖 Paperclip heartbeat 同单回报与去重；未覆盖飞书多 Agent 入口 |
| Runtime identity | PASS | `lsof -nP -iTCP:3100 -sTCP:LISTEN`、`lsof -nP -iTCP:4321 -sTCP:LISTEN` | 见下表；运行态会随时间变化 |
| Live behavior | PARTIAL | Paperclip `AGE-18` 完成闭环；小D此前已完成受控转录与飞书交付 | 本轮未验证飞书多 Agent 会话入口，也未把小D接入 Paperclip |
| Release readiness | PARTIAL | 本机控制面与低风险适配已验证 | 飞书应用/会话配置、真实业务 Agent 的 Paperclip 治理、预算与审批尚未验收 |

## Live runtime snapshot

Checked at: 2026-07-20 20:14 CST

| Service role | URL/port | Listener/process | Process cwd | Config source |
| --- | --- | --- | --- | --- |
| Paperclip 总控 | `http://127.0.0.1:3100` | PID `34666`，`paperclipai run --no-repair`，仅 `127.0.0.1` | 仓库根目录 | Paperclip 本机配置；不得读取或记录 `.env` |
| A君本地运行时 | `http://127.0.0.1:4321` | PID `57194`，`node src/server.js`，监听 `*:4321` | `apps/ajun-runtime` | 本机运行配置；不得读取或记录 `.env` |

## Commands already run

```text
cd apps/ajun-runtime && npm test
38 passed, 0 failed（2026-07-20 20:14 CST）

lsof -nP -iTCP:3100 -sTCP:LISTEN
PID 34666 listens on 127.0.0.1:3100

lsof -nP -iTCP:4321 -sTCP:LISTEN
PID 57194 listens on *:4321
```

## Open risks and gates

- Blocker or risk: 截图中的部门分组和会话列表由飞书客户端呈现；尚未确认飞书是否支持以应用配置实现同样的分组方式。不能据截图推断可编程能力，更不能先复制一个网页。
- External state that may have changed: 飞书应用、机器人发布状态和 Paperclip 进程均是外部/运行态，应在实施前复核。
- Human confirmation required: 若最小接线需要新建或发布飞书机器人、修改权限、登录飞书管理后台或发送测试消息，必须由所有者明确授权范围。
- Dangerous or destructive action not yet authorized: 任何飞书应用创建/发布、权限扩张、外发消息、外部账号连接、公开发布；不得读取或展示凭据、Cookie、token、授权链接、浏览器会话或私密媒体。

## Recommended skills

- `web-access:web-access` — 查飞书官方机器人/应用会话能力时必须使用，避免凭截图臆测。
- `project-execution-loop` — 在确认入口后执行跨飞书、Paperclip与小D的最小接线，并把代码、运行时和外部证据分开验证。
- `browser-testing-with-devtools` — 若新增或调整本地入口页，验证真实页面和控制台状态；不用于替代飞书外部验收。
