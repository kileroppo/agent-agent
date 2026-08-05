# M5 高权限内容自治交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 2026-08-05 已完成一次负责人单独授权的小红书真实发布冒烟，平台内容 ID 已分配且当前“审核中”；该动作未经过 production Runtime。Cron 与 Publisher 继续关闭，Paperclip selector/Profile lease、抖音发布、指标和 7 天闭环未完成，M5 未完成 |
| 创建时间 | 2026-07-30 Asia/Shanghai |
| 交出者 | Codex |
| 接手者 | Codex / A君 |
| 关联任务 | [M5 PRD](../../../tasks/prd-m5-high-autonomy-content-operations.md) |
| 截止条件 | R4 main/recovery smoke 与 live 切换已完成；下一门禁是只读 production readiness 和 Paperclip 兼容层/插件逐项 apply。未经独立批准不得开启 Publisher、批准活动或执行平台写入 |

## 1. 接手目标

- 目标：把内容增长链升级为可恢复、可审计、可受控发布的真实执行循环。
- 用户约束与不可做事项：抖音+小红书；旁白混剪；活动级预授权；不使用逆向接口、Cookie 导出、私信、评论、投流或自动删除。
- 做完的定义：本地代码、自动化、fresh 运行时、多模态、Computer Use、双平台首发和 7 天指标回流分层有证据。
- 唯一下一步：保持活动、Cron 和 Publisher 关闭，对 R4 live 做只读 production readiness，明确 Paperclip 兼容补丁、`0.4.9` 插件和真实 connector 各自仍缺的门禁；不要把 A君已切版写成活动已可发布。
- 允许继续的前提：A君`1051/1051`、Pipeline`67/67`、插件`97/97`、Publisher`203/203`
  和15/17/5 Paperclip live结构已通过；A君 16/18/6 代码与恢复硬化已进入 R4 live，但 Paperclip 16/18/6 资源尚未 apply。CuaDriver 辅助功能、屏幕录制和拒绝诊断已完成，完整本地假页
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
| 代码与文档 | A君 R4 已加载16阶段/18 Routine/6控制器代码；Paperclip资源仍为15/17/5 | R4 release、M5 PRD、架构、M5 验收 | Paperclip 16/18/6 尚未 apply |
| 双平台内容变体 | `baseline` 独立驱动 master/小红书，`gray_douyin` 独立驱动抖音；脚本、TTS、模板绑定、渲染、机器审核和内容血缘按变体核验 | A君全量测试与 M5 验收 | 本地契约；没有真实平台发布 |
| v2 clone cutover | Pipeline `6dfd94da…`、Project `86ad0a0a…`、草案 `8dd29a3b…` 已 live；A君 R4 回读既有 v2 ID/key，旧 v1/22 Case 保留 | live 回读、A君 4321 `/api/content-campaigns` | 新草案未批准 0/14，Cron off |
| 现成控制面 | Paperclip `2026.722.0` 已含 Plugin、Pipeline、Routine、预算、审批、审计和恢复；Hermes 0.19 已含 Profile、skills audit、MCP、Cron、checkpoint | 本机健康接口、CLI 与官方源码 | 已验证 |
| 自动化 | A君`1051/1051`、Pipeline`67/67`、插件`97/97`、Publisher`203/203` | [M5 验收](../../reviews/m5-high-autonomy-content-operations/acceptance.md) | 只证明本地源码和fixture |
| 技术修复源码根 | 运行 release 与可写源码根分离；外置源码根须显式、clean、Git 身份可验证，修理副本绑定 task/common-dir/HEAD/精确范围；越界、错误归属、漂移和部分 promotion 失败均拒绝或回滚。成功只返回 `candidate_promoted` 并进入 `repair_candidate_awaiting_release` | 聚焦回归 `139/139`、M5 验收 | candidate 仍 awaiting release，不能冒充当前 live 已修复 |
| 本机持久状态权限 | `task-store` 与飞书 completion watcher 使用唯一 tmp、`wx`/0600、原子 rename 和 rename 后 chmod；既有 0644 收敛、失败不破坏旧文件或无关 tmp | 聚焦回归 `15/15` | 只在临时 fixture 验证；未直接 chmod 真实数据 |
| A君不可变 release | R4 commit `7ac6defc…`；release `7b90e666…`、payload `e2a1aca0…`；双 smoke 通过并由 PID `58141` 激活 | 冻结、launchd 与验收账本 | r3/r2 仅为历史候选 |
| A君上一版 release | HISTORICAL R2 / NOT CURRENT：source `33aa25bd…`；路径 `work/m5-runtime-releases/m5-8point-20260731-r2/ajun-runtime-release-v1-1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef/`；release `1c7f244d…`、payload `7bd23d48…`、manifest `102daa78…`、full-dir `efc8967c…`、7571 项；隔离启动与 SIGTERM 退出曾通过 | 历史冻结与验收账本 | 不含 r3 硬化，不是当前候选，也不能冒充 live exact rollback |
| Runtime 恢复 | degraded recovery ready 且已在实际切换中接管 4321；exact previous 不可用 | R4 plan、recovery health 与 launchd 记录 | 只读恢复不挂正式状态、不冒充旧 live |
| Paperclip 待办清理 | 153 条历史巡检失败和 9 条历史验收已归档为取消/隐藏且未删除；当前 83 条：active_incident 16、unresolved 67 | `integrations/paperclip/scripts/classify-blocked-pending-issues.mjs`、M5 验收 | 真实故障与未决任务仍保留负责人和恢复动作 |
| Paperclip / 插件 | live v2 为 17 Routine、15 阶段、5 个无模型 HTTP 控制器；插件 `agent-army.content-autonomy` live `0.4.7` 已从不可变净包安装并 `ready`。`0.4.9` 候选包 `payloadHash=b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d`、`entryCount=19986`、`manifestSha256=dabf16ac255eec3348e5800239f907793db1c1e507d1aa2820cd57fb71ec8dd7`、独立全目录哈希 `82f75845b927c8fa817e45e8e4d588338c7131677f2681c7297dba987db0c8bd`；搬移时仅 bundle 根由 `0555` 短暂调为 `0755`，内部未改，完成后根恢复 `0555`、manifest 保持 `0444`，独立复算与安全审计放行。源码 `97/97`、`check` 和 Paperclip 集成 `48/48` 通过；`0.4.8` 仅为历史候选，`0.4.6` 回滚兼容链保留 | live 资源核验、候选源码测试、不可变包、生成方与独立安全账本 | `0.4.9` 尚未安装到 live；配置校验和、对象形 Secret 引用和 8 岗绑定有效；新草案仍未批准，`approvedAt=null`、`0/14`、Cron 关闭 |
| 预算 | 13 条 M5 Budget 策略分别覆盖公司、Project 和 11 个正式岗位；每条均为 625 分的同一分层硬上限；公司与 M5 v2 Project 累计均为 392 分，剩余 233 分；小创累计 62 分、小拆累计 30 分 | Paperclip live Budget 与 m5v2 费用事件 | 分层上限不能相加；保守 `cost-events` 不等于 StepFun 官方最终账单 |
| Hermes Profile 与技能白名单 | 11 个正式 Profile、Paperclip Adapter 与 fresh A君 release 已切到 `deepseek/deepseek-v4-flash`，回退链为空；5 个常驻 Gateway 已重启 | Profile 配置、launchd PID/cwd、Paperclip 11/11 对账 | 未执行付费 DeepSeek 探针；微信取件员不属于 11 岗 |
| 本地运行时 | Paperclip `3100/api/health` 200；A君 PID `58141` 的 `4321/api/overview` 200，cwd/entrypoint 指向 R4；Publisher `4390` disabled | listener/cwd、plist 与只读 HTTP | 活动未批准；没有触发 publisher/retrospective heartbeat |
| 运维巡检 | 修复后连续 3 次受控手动 Routine Run 与至少 1 次自然定时 Run 为 `completed` | Paperclip Routine Run 只读记录 | 更早失败仍作为历史保留 |
| 指标回流 | current-run scope 与 `PaperclipBridge` 六项核心 access 已由 R4 加载；2h/24h/72h 与独立指标 approval 代码存在 | R4 live、代码与本地测试 | Paperclip 兼容补丁未 apply，connector dependencies 为空并失败关闭；无真实 PublishReceipt 或指标 |
| 生产 readiness | 只读 CLI/API 已就绪；当前结果 `not_ready`、退出码 `2`、唯一下一步 `provide-campaign-status-snapshot` | `npm run production:readiness` | 4390 仍 disabled，缺 Campaign snapshot、selector、Profile lease 与 provider；预检不启用生产 |
| 发布与复盘写回 | publisher 与 retrospective 控制器和 Routine 已接入 live；production Runtime/composition 与 A君惰性 provider 已接线，账号、日期、预算、幂等和强证据为硬门 | 代码、Pipeline `67/67`、live Agent/Routine 绑定 | live 未注入 production provider；没有真实连接器、发布凭证、学习样本或模板升级 |
| StepFun | 文本实调用 `11/11`、岗位语义 `11/11`、新 Cross `19/19` passed；Profile 收敛后另完成 1 次 `video-content-analyst` 真实 no-tool 探针，工具调用 0。旧多模态 Provider 账本含35个action-linked费用记录、合计42美分、`lifetimeProviderCalls=43` | StepFun账本与语义证据 | 新调用 usage 的 `cost_status=unknown`；`estimated_cost_usd=0` 只是 usage 字段，不是官方账单。no-tool 探针只证明文本传输和模型身份，不承担内容 Provider 血缘；尚无真实 M5 Campaign StepFun 视觉，不证明 A君 live 或平台发布 |
| 本地成片与血缘 | 上游已原生生成 lineage；native smoke为Provider0、1/1 lineage、3/3媒体，45秒、1080×1920、H.264/AAC、0黑帧、-15.1LUFS。历史lineage-v2仍为7/7 lineage、21/21媒体；另3主题9视频dry-run `12/12` | 本地账本 | `externalPublished=false`，不证明平台发布 |
| 控制台 | 桌面、中间宽度和 390px 真实浏览器通过；草案状态、0/14、费用、下一步、恢复位置和授权按钮完整可见，console 无相关错误 | 本轮浏览器验收 | 授权按钮未点击 |
| 外部平台 | 抖音、小红书现有连接仅允许读取；外部写入显示 planned | `/api/access-connections`、`/api/overview` | 已验证 |
| Computer Use | `browser_consent_required` 不再误报为 `prepared_browser_pid_missing`，现在保留真实授权错误 | CuaDriver/Publisher 测试 | 完整假页仍缺当次五分钟单次 token；真实 selector、Profile lease、登录和写授权未验收 |

