# 用户体验与稳定性 1–7 验收账本

更新时间：2026-08-18  
最终代码基线：`0b5b08d88f11a9673a7f3d54886f462929b10e8e`（完整继承 `a56f8c0` 的 1–7 与移动端详情修复）  
当前线上基线：Git `0b5b08d88f11a9673a7f3d54886f462929b10e8e` / release `ef6ed69cc2982917aa0f86e388d453e10d5bc043ebf653e5e5736499b50aceea` / payload `b397a646…` / PID `78965`  
当前回滚基线：Git `a56f8c0` / release `60c09c36…` / payload `7828…`  
发布助手包：`f0198fee`  
观测工具修复：`49e86cb`（结论防回退）、`f795685`（信号退出）、`b9166ae`（短期/长期文案）、`fd7defb`（72 小时 CPU 门禁）、`690ef9f`（launchd 生命周期监督）、`79e36f3`（CPU 区间差分 v2）、`afa94ad`（按有效观测时长完成）、`1d9602b`（最终机器关闭门禁）
当前交接：[用户体验与稳定性 1–7 收口交接单](../../handoffs/current/ux-stability-1-7-2026-08-18.md)

## 结论

用户授权后的发布与实机验证继续推进到新正式线上。`0b5b08d` 是 `a56f8c0` 的直系后代；正式 validator 已核对 `7347` 个 entries，smoke 通过。当前线上绑定 Git `0b5b08d88f11a9673a7f3d54886f462929b10e8e`、release `ef6ed69cc2982917aa0f86e388d453e10d5bc043ebf653e5e5736499b50aceea`、payload `b397a646…` 与 PID `78965`，八项发布身份/运行检查全部为 true；回滚入口指向 `a56f8c0 / 60c09c36… / 7828…`。当前 live 的真实 DOM 1440/390/320、移动详情与 list 503 恢复路径全部通过，报告保存在 `/tmp/ajun-live-ui-0b5b08d.JkknDE`。

原本针对 `a56f8c0 / 60c09c36…` 的独立 30 分钟 run 在 43 样本、有效观察 `1260.89s` 时，72 小时 run 在 56 样本、有效观察 `1650.89s` 时，均因 live 切换到 `0b5b08d / ef6ed69c… / PID 78965` 而被身份漂移门禁 fail-closed 终止。两条 run 均已释放锁、清理 label、保留证据，禁止 resume。

随后先启动的两条 `0b5b08d / ef6ed69c…` run 使用了普通 source 中 `0755/0644` 权限的工具，因此在 19 样本阶段被受控停止；`stopRequested=true`、锁已释放、证据保留。这不是产品结果失败，而是工具完整性边界要求用安全工具包替换，旧 run 同样禁止 resume。

安全独立 30 分钟 run `ux-stability-30m-0b5b08d-ef6ed69c-cpuv2-effective-20260818T010227Z` 已自然完成并 PASS：61 样本、有效观察 `1801.37s`、remaining `0`、`stopRequested=false`、`identityFailure=null`。required `243/244 = 99.5902%`，唯一失败样本是 console overview `3001ms` 超时并完整保留；CPU v2 `60/60`、coverage `1`、P95 `4.30%`；RSS `185.81 → 172.36 MB`，max `195.30 MB`，非单调、ratio `0.928`；identity、成本 `0 CNY / open`、61 个 externalEffects=false 样本全部通过。observer 自然退出、锁释放，supervisor `runs=1` 未重启；30 分钟 label 随后清理，run 证据保留。`runtime-reliability` 以 0600 权限更新为 healthy，live UI 明确只展示“30 分钟结论”，不冒充 72 小时结果。

与该短测同秒启动的 72 小时 run 因双探针同步出现 timeout，在 29 样本时以 `stopRequested=true` 受控停止并保留证据；第一次错峰 run 又因实际偏移仅 `9.6s < 10s`，在 4 样本时受控停止。当前唯一 72 小时 run 为 `ux-stability-72h-0b5b08d-ef6ed69c-cpuv2-effective-staggered2-20260818T012800Z`，label `ai.agent-army.stability-72h-0b5b08d-ef6ed69c-staggered2-012800`，supervisor/observer PID `36484/36489`。它使用安全工具、`resumeCount=0`，与已完成短测的实际采样偏移为 `14.779–15.660s`；首 6 样本 required `24/24`、CPU v2 P95 `4.23%`、RSS、identity、cost 与 externalEffects 均通过，但距离 72 小时仍很远。唯一下一步是只读守护这条唯一长测至自然完成。

