# 11 岗位能力 E2E 覆盖矩阵

检查时间：2026-08-10 20:38 CST（Asia/Shanghai）

> 2026-08-11 后续更正：本文下表是 2026-08-10 时点快照，不得继续当作当前 freshness 真相。固定第二批已登记 `revision_required`；审核官后续已有新鲜合格成功；小R最新受控任务 `b614bb54…` 虽为技术 `succeeded`，但报告自述核心正文与三条建议未交付，业务验收为 FAIL CLOSED。当前只以[产品成熟度总交接](../handoffs/current/agent-army-product-maturity-handoff.md)为继续入口。

## 结论

- 11 个正式岗位均已有活动 Manifest、运行配置、live 投影和至少一条成功任务证据；但这不等于 11 个岗位都已获得当前任务账本中的人工采用。
- live 严格口径下，`declared/configured/live/verified` 为 `11/11`，`humanAccepted` 只有运维官 `1/11`。A君不在 `/api/overview.agents` roster 数组中，相关四层结论由活动 Manifest、A君不可变运行时和既有真实总任务共同推导，矩阵用 `*` 标记，不伪装成 roster 原生字段。
- 创建官、技术专家、小创的 `verifiedAt` 早于各自最新失败；A君最新成功业务证据也早于最近一次部分失败。因此当前真正需要新鲜业务复验的是 4 个岗位，不是重新跑全部 11 岗位。
- 历史验收文档中存在真人阅读、真实飞书和岗位边界核对，但多数没有以 `humanAcceptance` 写回当前任务账本。本矩阵将这些证据保留为历史辅助，不把它们自动升级为 live `humanAccepted=true`。
- 唯一推荐的下一条真实验证是：小创复用现有确认稿 `#10E4F814` 和正式分析 `#B5403CD9`，生成一版本地待审 `content.video-script-package`，随后由负责人登记 `accepted` 或 `revision_required`。本轮只完成盘点和场景定义，没有创建任务、调用 Provider、发送消息或启用 Publisher/Campaign/Cron。

## 口径与范围

| 字段 | 严格判定 |
| --- | --- |
| `declared` | `agents/<agentId>/manifest.json` 为 `active`，且登记了岗位职责和任务类型 |
| `configured` | live roster 返回运行配置，或 A君由自身 Manifest、Hermes Profile 映射和不可变运行时共同证明 |
| `live` | live `/api/overview` 返回该岗位，或 A君 `runtime:fingerprint` 返回 4321 可达及真实进程 |
| `verified` | live `capabilityTruth.verified=true` 且有 `verifiedAt/evidenceRef`；A君使用既有真实总任务与验收记录推导 |
| `humanAccepted` | 只接受当前任务/Workflow 账本中可追溯的负责人 `accepted` 写回；历史“看过页面/收过消息/里程碑通过”不自动代替 |
| 新鲜度 | `later_than_latest_failure` 或 `no_failure` 为新鲜；`predates_latest_failure` 表示成功证据早于最新失败，需要业务复验 |

正式岗位固定为 A君、小D、小R、小办、运维官、创建官、审核官、架构师、技术专家、小拆和小创。`wechat-chat-retriever` 是 A君本机私密只读适配能力，不计入这 11 岗位；已退役的 `task-coordinator` 也不计入。

## 覆盖矩阵

| 岗位 | 代表性关键能力 | declared | configured | live | verified | humanAccepted | 当前成功证据 | 新鲜度 / 最新失败 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| A君 `ajun` | 接收目标、跨岗位编排、如实统一交付 | `true` | `true*` | `true*` | `true*` | `false` | `#6C907063`，真实跨岗位总任务 `mission_delivered`；另见 M2 数字员工公司验收 | 成功早于 `#66C3F7F9` 的 `mission_partially_failed`，需新鲜复验；`*` 为非 roster 推导 |
| 小D `xiaod` | 授权素材获取、确认稿与可读整理产物 | `true` | `true` | `true` | `true` | `false` | `#10E4F814`，7 个产物，`xiaod_completed` | `later_than_latest_failure`；最近旧失败 `#DABA9068` |
| 小R `intel-researcher` | 公开资料多路线研究与主张级证据 | `true` | `true` | `true` | `true` | `false` | `#C107107F`，公开研究 v7，2 个产物 | `later_than_latest_failure`；前一版 `#7A6130BE` 为 `waiting_test` |
| 小办 `office-assistant` | 办公汇报与演示文稿本地交付 | `true` | `true` | `true` | `true` | `false` | `#CA1C34A8`，本地演示文稿 3 个产物 | `later_than_latest_failure`；此前 `#6B5B89F5` 为 `waiting_test` |
| 运维官 `operator` | 脱敏健康检查、安全恢复与证据回报 | `true` | `true` | `true` | `true` | `true` | `#167203DF`，真实飞书只读健康 Workflow；负责人已写回 `accepted` | `later_than_latest_failure`；是唯一完成五层闭环的岗位 |
| 创建官 `creator` | 生成有边界、预算和验收任务的岗位草案 | `true` | `true` | `true` | `true` | `false` | `#268CA021`，岗位草案，`paperclip_hermes_completed` | `predates_latest_failure`；最新 `#06919605` 为 `waiting_test` |
| 审核官 `reviewer` | 对高风险范围、权限和有效期形成审核结论 | `true` | `true` | `true` | `true` | `false` | `#032C6F94`，岗位草案审核，1 个产物 | `later_than_latest_failure`；此前 `#7FCFEF8F` 为 `waiting_test` |
| 架构师 `architect` | 基于事实给出架构判断、方案和最小验证 | `true` | `true` | `true` | `true` | `false` | `#2A0436B9`，Paperclip 架构审查完成 | `later_than_latest_failure`；最近旧失败 `#7F0F00D0` |
| 技术专家 `technical-expert` | 隔离范围内诊断、修复、测试与恢复检查 | `true` | `true` | `true` | `true` | `false` | `#8B86DB66`，隔离加法错误修复，3 个产物 | `predates_latest_failure`；最新 `#B7922C34` 为 `paperclip_repair_failed` |
| 小拆 `video-content-analyst` | 基于确认稿和证据生成正式视频分析 | `true` | `true` | `true` | `true` | `false` | `#B5403CD9`，真实飞书、1 次 DeepSeek、2 个产物，结构修复后成功 | `later_than_latest_failure`；产物尚待负责人内容采用 |
| 小创 `content-creator` | 基于确认稿和正式分析生成待审脚本/平台草稿 | `true` | `true` | `true` | `true` | `false` | `#A5415600`，真实待审草稿，`externalSideEffects=0` | `predates_latest_failure`；最新 `#FF18A362` 因缺确认稿/正式分析而如实失败 |

