# M5 高权限内容自治验收

> 当前总判定：**PARTIAL / M5 NOT COMPLETE**。2026-08-05 已完成一次负责人单独授权的小红书真实发布冒烟，平台分配内容 ID 且笔记当前“审核中”；该动作使用隔离 CuaDriver 人工验收链，不是 A君 production Runtime、Paperclip selector/Profile lease 或真实 PublishReceipt。Cron 与 Publisher 继续关闭；抖音发布、双平台回读、指标和 7 天闭环仍未完成。

## 2026-08-15 StepFun 能力模型切换追加证据

| 项目 | 事实 | 边界 |
| --- | --- | --- |
| UI 与策略 | A君模型页可保存主模型、岗位覆盖和能力专用模型；ASR 可选 `stepaudio-2.5-asr` 或本机 Whisper，视觉固定 `step-3.7-flash`，生图/改图固定 `step-image-edit-2`，TTS 固定 `stepaudio-2.5-tts` | 保存只作用于新任务；正在执行的任务不换模型 |
| 小D ASR | 小D创建任务时冻结 ASR 路线；StepFun 已提交后不自动重试、不跨服务商改投，响应中断写 `ambiguous` 回执 | 自动化和运行配置已验收；本轮未发送真实音频，因此不宣称 StepAudio 真实转写成功 |
| 内容插件 | Paperclip 插件由不可变 `0.4.9` 同 ID 软升级为不可变 `0.5.0`，配置校验值保持，live API 与 health 均回读 `ready/healthy`；manifest 视觉工具回读 `step-3.7-flash` | 新包 `payloadHash=9fe0df77a9b9a87fbca8f787d6ebcc27ce50fef525d9998535c8bbd37893b43e`、`entryCount=939`；隔离冻结目录的 TypeScript 二次 check 因依赖解析冲突未通过，真实 Workspace check、全量测试和 live 加载健康通过 |
| 安全状态 | Paperclip 数据库备份健康，Campaign `stopped`，每日 Cron disabled，Publisher 未启动；0.4.9 不可变回滚包和显式回滚动作保留 | 升级没有恢复活动、调用媒体 Provider、发送飞书消息或发布平台内容 |

## 2026-08-06 A君不可变 release 收口

| 层级 | 结论 | 事实与边界 |
| --- | --- | --- |
| 不可变来源 | PASS | clean commit `bf8b6586f3e21b241a270e70142fe44745e194f7`；release `0ba4980dad1df73b3bc0b32d8364d0a5600ae516d056602911d5e7d010b96752`；payload `e7ec9ea89300dddc8a58bed5d5ea9262a084c361e5d65c8132234690de537147` |
| 自动化 | PASS | 聚焦 `24/24`、A君 `1143/1143`、Pipeline `67/67`、内容插件 `97/97`；架构检查、main/recovery smoke、payload 校验通过。隔离 worktree 的根 `npm run check` 仅因仓库外 Local-AI Python venv 路径未复制而不能完整执行，不是产品测试失败 |
| live 运行 | PASS | PID `36973`，cwd/entrypoint 指向 release；`/api/overview=200`，11 个 Agent、771 条任务、0 条进行中/后台/待审批任务。Paperclip、小D、Publisher 健康接口为 200 |
| 浏览器 | PASS | 真实 Chrome DevTools 协议验证任务详情 `#employees` 在后台同步和整页重载后仍保持选中；浏览器错误 0 |
| 生产边界 | CLOSED | Publisher `disabled`、`realConnectorsConfigured=false`；Campaign、Cron 未恢复。Provider 调用、发布、外部消息均为 0；M5 仍为 PARTIAL |
| 恢复 | DEGRADED PASS / EXACT UNAVAILABLE | 切换前 launchd plist 已以 `0600` 备份；只读 recovery smoke 证明 `local_recovery_only`、`externalEffects=false`、`writableRoutes=false`。没有 exact previous，备份只作审计与人工恢复材料 |

唯一安全下一步：生成并人工审阅不含 Secret 的当前 Campaign readiness 输入快照，再执行只读 `production:readiness`。恢复 Campaign、注入 provider、启用 Publisher 或发布均须另行批准。

## 2026-08-14 StepFun 3.7 文本主模型切换追加证据

| 项目 | 事实 | 边界 |
| --- | --- | --- |
| 仓库契约 | 11 个正式 AgentManifest、Hermes 映射、schema 与 Paperclip Adapter 均固定为 `stepfun/step-3.7-flash`，fallback/extraArgs 为空 | 微信私密只读岗位继续本机 Qwen，不属于本次文本模型切换 |
| 本机 Profile | 默认 Hermes 与 11/11 隔离 Profile 均回读为 `custom:sstefun / step-3.7-flash`、`api.stepfun.com/step_plan/v1`、凭据存在、fallback 为空；5 个常驻 Gateway 已以新 PID 重启 | 凭据只在本机配置间受控同步，未回显、未写入仓库 |
| 不可变来源 | clean source commit `136a95998ae83230a889071222971b5521f1eefe`；release `0f3017d13a2e21b12334b299e18c8827acdb252c2a12c36845c2fd59daf582ec`；payload `5dbd1e17420e71ca36041771d2a4be231b7828b08b2f0127ae9eb4c985aa9112` | main/recovery smoke 与冻结门禁通过；降级只读恢复 ready |
| live 切换 | A君 PID `90356`，4321 listener、entrypoint、cwd 与 `/api/overview=200`；`runtime:fingerprint` 为 `same_git_head`；Paperclip 11/11 正式岗位为 StepFun 3.7 且显式空数组 | PID 是本次切换快照；Publisher 关闭导致总体状态仍可为 degraded |
| 外部证据 | 本轮未主动发起模型探针、飞书消息、Paperclip 业务任务或发布动作 | StepFun 3.7 主传输仍为 `model-transport-pending`，需真实业务调用或另行授权付费探针 |

## 2026-08-02 DeepSeek 文本主模型切换追加证据

| 项目 | 事实 | 边界 |
| --- | --- | --- |
| 仓库契约 | 11 个 AgentManifest、Hermes 映射、schema 与 Paperclip Adapter 均固定为 `deepseek/deepseek-v4-flash`，显式清空 fallback/extraArgs | 微信取件员继续本机 Ollama；M5 StepFun 多模态不属于文本模型切换 |
| 本机 Profile | 11/11 `~/.hermes/profiles/*` 解析为 DeepSeek，fallback 0；5 个常驻 Gateway 已以新 PID 重启 | 未读取或回显 `.env`/密钥，未执行模型请求 |
| 不可变来源 | clean source commit `53eb2fcab8d883eaa4eb50ca7e1a806fd748e233`；release `80bd473f34472308a99987a8f6b12110d07f6e24bc969b377776d1ea6c1f31b6`；payload `009da83e212b361e42b87706bdb54d1d66a37beb07fed91fd28653360df9fc72` | main/recovery smoke 与冻结门禁通过；旧 release 仅作历史参考，降级只读恢复 ready |
| live 切换 | A君 PID `3694 → 73653`，4321 listener、entrypoint、cwd 与 overview 通过；启动后 Paperclip 11/11 自动对账为 DeepSeek，跨 60 秒复核未回退 | 只证明配置和本机运行路径，不证明 DeepSeek 真实传输或岗位质量 |
| 外部证据 | 本轮 Provider 请求 0、飞书消息 0、Paperclip 业务任务 0、发布 0 | 新模型 Profile 保持 `model-transport-pending`，需另行授权付费探针或由真实业务调用形成证据 |

