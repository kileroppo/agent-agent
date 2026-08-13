# 飞书任务卡分岗位灰度验收

| 字段 | 内容 |
| --- | --- |
| 状态 | 已部署并验收；自动化、五个活动 Gateway、真实 Feishu provider 与桌面客户端视觉闭环均通过 |
| 日期 | 2026-08-12 |
| 范围 | A君、小D、小R、小办、运维官的卡片策略、Profile 隔离、灰度和真实飞书验收 |

## 用途门禁

- 卡片只用于持续任务状态、真实可执行动作和最终交付入口。
- 建立任务后等待 5 秒；已完成的快任务只发最终文字，不创建卡片。
- 普通问答、能力说明、状态查询和运维正常巡检不发卡。
- 同一任务由原始飞书会话持有一张卡片；转派岗位不另建第二张。
- 创建官、审核官、架构师、技术专家等非直连岗位保持 `disabled`，不新增 Gateway。

## 自动化与运行态账本

| 项目 | 要证明什么 | 当前状态 | 证据或待执行检查 |
| --- | --- | --- | --- |
| Manifest 策略 | A君=`routed-task`；小D/小R/小办=`durable-task`；运维官=`incident-only`；其余默认 `disabled` | **PASS** | Agent Manifest、Profile MCP 环境与 Paperclip adapter 契约测试 |
| 快任务边界 | 5 秒内终态只发文字，5 秒后仍活动才允许初发卡 | **PASS** | Hermes adapter 快任务 debounce 与 A君 HTTP 投影测试 |
| 单卡与隔离 | `agentId + profileId + chatId + taskId` 防串卡，同任务只维护一个锚点 | **PASS** | Hermes runtime/adapter 与非 A君 HTTP 身份测试 |
| 失败关闭 | 未知策略、跨会话/跨 Profile、旧 revision、未知初发结果不产生第二张卡 | **PASS** | Hermes runtime/adapter 与 task-card action 测试 |
| 动作真实性 | 只显示投影中当前可用的批准/拒绝/暂停/继续；终态零动作 | **PASS** | A君 task-card API、renderer 与回调测试 |
| 活动安装 | 五个 Gateway 使用同一已修补 adapter，身份和策略由各自 launchd 环境固定 | **PASS** | 最终重载后 A君/小D/小R/小办/运维官 PID 为 `16883/16896/16919/16942/16965`，均重新出现 `✓ feishu connected`；五份卡片账本均为 `0600` |

2026-08-12 切换前只读基线：五个活动 Gateway 均为 `running`，PID 分别为 A君
`70874`、小D `70928`、小R `70925`、小办 `70887`、运维官 `70912`；五份日志最近一次
共同记录 `2026-08-12 14:07 ✓ feishu connected`。五者共享 Hermes 安装中的 adapter，
但 `HERMES_HOME` 按上表隔离。该基线只证明原有 Gateway 正常，不证明新增岗位卡片已加载。

自动化证据：以下九个聚焦测试文件合并运行 `115/115` 通过，覆盖 Manifest、Profile 同步、
Paperclip Hermes 配置、A君 HTTP 投影、卡片渲染、Hermes adapter、MCP 完成事件和身份隔离：
`agents/test/agent-manifest.test.mjs`、`integrations/hermes/test/feishu-task-card-runtime.test.mjs`、
`integrations/hermes/test/patch-feishu-agent-proposal-router.test.mjs`、
`integrations/hermes/test/patch-hermes-agent-army-task-card-events.test.mjs`、
`apps/ajun-runtime/test/governance-hermes-runtime.test.js`、
`apps/ajun-runtime/test/configure-governance-hermes-runtime.test.js`、
`apps/ajun-runtime/test/runtime-http-feishu.test.js`、
`apps/ajun-runtime/test/task-card-presentation.test.js`、
`apps/ajun-runtime/test/agent-army-mcp-completion-delivery.test.js`。

Manifest 管理的五个 Profile 目录已完成 dry-run，结果均为 `writesPerformed=false`、
`gatewayActions=0`，只检出 MCP 环境缺 `AGENT_ARMY_PROFILE_ID` 与
`AGENT_ARMY_TASK_CARD_POLICY`，SOUL 与飞书工具白名单无漂移。小D、小R、小办和运维官
的活动 Gateway 正使用这些 Profile 目录，可以按受控 Profile sync 收敛。A君是历史兼容例外：
活动 Gateway 使用 `~/.hermes`，而配置器的 `ajun` 目标为 `~/.hermes/profiles/ajun`；不得把
后者 apply 当成活动 A君 已同步。A君本轮继续使用已验证的 Commander 与旧开关兼容路径，
除非另行完成根 Home 的安全迁移。共享 adapter 仍只安装一次，launchd 身份/策略逐个启用。

2026-08-12 18:15-18:17 活动切换：A君 runtime 已切到只读不可变包
`a566f108a545176fef61339d200aaeb907059d0267a12e0893e0b7d4a1e8f6a9`，冻结包启动验证和
恢复模式验证通过；活动 PID 为 `11753`，概览仍为处理中 `0`、待审批 `0`。共享 Hermes
adapter 和 Gateway MCP 事件桥已安装并通过 Python 编译与二次幂等补丁检查。四个员工
Profile 已用受控同步器写入新不可变 MCP 路径、`AGENT_ARMY_PROFILE_ID` 和
`AGENT_ARMY_TASK_CARD_POLICY`，二次 dry-run 无漂移；A君根 Home 保持 Commander 兼容路径。
五个 launchd 任务分别固定 Agent、Profile、策略和本机 `127.0.0.1:4321` 卡片真相入口，
未给非 A君 Profile 配置 Commander ingress，因此不会截获员工普通对话。切换前的 plist、
adapter 和 Gateway run 文件保存在权限受控的本机备份目录中，可按单 Profile 回滚。

