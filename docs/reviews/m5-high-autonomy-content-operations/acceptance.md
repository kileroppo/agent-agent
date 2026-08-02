# M5 高权限内容自治验收

> 当前总判定：**PARTIAL / M5 NOT COMPLETE**。A君 R4 已以不可变 release 切入 live，PID `58141`、`/api/overview` 200；Paperclip 资源仍为 15 阶段 / 17 有效 Routine / 5 控制器，活动草案仍未批准且为 `0/14`，Publisher 仍 disabled。本轮没有真实 Provider 调用、外部发布或 7 天闭环。

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
| v2 clone cutover | LIVE PASS / CAMPAIGN OFF | live Pipeline `6dfd94da…`、Project `86ad0a0a…`、新草案 `8dd29a3b…`；没有分支引用且从未触发的旧 `m5-research` Routine 已归档并保留记录。归档后的只读 reconcile/dry-run 为 15 阶段、有效 Routine `17/17`、转换 `16/16`、blocker 0；旧 v1 Pipeline/22 Case 保留，旧草案 superseded/cancelled | 新草案仍为 `0/14`，Cron off；未批准活动，未运行真实内容阶段 |
| 自动化 | LOCAL PASS | A君 `1051/1051`、Pipeline `67/67`、内容插件 `97/97`、Publisher `203/203`，覆盖当前 16/18/6 源码候选、完整双变体、模板绑定、Publisher 六项 Paperclip 核心 access 与恢复失败关闭 | 只证明共享源码与本地 fixture；不证明 live、Provider、Computer Use 或平台发布 |
| A君源码根与技术修复 | R4 LIVE / CLEAN SOURCE ROOT | 运行包与可写源码根分离；R4 绑定 clean source commit `7ac6defc…`，修理 Worktree 仍须绑定 task、common-dir、HEAD 和精确范围；越界、错误归属和漂移失败关闭 | 后续修复仍只能生成新候选，不能直接改当前不可变 live |
| A君本机持久状态权限 | LOCAL PASS / REAL DATA UNTOUCHED | `task-store` 与飞书 completion watcher 使用唯一 tmp、`wx`/0600、原子 rename 和 rename 后 chmod；既有 0644 收敛到 0600，失败保留旧文件且不误删无关 tmp。对应测试 `15/15` | 仅在临时 fixture 验证；本轮未直接 chmod 真实数据 |
| A君不可变 Runtime Release | R4 ACTIVE | source commit `7ac6defc516085e5b9e8594eb5507617294c0689`；`releaseHash=7b90e666b5c11366a086e92895033be8c6f3a53b071aaf0e7cd207f7a7905277`、`payloadHash=e2a1aca014fc63d8c3d39f240a752a0e582c46020a28e96fce1258ed038094aa`；main/recovery smoke 与 live PID/cwd/entrypoint 均通过 | r3/r2 仅为历史候选；活动和 Publisher 未随切版启用 |
| A君上一版不可变 Runtime Release | HISTORICAL R2 / NOT CURRENT | source commit `33aa25bd7ff7431d64467fca87866d299caa9857`；候选路径 `work/m5-runtime-releases/m5-8point-20260731-r2/ajun-runtime-release-v1-1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef/`；`releaseHash=1c7f244ddaae055f336340ac0de566569012af3d39a6e66e8df528fda46ce0ef`、`payloadHash=7bd23d48db1f66583d854a28d420498e60e884e261a10171c4767e818156c910`、`entryCount=7571`、`manifestSha256=102daa78172a8857e7151d1a619d6868fb30f97cad1b48e8751ca93b5feb128c`、独立全目录哈希 `efc8967c6662b645f3018c0b6386231006f21b45f561a932e88df03799eb4b88`；隔离启动 `/api/overview` 200，SIGTERM 后确认退出 | 不含 r3 的学习、双变体与恢复硬化；不是当前候选，也不能作为 live exact rollback 身份 |
| Runtime 恢复 | DEGRADED LIVE EXERCISED / EXACT UNAVAILABLE | R4 的 `verified_degraded_fallback` plan 为 ready，独立 recovery entrypoint 已实际接管 4321 并证明无外部效果、无写路由；随后生产切换成功 | 仍没有 exact previous live 身份；旧脏源码 plist 只作审计备份 |
| Paperclip 待办清理 | PARTIAL | 已将 153 条带确定 Routine 标记的历史巡检失败和 9 条历史验收记录归档为 `cancelled`/hidden，保留评论与证据且未删除；当前分页读取为 83 条，其中 active_incident 16、unresolved 67 | 16 条真实故障与 67 条未决任务仍保留负责人和恢复动作，不能宣称清空 |
| Paperclip live apply | PASS / CAMPAIGN OFF | live v2 为 Goal `0363da03…`、Project `86ad0a0a…`、17 个有效 Routine、15 阶段 Pipeline `6dfd94da…` 及 5 个 HTTP 系统控制器；旧 `m5-research` 已作为从未触发的归档记录保留，不计有效 Routine。13 条 M5 Budget 策略覆盖公司、Project 和 11 岗，每条均为 625 分的同一分层硬上限；公司与 M5 v2 Project 累计均为 392 分，剩余 233 分 | 分层上限不能相加；保守 `cost-events` 不等于 StepFun 官方最终账单；新草案未批准，`approvedAt=null`、`0/14`、Cron 关闭 |
| 插件安装 | LIVE 0.4.7 READY / FROZEN 0.4.9 CANDIDATE | `/api/plugins` 显示 `agent-army.content-autonomy` live `0.4.7`、`ready`，packagePath 指向 `content-autonomy-bundle-0.4.7-cac8390a…4723c13`。`0.4.9` 已冻结到 `work/m5-content-autonomy/plugin-packages/content-autonomy-bundle-0.4.9-b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d/`：`payloadHash=b64760f6c00e2031d5a5ae51fac4a76e26183698e1bb9bf536e407fd27592c0d`、`entryCount=19986`、`manifestSha256=dabf16ac255eec3348e5800239f907793db1c1e507d1aa2820cd57fb71ec8dd7`、独立全目录哈希 `82f75845b927c8fa817e45e8e4d588338c7131677f2681c7297dba987db0c8bd`。为搬移候选包，仅 bundle 根由 `0555` 短暂调整为 `0755`，内部未改；完成后根恢复 `0555`、manifest 保持 `0444`，独立复算与安全审计放行。源码测试 `97/97` 且 `check` 通过。`0.4.8` 仅为历史候选，`0.4.6` 回滚兼容链保留 | `0.4.9` 尚未安装到 live；新增视觉与 Provider 血缘硬化不能算运行态能力，插件 ready 也不等于活动批准或发布授权 |
| Hermes Profile 精确同步 | LIVE CONFIG PASS / GATEWAYS UNTOUCHED | 11 个正式 Profile 已实际同步到 `stepfun/step-3.5-flash-2603`、岗位 MCP 作用域和精确 Feishu toolset；同步后全军只读 dry-run 为 `0 drift`，同步未启停 Gateway | A君 R4 已加载；Paperclip 兼容补丁和插件升级仍是独立门禁 |
| Hermes 技能白名单 | LIVE PASS / 11 CLEAN | 11 个正式 Profile 指定只读检查均为 clean，无额外 enabled skill、无声明技能缺失或被禁用；`xiaod` 原有 78 个额外技能保持 disabled，办公助理遗留 `feishu-doc` 已显式收敛并复验 clean | 微信取件员不属于 11 个正式内容岗位；技能包仍可保留在目录或备份中，但未授权技能默认不可用 |
| 岗位执行适配器 | LOCAL REAL-ADAPTER PASS / PROFILE CONFIG SYNCED | 小R动态网页用临时 Chrome、同源只读请求和 DNS 固定；公开 PDF 以固定 IP 流式读取，真实 2,215,244 bytes PDF 通过，超过 8MB 中止。开放研究及其路由/Routine 契约针对网页/PDF/GitHub、Observation 换路、预算/重试/重规划及 Work Product 回写的定向测试为 `29/29`；恢复来源必须匹配当前 assignment 的 Issue/Run，任务自报与跨 Issue/Run 内嵌 Observation 注入均失败关闭。小办 DOCX/XLSX/PDF 已真实生成回读；Markdown 外部资源、本机偷读和符号链接越界写入均拒绝。11 个实际 Hermes Profile 已完成精确同步并 post dry-run `0 drift` | 受控本地/公开读取、文档生成和 Profile 配置均有证据，但当前 A君 `4321` 尚未重启加载本轮源码；登录型网页、外部发送和业务闭环仍未证明 |
| One-shot 与正式视觉边界 | LOCAL SECURITY PASS / LIVE NOT LOADED | 内容插件固定视觉模型 `step-1o-turbo-vision`、生图/改图模型 `step-image-edit-2`、TTS 模型 `stepaudio-2.5-tts`。通用 Hermes one-shot 已移除 `--ignore-rules`，普通调用固定为 `clarify`，只有无 Provider 的受控故事板分支允许 `vision`。正式视觉仅由当前 Paperclip Run 的单用途回调触发，绑定固定 action、相对 PNG、帧哈希、时间点、confirmed receipt 和同一 Project；新产物与已有视觉 Work Product 重放都使用同一校验，漂移时阻塞且不覆盖。渲染强制消费可信 `GeneratedImagePackage`，机器审核反查同 Project 的图片、视觉、TTS 三条 confirmed action/cost | 只由候选源码和本地 Fake 测试证明；live 插件仍为 `0.4.7` 且未安装 `0.4.9`，当前 A君仍是旧进程，尚无真实 M5 Campaign StepFun 视觉调用 |
| 工具执行身份 | LOCAL COMPAT PASS / LIVE NOT APPLIED | `/api/tool-executions` 的应用层契约只接受与 canonical Case 当前运行中 Agent/Company/Run 一致、有效期不超过 2 小时的 Paperclip Run JWT；版本锁定 `forwardRunJwt` 兼容补丁与一次性恢复 Approval 补丁合并定向测试 `15/15`。controller cutover 工具 `15/15`；其快照读写 TOCTOU 已改为同 fd、`O_NOFOLLOW`、dev/ino 复验、原子 no-replace 发布和固定原目录身份的清理器。A→B symlink、发布前父目录替换及 post-link 父目录替换均失败关闭；最后一种确认原目录/替代目录无残留且 0 Paperclip PATCH，清理不完整标记 `recoveryRequired`。ready/cleanup/close 均有硬超时；SIGSTOP 和不响应 close 均会 TERM、KILL 并确认退出，独立红队确认无子进程或监听器残留 | live Paperclip HTTP adapter 仍是原始文件，控制器 adapterConfig 未启用 `forwardRunJwt`；当前只证明可审计、可回滚的本地兼容实现 |
| 本地 chaos | LOCAL FAKE PASS | 定向测试 `4/4`；15 阶段成功路径、并行峰值 4、一次安全重试、检查点恢复、一次 `request_changes`、预算硬停后受控恢复、Fake 发布幂等和 2h/24h/72h 三次模拟指标通过；账本扫描 318 个节点，未发现凭据或绝对路径 | `mode=local_fake_only`、`externalEffects=false`、`paidCalls=0`；不证明 live Case、真实 Provider、真实平台或现实 72 小时运行 |
| Fake 全链 E2E | LOCAL PASS / NO EXTERNAL EFFECT | `5/5`；完整纵切从草案、选题、五分支 `[4,1]` 波次、脚本、渲染、退回、审核、Fake 发布进入 2h/24h/72h 模拟指标、复盘和 done；另 4 条直接验证真实无模型协调器的前置依赖、全局并发 4 和健康 Work Product 汇聚 | `externalEffects=false`、`paidCalls=0`；本地内存 Paperclip 和 Fake 平台，不证明 live、StepFun 或真实平台 |
| 7 天真实 MP4 → Fake Publisher | LOCAL PASS / SIMULATED CLOCK | `work/m5-publisher-gateway/acceptance/fake-seven-day-2026-07-31-v1/` 使用 14 支真实本地 MP4 生成 14 个 fake PublishReceipt、42 个 2h/24h/72h 模拟 MetricSnapshot；44 次 Runtime 重建后幂等重放同一 72h 快照。`realPlatformTouched=false`、`externalPublished=false`、`realPlatformCalls=0`、`totalCostUsd=0` | `actualPlatformElapsedTime=false`；不等于真实等待 72 小时、真实平台指标或真实发布 |
| 本地运行 | R4 LIVE / CAMPAIGN OFF | Paperclip `127.0.0.1:3100/api/health` 为 200；A君 PID `58141` 的 `4321/api/overview` 为 200，cwd 与 entrypoint 指向 R4；Publisher `4390/health` 为 `disabled`；Paperclip 15/17/5 对账保持 | 活动草案未批准、Cron 无 trigger、真实连接器未启用；A君没有 `/api/health` 路由 |
| 运维巡检 | PASS | “A君定时本机巡检”修复后连续 3 次受控手动 Routine Run 为 `completed`，并已观察到至少 1 次修复后自然定时 `completed` | 更早失败按历史保留 |
| StepFun 文本 | CURRENT PROVIDER PASS | 11 个正式 Profile 已以 `step-3.5-flash-2603` 完成当前无副作用实调用 `11/11`，均返回精确文本 `M5_OK`；DeepSeek 0 次、无业务外部副作用。证据：`artifacts/2026-07-31-stepfun-text-probes.json` | 只证明当前文本传输，不证明复杂任务、多模态或回退 |
| StepFun 复杂岗位任务 | STRUCTURE 11/11 / SEMANTIC 11/11 / CROSS PASS / PROFILE PROBE PASS | 最新 `video-content-analyst` 使用 `step-3.5-flash-2603`，18 项结构和语义门禁为 `18/18`，从而11个岗位全部通过。新的 Cross 首次因未转义 JSON 失败关闭，缩短并固定输出结构后安全重试为 `19/19`；最终 `summary.status=passed`、`rolePassedCount=11`、`crossRoleStatus=passed`，离线重验同样通过。此次新增 1 次 video 和 2 次 Cross StepFun 调用，工具调用 0、`externalSideEffects=0`；语义门禁与提示契约自测为 `72/72`。全军 Profile 收敛后另完成 1 次 `video-content-analyst` 真实 StepFun no-tool 探针，工具调用仍为 0 | usage 的 `cost_status=unknown` 必须保留；探针中的 `estimated_cost_usd=0` 只是 usage 字段，不是官方账单。no-tool 探针只证明文本传输和模型身份，不承担内容 Provider 血缘；这些证据不证明当前 A君已加载本轮源码、真实 M5 Campaign StepFun 视觉、平台发布或业务外部闭环 |
| StepFun 多模态 | HISTORICAL PROVIDER LEDGER PASS / NO NEW CALL | 旧 `m5v2` 账本 `status=succeeded`：35 个 action-linked 费用记录合计 42 美分，`confirmedReplay=35`、`lifetimeProviderCalls=43`。本轮 Provider 请求/调用均为 0、没有新增费用或 `cost-event`；公司与 Project 累计仍为 392 分 | 42 美分是旧保守项目账本，不是 StepFun 官方最终账单；本轮没有新增付费调用，也不证明真实平台发布 |
| 指标回流 | R4 BINDING LOADED / PIPELINE OFF | 2h/24h/72h、独立指标 approval、current-run scope 与 `PaperclipBridge` 六项核心 access 已由 R4 加载；发布与指标 runner/Profile 隔离 | Paperclip 原始 `2026.722.0` 的兼容补丁未 apply，R4 connector dependencies 为空并失败关闭；尚无真实 PublishReceipt、平台指标或人工核对 |
| 生产 readiness | READ-ONLY / NOT READY | `npm run production:readiness` 固定检查 4390 health、Campaign snapshot、selector 安全、Profile lease 引用和 provider 注入；当前 `not_ready`、退出码 `2`、唯一下一步 `provide-campaign-status-snapshot` | 不读 `.env`/Secret，不启动服务、不批准 Campaign/Cron，不等于生产启用 |
| 发布写回 | LIVE CONTROLLER / NO REAL RECEIPT | publisher 控制器与 Routine 已接入 live；production Runtime 覆盖注入式抖音官方 API 与 CUA；账号、日期、预算、幂等和强成功证据均在写回前硬校验；standalone 4390 禁止 real，真实入口只保留 A君逐请求刷新 Paperclip 批准的惰性路径 | live Publisher 为 `disabled`，没有真实连接器、平台内容 ID 或真实回执 |
| 复盘学习 | LIVE CONTROLLER / NO REAL SAMPLE | retrospective 控制器与 Routine 已接入 live；只接受标准信任的同平台 72h `MetricSnapshot`，少于 5 条写 `insufficient_sample`，达到 5 条才附带 `proposed` LearningProposal | 无真实样本；不会自动修改 Prompt、权限、频率或投流，离线回放、审核和灰度均未执行 |
| 本地成片与原生血缘 | LOCAL PRODUCTION RENDER + LINEAGE PASS / NO PUBLISH | 上游已直接生成 lineage；`native-artifact-smoke` 以 Provider 0 完成 1/1 份原生 lineage 和 3/3 支平台媒体，均为 45 秒、1080×1920、H.264/AAC、黑帧 0、-15.1 LUFS。历史 `m5v2-lineage-v2` 仍以 Provider 0 保留 7/7 份 lineage 和 21/21 支媒体复核，响度 -15.2 至 -14.9 LUFS；原 `m5v2` 保留 7/7 review、63/63 固定产物 hash/bytes 与 t04 八点人工抽帧证据；另有 3 主题、9 视频 dry-run `12/12` | 全部 `externalPublished=false`；证明本地成片与血缘，不证明真实平台发布、PublishReceipt 或指标回流 |
| 控制台 | BROWSER PASS | 桌面、中间宽度和 390px 真实浏览器中均能看到 1 个草案、`0/14`、费用、下一步、恢复位置和唯一授权按钮；390px 无横向溢出，浏览器无相关 error/warn | 未点击授权按钮，未启动活动 |
| Computer Use | DIAGNOSTIC FIX PASS / FULL FAKE PAGE WAITING UNLOCK + TOKEN | CuaDriver `0.14.1`；Accessibility 与 Screen Recording 均为 `true`，`doctor` 正常。runner 会保留真实 `browser_consent_required`，不再误报为 `prepared_browser_pid_missing`；受控 runner 仍要求 selector、Profile lease、页面身份和强回执。最新只读 app-state 检查明确返回 Mac locked，没有继续执行页面动作 | 先人工解锁 Mac，再在同次五分钟窗口内生成并单次使用 browser approval token；Token 不得打印、落盘或复用。真实 selector、Profile lease、登录和写授权均未验收 |
| 抖音/小红书 | NOT AUTHORIZED | 现有连接仅为读取权限 | 发布账号、时间窗和写授权 |
| 7 天活动 | NOT STARTED | 需先完成上述门禁 | 14 次发布与指标回流 |

## 当前明确没有发生

- 内容插件 live 已升级为不可变净包 `0.4.7` 并处于 `ready`，`0.4.6` 回滚兼容链保留；这没有批准活动或授予平台写权限；
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
# 候选源码 0.4.9 为 97/97，check 通过；0.4.8 仅为历史候选，上游原生 lineage 与历史迁移复核均覆盖；
# live 仍为 0.4.7，不能把本地结果当作插件已升级

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