## 证据解释

- A君 4321 在检查时为 PID `74734`，运行于 immutable release `b04472f1…`；`runtime:fingerprint` 显示 `sourceRelationship=same_git_head`、HTTP 200。Publisher 4390 无监听，整体 `degraded` 只反映该安全关闭边界。
- live `/api/overview` 有 802 条任务，运行中 0、后台 0、待审批 0；唯一负责人动作仍是 `#B5403CD9` 的可选内容验收。该统计证明当前没有被本次盘点打断的任务，不证明外部平台或所有岗位业务能力都可用。
- `/api/overview.agents[].capabilityTruth` 为除 A君外的 10 个正式岗位提供 `verifiedAt/evidenceRef/freshness/latestFailureTaskId`。A君是承载该 API 的运行总管，不在同一 roster 数组中，因此单列推导，避免把缺字段写成 roster 原生 `true`。
- M2 数字员工公司验收记录了 A君、小R、小办及治理岗位的真实飞书/任务过程，M3 记录了小D、小拆、小创的真实产物和人工检查。但当前任务账本只有运维官 `#167203DF` 存在明确 `humanAcceptance.status=accepted`，所以严格列仍为 `1/11`。

## 唯一下一条真实验证

场景：**小创基于现有正式证据生成一版 45 秒竖屏本地待审脚本包，并由负责人给出采用结论。**

选择理由：小创属于真实内容生产主链，当前 `verified` 证据早于最新失败；最新失败 `#FF18A362` 的唯一缺口正是缺少 `confirmed_transcript` 或正式 `video_content_analysis_report`，而这两个前置现在分别由 `#10E4F814` 和 `#B5403CD9` 提供。该场景能验证“失败条件消失后是否真实恢复”，同时不需要登录账号、抓取新素材、外发或发布。

### 固定输入

- 任务类型：`content.video-script-package`。
- 一句话主题：基于现有宿命论访谈确认稿，生成一版 45 秒竖屏解释型短视频主脚本。
- 来源任务：`#10E4F814` 的 `confirmed_transcript`，以及 `#B5403CD9` 的正式 `video_content_analysis_report`。
- `approvedForUse=false`；只生成本机待审产物，不生成图片、配音、成片，不连接平台账号。
- 不补抓公开网页；如现有证据不足，改写为证据可支持的表达或进入 `needs_input`，不得编造。

### 验收标准

1. 任务终态只能是 `succeeded`、`needs_input`、`waiting_test` 或明确失败，不能把部分产物冒充成功。
2. 成功时只有一个 `video_script_package`，内部包含 script、shots、subtitles、sources、manifest 五个受控文件，均存在、可读、非空且有校验值。
3. 产物明确引用 `#10E4F814` 和 `#B5403CD9`，不新增确认稿之外的事实；`publishingStatus=draft_only`、`externalSideEffects=0`。
4. 不产生 `PublishReceipt`，不启动 Publisher/Campaign/Cron，不发送飞书测试消息，不写入外部平台。
5. 负责人阅读标题、前三秒、完整口播、证据边界和可拍性后，在同一任务上登记 `accepted` 或 `revision_required`；只有该写回完成才把小创记为 `humanAccepted=true`。

### 费用、权限与失败处理

- 需负责人另行授权后才创建任务。授权范围只包含一次小创本地脚本任务、最多 1 次已登记模型调用，估算费用硬上限 `0.02 USD`；预检无法确认模型、调用次数或估算上限时不执行。
- 不授权账号登录、公开发布、私信、投流、外部素材抓取、视觉 Provider、图片/音频/成片生成或权限扩展。
- 缺确认稿/正式分析：立即 `needs_input`，不得调用模型。
- 模型或工具故障：按现有 Policy 只做一次受控恢复和一次重试；仍失败则停止，保留错误与已生成证据，不追加调用或扩大预算。
- 产物结构/证据门禁失败：进入 `waiting_test` 或失败，不进入人工采用；负责人只有在机器门禁通过后才做内容判断。

## 本轮未执行

- 未创建或修改任何任务、Workflow、Paperclip Issue 或 Hermes Session。
- 未调用 DeepSeek、StepFun、视觉 Provider 或其他付费模型。
- 未登录、读取或修改外部账号；未发送飞书消息；未启用 Publisher、Campaign 或 Cron。
- 未修改历史任务终态、能力真相或人工验收记录。