## 2026-08-01 R4 live 切换追加证据

| 项目 | 事实 | 边界 |
| --- | --- | --- |
| 不可变来源 | clean source commit `7ac6defc516085e5b9e8594eb5507617294c0689`；release `7b90e666b5c11366a086e92895033be8c6f3a53b071aaf0e7cd207f7a7905277`；payload `e2a1aca014fc63d8c3d39f240a752a0e582c46020a28e96fce1258ed038094aa` | 候选排除了切换准备期间并发写入的 boom-monitor 半成品 |
| 冻结验证 | release 工具执行 A君、Pipeline、内容插件与 Publisher 检查；main startup smoke `/api/overview` 200，recovery startup smoke `/api/health` 200，payload 未漂移 | 仅本地隔离与源码测试，不是平台验收 |
| 实际恢复演练 | 首次 bootstrap 遇到 launchd 卸载竞态后，独立 recovery entrypoint 实际接管 4321；模式 `local_recovery_only`、`externalEffects=false`、`writableRoutes=false` | 不挂正式状态，不是 exact previous 回滚 |
| live 身份 | 等待旧 launchd label 完全卸载后切换成功；PID `58141`，entrypoint 与 cwd 均位于 R4 release；live plist SHA-256 与 staged plist 同为 `029e1fee451ac882d57981e97b6c6a8e4812e05a6177c26740969b8dc4d02d0c` | 原 PID `15246` 已退出 |
| 状态保持 | `/api/overview` 返回 552 tasks、11 agents、25 approvals；活动 `8dd29a3b…` 仍为 draft、`approvedAt=null`、`0/14`；11 个 M5 Routine 无 trigger、无 running Run；4390 仍 disabled | 没有活动批准、付费调用或外部发布 |
| 可恢复备份 | 切换前 plist SHA-256 `5bd8184a762dbe46a946bf6e8f33e39af058781e637f661cec1ae43b75f4abd3`，备份与生产/恢复 staged plist 均保存在 R4 `launchd-backup/` | 旧 plist 指向共享脏源码，只作审计备份，不作为自动 exact rollback |

