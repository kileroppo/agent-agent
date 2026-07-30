# M5 高权限内容自治交接

| 字段 | 内容 |
| --- | --- |
| 状态 | live v2 为15阶段/17有效Routine/16转换/5控制器；从未触发的旧 `m5-research` 已归档，归档后只读对账 17/17、0 blocker、草案0/14、Cron off。11 个正式 Hermes Profile 已实际同步，post dry-run `0 drift`，11 份备份目录为 `0700`，`gatewayActions=0`；11 岗技能白名单复验 clean。正式视觉与三类 Provider 血缘门禁已在候选源码和本地 Fake 测试闭合，但 live 插件仍为 `0.4.7`，A君 `4321` 仍是未重启的旧进程，Publisher 关闭，真实 M5 Campaign StepFun 视觉和外部闭环未执行，因此 M5 未完成 |
| 创建时间 | 2026-07-30 Asia/Shanghai |
| 交出者 | Codex |
| 接手者 | Codex / A君 |
| 关联任务 | [M5 PRD](../../../tasks/prd-m5-high-autonomy-content-operations.md) |
| 截止条件 | 11 个实际 Hermes Profile 与技能白名单已经收敛；当前源码的新 runtime release `1c7f244d…` 已完成 clean provenance、冻结、全目录哈希和启动验证。历史 `025d4816…` 已失效；仍须提供独立 clean 且与旧运行版精确匹配的 rollback release/源码根。在此之前不得重启当前 4321、apply Paperclip 兼容补丁/controller cutover 或开启 Publisher；后续仍需 fresh 4321、真实 M5 Campaign StepFun 视觉、外部发布门禁和完整 7 天活动 |

## 1. 接手目标

- 目标：把内容增长链升级为可恢复、可审计、可受控发布的真实执行循环。
- 用户约束与不可做事项：抖音+小红书；旁白混剪；活动级预授权；不使用逆向接口、Cookie 导出、私信、评论、投流或自动删除。
- 做完的定义：本地代码、自动化、fresh 运行时、多模态、Computer Use、双平台首发和 7 天指标回流分层有证据。
- 唯一下一步：保持活动、Cron、真实 Publisher 和当前 4321 不动；新侧 `1c7f244d…`
  已生成并通过启动验证，现在只先提供独立 clean、与旧运行版精确匹配的 rollback release/源码根。当前
  运行版无法从现状精确重建，仓库 HEAD 只能作为降级候选，不能冒充旧版精确回滚包。
  11 个实际 Hermes Profile 已收敛，不需要再次同步。文本 no-tool 探针只证明传输和模型身份，
  不承担内容 Provider 血缘；正式视觉门禁已经本地通过，但真实 Campaign StepFun 视觉仍未运行。
  只有新旧 release 前置同时闭合后，才经单独授权 apply 并核验版本锁定的 Run-JWT/恢复 Approval 兼容补丁和
  controller cutover，再启动 fresh 4321 验证源码已接线的 current-run 恢复 binding。
  上述本机执行缝闭合后，才采集真实 selector bundle、签发 Profile lease 并进入账号写权限门禁。
- 允许继续的前提：自动化和 15/17/5 live 结构已通过；新增本轮能力目前只有本地证据，
  尚不能作为 live 执行能力。CuaDriver 辅助功能、屏幕录制和拒绝诊断已完成，完整本地假页
  验收仍等待当次五分钟单次 approval token；插件 live `0.4.7`、`0.4.6` 回滚兼容链、Secret 引用、8 岗绑定及
  StepFun 多模态生产账本和 21 支全量渲染/机器审核也已通过。还必须完成真实
  selector bundle/Profile lease/登录态和平台写权限等独立门禁，才能批准活动。

## 2. 当前事实

工作区快照（2026-07-31 05:07 CST）：