本轮没有发送真实飞书消息，没有公开发布内容，也没有调用付费模型或付费 Provider。外部业务送达质量不在本轮本地验收结论内。

## 1–7 验收明细

| 项目 | 已实现内容 | 已有验证证据 | 当前判定 |
| --- | --- | --- | --- |
| 1. 健康状态与性能真相 | `/api/health` 改为轻量核心探活；控制台健康状态拆成核心在线、可靠性、业务欠账；未知状态不显示为绿色；Paperclip 探测支持并发合并；控制台快照缓存随数据变更失效；稳定性快照绑定当前 Git 与不可变 release 身份；72 小时结论额外执行 A君 CPU P95 ≤5% 门禁。 | `runtime-health.test.js`、`console-overview-read-model.test.js`、`paperclip-heartbeat.test.js`、`runtime-reliability-snapshot.test.js` 与 observer/supervisor 测试覆盖轻量探活、并发合并、缓存、完整身份、跨进程锁、RSS、CPU、信号退出、睡眠时长、费用、自然完成、外部副作用和快照防回退。安全独立 30 分钟 run 已以 61 样本、`1801.37s`、required `99.5902%`、CPU v2 P95 `4.30%`、RSS/identity/cost/external-effects 全门禁自然完成 PASS；当前唯一错峰长测首 6 样本全门禁通过。 | 代码、自动化与最终身份 30 分钟门禁通过；reliability 已更新 healthy，但 UI 明确这只是 30 分钟结论。72 小时远未完成。 |
| 2. 发布真相与可回滚 | 页面和接口区分线上版本、候选版本、验证结果、是否可发布、未部署差异与可回滚版本；发布前校验 PID、cwd、argv、release、payload、Git 与 HTTP 回读；验证失败会保留真实状态并阻止发布。 | 正式 validator 校验 `7347` entries 且 smoke 通过；最终线上 PID `78965` 的完整 Git `0b5b08d88f11a9673a7f3d54886f462929b10e8e`、release `ef6ed69cc2982917aa0f86e388d453e10d5bc043ebf653e5e5736499b50aceea`、payload `b397a646…` 等八项检查全 true，回滚入口为 `a56f8c0 / 60c09c36…`。 | 代码、validator、smoke、真实发布、上线回读与回滚入口验证通过。 |
| 3. Hermes 默认拒绝白名单 | 岗位 Manifest 的 `runtimeCapabilities.gatewaySkills`（显式存在时）或 `skills` 成为 Gateway 白名单真相；A君可明确声明空 Gateway 技能；配置变更前备份，写入失败或复核不一致时回滚；Gateway 启动增加守卫；launchd 迁移保留精确 SHA-256 备份。 | 自动化覆盖默认拒绝、备份、回滚、静默失败复核、守卫启动与备份完整性；真实 A君 Profile 收敛 87 个额外技能后复核为 clean；五个运行中 Gateway 已逐个迁移、重启并核对 wrapper/child，plist lint、0600 权限与受控备份均通过。`node integrations/hermes/scripts/reconcile-hermes-skill-whitelist.mjs` 已再次只读回读全部 11 个 active Hermes 岗位：越权启用、声明不可用/已禁用均为 0，且退出码为 0；五个常驻 Gateway 仍是 `runs=1` 的 guarded wrapper/child 配对。 | 代码、自动化、实时白名单只读复核与真实 Gateway 迁移通过。 |
| 4. 热路径减负与告警降噪 | 控制台热路径不再反复扫描完整历史和验证活动；缓存只在相关存储变更时失效；健康恶化使用持久化状态门，首次或“健康→异常”才创建事故，持续异常只追加例行证据。 | 自动化覆盖缓存、变更失效、跨重启状态和持续异常不重复开单；最终身份 30 分钟 run 保留唯一一次 console overview `3001ms` 超时，required 仍为 `243/244 = 99.5902%` 并按契约 PASS。同步双探针引发的后续 timeout 促使 72 小时 run 改为实际偏移 `14.779–15.660s` 的 staggered2。 | 代码、自动化和 30 分钟性能门禁通过；唯一长测刚开始采样，尚无 72 小时 P95 结论。本轮没有为了取证主动停服务或制造真实事故。 |
| 5. 送达回执状态机 | 送达状态明确拆成 `prepared`、`sending`、`delivered`、`delivery_unknown`、`failed`；自动启动最多两次；未知结果不自动重发，只允许显式核验或重试；失败不再投影成“就绪”；证据引用会剥离 URL 查询串/片段并拒绝疑似凭据。 | `delivery-receipt-state.test.js`、`task-notification-delivery-receipt.test.js`、`official-feishu-completion-watcher.test.js` 覆盖幂等、重试上限、未知态、失败态和回执写回。线上仍有 5 条 `delivery_unknown`，它们按设计留给人工核对，没有自动重发或伪装成功。 | 本地状态机与自动化验证通过；5 条未知回执仍是人工核对边界，没有用真实飞书发送做外部送达验收。 |
| 6. 控制台界面做减法 | 运行台优先展示 A君和管理视角，业务结果型员工优先，后台能力折叠；“负责人下一步”与运行状态、可靠性、业务欠账分开；能力按真实程度分层；关键控件最小触控尺寸为 44px；移动端正文滚动区不再被固定底栏覆盖；版本文案只展示可验证事实。 | 自动化与生成资源验证结构、文案、版本状态和触控尺寸；当前 live `0b5b08d / ef6ed69c…` 的真实 DOM 1440/390/320、移动详情与 list 503 恢复路径全部通过，报告 `/tmp/ajun-live-ui-0b5b08d.JkknDE`。 | 代码、静态测试、真实失败恢复及当前最终线上真实 DOM 回读通过。 |
| 7. 核心状态类型收紧 | Task、Workflow、审批与送达状态改为显式联合类型；状态到展示/策略的映射使用完整 `Record` 和穷尽分支；热点路径消除宽泛 `any`，避免新增状态被静默吞掉。 | `npm run check` 已通过类型检查与策略门禁；任务生命周期、工作流和策略相关测试在集成轮次通过。 | 类型与自动化验证通过。 |

