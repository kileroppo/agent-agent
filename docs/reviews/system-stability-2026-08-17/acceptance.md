# Agent军团全方位稳定性验收

| 字段 | 当前值 |
| --- | --- |
| 状态 | 进行中（历史阶段记录；当前运行态已转交） |
| 开始时间 | 2026-08-17 18:28 CST |
| 验收对象 | 当前线上不可变版本与候选源码分轨 |
| 负责人 | 本机负责人 |
| 外部边界 | Campaign/Cron 保持关闭；只允许私密草稿；Provider 40 元软停、50 元硬停 |

> 时效说明：本文保留 2026-08-17 阶段的基线、失败和未验证项，文中的 PID、Git、release、候选和“72 小时尚未启动”等均是当时截点，不得当作当前运行真相。后续最终版运行身份、Hermes guarded Gateway、30 分钟结论和正在进行的睡眠安全 72 小时观测，以[用户体验与稳定性 1–7 验收账本](../ux-stability-1-7-2026-08-17/acceptance.md)为准；真实外发、付费 Provider、平台草稿、灾备和人工验收仍按本文边界保持未验证。

## 1. 版本与范围

- 正式安全基线 Run ID：`stability-20260817-final`；原始脱敏证据目录：`~/.agent-army/acceptance/stability-20260817-final/`。
- 自动化与并发附属证据分别保存在 `stability-20260817T104030Z-58ef80` 和 `stability-20260817-safe-baseline`；前者修复前记录过 Hermes 文件名和绝对路径，只含 metadata、未读取正文，已标为 superseded baseline，不作为安全基线。
- 当前源码基线：`main@18db26ae19f400d76b4887210cc1932976ea7f85`；正式基线采样时 `changedPathCount=24`。当前 `git status` 已到 43 项，其中本轮稳定性范围 15 项（之前 12 项，另加 `task-overview.ts`、`task-validation-overview.ts`、`console-overview-read-model.test.js`），其余 28 项为并发/用户改动，继续保留且不纳入线上版本结论。
- 线上 A君、小D、Paperclip 的 PID、cwd、端口、release/payload 身份以本轮 `baseline.json` 和每次实时指纹为准，不沿用历史文档快照。
- 本轮基线回读：A君 `pid=60472`、`4321`、不可变 release `8fbea9619d14006083c62a60891d36efdcad166aded1e2f2e94c9d70f4860d10`、payload `24d7ac7ce7901e0fc567768c357a7629e1a38a5b4b9e5d9f598f1d009a6baf88`；小D `pid=73489`、`4318`、不可变 release `433c3e5386b5cd7736f810c2abf42a5ed7be3ef755afcd9c8ee8df1b39e144ef`；Paperclip `pid=10376`、`3100`、`2026.722.0`；Publisher 未监听 `4390`。
- Publisher、真实飞书外发、Provider 调用、平台草稿、服务停止和线上回滚在获得各阶段二次确认前均为 `NOT CHECKED`。
- `scripts/stability-observer.mjs observe` 已支持显式续跑：已有 `observations.jsonl` 时默认拒绝，只有 `--resume true` 且 live Git HEAD / release hash 与既有 run 身份匹配时才允许继续；续跑保留原 `startedAt`，并累计 `resumeCount` 与总有效观察时长。
- 原始脱敏证据保存于 `~/.agent-army/acceptance/<run-id>/`，正式 run 目录与文件权限均已核对为 `0700/0600`；`stability-20260817T104030Z-58ef80` 等旧 run 修复前曾保留 Hermes 文件名和绝对路径 metadata，现仅作为 superseded 历史对照，不再作为安全基线。

## 2. 验收门禁

- 任务丢失、重复外部副作用、未经批准高风险动作和 Secret 泄漏必须全部为 0。
- 关键产物存在、可读、哈希与权限验证必须 100% 通过；聊天回复、任务终态、产物验证和人工验收分别记账。
- 除计划维护窗口外，72 小时必需端点成功率不低于 99.5%。
- A君 `/api/health` P95 不高于基线两倍或 300ms 中较高者；`/api/console-overview` P95 不高于基线两倍或 1 秒中较高者；10 并发时不超过 2 秒。
- A君空闲 CPU P95 不高于 5%；结束 RSS 不高于起始值的 125%，且不得持续单调增长。
- A君、小D恢复目标 60 秒，Paperclip 120 秒，Hermes/飞书 5 分钟；每个故障最多自动恢复一次、重试一次。