运行时快照（2026-08-01 R4 切换后）：

| 服务 | 地址 | 监听/进程 | cwd | 配置来源 |
| --- | --- | --- | --- | --- |
| A君运行台 | `http://127.0.0.1:4321` | PID `73653`；`/api/overview` 200 | `work/runtime-sources/deepseek-cutover-20260802-release-r1/…/apps/ajun-runtime` | `~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist` |
| Paperclip | `http://127.0.0.1:3100` | 0.4.7 live 重载后 PID `51714` | 本仓库 | Paperclip `2026.722.0` 本机私有部署 |
| Publisher Gateway | `http://127.0.0.1:4390` | listener PID `82321`；health=`disabled` | `integrations/publishing/m5-publisher-gateway` | `~/Library/LaunchAgents/ai.agent-army.m5-publisher-gateway.plist` |

## 3. 变更与决策

- 已完成 R4 A君切版：16 阶段/18 Routine/6 控制器代码与恢复失败关闭已进入 A君 live；Paperclip 资源仍为 15/17/5，尚未 apply 新结构。
- 已完成本地双变体：`baseline` 驱动 master/小红书，`gray_douyin` 驱动抖音；脚本、TTS、模板绑定、渲染、机器审核和血缘独立。
- 已完成：publisher、metrics、retrospective 的专用 Work Product 写回契约；复盘样本门槛、版本化、离线回放/审核/单条灰度门禁。`LearningProposal` 只提建议，不改 Prompt、权限、频率或投流。
- 已完成 Profile 配置层：11 个实际 Hermes Profile post dry-run `0 drift`、技能白名单 `11/11 clean`，同步没有启停 Gateway；A君 4321 已 fresh 加载 R4。
- 已完成本地纵切与 R4 加载：通用 current-run scope 与 `PaperclipBridge` 六项 Publisher 核心 access 已进入 A君 live；A君整包 `1051/1051`、Publisher `203/203`、Fake 全链 `5/5`。Paperclip Run-JWT/恢复 Approval 兼容补丁仍未 apply，因此真实 connector 保持失败关闭。
- 已完成：v2 clone cutover。审计核验旧18阶段、无活动 Case、唯一草案 `0/14`、
  Cron off、目标15阶段并完整解压指定 gzip 备份；随后保留 v1 全部资源，创建
  v2 Project/Pipeline/17 Routine/5 控制器与未批准草案，并封存旧草案。