| 层级 | 当前结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 复用调研 | ACCEPTED | 已核对本机 Paperclip `2026.722.0`、Hermes 0.19 与官方源码；撤销重复的文件状态机/技能注册表 | 外部发布仍需独立授权与验收 |
| 契约与代码 | R4 RUNTIME PASS / PAPERCLIP 15/17/5 | R4 声明 16 阶段、18 Routine（17 阶段/分支 + 1 daily）和 6 个无模型控制器，并已由 A君 live 加载；Paperclip 资源仍为 15/17/5。灰度日的 `baseline` 独立驱动 master/小红书，`gray_douyin` 独立驱动抖音 | Paperclip 新结构尚未 apply；真实连接器仍未配置、未启用 |
| v2 clone cutover | LIVE PASS / CAMPAIGN PAUSED | live Pipeline `6dfd94da…`、Project `86ad0a0a…`、活动 `8dd29a3b…`；没有分支引用且从未触发的旧 `m5-research` Routine 已归档并保留记录。当前活动 `campaignGrant.status=paused`、无 active work，M5 每日 Cron 关闭；旧 v1 Pipeline/22 Case 保留 | 活动曾被批准并触发过入口，当前不是未批准草案；本次插件版本收敛未恢复活动或执行内容阶段 |
| 自动化 | LOCAL PASS | A君 `1051/1051`、Pipeline `67/67`、内容插件 `97/97`、Publisher `203/203`，覆盖当前 16/18/6 源码候选、完整双变体、模板绑定、Publisher 六项 Paperclip 核心 access 与恢复失败关闭 | 只证明共享源码与本地 fixture；不证明 live、Provider、Computer Use 或平台发布 |
| A君源码根与技术修复 | R4 LIVE / CLEAN SOURCE ROOT | 运行包与可写源码根分离；R4 绑定 clean source commit `7ac6defc…`，修理 Worktree 仍须绑定 task、common-dir、HEAD 和精确范围；越界、错误归属和漂移失败关闭 | 后续修复仍只能生成新候选，不能直接改当前不可变 live |
| A君本机持久状态权限 | LOCAL PASS / REAL DATA UNTOUCHED | `task-store` 与飞书 completion watcher 使用唯一 tmp、`wx`/0600、原子 rename 和 rename 后 chmod；既有 0644 收敛到 0600，失败保留旧文件且不误删无关 tmp。对应测试 `15/15` | 仅在临时 fixture 验证；本轮未直接 chmod 真实数据 |
| A君不可变 Runtime Release | R4 ACTIVE | source commit `7ac6defc516085e5b9e8594eb5507617294c0689`；`releaseHash=7b90e666b5c11366a086e92895033be8c6f3a53b071aaf0e7cd207f7a7905277`、`payloadHash=e2a1aca014fc63d8c3d39f240a752a0e582c46020a28e96fce1258ed038094aa`；main/recovery smoke 与 live PID/cwd/entrypoint 均通过 | r3/r2 仅为历史候选；活动和 Publisher 未随切版启用 |
| A君上一版不可变 Runtime Release | HISTORICAL R2 / NOT CURRENT | source commit `33aa25bd7ff7431d64467fca87866d299caa9857`；候选路径 `work/m5-runtime-releases/m5-8point-20260731-r2/ajun-runtime-release-v1-1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef/`；`releaseHash=1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef`、`payloadHash=7bd23d48db1f66583d854a28d420498e60e884e261a10171c4767e818156c910`、`entryCount=7571`、`manifestSha256=102daa78172a8857e7151d1a619d6868fb30f97cad1b48e8751ca93b5feb128c`、独立全目录哈希 `efc8967c6662b645f3018c0b6386231006f21b45f561a932e88df03799eb4b88`；隔离启动 `/api/overview` 200，SIGTERM 后确认退出 | 不含 r3 的学习、双变体与恢复硬化；不是当前候选，也不能作为 live exact rollback 身份 |
| Runtime 恢复 | DEGRADED LIVE EXERCISED / EXACT UNAVAILABLE | R4 的 `verified_degraded_fallback` plan 为 ready，独立 recovery entrypoint 已实际接管 4321 并证明无外部效果、无写路由；随后生产切换成功 | 仍没有 exact previous live 身份；旧脏源码 plist 只作审计备份 |
| Paperclip 待办清理 | PARTIAL | 已将 153 条带确定 Routine 标记的历史巡检失败和 9 条历史验收记录归档为 `cancelled`/hidden，保留评论与证据且未删除；当前分页读取为 83 条，其中 active_incident 16、unresolved 67 | 16 条真实故障与 67 条未决任务仍保留负责人和恢复动作，不能宣称清空 |
| Paperclip live apply | PASS / CAMPAIGN PAUSED | live v2 为 Goal `0363da03…`、Project `86ad0a0a…`、17 个有效 Routine、15 阶段 Pipeline `6dfd94da…` 及 5 个 HTTP 系统控制器；旧 `m5-research` 已作为从未触发的归档记录保留，不计有效 Routine。活动 `8dd29a3b…` 当前 `paused`、无 active work，M5 每日 Cron 关闭 | 分层预算不能相加；保守 `cost-events` 不等于 StepFun 官方最终账单；暂停不等于删除或从未批准 |
| 插件安装 | LIVE 0.4.9 READY / HEALTHY | `/api/plugins` 显示 `agent-army.content-autonomy` live `0.4.9`、`ready`，packagePath 与 worker 进程均指向 `content-autonomy-bundle-0.4.9-b64760f6…`；`/health` 返回 `ready/healthy`，对象形 Secret Reference 有效且未回显 Secret 值。不可变包 `payloadHash=b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d`、`entryCount=19986`、`manifestSha256=dabf16ac255eec3348e5800239f907793db1c1e507d1aa2820cd57fb71ec8dd7`、独立全目录哈希 `82f75845b927c8fa817e45e8e4d588338c7131677f2681c7297dba987db0c8bd`。`0.4.6` 回滚兼容链保留，回滚脚本及测试已改指向 `0.4.6`；`0.4.7` 本地包删除 | live 版本与安全门禁已对账；仍没有因此触发 Provider、恢复活动或授予发布权限 |
| Hermes Profile 历史精确同步 | HISTORICAL STEP FUN BASELINE | 2026-07-31 曾将 11 个正式 Profile 同步到 StepFun、岗位 MCP 作用域和精确 Feishu toolset | 该 3.5 历史同步不代表当前 StepFun 3.7 live 主模型；当前状态以上方 2026-08-14 追加证据为准 |
| Hermes 技能白名单 | LIVE PASS / 11 CLEAN | 11 个正式 Profile 指定只读检查均为 clean，无额外 enabled skill、无声明技能缺失或被禁用；`xiaod` 原有 78 个额外技能保持 disabled，办公助理遗留 `feishu-doc` 已显式收敛并复验 clean | 微信取件员不属于 11 个正式内容岗位；技能包仍可保留在目录或备份中，但未授权技能默认不可用 |
| 岗位执行适配器 | LOCAL REAL-ADAPTER PASS / PROFILE CONFIG SYNCED | 小R动态网页用临时 Chrome、同源只读请求和 DNS 固定；公开 PDF 以固定 IP 流式读取，真实 2,215,244 bytes PDF 通过，超过 8MB 中止。开放研究及其路由/Routine 契约针对网页/PDF/GitHub、Observation 换路、预算/重试/重规划及 Work Product 回写的定向测试为 `29/29`；恢复来源必须匹配当前 assignment 的 Issue/Run，任务自报与跨 Issue/Run 内嵌 Observation 注入均失败关闭。小办 DOCX/XLSX/PDF 已真实生成回读；Markdown 外部资源、本机偷读和符号链接越界写入均拒绝。11 个实际 Hermes Profile 已完成精确同步并 post dry-run `0 drift` | 受控本地/公开读取、文档生成和 Profile 配置均有证据，但当前 A君 `4321` 尚未重启加载本轮源码；登录型网页、外部发送和业务闭环仍未证明 |
| One-shot 与正式视觉边界 | LIVE CODE LOADED / PROVIDER NOT EXERCISED | 内容插件固定视觉模型 `step-1o-turbo-vision`、生图/改图模型 `step-image-edit-2`、TTS 模型 `stepaudio-2.5-tts`。通用 Hermes one-shot 已移除 `--ignore-rules`，普通调用固定为 `clarify`，只有无 Provider 的受控故事板分支允许 `vision`。正式视觉仅由当前 Paperclip Run 的单用途回调触发，绑定固定 action、相对 PNG、帧哈希、时间点、confirmed receipt 和同一 Project；新产物与已有视觉 Work Product 重放都使用同一校验，漂移时阻塞且不覆盖。渲染强制消费可信 `GeneratedImagePackage`，机器审核反查同 Project 的图片、视觉、TTS 三条 confirmed action/cost | `0.4.9` 已由 live 加载，但尚无真实 M5 Campaign StepFun 视觉调用；加载代码不能替代 Provider 或业务验收 |
| 工具执行身份 | LOCAL COMPAT PASS / LIVE NOT APPLIED | `/api/tool-executions` 的应用层契约只接受与 canonical Case 当前运行中 Agent/Company/Run 一致、有效期不超过 2 小时的 Paperclip Run JWT；版本锁定 `forwardRunJwt` 兼容补丁与一次性恢复 Approval 补丁合并定向测试 `15/15`。controller cutover 工具 `15/15`；其快照读写 TOCTOU 已改为同 fd、`O_NOFOLLOW`、dev/ino 复验、原子 no-replace 发布和固定原目录身份的清理器。A→B symlink、发布前父目录替换及 post-link 父目录替换均失败关闭；最后一种确认原目录/替代目录无残留且 0 Paperclip PATCH，清理不完整标记 `recoveryRequired`。ready/cleanup/close 均有硬超时；SIGSTOP 和不响应 close 均会 TERM、KILL 并确认退出，独立红队确认无子进程或监听器残留 | live Paperclip HTTP adapter 仍是原始文件，控制器 adapterConfig 未启用 `forwardRunJwt`；当前只证明可审计、可回滚的本地兼容实现 |
| 本地 chaos | LOCAL FAKE PASS | 定向测试 `4/4`；15 阶段成功路径、并行峰值 4、一次安全重试、检查点恢复、一次 `request_changes`、预算硬停后受控恢复、Fake 发布幂等和 2h/24h/72h 三次模拟指标通过；账本扫描 318 个节点，未发现凭据或绝对路径 | `mode=local_fake_only`、`externalEffects=false`、`paidCalls=0`；不证明 live Case、真实 Provider、真实平台或现实 72 小时运行 |
| Fake 全链 E2E | LOCAL PASS / NO EXTERNAL EFFECT | `5/5`；完整纵切从草案、选题、五分支 `[4,1]` 波次、脚本、渲染、退回、审核、Fake 发布进入 2h/24h/72h 模拟指标、复盘和 done；另 4 条直接验证真实无模型协调器的前置依赖、全局并发 4 和健康 Work Product 汇聚 | `externalEffects=false`、`paidCalls=0`；本地内存 Paperclip 和 Fake 平台，不证明 live、StepFun 或真实平台 |
| 7 天真实 MP4 → Fake Publisher | LOCAL PASS / SIMULATED CLOCK | `work/m5-publisher-gateway/acceptance/fake-seven-day-2026-07-31-v1/` 使用 14 支真实本地 MP4 生成 14 个 fake PublishReceipt、42 个 2h/24h/72h 模拟 MetricSnapshot；44 次 Runtime 重建后幂等重放同一 72h 快照。`realPlatformTouched=false`、`externalPublished=false`、`realPlatformCalls=0`、`totalCostUsd=0` | `actualPlatformElapsedTime=false`；不等于真实等待 72 小时、真实平台指标或真实发布 |
| 本地运行 | LIVE / CAMPAIGN PAUSED | Paperclip `127.0.0.1:3100/api/health` 为 200；A君 `4321/api/overview` 为 200；内容插件 `0.4.9` worker 存活；Publisher `4390/health` 仍为 `disabled`；Paperclip 15/17/5 对账保持 | 活动当前暂停、M5 每日 Cron disabled、真实连接器未启用；A君没有 `/api/health` 路由 |
| 运维巡检 | PASS | “A君定时本机巡检”修复后连续 3 次受控手动 Routine Run 为 `completed`，并已观察到至少 1 次修复后自然定时 `completed` | 更早失败按历史保留 |
| StepFun 3.5 文本 | HISTORICAL PROVIDER PASS | 11 个正式 Profile 曾以 `step-3.5-flash-2603` 完成无副作用实调用 `11/11`，均返回精确文本 `M5_OK`；DeepSeek 0 次、无业务外部副作用。证据：`artifacts/2026-07-31-stepfun-text-probes.json` | 只证明当时的 3.5 文本传输，不证明当前 3.7、复杂任务、多模态或回退 |
| StepFun 3.5 复杂岗位任务 | HISTORICAL STRUCTURE 11/11 / SEMANTIC 11/11 / CROSS PASS | `video-content-analyst` 使用 `step-3.5-flash-2603`，18 项结构和语义门禁为 `18/18`，从而11个岗位全部通过。Cross 首次失败关闭后安全重试为 `19/19`；最终 `summary.status=passed`、`rolePassedCount=11`、`crossRoleStatus=passed`。此次新增 1 次 video 和 2 次 Cross 调用，工具调用 0、`externalSideEffects=0`；语义门禁与提示契约自测为 `72/72` | usage 的 `cost_status=unknown` 必须保留；这些历史证据不证明当前 StepFun 3.7 主传输、真实 M5 Campaign 视觉、平台发布或业务外部闭环 |
| StepFun 多模态 | HISTORICAL PROVIDER LEDGER PASS / NO NEW CALL | 旧 `m5v2` 账本 `status=succeeded`：35 个 action-linked 费用记录合计 42 美分，`confirmedReplay=35`、`lifetimeProviderCalls=43`。本轮 Provider 请求/调用均为 0、没有新增费用或 `cost-event`；公司与 Project 累计仍为 392 分 | 42 美分是旧保守项目账本，不是 StepFun 官方最终账单；本轮没有新增付费调用，也不证明真实平台发布 |
| 指标回流 | R4 BINDING LOADED / PIPELINE OFF | 2h/24h/72h、独立指标 approval、current-run scope 与 `PaperclipBridge` 六项核心 access 已由 R4 加载；发布与指标 runner/Profile 隔离 | Paperclip 原始 `2026.722.0` 的兼容补丁未 apply，R4 connector dependencies 为空并失败关闭；尚无真实 PublishReceipt、平台指标或人工核对 |
| 生产 readiness | READ-ONLY / NOT READY | `npm run production:readiness` 固定检查 4390 health、Campaign snapshot、selector 安全、Profile lease 引用和 provider 注入；无 snapshot 输入时为 `not_ready`、退出码 `2`，机器建议动作 `provide-campaign-status-snapshot` | 不读 `.env`/Secret，不启动服务、不批准 Campaign/Cron，不等于生产启用 |
| 发布写回 | LIVE CONTROLLER / NO REAL RECEIPT | publisher 控制器与 Routine 已接入 live；production Runtime 覆盖注入式抖音官方 API 与 CUA；账号、日期、预算、幂等和强成功证据均在写回前硬校验；standalone 4390 禁止 real，真实入口只保留 A君逐请求刷新 Paperclip 批准的惰性路径 | live Publisher 为 `disabled`，没有真实连接器、平台内容 ID 或真实回执 |
| 复盘学习 | LIVE CONTROLLER / NO REAL SAMPLE | retrospective 控制器与 Routine 已接入 live；只接受标准信任的同平台 72h `MetricSnapshot`，少于 5 条写 `insufficient_sample`，达到 5 条才附带 `proposed` LearningProposal | 无真实样本；不会自动修改 Prompt、权限、频率或投流，离线回放、审核和灰度均未执行 |
| 本地成片与原生血缘 | LOCAL PRODUCTION RENDER + LINEAGE PASS / NO PUBLISH | 上游已直接生成 lineage；`native-artifact-smoke` 以 Provider 0 完成 1/1 份原生 lineage 和 3/3 支平台媒体，均为 45 秒、1080×1920、H.264/AAC、黑帧 0、-15.1 LUFS。历史 `m5v2-lineage-v2` 仍以 Provider 0 保留 7/7 份 lineage 和 21/21 支媒体复核，响度 -15.2 至 -14.9 LUFS；原 `m5v2` 保留 7/7 review、63/63 固定产物 hash/bytes 与 t04 八点人工抽帧证据；另有 3 主题、9 视频 dry-run `12/12` | 全部 `externalPublished=false`；证明本地成片与血缘，不证明真实平台发布、PublishReceipt 或指标回流 |
| 控制台 | BROWSER PASS | 桌面、中间宽度和 390px 真实浏览器中均能看到 1 个草案、`0/14`、费用、下一步、恢复位置和唯一授权按钮；390px 无横向溢出，浏览器无相关 error/warn | 未点击授权按钮，未启动活动 |
| Computer Use | DIAGNOSTIC FIX PASS / PRODUCTION APPROVAL PENDING | CuaDriver `0.17.0`；Accessibility 与 Screen Recording 均为 `true`，`doctor` 正常。runner 会保留真实 `browser_consent_required`，并使用只读语义查询与唯一标题/详情 URL 强回执门禁 | 当前网址的 Computer Use 操作受限；真实 selector、Profile lease 与 production Runtime 回执仍未验收 |
| 抖音/小红书 | NOT AUTHORIZED | 现有连接仅为读取权限 | 发布账号、时间窗和写授权 |
| 7 天活动 | NOT STARTED | 需先完成上述门禁 | 14 次发布与指标回流 |