## 3. 验证账本

| 阶段 | 结论 | 证据 | 未证明部分 |
| --- | --- | --- | --- |
| 保护与基线 | PASS | `stability-20260817-final/baseline.json`、`sqlite-backups/`：A君 live `same_git_head`，3 个正式 SQLite 在线 `.backup` 后源/备份 `quick_check=ok`、表数一致；state 与 Hermes live profile 只做匿名 metadata 汇总 | 尚未做恢复演练 |
| 静态与自动化 | PARTIAL | 首次 `phase1` 保留 3 个失败；fixed run 仅剩 Hermes whitelist 只读检查退出码 `2`。其后已对 `xiaod` Hermes 配置做 exact `0600` 备份并 apply，dry-run 回读为 0 漂移；除 `skills.disabled` 补入 12 项外保持语义等价，且未重启 Gateway。`root-test` 严格串行 `3×2431` 全绿，`core-test` 严格串行 `3×2174` 全绿；`scripts/*.test.mjs 82/82`、`public-dynamic fake 4/4`、`runtime-release-client 2/2`、全量 `2434/2434`、关键 Chaos/发布/边界/并发专项 `96/96`、本地 AI smoke PASS；`npm run check` PASS，`git diff --check` PASS | Hermes 白名单文件已修正，但 live Gateway 尚未重启回读，因此线上会话侧仍不能把“0 漂移”直接当作已生效事实；首次 phase1 的 3 个失败已保留原始账本，相关回归虽已刷新最终数字，但运行边界仍需与 Gateway 生效状态分开记账 |
| 并发与短时观察 | FAIL | `stability-20260817-safe-baseline/load.json`：4 级共 1600 次只读请求全部成功；后续 30 分钟 run 共 62 个样本、总有效观察时长 `1831.19s`、`resumeCount=1`，身份门禁通过，但 `requiredEndpointSuccessRate=99.1935%` 低于 `99.5%` 门禁；`/api/health p95=862.34ms` 超过 `300ms` 门禁，`/api/console-overview p95=1710.13ms` 超过 `1s` 门禁且出现 2 次超时；RSS gate PASS，`finalToInitialRssRatio=1.193983` 且非单调增长，FD `47→38`、峰值 `54` | 本轮 30 分钟 run 期间叠加全量编译测试，属于主机饱和压力证据，不能冒充干净 fake 任务 burst；72 小时观察仍未启动 |
| 真实研究任务 | NOT CHECKED | Paperclip/Hermes/飞书/产物引用 | 未提交：Paperclip 公司预算仅余 `9` cents（`616/625`），处于 hard-stop warning；Provider 尚有 `267` 条未知费用未完成总账核销，且专用测试会话仍未确认 |
| 小D音视频任务 | NOT CHECKED | `BV1ymux6BEFU` 官方时长 `772s / 12:52` 符合 10–30 分钟窗口；`4318` 健康可达 | 因缺少可确认的专用飞书 `chatRef/requestRef`，本轮未提交真实任务；checkpoint、飞书文档与产物哈希因此仍未取得 |
| 小红书私密草稿 | BLOCKED | Publisher production readiness `not_ready` | 4390、Campaign snapshot、selector、Profile lease、production provider 均未就绪；不得改成公开发布 |
| 抖音私密草稿 | BLOCKED | Publisher production readiness `not_ready` | 同上；不得用 fake 结果冒充真实草稿 |
| 灾备演练 | NOT CHECKED | 明日窗口的只读预检已完成；PID/cwd/release/回滚/恢复时长正式账本待现场执行 | 今晚未执行停服或回滚；A君 真实回滚当前不能保证切回现版，需基于明日窗口的新事实再次确认 |
| 72 小时观察 | NOT CHECKED | `soak-manifest.json` | 尚未启动；当前 `summary.json` 仅覆盖约 10 分钟短时观察，不代表 72 小时结果 |
| 候选版本 | BLOCKED | 自动化构建与发布专项 `18/18`；`scripts/*.test.mjs 82/82`、`public-dynamic fake 4/4`、`runtime-release-client 2/2`、console 定向 `25/25`、`npm run check` PASS、`git diff --check` PASS；console 候选规模化隔离复验覆盖 929 个合成任务 / 125 个 workflow，10 并发全 200，`p95=790.13ms`，`campaignCalls=0`；隔离 Chromium 已验证真实 DOM/CSS、按钮可达、进行中状态，且无写请求、4322/Chromium 无残留 | 上述结果只证明源码候选修复通过隔离回归，当前仅可记为“候选修复待部署/线上复验”；`4321` live 仍未部署该候选，旧版 30 分钟门禁 FAIL 不变，不能写成线上已修。工作树仍非干净 detached worktree，也没有独立候选提交 |
| 人工验收 | NOT CHECKED | 负责人现场确认 | 尚未进行 |