## 验证分层

### 已完成

- 1–7 主体提交为 `c82559a`；可靠性取证修复与移动端实机缺陷曾上线到 `faf2302`；发布真相、送达原子性、Hermes 迁移路径、健康快照/锁、缓存与类型复审加固收敛到 `e628d58`，正式 UI 提交与移动端 `0×0` 实机缺陷修复后收敛到 `a56f8c0`，并由其直系后代 `0b5b08d` 完整继承。
- 相关定向测试与集成轮次的 `npm run check` 通过。
- 2026-08-18 对当前工作树重新做了分组只读复验：健康/缓存/状态类型与 workflow 直接测试 103 条、发布/Hermes/送达直接测试 49 条、控制台与版本 UI 契约测试 15 条、observer 与 supervisor 测试 45 条全部通过；`npm run check` 通过，前端 19 个生成 JS 与源码等价构建结果逐文件一致。
- Hermes 白名单本轮再次覆盖全部 11 个 active Profile，extra enabled 与 declared unavailable/disabled 均为 0；五个常驻 Gateway 均为 `runs=1` 的 guarded wrapper → `hermes gateway run --replace` 子进程配对。本次只读复核没有修改 Profile 或重启 Gateway。
- 送达、发布、稳定性都使用“未知就是未知”的状态语义，不再把部分成功显示成完整成功。
- 用户已授权切换。历史旧 run 以 `stopRequested=true` 优雅汇总并释放锁；发布助手包 `f0198fee` 参与受控发布链路。中间 `e628d58 / b7893670…` run 在正式 UI 提交上线造成身份漂移后 fail-closed 终止，没有继承到后续版本。
- `255… / 2ee0…` 的真实移动端详情页回读暴露 `0×0` 失败；`a56f8c0` 修复后曾完成三档 DOM 回读。其直系后代 `0b5b08d` 当前已通过 `7347` entries validator、smoke、八项线上身份检查，以及 1440/390/320、移动详情和 list 503 恢复路径真实回读；报告 `/tmp/ajun-live-ui-0b5b08d.JkknDE`。
- 本轮未通过真实飞书、公开发布或付费 Provider 制造验收结果。

### 已完成的旧版 30 分钟观测