## 当前明确没有发生

- 内容插件 live 已升级为不可变净包 `0.4.9` 并处于 `ready/healthy`，`0.4.6` 回滚兼容链保留，`0.4.7` 本地包删除；这没有恢复活动或授予平台写权限；
- 公司级配置使用对象形 Secret 引用并完成 8 岗 `agentRoleBindings`；门禁只读元数据，
  不解析或回显 Secret 值；
- 已创建 1 个活动草案，但没有批准；`approvedAt=null`、进度 `0/14`，Cron 没有启用；
- 已归档 153 条历史巡检失败和 9 条历史验收记录；操作为取消/隐藏并保留证据，没有删除记录；
- 没有读取或回显 StepFun Key；
- 内容插件旧 Provider 账本包含 35 个 action-linked 费用记录、合计 42 美分和
  `lifetimeProviderCalls=43`；本轮没有新增 Provider 请求、调用或费用。13 条分层 M5
  Budget 策略继续执行同一硬上限，公司与 M5 v2 Project 累计仍为 392 分（剩余 233 分）。
  Paperclip `cost-events` 是保守项目成本，不等于 StepFun 官方最终账单；
- 没有操作抖音或小红书真实发布页面；7 天 Publisher 验收只使用本机 Fake connector。
  Computer Use 的诊断误报已修复，但完整本地假页仍因缺少当次五分钟单次 token 而未运行；