- 已完成：Xiaod `AssetPackage` 的真实视觉帧转存、版权依据、相对路径与哈希门禁；Remotion 三版 props 强制绑定真实 `coverSrc`/`imageSrc`/`assetLedger`，素材被替换会在渲染前失败；机器审核通过必须绑定固定 9 项产物的 `artifact-manifest.json`。
- 已完成候选源码安全收口：固定视觉模型 `step-1o-turbo-vision`、生图/改图模型 `step-image-edit-2`、TTS 模型 `stepaudio-2.5-tts`。通用 Hermes one-shot 移除 `--ignore-rules`，普通调用固定 `clarify`，只有无 Provider 的受控故事板分支允许 `vision`；正式视觉绑定当前 Paperclip Run、固定 action、相对 PNG、帧哈希、时间点、confirmed receipt 和同一 Project。已有视觉 Work Product 重放同样校验，漂移时阻塞且不覆盖；渲染强制消费可信 `GeneratedImagePackage`，机器审核反查同 Project 三条 confirmed action/cost。候选源码为 `0.4.9`，`0.4.8` 仅为历史候选；该结果尚未进入 live `0.4.7` 或旧 A君进程，也没有真实 Campaign StepFun 视觉调用。
- 已完成：Paperclip blocked/pending 只读分类 dry-run；只取 companies、agents、issues，输出 historical_acceptance / active_incident / decision_required / unresolved、负责人和唯一恢复动作建议。
- 已确定：Paperclip Pipeline/Routine/Plugin 与 Hermes Profile 是执行底座；发布由插件外的无模型 Publisher Gateway 执行。
- 已确定：11 个正式岗位主模型固定为 `deepseek/deepseek-v4-flash`，不回退 StepFun 文本模型；M5 StepFun 多模态仍是独立媒体能力。微信私密只读检索岗位不计入 11 岗。
- 关键文件：M5 PRD、ADR、复用调研、`integrations/paperclip/plugins/content-autonomy/`。
- 兼容边界：M1–M4 任务和现有只读连接继续工作。
- 不要重复创建：组织任务队列、通用技能商店、第二套审批系统。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | LOCAL PASS | A君`1051/1051`、Pipeline`67/67`、插件`97/97`、Publisher`203/203`、Fake全链`5/5` | 不证明live或外部闭环 |
| A君 release | R4 ACTIVE | commit `7ac6defc…`、release `7b90e666…`、payload `e2a1aca0…`；双 smoke 与 PID/cwd/entrypoint 通过 | 不代表活动或发布已启用 |
| A君历史 clean frozen 候选 | HISTORICAL INVALID FOR CURRENT CUTOVER | `5c4b463…` clean 源码冻结为 `025d4816…`，`entryCount=7570`；曾完成临时隔离启动和移动后全包复验 | 不含本轮最终硬化，不能用于本轮切换；仅保留历史证据 |
| StepFun 七主题生产 | PROVIDER PASS / STRICT REPLAY PASS / NO PUBLISH | `work/m5-content-autonomy/provider/7-theme/m5v2/ledger.json`：`status=succeeded`、43 次明确调用记录 50 分（18 图/18 视觉/7 TTS）、生产阶段 4 新调用、31 次已确认复用、43 次生命周期调用；0.4.7 live 后严格重放 35/35、Provider 请求/调用=0、无新增多模态费用事件；t04 无人物候选经机器与人工复核 | 费用为保守 `cost-events`，不是官方最终账单；没有平台发布 |
| 七主题本地成片 | LOCAL PRODUCTION RENDER PASS / NO PUBLISH | `work/m5-content-autonomy/stepfun-seven-theme-render/m5v2/ledger.json`；7 主题、21/21 视频、7/7 review；63/63 固定产物 hash/bytes 一致；45 秒、1080×1920、H.264/AAC、无黑帧、-14.9 至 -15.2 LUFS；t04 原分辨率 8 点抽帧无人脸 | `externalPublished=false`；没有真实 PublishReceipt、指标或平台内容 ID |
| 7 天真实 MP4 → Fake Publisher | LOCAL PASS / SIMULATED CLOCK | `work/m5-publisher-gateway/acceptance/fake-seven-day-2026-07-31-v1/`：7 个主题、14 支真实本地 MP4、14 个 fake 回执、42 个模拟快照；44 次 Runtime 重建后同一 72h 快照幂等重放，0 平台调用、0 成本；证据明确 `actualPlatformElapsedTime=false` | 不等于真实等待 72 小时、真实平台指标或真实发布 |
| Paperclip 清理 | PARTIAL | 162 条历史记录已取消/隐藏且未删除；当前快照 83 条 | 仍有 16 条真实故障和 67 条未决 |
| 运行时 | R4 FRESH / PAPERCLIP STRUCTURE UNCHANGED | A君 PID `58141` 为 R4；Paperclip v2 仍为 17 Routine / 15 阶段 / 5 控制器；草案 `0/14`，Cron disabled | Paperclip HTTP adapter 未启用 Run JWT；live 插件仍 `0.4.7`，Publisher 关闭 |
| 恢复 | DEGRADED LIVE EXERCISED | R4 recovery entrypoint 实际接管 4321 且无外部效果/写路由；生产随后恢复 | exact previous 仍不可用 |
| Computer Use | DIAGNOSTIC FIX PASS / PRODUCTION APPROVAL PENDING | CuaDriver `0.17.0`、Accessibility `true`、Screen Recording `true`、`doctor` 正常；`browser_consent_required` 会保留真实拒绝，runner 使用只读语义查询和唯一标题/详情 URL 强回执门禁 | 当前网址的 Computer Use 操作受限；没有批准冻结的真实 selector bundle、命名 Profile lease 或 production Runtime 回执 |
| 外部平台 | NOT CHECKED | 未执行外部写入 | 双平台发布未授权、未执行 |
| 人工验收 | PARTIAL | A君 R4 fresh；Paperclip 15/17/5；草案0/14、Publisher off | Paperclip新结构、真实Provider/平台闭环仍待验收 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：A君 R4 已 fresh，degraded recovery 可用但 exact previous 仍不可用；Paperclip 仍为15/17/5且兼容补丁未 apply，Publisher 为 disabled。本轮无真实Provider调用或发布。
- 当前未发生：未批准或启动活动；production connector 代码虽已接 Runtime/composition，但 live 未注入 provider、未配置真实连接器，未操作平台页面、未真实发布，未生成真实 `LearningProposal`；1 个草案保持 `approvedAt=null`、Routine 定义 active 但 schedule trigger 关闭且从未触发。
- 不得复制或展示的信息：模型 Key、Cookie、OAuth Token、账号授权链接。
- 需要谁确认：屏幕录制、插件升级和本轮付费多模态已经完成；抖音/小红书写权限和真实发布活动仍需负责人分别确认。
- 关闭条件：M5 验收记录的全部层级达到约定门禁。
- 关闭证据链接：[M5 验收](../../reviews/m5-high-autonomy-content-operations/acceptance.md)。

