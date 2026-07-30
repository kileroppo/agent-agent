# M5 高权限内容自治 PRD

| 字段 | 内容 |
| --- | --- |
| 状态 | 并行 v2 的 15/17/5 结构已安全克隆到 live；11 个正式 Hermes Profile 已实际同步并 post dry-run `0 drift`，技能白名单 `11/11 clean`；内容插件候选源码 `0.4.9` 已通过本地测试 `97/97` 和 `check`，`0.4.8` 仅为历史候选，但 Paperclip live 仍为 `0.4.7 ready` 且未安装 `0.4.9`。当前 A君 `4321` 仍未重启，Publisher 关闭，真实 M5 Campaign 的 StepFun 视觉调用、Run-JWT/恢复兼容补丁加载、活动和外部发布均未完成，因此 M5 未完成 |
| 负责人 | A君 |
| 创建时间 | 2026-07-30 |
| 上游 | [Agent军团总 PRD](./prd-agent-army-master.md) |

## 1. 目标

移除 M4 遗留的 A君本地三步 DAG/预算/CapabilityGrant 真相，保留开放任务入口并统一委托给 Paperclip/Hermes 的可恢复执行循环；再以“AI Agent 实战”旁白混剪验证内容生产闭环：

`选题 → 研究 → 证据 → 脚本 → 素材/配音 → 渲染 → 审核 → 双平台适配 → 发布 → 核验 → 指标 → 复盘`

首轮活动默认 7 天、每天 1 个主题、抖音和小红书各 1 个适配版本。活动授权是外部写入的唯一放行依据；代码上线不等于账号已授权，也不等于真实发布已经发生。

## 2. 用户结果

- A君能创建、批准、暂停、恢复和停止一条内容活动；
- 每个执行步骤由 Paperclip Issue/Case/Run 保存负责人、能力、预算、输入产物、Observation、重试和恢复信息；
- 恢复必须由执行器真实消费 `m5Recovery`：只有业务输入哈希、实际工具集合或执行策略发生变化时才允许记录 `routeChanged=true`；岗位文字声明不能替代执行回执，同一路线重复失败按既有重试/重规划上限推进至 `blocked`；
- 小R、小D、小拆、小创、审核官、运维官和小办使用 Paperclip agent tool grants 与隔离 Hermes Profile，不另建 SkillBundle 注册表；
- 小R 的研究与证据产物采用逐 claim 证据绑定：每条事实 claim 必须保存真正支持它的 `sourceIds` 和逐来源 `evidenceFragments`；M5 来源必须具备公开 URL、抓取时间和正文内容哈希，GitHub 搜索元数据只能用于发现线索，不能直接算事实证据；
- Publisher Gateway 只执行通过活动授权和机器审核的确定性动作；
- 每次发布保存幂等键、平台内容引用、核验证据和指标快照；
- 真实指标只能生成待审核的改进提案，不能直接改生产 Prompt、提频或投流。

## 3. 范围

### 本里程碑实施

- Paperclip Pipeline/Case 表达内容阶段与审核门禁，Routine/Issue 表达 7 天日程和岗位执行；
- 使用 Paperclip 原生持久运行、预算、审批、审计、并发、重试与恢复；
- Hermes Profile 原生技能审计、MCP/工具开关、Cron、Session 和 checkpoint；
- Paperclip 内容自治插件只增加领域类型、StepFun/媒体工具和发布连接器；
- 确定性 Publisher Gateway、模拟连接器与真实连接器插槽；
- 内容血缘、审核、发布凭证、指标和学习提案契约；
- 本机控制台的活动状态、唯一下一步和停止入口；
- 11 个正式自主 Profile 改用 `stepfun/step-3.5-flash-2603`；DeepSeek 仅在 `transport_unavailable` 时回退。微信私密只读检索岗位属于 A君本地适配能力，不纳入这 11 岗。
- 内容插件固定视觉模型 `step-1o-turbo-vision`、生图/改图模型 `step-image-edit-2` 和 TTS 模型 `stepaudio-2.5-tts`；模型身份必须进入 Provider action、费用事件和产物血缘。