第一次真实小D卡片初发已获得 Feishu `message_id`，随后在最终通知抑制处暴露构造器缺省字段；
灰度因此立即停在小D，没有继续其他岗位。补丁补齐初始化并新增回归断言后，共享 adapter
重新安装、编译并重载五个 Gateway。之后使用各 Profile 已存在的真实飞书原会话，依次完成
小D、小R、小办、运维官受控审批任务的“初发卡成功 → 权威拒绝测试任务 → PATCH 同一锚点为
终态 → 终态动作为空”；四份新账本均以 `0600` 创建。运维官另用结构化
`operations.health-review` 待审批样例验证 `healthReviewCardSent=false` 且账本锚点数不变。
测试任务只用于卡片链路，均已拒绝关闭，未执行外发、付费、删除或扩权。

## 真实飞书分岗位验收

| 岗位 | 受控样例 | 卡片用途与通过标准 | 外部/人工状态 |
| --- | --- | --- | --- |
| A君 | 无执行器、无模型、无外发的 `army.intake` | 单卡出现；“查看最新状态”PATCH 原卡；终态移除按钮 | **PASS**：任务 `#13AA0C77` 已由负责人确认原地刷新 |
| 小D | 本机短媒体或受控媒体任务 | 5 秒后仍活动才发卡；真实可暂停/继续时才显示按钮；完成后给交付入口 | **PASS**：桌面原会话只见任务 `#3ADA740A` 的一张终态卡，显示“已取消/任务已经关闭”，无动作按钮；provider 原卡 PATCH 与 `0600` 账本一致 |
| 小R | 不登录、不付费的公开来源调研 | 只显示调研状态、刷新和可信交付入口，不出现虚假暂停 | **PASS**：桌面原会话只见任务 `#113ECBEB` 的一张终态卡，显示“已取消/任务已经关闭”，无动作按钮；provider 原卡 PATCH 与 `0600` 账本一致 |
| 小办 | 本机受控文档或 PPT 制作 | 只显示制作状态、刷新和可信飞书交付入口 | **PASS**：桌面原会话只见任务 `#333414F1` 的一张终态卡，显示“已取消/任务已经关闭”，无动作按钮；provider 原卡 PATCH 与 `0600` 账本一致 |
| 运维官 | 一次正常健康检查 + 一次受控事故/恢复任务 | 正常检查只回文字；只有结构化事故、恢复或审批任务发卡 | **PASS**：桌面原会话只见事故任务 `#43073FBE` 的一张终态卡，显示“已取消/任务已经关闭”，无动作按钮；未出现 health-review 卡，且 provider/账本均证明未新增锚点 |
| 其他岗位 | 不执行测试任务 | 不新增独立卡片、不新增常驻 Gateway | **PASS**：Manifest 默认 `disabled`，活动运行态仍只有原五个 Gateway |

每个岗位通过前必须同时具备：源码/测试证据、对应 Gateway 新 PID 与连接日志、Profile 私有
账本及单一可信锚点、真实飞书 provider 回执。2026-08-12 解锁后已在桌面客户端逐会话核对
A君、小D、小R、小办、运维官终态卡：每个受控任务只有一张卡，终态均无动作按钮；本次为
只读视觉验收，没有发送新消息或点击动作。分岗位卡片专项据此关闭；手机端长内容排版、任务
详情链接等其他体验门禁继续由总交接单单独跟踪。

20:20 手机反馈修正：旧运行中卡片把刷新动作命名成“查看最新状态”，点击后只显示处理状态
提示，容易被理解为“查看任务详情”。现已把“查看任务详情”和“刷新任务状态”拆成两个动作；
详情在原卡内展开/收起，终态直接显示只读详情，不再依赖手机不可达的 `127.0.0.1` 链接。
同时修复“请直接回复、不要创建任务/调用工具”被否定词误命中任务创建的问题。A君活动运行时
已切至 release `dea90c9c…`（PID `23703`、HTTP 200），五个 Gateway 于 20:19 重新连接；
安装态渲染已核对两个独立按钮，本机真实 Commander 请求返回 `handled=false` 且任务总数
`828 → 828`。新卡在飞书手机端的点击外观仍由负责人下一次真实持续任务确认，不提前记 PASS。

## 灰度、回滚与关闭条件

1. 先回归 A君，再依次启用小D、小R、小办、运维官；不并行切五个 Profile。
2. 每次启用前确认 A君概览没有处理中或待审批任务，安装共享补丁后只重载目标 Gateway。
3. 目标 Profile 失败时关闭其卡片开关并重载该 Gateway；保留文字降级、原账本和其他
   Profile，不删除锚点、不盲目重发。
4. 五个岗位的外部/人工状态均为 PASS，且其他岗位仍为 `disabled` 后，本验收才能关闭。

不得在记录中写入飞书 App Secret、token、Cookie、授权链接、真实用户标识或原始聊天内容。