- 仓库：当前 `agent-agent` 工作区
- 分支：`experiment/governance-hermes-full-migration`
- HEAD：`1ddc889cde72d3f9c1a9584b81d527b89962d433`
- 脏基线：快照时 `285` 项状态记录；均视为共享工作树中的既有工作，不得重置或覆盖。

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | v2 为15阶段、17 Routine、daily/parallel/publisher/metrics/retrospective 5 个无模型控制器；发布、指标和复盘使用专用 Work Product 写回 | Git 状态、M5 PRD、ADR、M5 验收 | live 只验证结构；新增开放任务/JWT/恢复/chaos 执行缝仍是本地证据 |
| v2 clone cutover | Pipeline `6dfd94da…`、Project `86ad0a0a…`、草案 `8dd29a3b…` 已 live；当前 A君返回既有 v2 ID/key，旧 v1/22 Case 保留并封存旧草案 | live 回读、A君 4321 `/api/content-campaigns` | 当前 4321 早于本轮源码，不是 fresh 证据；新草案未批准 0/14，Cron off |
| 现成控制面 | Paperclip `2026.722.0` 已含 Plugin、Pipeline、Routine、预算、审批、审计和恢复；Hermes 0.19 已含 Profile、skills audit、MCP、Cron、checkpoint | 本机健康接口、CLI 与官方源码 | 已验证 |
| 自动化 | Pipeline `67/67`、Fake E2E `5/5`、插件候选源码 `0.4.9` 为 `97/97` 且 `check` 通过（`0.4.8` 仅为历史候选）、Paperclip 集成 `48/48`、Publisher `203/203`、A君候选源码 `1004/1004`、岗位 `15/15`；源码根/修理副本/候选发版既有聚焦回归 `139/139`，持久状态权限 `15/15`，不可变 release 专项 `11/11`、与 runtime-source-root 联合 `18/18`，controller cutover `15/15`、恢复 provider composition `43/43`、相关 server/controller `84/84`、语义门禁自测 `72/72` | [M5 验收](../../reviews/m5-high-autonomy-content-operations/acceptance.md) | 本地通过；live 插件仍为 `0.4.7` 且未安装 `0.4.9`，当前 A君仍旧，不证明外部发布 |
| 技术修复源码根 | 运行 release 与可写源码根分离；外置源码根须显式、clean、Git 身份可验证，修理副本绑定 task/common-dir/HEAD/精确范围；越界、错误归属、漂移和部分 promotion 失败均拒绝或回滚。成功只返回 `candidate_promoted` 并进入 `repair_candidate_awaiting_release` | 聚焦回归 `139/139`、M5 验收 | candidate 仍 awaiting release，不能冒充当前 live 已修复 |
| 本机持久状态权限 | `task-store` 与飞书 completion watcher 使用唯一 tmp、`wx`/0600、原子 rename 和 rename 后 chmod；既有 0644 收敛、失败不破坏旧文件或无关 tmp | 聚焦回归 `15/15` | 只在临时 fixture 验证；未直接 chmod 真实数据 |
| A君不可变 release | clean source commit `33aa25bd7ff7431d64467fca87866d299caa9857` 已冻结为 `work/m5-runtime-releases/m5-8point-20260731-r2/ajun-runtime-release-v1-1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef/`；`releaseHash=1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef`、`payloadHash=7bd23d48db1f66583d854a28d420498e60e884e261a10171c4767e818156c910`、`entryCount=7571`、`manifestSha256=102daa78172a8857e7151d1a619d6868fb30f97cad1b48e8751ca93b5feb128c`、独立全目录哈希 `efc8967c6662b645f3018c0b6386231006f21b45f561a932e88df03799eb4b88`；隔离启动 200、SIGTERM 确认退出；staging/final 先分别 validate，仅将自产 staging 移至 `~/.Trash/agent-army-staging-1c7f244ddaae055f-20260731` 后 final 再次 validate 通过 | manifest、生成方冻结账本、独立安全最终账本 | STARTUP-VERIFIED CANDIDATE / NOT LIVE；`025d4816…` 为历史失效候选，旧运行版精确 rollback release/源码根仍缺失；无 plist/live/restart/外发 |
| Paperclip 待办清理 | 153 条历史巡检失败和 9 条历史验收已归档为取消/隐藏且未删除；当前 83 条：active_incident 16、unresolved 67 | `integrations/paperclip/scripts/classify-blocked-pending-issues.mjs`、M5 验收 | 真实故障与未决任务仍保留负责人和恢复动作 |
| Paperclip / 插件 | live v2 为 17 Routine、15 阶段、5 个无模型 HTTP 控制器；插件 `agent-army.content-autonomy` live `0.4.7` 已从不可变净包安装并 `ready`。`0.4.9` 候选包 `payloadHash=b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d`、`entryCount=19986`、`manifestSha256=dabf16ac255eec3348e5800239f907793db1c1e507d1aa2820cd57fb71ec8dd7`、独立全目录哈希 `82f75845b927c8fa817e45e8e4d588338c7131677f2681c7297dba987db0c8bd`；搬移时仅 bundle 根由 `0555` 短暂调为 `0755`，内部未改，完成后根恢复 `0555`、manifest 保持 `0444`，独立复算与安全审计放行。源码 `97/97`、`check` 和 Paperclip 集成 `48/48` 通过；`0.4.8` 仅为历史候选，`0.4.6` 回滚兼容链保留 | live 资源核验、候选源码测试、不可变包、生成方与独立安全账本 | `0.4.9` 尚未安装到 live；配置校验和、对象形 Secret 引用和 8 岗绑定有效；新草案仍未批准，`approvedAt=null`、`0/14`、Cron 关闭 |
| 预算 | 13 条 M5 Budget 策略分别覆盖公司、Project 和 11 个正式岗位；每条均为 625 分的同一分层硬上限；公司与 M5 v2 Project 累计均为 392 分，剩余 233 分；小创累计 62 分、小拆累计 30 分 | Paperclip live Budget 与 m5v2 费用事件 | 分层上限不能相加；保守 `cost-events` 不等于 StepFun 官方最终账单 |
| Hermes Profile 与技能白名单 | 11 个正式 Profile 已实际同步到 `stepfun/step-3.5-flash-2603`、岗位 MCP 和精确 Feishu toolset；post dry-run `0 drift`，11 个备份目录 `0700`，`gatewayActions=0`。11 岗技能白名单指定复验均 clean；`xiaod` 原有 78 个额外技能保持 disabled，办公助理遗留 `feishu-doc` 已收敛 | Profile sync apply/post dry-run、技能白名单 dry-run | Profile 配置层通过且没有启停 Gateway；A君 4321 仍旧，微信取件员不属于 11 岗 |
| 本地运行时 | Paperclip `3100/api/health` 为 200；A君 `4321/api/overview` 为 200；Publisher `4390/health` 为 200 但状态是 `disabled`、`realConnectorsConfigured=false`，且 standalone 服务禁止 real | listener/cwd 与只读 HTTP 检查 | A君 PID `15246` 早于本轮源码，不是 fresh 运行时；A君无 `/api/health` 路由；没有触发 publisher/retrospective heartbeat |
| 运维巡检 | 修复后连续 3 次受控手动 Routine Run 与至少 1 次自然定时 Run 为 `completed` | Paperclip Routine Run 只读记录 | 更早失败仍作为历史保留 |
| 指标回流 | `m5-metrics-controller` 使用 Paperclip Issue `executionPolicy.monitor` 安排 2h/24h/72h；小红书本人指标使用独立 `read_own_metrics` approval、五步只读 runner、selector 和 Profile lease 接入 production composition/MetricSnapshot，且与发布 runner/Profile 隔离；Gateway 使用 claimToken、authorizationId 唯一、最终 mutation 前二次核验和 hard-stop 重启补停。仓库已实现版本锁定的 Run-JWT/一次性恢复 Approval 兼容补丁（`15/15`）；controller cutover `15/15` 且读写 TOCTOU 已修复，包含 post-link 父目录替换后原目录/替代目录零残留、0 PATCH，清理不完整标记 `recoveryRequired`。清理器 ready/cleanup/close 均有硬超时，卡死时 TERM、KILL 并确认退出。A君 current-run 恢复 access 已 wire 进 server composition/metrics 请求级作用域，provider composition `43/43`、相关 server/controller `84/84` | 代码、本地测试、live Agent/Routine 结构 | Paperclip 原始安装仍缺原生契约；兼容补丁未 apply、当前 4321 未加载恢复 binding，live 不可调用恢复；无真实 PublishReceipt、账号指标、人工核对或 72 小时运行 |
| 生产 readiness | 只读 CLI/API 已就绪；当前结果 `not_ready`、退出码 `2`、唯一下一步 `provide-campaign-status-snapshot` | `npm run production:readiness` | 4390 仍 disabled，缺 Campaign snapshot、selector、Profile lease 与 provider；预检不启用生产 |
| 发布与复盘写回 | publisher 与 retrospective 控制器和 Routine 已接入 live；production Runtime/composition 与 A君惰性 provider 已接线，账号、日期、预算、幂等和强证据为硬门 | 代码、Pipeline `67/67`、live Agent/Routine 绑定 | live 未注入 production provider；没有真实连接器、发布凭证、学习样本或模板升级 |
| StepFun | 文本实调用 `11/11`、岗位语义 `11/11`、新 Cross `19/19` passed；Profile 收敛后另完成 1 次 `video-content-analyst` 真实 no-tool 探针，工具调用 0。旧多模态 Provider 账本含35个action-linked费用记录、合计42美分、`lifetimeProviderCalls=43` | StepFun账本与语义证据 | 新调用 usage 的 `cost_status=unknown`；`estimated_cost_usd=0` 只是 usage 字段，不是官方账单。no-tool 探针只证明文本传输和模型身份，不承担内容 Provider 血缘；尚无真实 M5 Campaign StepFun 视觉，不证明 A君 live 或平台发布 |
| 本地成片与血缘 | 上游已原生生成 lineage；native smoke为Provider0、1/1 lineage、3/3媒体，45秒、1080×1920、H.264/AAC、0黑帧、-15.1LUFS。历史lineage-v2仍为7/7 lineage、21/21媒体；另3主题9视频dry-run `12/12` | 本地账本 | `externalPublished=false`，不证明平台发布 |
| 控制台 | 桌面、中间宽度和 390px 真实浏览器通过；草案状态、0/14、费用、下一步、恢复位置和授权按钮完整可见，console 无相关错误 | 本轮浏览器验收 | 授权按钮未点击 |
| 外部平台 | 抖音、小红书现有连接仅允许读取；外部写入显示 planned | `/api/access-connections`、`/api/overview` | 已验证 |
| Computer Use | `browser_consent_required` 不再误报为 `prepared_browser_pid_missing`，现在保留真实授权错误 | CuaDriver/Publisher 测试 | 完整假页仍缺当次五分钟单次 token；真实 selector、Profile lease、登录和写授权未验收 |