### 独立授权后实施或验收

- StepFun 视觉、生图、改图和 TTS 的付费调用；
- 真实平台 Computer Use selector map、账号与写权限验收（CuaDriver 升级、辅助功能、
  屏幕录制和拒绝诊断已完成；完整本地假平台测试页验收仍缺当次五分钟单次 token）；
- 抖音官方发布能力申请；
- 小红书和抖音真实账号写权限；
- 真实 1+1 首发和后续 7 天活动。

## 4. 非目标

- 不开放任意 Shell、Cookie 导出、私信、评论、关注、投流、付款或账号设置；
- 不允许内容模型直接点击发布；
- 不自动删除历史内容；
- 不让模型静默安装或启用技能；
- 不复制 Paperclip 的组织任务、预算、审批和审计控制面；
- 不用 `step-router-v1` 冒充“纯 StepFun”。

## 5. 核心规则

- 活动未批准、授权过期、暂停或停止时，外部写入固定拒绝；
- 发布授权绑定平台、账号引用、主题、时间窗、每日/总次数、动作与预算；
- 预算默认由一次干跑估算乘以 7 再加 25%；超过 5 美元必须在活动审批中明确确认；
- 相同 `campaignId + platform + contentVersion + scheduledDate` 只能产生一个发布动作；
- 验证失败、连续两次发布失败、验证码、风控、账号切换、违规提示或超预算时自动暂停；
- 发布成功必须取得平台内容引用或可验证页面证据；
- 删除永远不包含在默认 CampaignGrant 中。

## 6. 完成标准

| 层级 | 完成条件 |
| --- | --- |
| 契约 | M5 类型、状态、权限和失败恢复进入 Paperclip Pipeline/Plugin 适配与 ADR |
| 自动化 | Paperclip 官方 Plugin SDK 测试宿主、授权、幂等、过期、越权、模拟双平台发布全部通过 |
| 本地运行 | Paperclip 加载经批准的 M5 插件，能通过 Pipeline/Routine 创建、审核、暂停和停止活动 |
| 多模态 | 取得单独付费授权后，各做一次视觉、生图和 TTS 无外发探针 |
| Computer Use | 取得 macOS 权限后，在测试页面验证上传、填表和结果读取 |
| 外部平台 | 指定账号和时间窗单独授权后，抖音/小红书各发布 1 条并回读内容引用 |
| 连续自治 | 前述门禁通过后完成 7 天、14 次发布和 2h/24h/72h 指标回流 |

## 7. 当前实施结论（2026-07-31）

- 本地已实现：
  - 并行 v2 目标源码声明 15 阶段 Pipeline：2 个无唤醒活动控制阶段、11 个业务阶段、独立 `done` 与 `cancelled` 终态；对应 17 个 Routine 和 5 个无模型 HTTP 控制器（daily、parallel、publisher、metrics、retrospective）。研究、证据、画面分析和生图通过 Paperclip 子 Case/blocker 并行，配音等待脚本，四项可信 Work Product 由无模型汇聚控制器核验后才解锁渲染；
  - 内容自治插件 live `0.4.7` 的 14 个工具，包括 StepFun 多模态、FFmpeg/FFprobe、受控 Remotion、固定 9 项产物包、产物血缘和发布前门禁；live 已从 `content-autonomy-bundle-0.4.7-cac8390a…4723c13` 不可变净包安装并处于 `ready`。净包清单含 20,012 项，精确排除 `apps/animated-chart/out/**`、`public/m5-*/**` 与 Remotion 根缓存 `node_modules/.cache/**`，同时保留完整运行依赖；`0.4.6` 不可变包和 Paperclip `2026.722.0` 二进制兼容回滚链保留；
  - 无模型 Publisher Gateway 已覆盖双平台幂等、失败暂停、发布凭证和显式指标采集；抖音官方 API connector 已完成上传/创建/查询/本人指标的依赖注入源码契约，production composition 与 A君延迟授权代码也已接线，但 live 未注入 production access 或真实 connector dependencies，真实 Runtime 仍未启用；2h/24h/72h 调度由 Paperclip 原生 Issue Monitor 承担；
  - 发布控制器从可信 Case、CampaignGrant 和已审核 ContentVersion 派生唯一动作，将 `PublishReceipt` 作为专用 Work Product 写回；指标控制器将 `MetricSnapshot` 写回；复盘控制器写入版本化 Retrospective Work Product；
  - 复盘少于 5 条同类型真实 72h `MetricSnapshot` 时只记录 `insufficient_sample`，达到 5 条才生成状态为 `proposed` 的 `LearningProposal`；提案必须离线回放、审核和单条灰度，不能直接修改生产 Prompt、权限、频率或投流；
  - A君内容活动 API、控制台、CampaignGrant、暂停/恢复/停止与“插件或公司级配置不完整即关闭”的失败关闭边界；
  - Paperclip `2026.722.0` 对象形 `secret_ref` 契约；旧字符串引用、缺失 Secret 元数据/绑定、未配置 Provider、岗位 grant、费率、官方音色或工作区会在活动批准/恢复前被只读门禁拒绝，门禁不解析 Secret 值。