## 4. 当前已知问题

- `xiaod` Hermes 白名单已做 exact `0600` 备份并 apply；dry-run 回读为 0 漂移，除 `skills.disabled` 补入 12 项外与 apply 前语义等价。由于尚未重启 Gateway，当前只能记为“配置已修正、live 会话侧待复读”，不能直接改写成线上已生效。
- 历史漂移明细仍保留账本：`blocked-page-recovery`、`box`、`competitor-news-monitor`、`document-to-action-items`、`email-inbox-triage`、`github-issue-to-pr`、`grounded-citations`、`meeting-action-items`、`merge-reconciler`、`product-price-monitor`、`session-librarian`、`weekly-review-planning`。
- Publisher 只读准备度退出码 `2`、`status=not_ready`；4390 未运行，且缺 Campaign snapshot、selector candidate/frozen、Profile lease 和 production provider，双平台私密草稿当前明确阻塞。
- 30 分钟 run 已证明：身份门禁可持续通过，但可用率和时延门禁未过；`requiredEndpointSuccessRate=99.1935%` 低于 `99.5%`，`/api/health p95=862.34ms`、`/api/console-overview p95=1710.13ms` 均超门禁，且 `console-overview` 出现 2 次超时。
- 该 30 分钟窗口叠加了全量编译测试，当前证据应解释为主机饱和压力表现，不能写成干净 fake 任务 burst 或独立业务流量结论。
- console 相关源码候选修复目前只拿到本地回归通过证据；在完成部署和同口径线上复验前，不得把它改写成 live 已修复，也不能据此覆盖旧版 30 分钟 FAIL 结论。
- console 候选新增的规模化隔离复验已经证明：929 个合成任务、125 个 workflow、10 并发全 200、`p95=790.13ms`、`campaignCalls=0`。这仍然只是候选源码证据，不是 `4321` live 事实。
- 稳定性工具已修复 affected-test 漏测：`scripts/` 变更现在会实际包含全部 `scripts/*.test.mjs`；费用 reference 只落 SHA-256，Phase1 不再保存原始 stdout/stderr。
- 成本账本当前仍为 `0`，40/50 CNY gate 的脚本门禁测试已生效；但真实研究任务受两层外部成本阻塞：Paperclip 公司预算仅余 `9` cents（`616/625`，hard-stop warning），Provider 尚有 `267` 条未知费用未完成总账核销。
- 72 小时空闲 CPU / RSS 观察仍未启动；5 分钟错误率/积压的权威来源，以及 24/48/72 小时真实探针仍待外部确认。真实业务闭环、平台私密草稿、灾备和线上回滚也均未执行，当前不能给出“全方位通过”。

## 5. 停止条件

- 公开发布、越权访问、Secret 泄漏、数据库校验失败或运行身份漂移时立即停止后续测试。
- Provider 累计达到 40 元停止新增真实调用，达到 50 元硬停；Paperclip、Gateway、Provider 三层分别核对。
- 外部平台缺少合规私密草稿能力时记为 `BLOCKED`，不得改成公开发布或使用模拟结果冒充通过。
- 原始失败保留在账本；只有定位并修复根因后连续通过 3 次，相关自动化项才能改为 `PASS`。