运行时快照（2026-07-31 只读复核；PID、cwd 与状态未漂移）：

| 服务 | 地址 | 监听/进程 | cwd | 配置来源 |
| --- | --- | --- | --- | --- |
| A君运行台 | `http://127.0.0.1:4321` | PID `15246`；`/api/overview` 200 | `apps/ajun-runtime` | `~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist` |
| Paperclip | `http://127.0.0.1:3100` | 0.4.7 live 重载后 PID `51714` | 本仓库 | Paperclip `2026.722.0` 本机私有部署 |
| Publisher Gateway | `http://127.0.0.1:4390` | listener PID `82321`；health=`disabled` | `integrations/publishing/m5-publisher-gateway` | `~/Library/LaunchAgents/ai.agent-army.m5-publisher-gateway.plist` |

## 3. 变更与决策

- 已完成：Paperclip v2 Pipeline/Routine 安全克隆为 15 阶段/17 Routine/5 个无模型控制器；内容自治插件、Fake Publisher Gateway、默认关闭的抖音官方 API/CUA production composition、A君可信惰性 provider、原生 Monitor 指标回流和失败关闭边界。代码已接线，但 live 未注入、未启用。
- 已完成：publisher、metrics、retrospective 的专用 Work Product 写回契约；复盘样本门槛、版本化、离线回放/审核/单条灰度门禁。`LearningProposal` 只提建议，不改 Prompt、权限、频率或投流。
- 已完成 Profile 配置层：A君、小R、小D、小办及其余正式岗位的 M5 Routine/MCP/Profile 声明已同步到 11 个实际 Hermes Profile；post dry-run `0 drift`，技能白名单 `11/11 clean`，同步没有启停 Gateway。该结果不代表当前 A君 4321 已重启加载本轮源码。
- 已完成本地纵切：开放研究及其路由/Routine 契约 `29/29`，恢复时只接收与当前 assignment 同 Issue/Run 的内嵌 Observation，跨 Issue/Run 注入失败关闭；M5 chaos `4/4`，与开放研究及 current-run 恢复 provider 的组合回归为 `38/38`；Paperclip Run-JWT/恢复 Approval 兼容补丁 `15/15`。controller cutover `15/15`；快照读写 TOCTOU 和 post-link 原目录清理已修复，清理不完整会 `recoveryRequired`；ready/cleanup/close 卡死均会有限时强制退出且不残留监听器。current-run 恢复 provider 已 wire 进源码 composition，聚焦回归 `43/43`、相关 server/controller `84/84`。这些仍是本地证据；兼容补丁未 apply，当前 4321 未加载新 binding。
- 已完成：v2 clone cutover。审计核验旧18阶段、无活动 Case、唯一草案 `0/14`、
  Cron off、目标15阶段并完整解压指定 gzip 备份；随后保留 v1 全部资源，创建
  v2 Project/Pipeline/17 Routine/5 控制器与未批准草案，并封存旧草案。