- 抖音官方 API connector 已贯穿 production Runtime/composition 与 A君可信惰性 provider；open_id 只以 SHA-256 交给 Paperclip 背书的账号核验器，并在任何 HTTP 前拒绝错账号。live A君仍未注入 production provider，Publisher `4390` 仍为 `disabled` 且真实连接器为零；测试中的官方响应均由依赖注入的假 HTTP 提供，平台内容 ID不是外部证据；
- Paperclip live 仍是 15 阶段、17 个有效 Routine 和 5 个控制器；A君 R4 已加载 16/18/6 代码，但 Paperclip 资源尚未
  apply。历史曾执行过受控 StepFun Provider 生产，本轮没有新 Provider 调用，也没有批准活动、
  启用 Cron 或发布；
- v2 的15阶段/17有效Routine/5控制器已安全克隆到 live；从未触发且无引用的旧
  `m5-research` 已归档并保留记录；归档后的只读对账为转换 16/16、blocker 0。旧 Pipeline、22个 Case、
  Issue 和 Work Product 保留，旧草案只增加 supersedes 血缘并进入 cancelled；
  新旧每日 Cron 都保持关闭；
- 没有真实 `PublishReceipt`、真实平台 `MetricSnapshot` 或基于 5 条真实同类内容生成的 `LearningProposal`；
- 当前 4321 的 PID `58141` 从 R4 不可变 release 运行，能返回既有 v2 Pipeline ID/key 和新草案；
  Cron 与外部写入仍未启用；
- 对每日 heartbeat 的 `campaignId` 伪造、指标 heartbeat 的 `receiptId` 伪造、
  未授权工具调用和活动批准预检都在 live 运行时返回 422；修复 Paperclip typed
  env 解析后，对象形 Secret 引用和 8 岗绑定已完成；新 v2 草案仍为
  `draft / approvedAt=null / 0/14`；
- CuaDriver 已升级，辅助功能与屏幕录制均为 `true`，`doctor` 正常；受控 runner
  已实现但默认关闭，并已修复把 `browser_consent_required` 误报为
  `prepared_browser_pid_missing` 的诊断错误。完整本地假页仍需要当次生成、五分钟有效、
  单次使用的 browser approval token；当前没有该 token，因此没有执行完整页面动作，
  更没有执行真实平台发布动作。
- Publisher 仅允许即时发布：`scheduledDate` 必须等于 `Asia/Shanghai` 当前执行日；
  历史或未来日期在读取产物、凭据和调用 connector 前拒绝，并返回重排恢复动作。

## StepFun 七主题历史 Provider 证据

- 最终账本：`work/m5-content-autonomy/provider/7-theme/m5v2/ledger.json`，
  `status=succeeded`
- 主题数：7；action-linked 费用记录数：35；合计 42 美分；
  `confirmedReplay=35`、`lifetimeProviderCalls=43`
- 本轮复核：`providerCalls=0`、`providerRequests=0`、`pendingCostRecovery=0`，
  没有新增多模态费用事件
- t04 选择候选 2；机器记录 `textFree=true`、`brandSafe=true`、`personFree=true`，
  并完成人工复核
- 两份失败账本与最终成功账本共同保留恢复证据，不删除、不覆盖
- 当前边界：七主题母版/抖音/小红书 21/21 支本地视频已经完成；活动仍为草案，
  Cron 关闭，`externalPublished=false`，没有真实发布

## 原生血缘与 StepFun 七主题本地成片证据

- 原账本：`work/m5-content-autonomy/stepfun-seven-theme-render/m5v2/ledger.json`
- 原生血缘迁移：`work/m5-content-autonomy/stepfun-seven-theme-render/m5v2-lineage-v2/`
- 新内容上游已直接生成 lineage，不再要求事后迁移；`native-artifact-smoke` 以
  Provider 0 完成 1/1 份原生 lineage 和 3/3 支平台媒体，均为 45 秒、1080×1920、
  H.264/AAC、黑帧 0、-15.1 LUFS
- 历史迁移仍以 0 Provider 调用完成 7/7 份 `lineage.json` 和 21/21 支视频复核；
  7 个主题各包含母版、抖音版和小红书版
- 机器复核：7/7 份 `review.json` 为 `passed=true`、`externalPublishAllowed=false`；
  21 支视频均为 45 秒、1080×1920、H.264/AAC，无检测到的黑帧，综合响度
  -14.9 至 -15.2 LUFS
- 固定产物：每主题 9 项，共 63/63 项；所有 manifest 登记的字节数与 SHA-256
  已独立复算一致，7 份 manifest 自身哈希也与总账本一致；没有 `.raw.mp4` 残留
- 平台适配：每主题的抖音与小红书文案 JSON 均不同，不是同一文案直接复制
- t04 人工复核：最终母版在 3/9/15/21/27/33/39/44 秒按原分辨率抽帧，新的
  StepFun 抽象工作台画面和仓库自有界面画面均无人脸；临时抽帧已清理
- 来源与费用边界：总账本引用的 Provider 生产账本哈希复算一致，
  `voiceProvider=StepFun official TTS`、`productionTtsVerified=true`；
  渲染复用已验证素材，没有触发新的 Provider 调用
- 外部边界：`externalPublished=false`，没有访问真实抖音或小红书发布页面，
  没有真实 `PublishReceipt` 或指标

## 7 天真实本地 MP4 输入的 Fake Publisher 证据

- 证据目录：`work/m5-publisher-gateway/acceptance/fake-seven-day-2026-07-31-v1/`
- 输入为 7 个主题、14 支机器审核通过的真实本地平台 MP4；Fake Runtime 产生
  14 个 `fake://` 回执、42 个 2h/24h/72h 指标快照，并在 44 次 Runtime 重建后
  幂等重放同一份 72h 快照