- 运行 ID：`ux-stability-c82559a-20260817T2109`；有效观察 `1811.39s`，62 个样本，必需端点成功率 100%。
- A君 health P95 `56.59ms`，console overview P95 `56.07ms`；身份门禁、RSS 门禁通过，PID 全程为 `35172`。
- 期间并行审计产生过一次约 1.67s 尖峰，但没有被删除；完整样本 P95 仍通过。可靠性快照已以 0600 权限写入，线上 `health.reliability.status` 回读为 `healthy`。
- 这组证据只属于 `c82559a / 33c1d792…`；最终版发布后身份门禁已拒绝继续沿用，页面在最终版短测完成前按事实保持 `unknown`。

### 已完成的旧线上 `faf2302` 30 分钟观测

- 运行 ID：`ux-stability-30m-faf2302-20260817T2227`；有效观察 `1800.9s`，61 个样本，自然完成且 `stopRequested=false`。
- 四个必需端点共 244/244 成功，成功率 100%；A君 health P95 `45.15ms`，console overview P95 `45.61ms`。
- A君 RSS 从 `213942272` 到 `220971008` 字节，峰值 `237748224`，末值/初值 `1.032853`，非单调增长，RSS 门禁通过。30 分钟 CPU P95 为 `8.2%`，按契约不用 72 小时专属 CPU 门禁提前裁决短测。
- 61/61 身份门禁通过，全程锁定 `faf2302 / e1b99e21… / PID 33915`，且没有外部副作用。observer 自然退出后 supervisor 曾以 launchd `runs=1` 驻留、锁已释放，证明没有重启循环；证据固化后已移除该短测 launchd label 和驻留进程，不留无用常驻资源。
- 0600 可靠性快照与 4321 `/api/console-overview` 均回读 `healthy`，并绑定同一 Git/release；细节明确写着“长期稳定仍以更长观测为准”。

### 已被最终线上安全 run 取代的历史观测

以下内容保留工具演进和旧线上趋势证据，但都不是当前唯一的 staggered2 长测，不得用于终局 72 小时验收，也不得把样本、startedAt 或有效观察时长续接到当前 run。