## 2026-08-05 补充：自媒体内容方法与公众号草稿

- 1–6 项内容方法已由现有 A君、小R、小创、审核官和小办承接；Paperclip 继续是唯一任务真相，没有引入上游任务卡或状态机。干净源码为分支 `codex/self-media-content-release-20260805`、提交 `44515e0619ac3ba6ca853923c473b1c2fa9b930c`。
- 第 7 项使用独立 `WechatDraftGateway` 与 `WenyanCliRunner`。能力仅限创建公众号草稿，回执固定未发布、未群发；账号、Secret Reference、批准快照、独立账本和不可变文件租约均在 Publisher 边界内。
- 自动化：clean source 的 contracts `13/13`、A君全量 `1108/1108`、Manifest `16/16`、Publisher `214/214`（公众号专项 `11/11`）、架构边界通过；冻结工具又复跑发布级测试、主入口和只读恢复入口 smoke。
- 运行时：不可变 release `e3b7ae7b1a1afac301a529e410743690edc2bfa4fd046e27b3a8bbdc6ae58017`、payload `fbbc1495006d801917d4c5b2b9115fdff076682c1158d5cb7dc6f126c4eb6893` 已切入 4321。受控重启 PID `14873 → 15283` 后 `/api/overview` 仍为 200，任务/审批保持 `744/25`；Paperclip health 正常，Publisher 仍为 `disabled`。
- 外部平台：未安装或调用真实 Wenyan，未读取真实 Secret，未访问公众号，也未创建草稿或群发。
- 唯一下一步：保持 Campaign、Cron、Publisher 和公众号连接器关闭；只有负责人对测试公众号的一次“创建草稿”给出独立授权后，才配置 accountRef、Secret Reference、IP 白名单并执行人工预览验收，仍不得群发。