- 验收明确记录 `timeline.kind=simulated_checkpoints` 和
  `actualPlatformElapsedTime=false`；2h/24h/72h 是注入时钟模拟检查点，不是现实中
  已等待 72 小时，也不是平台真实指标
- 14 次发布授权断言全部通过、无暂停、无重复发布；`realPlatformTouched=false`、
  `realPlatformCalls=0`、`externalPublished=false`、`totalCostUsd=0`

## 本地历史成片证据

- 有效账本：`work/m5-content-autonomy/local-dry-run/2026-07-30T19-58-12-831Z/ledger.json`
- 主题数：3；视频数：9；dry-run `12/12`；`externalPublished=false`；
  `paidProviderCalls=0`
- 机器复核：9 支视频均为 45 秒、1080×1920、H.264/AAC；黑帧检测均为 0；综合响度为 -14.9、-15.1 或 -14.9 LUFS
- 视觉素材：4 张仓库自有设计预览图先规范化为真实 PNG；三版 props 都绑定
  `coverSrc`、逐场景 `imageSrc` 与 `assetLedger + sha256`，机器复核为
  `checkedPlatforms=3`、`checkedAssets=4`、`rightsBasis=repository_owned_design_previews`
- 视觉抽检：3 个主题封面和首屏均能看到实际截图、来源标记、标题、字幕安全区和进度条
- 固定产物：每主题的 `artifact-manifest.json` 只登记
  `master.mp4`、`douyin.mp4`、`xiaohongshu.mp4`、双平台文案、`cover.png`、
  `sources.json`、`review.json`、`lineage.json`；独立重算为 27/27 文件哈希及字节数一致
- 失败闭锁证据：`2026-07-30T07-27-47-857Z` 首轮真实视觉干跑只因字幕安全宽度失败，
  没有生成总 `ledger.json`，修复为最多 3 行后才产生上述有效账本
- 旧目录 `2026-07-30T04-19-26-663Z` 是纯文字模板成片，不能再作为“真实混剪”
  或本轮 `LOCAL VISUAL-FIXTURE PASS` 证据
- 音频边界：`voiceProvider=macOS system voice`、`productionTtsVerified=false`；
  该运行不等于 StepFun TTS 真实调用

## 本轮复核命令

```text
cd integrations/paperclip/plugins/content-autonomy && npm test && npm run check
# 0.4.9 源码为 97/97，check 通过；live API、健康检查和 worker 路径均已对账到 0.4.9；
# 这不替代真实 Campaign StepFun Provider 调用或平台发布验收

cd integrations/paperclip && node --test test/*.test.mjs
# 48/48，通过；只证明本仓库 Paperclip 维护、兼容与迁移契约

cd integrations/paperclip/m5-content-pipeline && npm test && npm run validate && npm run dry-run
# 当前源码契约目标为 16 阶段、18 个 Routine（17 阶段/分支 + 1 daily）和 6 个控制器；
# 当前 Pipeline 结果 67/67；A君 R4 已激活，Paperclip 新资源未 apply
npm run test:fake-e2e
# 5/5，通过；完整纵切与真实无模型并行协调器，零外部效果、零付费

cd integrations/publishing/m5-publisher-gateway && npm test && npm run check
# 203/203，通过；覆盖 Fake、独立服务、默认关闭的 CuaDriver runner、注入式
# 抖音官方 API、账号/日期/预算/幂等/强证据、独立小红书指标链；没有真实外发
npm run acceptance:fake:seven-day -- \
  --confirm I_ACCEPT_LOCAL_FAKE_MP4_ACCEPTANCE \
  --output <新的本地证据目录>
# 当前证据：14 个 fake receipt、42 个模拟快照、44 次 Runtime 构造重放；
# realPlatformCalls=0、totalCostUsd=0

## 2026-08-05 自媒体内容方法与公众号草稿候选

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 内容契约 | PASS / LIVE LOADED | `@agent-army/m5-contracts` 13/13；四渠道、简报、六项质量门、标准指标、公众号草稿 schema；已进入 commit `44515e0…` 对应不可变 release | 不证明真实岗位模型输出的人工作品质量 |
| 岗位执行 | PASS | A君内容增长 22/22、小R 8/8、复盘 5/5、Manifest 16/16 | 不证明真实模型输出的人工作品质量 |
| Publisher | PASS / EXTERNAL OFF | `@agent-army/m5-publisher-gateway` 214/214；其中公众号草稿 11 条覆盖默认关闭、惰性构造、双授权、批准账号绑定、预算硬停、文件租约、幂等、脱敏、外部成功但回执落账失败的暂停，以及禁止重试 | 依赖注入假 CLI；无真实 Wenyan、公众号或 Media ID |
| 运行时 | LIVE PASS | 干净源码 commit `44515e0619ac3ba6ca853923c473b1c2fa9b930c`；A君全量 `1108/1108`。冻结 release `e3b7ae7b…`、payload `fbbc1495…` 的主入口与只读恢复 smoke 通过；切换后受控重启 PID `14873 → 15283`，cwd/entrypoint 指向新 release，`/api/overview=200`，任务/审批 `744/25`；Paperclip 正常，Publisher 仍 `disabled` | 不代表 Hermes Profile 提示词已外部同步，也不证明真实公众号写入 |
| 外部平台 | NOT AUTHORIZED / NOT CHECKED | 未读取 Secret，未调用公众号，未创建草稿或群发 | 需测试账号、Paperclip 批准、IP 白名单和一次明确草稿写入授权 |
| 人工验收 | WAITING | 代码行为已固定为 `externalPublished=false`、`groupSent=false` | 仍需公众号后台预览正文、图片、主题和链接 |

当时下一步（历史）：保持现有 Campaign、Cron、Publisher 和公众号连接器关闭。只有负责人另行批准测试账号的一次“创建草稿”后，才配置 Wenyan、Paperclip accountRef/Secret Reference 和 IP 白名单，并在公众号后台人工预览，禁止群发。

cd apps/ajun-runtime
node --test test/paperclip-bridge.test.js test/paperclip-retrospective.test.js \
  test/production-control-plane-boundary.test.js test/local-content-growth.test.js
# 保留定向复核命令；全量结果见下一项

node --test agents/test/agent-manifest.test.mjs
# 15/15，通过

cd apps/ajun-runtime && npm test
# 1051/1051，通过；R4 冻结与 live PID/cwd/entrypoint 另有运行态证据

node --test test/runtime-source-root.test.js \
  test/isolated-repair-workspace.test.js \
  test/technical-repair-promotion.test.js \
  test/technical-repair-evidence-relay.test.js \
  test/local-technical-expert.test.js \
  test/task-service.test.js
# 139/139，通过；外置源码根、隔离副本、promotion 回滚和
# candidate awaiting release 口径均失败关闭

node --test test/task-store.test.js \
  test/official-feishu-completion-watcher.test.js
# 15/15，通过；唯一 tmp、wx/0600、原子 rename、rename 后 chmod，
# 既有 0644 收敛，失败不破坏旧文件或无关 tmp；未直接 chmod 真实数据

node --test test/immutable-runtime-release.test.js \
  test/runtime-source-root.test.js
# 18/18，通过，其中不可变 release 专项 11/11

node --test test/m5-local-chaos-acceptance.test.js \
  test/open-task-routing.test.js test/open-task-runtime-wiring.test.js \
  test/m5-route-execution.test.js test/m5-routine-execution-contract.test.js \
  test/paperclip-metric-recovery-access.test.js
# 38/38，通过：chaos 4、开放研究及路由/Routine 契约 29、current-run 恢复 provider 5；
# 均为本地证据；恢复 provider 后续已 wire 到源码 composition，但未加载到 live

cd ../../integrations/paperclip/m5-content-pipeline
node --test test/controller-run-jwt-cutover.test.js
# 15/15，通过；含 A→B symlink、发布前与 post-link 父目录替换 TOCTOU 零副作用拒绝，以及清理器三类卡死的有限时退出
node --test
# 67/67，通过

cd ../../../apps/ajun-runtime
node --test test/m5-server-publisher-composition.test.js \
  test/paperclip-metric-recovery-access.test.js \
  test/m5-publisher-bindings.test.js \
  test/paperclip-publisher-run-context.test.js \
  test/paperclip-metric-monitor.test.js \
  test/production-control-plane-boundary.test.js
# 43/43，通过；源码 composition 已接线，live 仍关闭

cd ../../integrations/paperclip
node --test test/paperclip-2026-722-http-run-jwt.test.mjs \
  test/paperclip-2026-722-recovery-approval.test.mjs
# 15/15，通过；版本锁定兼容补丁尚未 apply 到 live

cd apps/animated-chart && npm run lint && npm run render:m5-local
# ESLint/TypeScript 通过；3 个主题、9 支视频 dry-run 12/12，
# externalPublished=false、paidProviderCalls=0

cd integrations/paperclip/plugins/content-autonomy
npm run lineage:migrate-rendered-stepfun -- \
  --source-ledger ../../../../work/m5-content-autonomy/stepfun-seven-theme-render/m5v2/ledger.json \
  --output ../../../../work/m5-content-autonomy/stepfun-seven-theme-render/<新的lineage目录>
# 当前证据：native-artifact-smoke 为 0 Provider、1/1 原生 lineage、3/3 媒体；
# 历史 m5v2-lineage-v2 为 0 Provider、7/7 lineage、21/21 媒体复核

node --test integrations/paperclip/test/classify-blocked-pending-issues.test.mjs
# 8/8，通过；覆盖四类优先级、负责人、唯一恢复动作、脱敏、loopback 限制、GET-only 分页及受控 apply 门禁

node integrations/paperclip/scripts/classify-blocked-pending-issues.mjs
# 本机只读快照：83 条；3 个 GET，0 个写请求，0 个应用动作

cua-driver manifest
cua-driver permissions status --json
cua-driver doctor
# binary_version=0.14.1；accessibility=true；screen_recording=true；doctor 正常
```