- 旧长测 `ux-stability-72h-c82559a-20260817T2141` 保留 80 个样本与 `2317.52s` 有效观察；最终版切换后它准确记录 Git/release 身份漂移并终止，因此明确标记为“被新版本取代”，不计入最终版 72 小时。
- 当时的最终版长测 `ux-stability-72h-faf2302-20260817T2227` 保留 168 个样本和 `5010.9s` 有效观察；required 端点成功率 100%，身份与 RSS 门禁通过。但该 run 的 CPU 使用 macOS `ps pcpu` 衰减平均，不是相邻 30 秒区间实际利用率；旧样本又没有累计 CPU 时间，无法无损回算。因此它已以 `stopRequested=true` 正常汇总、释放锁并标记为“测量口径被 v2 取代”，不用来裁决最终 CPU 门禁。
- `79e36f3` 将 CPU 真值改为“相邻同 PID 的累计 CPU 时间差 / 实际 observedAt 时间差”，保留 `pcpu` 仅作诊断；PID 变化、负差、缺字段、旧样本都不混算，且有效区间覆盖率必须 ≥99.5% 才能裁决。定向回归 33/33 与全仓 `npm run check` 通过，旧 manifest 即使伪造 v2 样本也只能得到 `unknown`。
- 第一轮 v2 长测 `ux-stability-72h-faf2302-cpuv2-20260817T2353` 保留 61 个样本和 `1800.88s` 有效观察；60/60 CPU 区间有效、覆盖率 100%、v2 CPU P95 `3.13%`，四个必需端点成功率 100%，身份与 RSS 门禁通过。复审发现其主循环仍按墙钟 deadline 退出：系统长时间睡眠可能让墙钟已满而有效观察不足，因此它已以 `stopRequested=true` 正常汇总、释放锁并标记为“完成时长控制被 `afa94ad` 取代”，不用来裁决最终 72 小时。
- `afa94ad` 移除墙钟 deadline，prepare、summary 与 observe 主循环统一使用有效观察时长；每个长 gap 最多计一个采样周期，有效时长不足就继续采样。跨 5 小时 gap 回归证明有效 30 秒、60 秒均不会提前完成，累计到目标 90 秒才完成；observer 定向回归 34/34 与全仓 `npm run check` 通过。
- 睡眠安全长测 `ux-stability-72h-faf2302-cpuv2-effective-20260818T0025` 于 `2026-08-17T16:26:38.366Z` 启动并锁定 `faf2302 / e1b99e21… / PID 33915`。前 107 个样本由工具包 `afa94ad` 连续采集；`1d9602b` 合入机器门禁后，旧 observer 曾以 `stopRequested=true` 正常汇总并释放锁，再由新工具包以同一 run-id、同一 startedAt、`resumeCount=1` 无损续跑，样本 107→108、有效观察没有清零。受控工具切换形成一次 `62.368s` 相邻 gap，effective 只计 `30s`；续跑首样本四个必需端点均为 HTTP 200、身份门禁通过、`safety.externalEffects=false`，0600 成本账本为 `0 CNY / gate=open`。这些是当时旧线上采样事实；用户授权最终发布后，该 run 再次以 `stopRequested=true` 优雅汇总、释放锁并永久作为 superseded 历史证据，不裁决终局。
- `49e86cb` 防止未完成同身份长测覆盖已完成短测结论并拒绝符号链接快照；`f795685` 使 SIGINT/SIGTERM 立即汇总、释放锁；`b9166ae` 明确区分 30 分钟与 72 小时文案；`fd7defb` 把 A君空闲 CPU P95 ≤5% 纳入 72 小时最终门禁；`79e36f3` 修正 CPU 测量口径并拒绝 v1/v2 混算；`afa94ad` 防止系统睡眠或大间隔虚增完成时长。
- `1d9602b` 把费用预算、自然完成和每条样本的无外部副作用正式并入 72 小时 summary/可靠性门禁；缺账本、坏记录、缺失安全字段或缺失自然完成标记均 fail-closed 为 unknown，费用越过软/硬线或出现外部副作用才 degraded。中断长测不会把同身份已完成的 30 分钟 healthy 覆盖成 degraded；损坏的旧 summary 也可由完好的 manifest、observations 和 cost ledger 自愈重建。定向回归 40/40 与全仓 `npm run check` 通过。
- `690ef9f` 增加 launchd supervisor：它转发 SIGINT/SIGTERM 并等待 observer 汇总、释放锁；observer 正常完成或身份门禁退出后会驻留，防止 `launchctl submit` 重启循环。`node --test scripts/stability-observer-supervisor.test.mjs` 真实子进程回归 5/5 通过；两个最终版 run 已在保留原 run-id 和样本的前提下切换为 `--resume true`，旧锁均由 observer 正常释放。
- 切换时的 `summary.json` 会保留 `stopRequested=true` 的中间快照，直到 observer 自然完成才更新；进行中的实时真相以 launchd 状态、`observations.jsonl` 和 `soak-manifest.json` 为准，不把中间 summary 误判为 run 已停。
- 中间长测 `ux-stability-72h-e628d58-b7893670-cpuv2-effective-20260817T234044Z` 曾以 `resumeCount=0`、supervisor/observer PID `81322/81352` 从零启动；早期 required/identity/cost/external-effects 通过，同时保留 CPU P95 `7.45%` 与一次 console `1735ms`。随后正式 UI 提交 `255… / 2ee0…` 上线导致 Git/release 身份漂移，observer 按契约 fail-closed 终止；该 run 不续跑、不改绑，也不裁决最终版本。
- `a56f8c0 / 60c09c36…` 的独立 30 分钟 run `ux-stability-30m-a56f8c0-60c09c36-cpuv2-effective-20260818T002716Z` 保留 43 样本与 `1260.89s` 有效观察；72 小时 run `ux-stability-72h-a56f8c0-60c09c36-cpuv2-effective-20260818T002032Z` 保留 56 样本与 `1650.89s` 有效观察。两者均因 live 切到 `0b5b08d / ef6ed69c… / PID 78965` 而身份漂移 fail-closed，锁释放、label 清理、证据保留并禁止 resume。
- 首轮 `0b5b08d / ef6ed69c…` 30 分钟与 72 小时 run 使用普通 source 中 `0755/0644` 权限的工具，在 19 样本时受控停止；两者 `stopRequested=true`、锁释放、证据保留、禁止 resume。这是工具完整性边界替换，不是产品结果失败。
- 安全工具包的同秒 72 小时 run `ux-stability-72h-0b5b08d-ef6ed69c-cpuv2-effective-20260818T010227Z` 与独立 30 分钟探针同步，出现同步 timeout 后在 29 样本时以 `stopRequested=true` 受控停止、释放锁并保留证据；它不是当前长测。
- 第一次错峰 72 小时 run 的实际探针偏移仅 `9.6s`，未达到至少 10 秒的错峰边界，因此在 4 样本时受控停止并保留证据；它同样不 resume。
- 最新发布事实：当前代码 `0b5b08d88f11a9673a7f3d54886f462929b10e8e` 已激活为 release `ef6ed69cc2982917aa0f86e388d453e10d5bc043ebf653e5e5736499b50aceea` / payload `b397a646…` / PID `78965`，正式 validator `7347` entries 与 smoke 通过，八项运行检查全 true；回滚入口为 `a56f8c0 / 60c09c36…`。