- 已完成：Xiaod `AssetPackage` 的真实视觉帧转存、版权依据、相对路径与哈希门禁；Remotion 三版 props 强制绑定真实 `coverSrc`/`imageSrc`/`assetLedger`，素材被替换会在渲染前失败；机器审核通过必须绑定固定 9 项产物的 `artifact-manifest.json`。
- 已完成候选源码安全收口：固定视觉模型 `step-1o-turbo-vision`、生图/改图模型 `step-image-edit-2`、TTS 模型 `stepaudio-2.5-tts`。通用 Hermes one-shot 移除 `--ignore-rules`，普通调用固定 `clarify`，只有无 Provider 的受控故事板分支允许 `vision`；正式视觉绑定当前 Paperclip Run、固定 action、相对 PNG、帧哈希、时间点、confirmed receipt 和同一 Project。已有视觉 Work Product 重放同样校验，漂移时阻塞且不覆盖；渲染强制消费可信 `GeneratedImagePackage`，机器审核反查同 Project 三条 confirmed action/cost。候选源码为 `0.4.9`，`0.4.8` 仅为历史候选；该结果尚未进入 live `0.4.7` 或旧 A君进程，也没有真实 Campaign StepFun 视觉调用。
- 已完成：Paperclip blocked/pending 只读分类 dry-run；只取 companies、agents、issues，输出 historical_acceptance / active_incident / decision_required / unresolved、负责人和唯一恢复动作建议。
- 已确定：Paperclip Pipeline/Routine/Plugin 与 Hermes Profile 是执行底座；发布由插件外的无模型 Publisher Gateway 执行。
- 已确定：11 个正式岗位主模型固定为 `stepfun/step-3.5-flash-2603`，DeepSeek 只在 `transport_unavailable` 时回退；微信私密只读检索岗位不计入 11 岗。
- 关键文件：M5 PRD、ADR、复用调研、`integrations/paperclip/plugins/content-autonomy/`。
- 兼容边界：M1–M4 任务和现有只读连接继续工作。
- 不要重复创建：组织任务队列、通用技能商店、第二套审批系统。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | LOCAL PASS | Pipeline `67/67`、Fake E2E `5/5`、插件候选源码 `0.4.9` 为 `97/97` 且 `check` 通过（`0.4.8` 仅为历史候选）、Paperclip 集成 `48/48`、Publisher `203/203`、A君候选源码 `1004/1004`、岗位 `15/15`；其余既有聚焦回归保持通过 | 新增执行缝均只在本地通过；live 插件仍 `0.4.7` 且未安装 `0.4.9`、A君仍旧，不证明外部发布 |
| A君当前 frozen 候选 | STARTUP-VERIFIED / NOT LIVE | source `33aa25bd7ff7431d64467fca87866d299caa9857`；release `1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef`、payload `7bd23d48db1f66583d854a28d420498e60e884e261a10171c4767e818156c910`、7571 项、manifest `102daa78172a8857e7151d1a619d6868fb30f97cad1b48e8751ca93b5feb128c`、full-dir `efc8967c6662b645f3018c0b6386231006f21b45f561a932e88df03799eb4b88`；startup/SIGTERM 通过 | live A君仍旧；旧运行版精确 rollback release/源码根缺失，不能 cutover |
| A君历史 clean frozen 候选 | HISTORICAL INVALID FOR CURRENT CUTOVER | `5c4b463…` clean 源码冻结为 `025d4816…`，`entryCount=7570`；曾完成临时隔离启动和移动后全包复验 | 不含本轮最终硬化，不能用于本轮切换；仅保留历史证据 |
| StepFun 七主题生产 | PROVIDER PASS / STRICT REPLAY PASS / NO PUBLISH | `work/m5-content-autonomy/provider/7-theme/m5v2/ledger.json`：`status=succeeded`、43 次明确调用记录 50 分（18 图/18 视觉/7 TTS）、生产阶段 4 新调用、31 次已确认复用、43 次生命周期调用；0.4.7 live 后严格重放 35/35、Provider 请求/调用=0、无新增多模态费用事件；t04 无人物候选经机器与人工复核 | 费用为保守 `cost-events`，不是官方最终账单；没有平台发布 |
| 七主题本地成片 | LOCAL PRODUCTION RENDER PASS / NO PUBLISH | `work/m5-content-autonomy/stepfun-seven-theme-render/m5v2/ledger.json`；7 主题、21/21 视频、7/7 review；63/63 固定产物 hash/bytes 一致；45 秒、1080×1920、H.264/AAC、无黑帧、-14.9 至 -15.2 LUFS；t04 原分辨率 8 点抽帧无人脸 | `externalPublished=false`；没有真实 PublishReceipt、指标或平台内容 ID |
| 7 天真实 MP4 → Fake Publisher | LOCAL PASS / SIMULATED CLOCK | `work/m5-publisher-gateway/acceptance/fake-seven-day-2026-07-31-v1/`：7 个主题、14 支真实本地 MP4、14 个 fake 回执、42 个模拟快照；44 次 Runtime 重建后同一 72h 快照幂等重放，0 平台调用、0 成本；证据明确 `actualPlatformElapsedTime=false` | 不等于真实等待 72 小时、真实平台指标或真实发布 |
| Paperclip 清理 | PARTIAL | 162 条历史记录已取消/隐藏且未删除；当前快照 83 条 | 仍有 16 条真实故障和 67 条未决 |
| 运行时 | LIVE STRUCTURE + PROFILE CONFIG PASS / EXECUTION SEAMS OPEN | live v2 为 17 Routine / 15 阶段 / 5 个控制器；11 Profile post dry-run `0 drift`；新草案未批准且为 `0/14`，Cron disabled | live HTTP adapter 未启用 Run JWT，恢复补丁/provider 未生效，当前 4321 过旧；live 插件仍 `0.4.7`，Publisher 关闭，真实 Campaign StepFun 视觉与内容阶段未执行 |
| 本地 chaos | LOCAL FAKE PASS | 15 阶段成功、并行峰值 4、重试、重启恢复、`request_changes`、预算硬停恢复、Fake 发布幂等及三次模拟指标均通过；安全扫描 318 节点无凭据/绝对路径 | `local_fake_only`、零付费、零外部效果；不证明 live 或真实平台 |
| Computer Use | DIAGNOSTIC FIX PASS / FULL FAKE PAGE WAITING UNLOCK + TOKEN | CuaDriver `0.14.1`、Accessibility `true`、Screen Recording `true`、`doctor` 正常；`browser_consent_required` 会保留真实拒绝，不再误报 `prepared_browser_pid_missing`；runner 的 selector/Profile lease/账号身份/强回执门禁通过。最新只读 app-state 检查返回 Mac locked，未执行页面动作 | 先人工解锁，再生成当次五分钟有效、单次使用的 browser approval token；没有批准冻结的真实 selector bundle、命名 Profile lease、登录态或写授权 |
| 外部平台 | NOT CHECKED | 未执行外部写入 | 双平台发布未授权、未执行 |
| 人工验收 | PARTIAL | 15/17/5、不可变净包 `0.4.7` live、`0.4.6` 回滚兼容保留、当前 StepFun 文本11/11、岗位语义11/11、Cross 19/19、七主题 Provider生产与严格重放、21支全量成片/审核和t04人工抽帧通过 | fresh CUA 单次批准、Hermes/Paperclip live 执行缝、账号、时间窗、真实发布和业务外部闭环仍需分别验收 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：工作树包含大量共享修改，不得重置或覆盖；A君仍从该脏工作树运行。11 个实际 Hermes Profile 和技能白名单已经收敛。新侧 `33aa25bd…` / `1c7f244d…` 已完成 clean、冻结、独立全目录哈希与 startup/SIGTERM 验证；历史 `025d4816…` 已失效，dirty `0767604f…` 继续隔离。运行版仍无法从 HEAD 精确重建为旧回滚包，缺少独立匹配的 old rollback release/源码根，故 cutover/rollback 继续 blocked，现在不得直接重启。冻结 staging 已移入系统废纸篓且可恢复；插件根审计期间的短暂 mode 调整已恢复只读并获独立安全放行。外置源码修复目前只会形成 `candidate_promoted` / `repair_candidate_awaiting_release`，不会冒充 live 已修复。blocked/pending 仍有 83 条。当前 4321 早于本轮源码；Paperclip Run-JWT/恢复兼容补丁未 apply，源码已接线的 A君恢复 binding 尚未被 live 加载。文本 no-tool 探针只证明传输和模型身份；正式视觉门禁已在候选源码通过，但 live 插件仍 `0.4.7` 且尚无真实 Campaign StepFun 视觉。岗位语义与 Cross 已通过，但不证明 live 执行。Publisher 仍关闭；真实平台 Computer Use、真实 PublishReceipt、真实学习样本和真实平台写入均没有外部证据。
- 当前未发生：未批准或启动活动；production connector 代码虽已接 Runtime/composition，但 live 未注入 provider、未配置真实连接器，未操作平台页面、未真实发布，未生成真实 `LearningProposal`；1 个草案保持 `approvedAt=null`、Routine 定义 active 但 schedule trigger 关闭且从未触发。
- 不得复制或展示的信息：模型 Key、Cookie、OAuth Token、账号授权链接。
- 需要谁确认：屏幕录制、插件升级和本轮付费多模态已经完成；抖音/小红书写权限和真实发布活动仍需负责人分别确认。
- 关闭条件：M5 验收记录的全部层级达到约定门禁。
- 关闭证据链接：[M5 验收](../../reviews/m5-high-autonomy-content-operations/acceptance.md)。