## 2026-08-05 小红书受控真实发布冒烟

| 项目 | 事实 | 边界 |
| --- | --- | --- |
| 授权 | 负责人先批准上传测试视频且不发布；完成表单核验后，再单独明确批准发布当前测试内容 | 只覆盖这一次小红书测试发布，不批准 Campaign、Cron、后续内容或抖音 |
| 输入 | 隔离命名 Profile 已登录；上传 1 秒、640×360、H.264 的合成黑色视频；标题为 `M5受控发布测试-请勿发布`，正文为测试说明并带 `#M5测试` | 不含生产素材、Secret、Cookie 或位置数据；小红书位置权限选择“一律不允许” |
| 提交 | CuaDriver exact 绑定下唯一“发布” ref 只点击一次，返回 `status=ok`；随后只读轮询，不重复提交 | 不是 Publisher Gateway production Runtime，也没有生成仓库 `PublishReceipt` |
| 平台回执 | 创作页跳转到 `/publish/publish?source=&published=true`；笔记管理精确命中同标题，内容 ID `6a72ddf8000000002201484e`，时间 `2026-08-05 14:53 Asia/Shanghai`，状态“审核中” | 证明平台已接受写入并分配内容 ID；尚不证明公开审核通过或指标可读 |
| 本地兼容 | 真实页暴露文件 input 无可访问名称、正文为唯一 `div role=textbox`；runner 已补唯一 ref 失败关闭与标签追加 | 已由前次真实页面验证，未重复发布 |
| 结果回读候选 | `read_result` 可只读跳转笔记管理，仅点击标题完全一致且唯一的详情入口，并组合列表中的平台状态与详情 URL 中的内容 ID；跨域、重复标题、缺状态或缺 ID 均硬停，发布按钮仍只允许一次。Publisher 全量 `221/221`、`npm run check`、`git diff --check` 通过 | 只证明候选源码和 fixture；受限网址无法再次通过 Computer Use 验证，且没有获批 selector/Profile lease 或 production Runtime `PublishReceipt` |
| CuaDriver | 官方发布脚本 SHA-256 与 v0.17.0 release 一致后，由 `0.14.1` 更新到 `0.17.0`；守护进程已恢复，Accessibility 与 Screen Recording 均为 `true`，语义快照/点击/导航工具仍存在 | 官方 0.16/0.17 主要增强语义路由和原生桌面安全，不新增 DOM 任意属性读取；未借升级绕过平台或网址限制 |
| selector / Profile 审批准备 | 根据负责人提供的真实创作页截图、已保存的单次冒烟回执和当前 CampaignGrant，生成候选 `xiaohongshu-1.1.0`；Paperclip `AGE-949` selector 冻结审批和 `AGE-950` Profile lease 审批已由负责人批准。selector 已冻结为 `0444` bundle/manifest，冻结文件与候选逐字节一致，规范哈希和文件哈希均匹配；Profile lease 校验通过 | 冻结不启用 Publisher、Cron 或发布；production Runtime 仍未构造 |

最新只读 production readiness：selector candidate/frozen 与 Profile lease 均安全通过；Campaign 当前因“指标回流后置、先完成本地门禁”而暂停，4390 仍为 `disabled` 且未注入 production provider，因此总判定仍为 `not_ready`。恢复 Campaign、注入 provider 或启用 Publisher 均需另行授权。

当时下一步（历史）：保持 Campaign、Cron 和 Publisher 关闭；若负责人决定继续 production Runtime 验收，先单独授权恢复 Campaign，仍不得据此发布。不得把本次人工冒烟或本地 fixture 写成 M5 完成。

## 2026-08-06 小红书静态卡本地候选验收