## 2026-08-05 补充：小红书受控真实发布冒烟

- 负责人分两次明确授权：先允许上传测试视频且不发布，完成表单核验后再允许发布当前测试内容。
- 隔离 CuaDriver exact 绑定完成上传、标题、正文、标签和一次发布点击；小红书位置权限被拒绝，没有传输位置数据。
- 平台跳转到 `/publish/publish?source=&published=true`；笔记管理返回内容 ID `6a72ddf8000000002201484e`、时间 `2026-08-05 14:53 Asia/Shanghai`、状态“审核中”。
- runner 已兼容无名称文件 input、唯一富文本正文和标签追加；新增笔记管理回读候选：只读跳转管理页，仅点击标题完全一致且唯一的详情入口，组合列表状态与详情 URL 内容 ID；缺 ID、重复标题或跨域均硬停，不重复点击发布。Publisher `221/221`、`npm run check`、`git diff --check` 通过。
- 当前边界：结果回读只通过本地 fixture；Computer Use 对当前网址拒绝操作，没有进行第二次真实发布或真实详情点击，也没有 Paperclip selector/Profile lease 或 production Runtime `PublishReceipt`。
- CuaDriver 已用官方 v0.17.0 发布脚本完成校验升级，daemon 已恢复，Accessibility/Screen Recording 仍为 `true`；新版未提供任意 DOM 属性读取，结果证据仍走受限语义快照和同源详情 URL。
- 唯一下一步：保持 Campaign、Cron 和 Publisher 关闭，为结果回读候选取得 Paperclip selector/Profile lease 独立批准并执行 production Runtime 单条验收；抖音与指标仍需另行完成。