- 自动化证据：目标 Pipeline `67/67`、Fake E2E `5/5`、内容自治插件候选源码
  `0.4.9` 为 `97/97` 且 `check` 通过（`0.4.8` 仅为历史候选）、Paperclip 集成 `48/48`、Publisher Gateway `203/203`、A君全量 `1004/1004`、岗位 Manifest
  `15/15` 已通过；内容插件 live 仍为 `0.4.7` 且未安装 `0.4.9`，新增视觉与原生血缘硬化当前只有源码/本地证据。本轮
  源码根/隔离修理副本/候选发版聚焦回归 `139/139`，`task-store` 与飞书 completion
  watcher 本机持久状态权限回归 `15/15`，不可变 release 专项 `11/11`、与
  runtime-source-root 联合回归 `18/18`。controller
  cutover `15/15`、恢复 provider composition `43/43`、相关 server/controller `84/84`
  和语义门禁自测 `72/72` 也已通过，以
  最新验收账本为准。当前
  `npm run validate` 返回 v2 源码目标 15 阶段。它们只证明本地代码、Fake 平台、
  默认关闭的 CuaDriver runner、注入式抖音官方 API 契约与门禁，不替代真实平台验收。
- 当前控制面与运行事实：
  - live v2 为 M5 Goal、Project `86ad0a0a…`、17 个有效 Routine、15 阶段 Pipeline `6dfd94da…`，以及 daily、parallel、publisher、metrics、retrospective 5 个无模型 HTTP 控制器；没有分支引用且从未触发的旧 `m5-research` Routine 已归档并保留记录。归档后的只读 reconcile/dry-run 为有效 Routine `17/17`、转换 `16/16`、blocker 0，草案仍为 `0/14`、Cron off；旧 v1 Pipeline 和 22 个 Case 原样保留；
  - 13 条 M5 Budget 策略分别覆盖公司、Project 和 11 个正式岗位，每条均是 625 美分的同一分层硬上限，不能相加为总预算；公司与 M5 v2 Project 当前累计均为 392 分，剩余 233 分。Paperclip `cost-events` 是按配置记录的保守项目成本，不等于 StepFun 官方最终账单；
  - 本机 Paperclip 为 `2026.722.0`；内容自治插件 `agent-army.content-autonomy` live `0.4.7` 已从 SHA 命名的不可变净包安装并处于 `ready`，配置校验和、Secret 引用、Campaign 和 Cron 在升级后保持不变；`0.4.6` 不可变包、版本锁定维护脚本和二进制兼容回滚链保留；
  - 公司级插件配置已使用对象形 Secret 引用并绑定 8 个执行岗位；门禁只读取引用元数据，不解析或回显 Secret 值；
  - publisher 与 retrospective 控制器和对应 Routine 已接入 live，但 Publisher Runtime 默认关闭，且没有真实发布凭证、指标或学习样本；
  - live 指标控制器只从同 Case 的可信 PublishReceipt 派生 2h/24h/72h 检查点，并把 MetricSnapshot 写为 Work Product。Publisher 不保存指标计划，也不创建 Cron；
  - A君、小R、小D和小办均已成为可调用的 Paperclip `hermes_local` 岗位；每个岗位只获得自身身份和声明的 M5 任务工具；高风险内容阶段使用无参数 `m5_stage_execute`，调用方不能选择工具、Case、路径或发布参数；
  - 11 个正式 Hermes Profile 的岗位技能白名单已在 live 对账为无额外、无缺失；`xiaod` 原有 78 个额外技能已禁用并保留可恢复路径；
  - 11 个正式 Hermes Profile 已实际同步到 `stepfun/step-3.5-flash-2603`、岗位 MCP 与精确 Feishu toolset；同步后全军只读 dry-run 为 `0 drift`，11 份逐 Profile 备份目录权限为 `0700`，`gatewayActions=0`。随后 11 岗技能白名单指定复验均为 clean；这些只证明 Profile 配置层，没有重启当前 A君 4321；
  - v2 已创建 1 个正式但未批准的活动草案 `8dd29a3b…`，`approvedAt=null`、进度 `0/14`；旧 v1 草案已 superseded/cancelled；没有启动活动或执行阶段；
  - “A君定时本机巡检”修复后连续 3 次受控手动 Routine Run 为 `completed`，随后至少 1 次自然定时运行也为 `completed`；更早失败仍保留为历史；
  - 已将 153 条带确定标记的历史巡检失败和 9 条历史验收记录归档为取消/隐藏；不删除记录。当前 blocked/pending 快照为 83 条（16 条 `active_incident`、67 条 `unresolved`），真实故障与未决任务仍保留负责人和恢复动作；
  - 11 个正式 Profile 已以 `step-3.5-flash-2603` 完成当前无副作用文本实调用 `11/11`，均返回 `M5_OK`，DeepSeek 调用为 0，证据为 `docs/reviews/m5-high-autonomy-content-operations/artifacts/2026-07-31-stepfun-text-probes.json`；这是当前 Provider 文本传输 PASS。最新 `video-content-analyst` 真实回归为 `18/18`，11 个岗位语义结果全部通过；新的 Cross 首次因未转义 JSON 失败关闭，缩短并固定输出契约后安全重试为 `19/19`。最终离线汇总为 `summary.status=passed`、`rolePassedCount=11`、`crossRoleStatus=passed`，随后的离线重验也通过；此次新增 1 次 video 和 2 次 Cross StepFun 调用，工具调用 0、`externalSideEffects=0`，语义门禁自测为 `72/72`。usage 记录 `cost_status=unknown`，不能把 `estimatedCostUsd=0` 当成已知零费用。证据目录为 `docs/reviews/m5-high-autonomy-content-operations/artifacts/2026-07-31-stepfun-3.5-role-quality/`。该结论证明当前本地题面下的岗位语义与跨岗位整合，不证明 Hermes/Paperclip live、平台发布或真实业务外部闭环；
  - 开放复杂任务的本地执行链已覆盖公开网页、动态网页、PDF、GitHub、来源核验、Observation 驱动换路、安全重试、预算硬停、Paperclip 重规划和 Work Product 幂等回写；恢复来源必须同时匹配当前 assignment 的 Issue/Run，拒绝任务自报和跨 Issue/Run 内嵌 Observation 注入。开放研究及其路由/Routine 契约当前定向自动化为 `29/29`。这只证明本地代码链，当前 A君 `4321` 进程早于本轮源码，尚未加载；
  - 通用 Hermes one-shot 已移除 `--ignore-rules`，普通调用固定为 `clarify`，只有无 Provider 的受控故事板分支允许 `vision`；正式画面分析只能由当前 Paperclip Run 的单用途回调调用，绑定固定 action、相对 PNG、帧哈希、时间点、confirmed receipt 和同一 Project。新产物与已有视觉 Work Product 重放使用同一校验，漂移时阻塞且不覆盖；渲染必须实际消费可信 `GeneratedImagePackage`，机器审核必须反查同 Project 的图片、视觉、TTS 三条 confirmed action/cost。`0.4.9` 已冻结为候选包：`payloadHash=b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d`、`entryCount=19986`、`manifestSha256=dabf16ac255eec3348e5800239f907793db1c1e507d1aa2820cd57fb71ec8dd7`、独立全目录哈希 `82f75845b927c8fa817e45e8e4d588338c7131677f2681c7297dba987db0c8bd`，路径为 `work/m5-content-autonomy/plugin-packages/content-autonomy-bundle-0.4.9-b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d/`。为搬移候选包，仅 bundle 根目录由 `0555` 短暂调整为 `0755`，内部未改；完成后根恢复 `0555`、manifest 保持 `0444`，独立复算与安全审计放行。但 live `0.4.7` 和旧 A君进程均未加载，也没有真实 M5 Campaign StepFun 视觉调用；
  - A君的技术修复链已把运行 release 与可写源码根分离：源码根必须是显式指定、clean、可验证身份的外置 Git 根，隔离 Worktree 绑定 task、Git common-dir、HEAD 和精确修复范围；越界路径、错误归属、源码漂移及部分 promotion 失败均失败关闭或回滚。外置源码修复成功也只返回 `candidate_promoted`、进入 `repair_candidate_awaiting_release`，必须再生成并验证新的不可变 release，不能把候选源码误报成当前运行版本已修复。聚焦回归为 `139/139`；
  - `task-store` 与飞书 completion watcher 的本机持久状态权限回归为 `15/15`：每次写入使用唯一临时文件、`wx`/0600、原子 rename 和 rename 后 chmod，既有 0644 文件收敛到 0600；失败时保留旧文件且不误删无关临时文件。本轮只在临时 fixture 验证，没有直接 chmod 真实数据；
  - 不可变 A君 runtime release 专项为 `11/11`，与 runtime-source-root 联合回归为 `18/18`。本轮 clean source commit `33aa25bd7ff7431d64467fca87866d299caa9857` 已冻结为 `work/m5-runtime-releases/m5-8point-20260731-r2/ajun-runtime-release-v1-1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef/`：`releaseHash=1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef`、`payloadHash=7bd23d48db1f66583d854a28d420498e60e884e261a10171c4767e818156c910`、`entryCount=7571`、`manifestSha256=102daa78172a8857e7151d1a619d6868fb30f97cad1b48e8751ca93b5feb128c`、独立全目录哈希 `efc8967c6662b645f3018c0b6386231006f21b45f561a932e88df03799eb4b88`。冻结包隔离启动后 `/api/overview` 为 200，SIGTERM 正常退出；staging 与 final 先分别 official validate，随后仅将自产 staging 移至 `~/.Trash/agent-army-staging-1c7f244ddaae055f-20260731`，final 再次 validate 通过。未修改 live、plist，未重启现有 A君，未外发；
  - `5c4b463…` / `025d4816…` 旧 clean 包保留为历史失效候选，`0767604f…` dirty 候选继续隔离。新侧已具备 clean provenance 和 startup 证据，但旧运行版仍无法从现状精确重建为独立 rollback release/源码根；因此 cutover/rollback 继续 blocked，不能把历史 `025d4816…`、仓库 HEAD 或 dirty 候选冒充旧版精确回滚包；
  - M5 本地 Fake E2E 为 `5/5`：完整纵切覆盖活动草案、选题、五分支并行、脚本、渲染、一次 `request_changes`、审核、Fake 发布、2h/24h/72h 模拟指标、复盘与 done；另 4 条直接验证真实无模型并行协调器的 `[4,1]` 波次、前置依赖、全局并发上限 4 和健康 Work Product 汇聚门禁。账本明确 `externalEffects=false`、`paidCalls=0`，不等于 live 或平台验收；
  - 3 个主题已使用 4 张仓库自有设计截图生成母版、抖音版和小红书版共 9 支本地视觉 fixture 成片，dry-run 验收为 `12/12`；截图通过 `coverSrc`、逐场景 `imageSrc` 和 `assetLedger + sha256` 进入时间线。视频均为 45 秒、1080×1920、H.264/AAC，无检测到的黑帧，综合响度 -14.9 至 -15.1 LUFS；每主题固定 9 项产物和 manifest 回读通过。该证据不等于生产选题素材；旁白使用 macOS 系统音色，`productionTtsVerified=false`，不作为 StepFun TTS；
  - A君控制台已在桌面、中间宽度和 390px 真实浏览器中验证，活动草案、下一步、恢复位置和授权按钮完整可见，无相关控制台错误；
  - 旧 StepFun `m5v2` Provider 账本 `work/m5-content-autonomy/provider/7-theme/m5v2/ledger.json` 为 `succeeded`：35 个 action-linked 费用记录合计 42 美分，`confirmedReplay=35`、`lifetimeProviderCalls=43`；本轮 Provider 请求/调用均为 0，没有新增付费或 `cost-event`。费用记录是本项目保守账本，不等于 StepFun 官方最终账单；
  - 内容插件上游现已原生生成 lineage，新内容不再依赖事后迁移；`native-artifact-smoke` 以 Provider 0 完成 1/1 份 lineage 和 3/3 支平台媒体复核，均为 45 秒、1080×1920、H.264/AAC、黑帧 0、-15.1 LUFS。历史旧 Provider 成片迁移仍保留在 `work/m5-content-autonomy/stepfun-seven-theme-render/m5v2-lineage-v2/`：0 Provider 调用完成 7/7 份 lineage 和 21/21 支媒体复核，响度 -15.2 至 -14.9 LUFS；原 `m5v2` 账本仍保留 7/7 机器审核和 63/63 固定产物 hash/bytes 证据。所有账本记录 `externalPublished=false`，没有外发或新增 Provider 调用；
  - 抖音官方 API connector、production composition 与 A君延迟授权源码已接入生产构造链，但 live 未注入 production access 或真实 connector dependencies，未启用任何真实 Publisher Connector，也未操作抖音或小红书发布页面；
  - CuaDriver 已升级到 `0.14.1`，辅助功能和屏幕录制均为 `true`，`doctor` 正常。runner 已修复将真实 `browser_consent_required` 误报成 `prepared_browser_pid_missing` 的诊断错误；现在保留 CuaDriver 的结构化授权失败。完整本地假页 Computer Use 验收仍缺当次生成、五分钟有效、单次使用的 browser approval token；Token 不得打印、落盘或复用。真实 selector、账号登录和平台验收仍未完成；
  - 真实 CUA 只有同时满足以下门禁才允许构造：selector bundle 经 Paperclip 批准后冻结且版本、规范哈希、文件哈希和有效期全部匹配；未过期的 `isolated_named` Profile lease 精确绑定平台、CampaignGrant `accountRef`、Profile 名和页面身份哈希；账号具备本次活动写授权；发布结果返回真实内容页、平台内容 ID、selector 版本/哈希和账号核验证据。任一缺失、错配、验证码、身份验证、账号切换、风控、违规或未知页面都在生成可信 PublishReceipt 前停止；
  - 7 天真实本地 MP4→Fake 证据位于 `work/m5-publisher-gateway/acceptance/fake-seven-day-2026-07-31-v1/`：7 个上海日历日、每天双平台，共 14 个 fake PublishReceipt 和 42 个 2h/24h/72h 模拟 MetricSnapshot；44 次 Runtime 重建后仍幂等重放同一 72h 快照。证据明确 `realPlatformTouched=false`、`externalPublished=false`、`realPlatformCalls=0`、`totalCostUsd=0`、`actualPlatformElapsedTime=false`，只证明本地发布账本、恢复和模拟指标回流，不是平台外发或真实 72h 等待；
  - 小红书本人指标已接入 Gateway production composition/Runtime/MetricSnapshot 链：发布与指标使用独立 Paperclip approval、runner 和命名 Profile，指标 runner 固定五步只读，并绑定可信 PublishReceipt、`accountRef`、内容 ID、selector 版本/哈希和页面身份；硬停会暂停 Campaign/Cron，批准到期与预算不足会在 connector 前拒绝。跨进程指标调用进入 `invoking` 后不可按租约换主；超过 10 分钟只会转为 `human_review`，禁止自动重试。Gateway 恢复要求有效持久 claimToken、全账本唯一 authorizationId，并在任何暂停或账本 mutation 前重新核验授权；确认存在外部效果时先暂停 Campaign/Cron，确认无外部效果时也不会自动再次调用。A君对完全一致的授权重放只读返回旧结果，绝不再次进入可写恢复。Paperclip `2026.722.0` 原始安装仍没有原生过期、撤销和原子 consume 的一次性恢复 Approval 契约；仓库现已提供版本锁定的 Run-JWT 转发与恢复 Approval 兼容补丁（合并定向测试 `15/15`），controller cutover 工具 `15/15`。快照读写 TOCTOU 已修复，包含 post-link 父目录替换后原目录/替代目录零残留、0 Paperclip PATCH，以及清理不完整时 `recoveryRequired`；清理器 ready/cleanup/close 均有硬超时，卡死时按 TERM、KILL、确认退出收口。只从 current-run provider 取身份和凭据的 A君恢复 access 已实际 wire 进 server composition/metrics 请求级作用域，provider composition `43/43`、相关 server/controller `84/84`。两份兼容补丁仍未 apply，live 控制器 adapterConfig 未启用 `forwardRunJwt`，当前 4321 也未加载新 binding，所以 live 恢复仍不可调用。抖音风控与费用上报双故障同样不会覆盖 hard-stop。当前没有真实浏览器、真实账号或平台指标，不能宣称真实回读；
  - Publisher 提供只读 `npm run production:readiness`；当前 4390 为 disabled，Campaign snapshot、selector、Profile lease 和 production provider 均未提供，因此结果为 `not_ready`、退出码 `2`、唯一下一步为 `provide-campaign-status-snapshot`。该命令不读取 `.env`/Secret，不启动服务、不批准 Campaign/Cron；
  - 当前 `127.0.0.1:4321` 仍能返回 `/api/overview` 200 并带有既有 v2 ID/key，但进程启动时间早于本轮开放任务、JWT、恢复 provider 和 Profile 修订，且本轮没有重启，不能作为本轮源码已加载证据；Paperclip live 仍为 15/17/5，内容插件 live `0.4.7` `ready`，每日 Cron 关闭。11 个实际 Hermes Profile 已收敛，但 Publisher 仍关闭；Profile 收敛后仅完成 1 次 `video-content-analyst` 真实 StepFun no-tool 探针，工具调用为 0。该探针只证明文本传输和模型身份，其 usage 中 `estimated_cost_usd=0` 不是官方账单，也不承担内容 Provider 血缘。正式视觉与三类 Provider 血缘门禁已在候选源码和本地 Fake 测试闭合，但尚无真实 M5 Campaign StepFun 视觉调用。21/21 支本地视频及机器审核已经完成，publisher/retrospective 真实 Case 和平台外写均未发生。

因此当前结论是“M5 执行、发布凭证写回、受控学习与并行 v2 已通过本地自动化并
安全克隆到 live 15/17/5 结构，七主题 21 支生产素材本地成片与机器审核已通过；Computer Use 只完成权限和拒绝诊断，完整本地假平台页仍待验收”。活动仍是未批准
草案；真实 selector map 与 Publisher Connector、真实 PublishReceipt/指标、平台写授权和双平台发布仍是不同的
未完成验收层，不能合并宣称完成。