| 项目 | 结果 | 证据与边界 |
| --- | --- | --- |
| 契约 | LOCAL PASS | 新增 `agent.army/social-card-package/v1`；`SocialCardPackage` 只作为现有 `RenderPackage` 的嵌套产物，Pipeline 阶段和控制器数量不变 |
| 工具门禁 | LOCAL PASS | `social-card-render` 只接受 3–9 页固定 `cover/evidence/checklist`、受限文本、可信图片账本、版权依据与模板哈希；拒绝越界图片、素材哈希漂移和覆盖既有产物 |
| 自动化 | LOCAL PASS | 内容插件 `100/100`、M5 contracts `13/13`、M5 kernel `13/13`、A君 Runtime `1146/1146`，架构检查通过 |
| 真实渲染 | LOCAL PASS / HUMAN REVIEWED | `work/m5-social-card-acceptance-20260806-e/candidate/social-cards/` 的 3/3 PNG 均为 1080×1440；props、manifest、每张卡均有 SHA-256；人工复核封面、证据页和清单页无裁切 |
| 外部状态 | UNCHANGED | 使用仓库自有图片和本机 Chrome；无 Provider 调用、无平台访问、无发布。Campaign/Cron/Publisher 未启用，live 插件仍为 `0.4.9` |

本次验收只证明 `0.5.0` 候选源码、自动化和本机静态输出。它不证明 live 已安装、不批准恢复 Campaign，也不授权任何发布动作。

## 2026-08-07 视频分析四模式单版本验收

| 项目 | 验收条件 | 当前证据边界 |
| --- | --- | --- |
| 统一契约 | `analysisIntent=digest|deep|template|style` 贯穿客户端、任务服务、MCP、Mission 和飞书；旧 `depth` 保持兼容 | 以 A君定向测试、全量测试和实际运行态回执分别记录，不能用源码替代 live |
| 素材复用 | 首次 URL 建立“小D获取 → 小拆分析”；后续模式切换携带原来源任务编号，只新增分析任务 | 不得重新下载、转写或抽帧；来源任务和确认稿校验值应在报告中可追溯 |
| 四类输出 | 精华提炼满足短摘要和原文引用；深度拆解保留 13 模块并区分事实/推断；模板只称候选；风格返回四个 150–250 字事实锁定短样稿 | 未确认机器稿只能初步分析，不能进入小创 |
| 指标学习 | 平台、内容 ID、发布时间、内容版本和至少五条同类 72h 样本齐全时才生成待审核 `LearningProposal` | 永不自动改 Prompt、模板、频率、投流或权限 |
| 外部边界 | 分析、模板和风格结果只提供人工下一步 | Campaign、Cron、Publisher 与真实平台写入继续关闭；真实飞书仍需负责人消息验收 |

### 实际验收结果（2026-08-07 21:49 CST）

| 层级 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 主工作区与隔离发布源码的 A君 均为 `1187/1187`；Manifest `18/18`；架构边界通过；Hermes 外层失败回退覆盖合格报告、深度待测试、证据拒绝和非视频隔离 | 不替代真实飞书或真实模型调用 |
| 首次不可变验收包 | PASS | 代码快照 commit `0e2fdd400debef07da177fa5cfb5d4ac1a58ecbb`；`releaseHash=71aac0b41a699b7c6b4e759a6f689d06aba2b64f6fdc03ebd5efed2a18128d34`；`payloadHash=936401150f920b7c828f984e9a4a11291c90f0e21e681bb7be7084d481c359af`；`entryCount=7104`；主入口与只读恢复 smoke 通过 | 这是在线任务验收时的代码等价快照；最终 docs-bound release 以 launchd entrypoint 的 manifest 为准 |
| 首次在线运行快照 | PASS | 验收时 launchd PID `10571`，监听 `127.0.0.1:4321`，命令与 cwd 指向只读 release；`/api/overview=200`，11 个 Agent | PID 是历史快照；当前值须重新读取 launchd；运行时通过不代表外部飞书收发通过 |
| 真实任务 | PASS | 任务 `7d45ed66-e86a-4a08-8179-509939352593` 返回 `succeeded/local_evidence_fallback_ready`；报告为 `analysisIntent=digest`、`reportVersion=video-analysis/v2`、`generationMode=deterministic_fallback`，证据/模式/确认稿/800 字门禁均通过 | 该次验收时 Hermes Profile 凭据返回 401，因此未形成真实 DeepSeek 语义报告；安全回退已实跑 |
| 素材复用 | PASS | 来源任务 `c0636161-cb44-4449-81ee-9baa4e027570` 仍为 7 个来源产物；确认稿校验值保持 `96748e00c38e1fd8b05d3abba7946a5acd2bbc5f5b93f4bdbfde6d9f9adb5b92`；验收后新增媒体任务为 0 | 本轮只实跑 digest；其余三模式由自动化覆盖并复用同一契约 |
| 下游与发布边界 | PASS | 验收任务之后只出现该分析任务；小创、审核、Publisher 任务为 0；`AJUN_M5_PUBLISHER_MODE`、Campaign 和 Cron 启用项均未设置 | 不批准真实发布或活动启用 |
| 外部飞书 | NOT CHECKED | 本地解析与字段透传测试通过 | 必须由负责人在 A君 真实飞书会话发送一条带模式的视频任务 |

当前唯一外部下一步见 [视频分析四模式飞书验收交接](../../handoffs/current/video-analysis-modes-feishu-acceptance-handoff.md)。

## 2026-08-08 当前活动与只读 readiness 复核

| 层级 | 结论 | 当前证据 | 未证明部分 |
| --- | --- | --- | --- |
| 活动状态 | STOPPED | A君 `GET /api/content-campaigns` 返回活动 `8dd29a3b…` 为 `stopped`、进度 `0/14`，并明确“重新运行必须创建新的授权草案” | 不批准创建新草案或恢复活动 |
| Selector | PASS / READ ONLY | candidate 与 frozen 文件均为安全普通文件，内容 SHA-256 一致 | 不等于账号或页面仍匹配 |
| Profile lease | EXPIRED | Paperclip 引用格式安全，但批准有效期止于 `2026-08-06T15:59:59.999Z`；新门禁返回 `profile_lease_expired` | 没有申请或签发新 lease |
| Publisher / Provider | OFF | 4390 不可达，production provider 未注入，真实 connector 未配置 | 没有启动服务、读取凭据或访问平台 |
| 只读预检 | EXPECTED NOT READY | `npm run production:readiness -- --snapshot <绝对路径>` 返回 `not_ready`、退出码 `2`；阻断为 stopped Campaign、过期 lease、Publisher 未就绪和 provider 未注入 | 不构成发布授权 |

本轮修复了旧预检只验证 lease 引用格式、无法识别过期授权的缺口；同时将 stopped Campaign 的机器下一步固定为新建授权草案，禁止把旧批准当作 paused 活动恢复。全程无外部效果。