### 最终线上安全独立 30 分钟观测（已完成 PASS）

- 运行 ID：`ux-stability-30m-0b5b08d-ef6ed69c-cpuv2-effective-20260818T010227Z`；launchd label：`ai.agent-army.stability-30m-0b5b08d-ef6ed69c`；supervisor/observer PID `19041/19059`。
- 使用 clean timestamped source 与权限为 `0700/0600` 的工具包，`resumeCount=0`；Git/release/payload/PID 与当前线上一致。最终 61 样本、有效观察 `1801.37s`、remaining `0`、`stopRequested=false`、`identityFailure=null`。
- required `243/244 = 99.5902%`，唯一失败为 console overview `3001ms` timeout；CPU v2 `60/60`、coverage `1`、P95 `4.30%`。
- RSS `185.81 → 172.36 MB`、max `195.30 MB`、非单调、ratio `0.928`；identity、成本 `0 CNY / gate=open`、61 个 externalEffects=false 样本全部通过。
- observer 自然退出、锁释放，supervisor `runs=1` 且未重启；label 随后清理，run 证据保留。0600 `runtime-reliability` 已更新为 healthy，live UI 明确只展示 30 分钟结论。

### 最终线上安全 72 小时观测（进行中）

- 运行 ID：`ux-stability-72h-0b5b08d-ef6ed69c-cpuv2-effective-staggered2-20260818T012800Z`；launchd label：`ai.agent-army.stability-72h-0b5b08d-ef6ed69c-staggered2-012800`；supervisor/observer PID `36484/36489`。
- 使用 clean timestamped source 与权限为 `0700/0600` 的工具包，`resumeCount=0`，没有继承任何旧 run 的 startedAt、样本或有效观察时长；成本 `0 CNY / gate=open`。
- 与已完成独立 30 分钟探针的实际采样偏移为 `14.779–15.660s`。首 6 样本 required `24/24`、CPU v2 P95 `4.23%`、RSS、identity、cost、externalEffects 均通过。
- 有效观察距离 72 小时仍很远，阶段性 pass 不是最终结论；当前 live reliability healthy 只代表已完成的 30 分钟结论。
- 唯一下一步是只读守护这条唯一 72 小时 run 至自然完成，再按完整 summary 裁决。

### 尚未完成

- 最终线上 `0b5b08d / ef6ed69c…` 的安全独立 30 分钟观测已自然完成 PASS；唯一 72 小时 staggered2 run 尚未自然完成。唯一下一步是只读守护该长测并在自然完成后读取完整 summary 裁决。
- 线上仍有 5 条 `delivery_unknown`，继续保持人工核对边界，不自动重发、不冒充成功。
- 真实飞书送达、真实内容发布与付费模型效果没有执行，也不属于本轮已通过项目。

## 关闭条件

本账本只有同时满足以下条件才可改为“验收完成”：

1. 当前线上 PID、cwd、argv、监听端口、Git HEAD、release hash 与 HTTP 回读一致；
2. 候选发布、回滚、恢复到候选版本均有可复核记录；
3. 运行中的 Hermes Gateway 使用守卫入口，白名单复核无额外技能，失败时可从已校验备份恢复；
4. 最终线上版本的 30 分钟观测完成且门禁全部通过；
5. 最终线上版本的 72 小时观测自然完成，`stopRequested=false`，且可用率、P95、A君 CPU P95、RSS、身份、成本与全程无外部副作用门禁全部通过；
6. UI 关键状态通过真实运行页面回读，而不仅是构建产物或测试断言；
7. 任何未执行的真实外部送达继续明确标注“未验证”，不冒充成功。
