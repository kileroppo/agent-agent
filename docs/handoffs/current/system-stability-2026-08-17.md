# Agent军团全方位稳定性测试交接单

| 字段 | 内容 |
| --- | --- |
| 状态 | 进行中（历史阶段记录；当前运行态已转交） |
| 创建时间 | 2026-08-17 18:28 CST |
| 交出者 | Codex |
| 接手者 | Codex / 本机负责人 |
| 关联任务 | [稳定性验收](../../reviews/system-stability-2026-08-17/acceptance.md) |
| 截止条件 | 线上与候选分轨结论完成；外部、灾备、72 小时观察和人工验收均有明确 PASS/FAIL/BLOCKED |

> 时效说明：本文保留 2026-08-17 全方位稳定性阶段的原始失败和未验证项，文中的 PID、Git、release、候选状态与“尚未重启 Gateway”等均是当时截点，不是当前运行真相。后续已完成的 Hermes 迁移、最终版 30 分钟结论和正在进行的 72 小时有效观测，以[用户体验与稳定性 1–7 收口交接单](./ux-stability-1-7-2026-08-18.md)及其验收账本为准；真实外发、付费 Provider、平台草稿和灾备等未授权项仍保留为未验证，不因转交而自动通过。

## 1. 接手目标

- 目标：完成 A君、小D、Paperclip、Hermes、飞书、本地 AI、Publisher 边界、数据恢复和候选版本的全方位稳定性验证。
- 用户约束与不可做事项：Campaign/Cron 始终关闭；只允许小红书、抖音私密草稿；Provider 40 元软停、50 元硬停；不得公开发布、泄露凭据或覆盖任何非本轮稳定性改动。
- 做完的定义：自动化、运行时、真实业务、灾备、72 小时观察和人工验收分别有事实结论，未验证项不得合并成通过。
- 唯一下一步：当前运行态和 72 小时观测由 1–7 交接单继续只读收口；本文剩余的真实外发、Provider、平台草稿、停服务、灾备与人工验收只有在本机负责人分别明确授权后才能执行，未授权前保持 `NOT CHECKED/BLOCKED`。
- 允许继续的前提：任何动作前重新读取实时运行指纹，不得沿用本文 2026-08-17 的固定 PID、Git 或 release。若继续当前 72 小时观测，必须遵守 1–7 交接单中的唯一 run-id、startedAt、CPU v2、有效时长、身份和只读门禁，不得新建平行 run 混淆证据。

## 2. 2026-08-17 截点事实（历史基线）

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | `main@18db26ae...`；正式基线采样时 `changedPathCount=24`，当前 `git status` 为 43 项，其中稳定性范围 15 项（之前 12 项，另加 `task-overview.ts`、`task-validation-overview.ts`、`console-overview-read-model.test.js`），其他 28 项并发/用户改动继续保留 | `stability-20260817-final/baseline.json`、验收记录 | 已验证 |
| 本地运行时 | A君 `4321` / release `8fbea961...`、小D `4318` / release `433c3e53...`、Paperclip `3100` / `2026.722.0` 可达；Publisher 未监听 | 本轮 `baseline.json` | 已验证 |
| 外部平台 | 未发送真实飞书消息、未调用真实 Provider、未创建平台草稿；`4318` 健康可达，但缺少可确认的专用飞书 `chatRef/requestRef`，因此小D真实视频任务未提交；真实研究任务也未提交 | 验收记录 | 未验证 |
| 人工确认 | 用户已选完整灾备、真实业务、双平台私密草稿和 72 小时观察 | 当前任务 | 已确认范围，逐阶段二次确认待完成 |

## 3. 变更与决策

- 已完成：确定线上与候选双轨；创建正式安全基线 `stability-20260817-final`；完成 A君 3 个 SQLite 在线备份、运行指纹、1600 次只读并发、首次 phase1 与 fixed run 复核、本地 AI smoke 和候选隔离 Chromium 验证。`xiaod` Hermes 白名单已做 exact `0600` 备份并 apply，dry-run 0 漂移；除 `skills.disabled` 补入 12 项外语义等价，且尚未重启 Gateway。正式 run 权限已核对为目录 `0700`、文件 `0600`；历史旧 run 修复前含绝对路径 metadata，现仅以 superseded 形式保留。
- 关键文件或外部配置位置：`scripts/stability-observer.mjs`、稳定性验收记录；原始证据只放私有 acceptance 目录。
- 已确定的边界与兼容性约束：不新增生产 API，不改状态或数据库 Schema；故障注入不得暴露到 4321。
- 不要重复创建的产物：不要复制第二套任务账本、预算控制面、Publisher 或 Paperclip 状态；不要重复备份历史 Boom SQLite。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PARTIAL | 首次 phase1 保留 3 个失败；fixed run 仅 Hermes whitelist 只读检查退出码 `2`。其后 `xiaod` 白名单已 exact 备份并 apply，dry-run 0 漂移；`root-test` 严格串行 `3×2431` 全绿，`core-test` 严格串行 `3×2174` 全绿；`scripts/*.test.mjs 82/82`、`public-dynamic fake 4/4`、`runtime-release-client 2/2`、console 定向 `25/25`、全量 `2434/2434`、专项 `96/96`、本地 AI smoke PASS；`npm run check` PASS，`git diff --check` PASS | 白名单配置已修正，但因尚未重启 Gateway，live 会话侧生效仍待复读；自动化通过不等于外部闭环通过 |
| 运行时 | FAIL | `runtime:fingerprint`、最终安全 `baseline.json`、1600 请求 `load.json`、30 分钟 run：62 样本 / `1831.19s` / `resumeCount=1` / 身份通过；RSS gate PASS，`finalToInitialRssRatio=1.193983`、非单调增长，FD `47→38`、峰值 `54`；console 候选规模化隔离复验覆盖 929 个合成任务 / 125 个 workflow，10 并发全 200，`p95=790.13ms`，`campaignCalls=0` | live 旧版 30 分钟门禁 FAIL 不变，且 `4321` 尚未部署候选修复：`requiredEndpointSuccessRate=99.1935%<99.5%`；`/api/health p95=862.34ms>300ms`；`/api/console-overview p95=1710.13ms>1s` 且 2 次超时。候选隔离复验只能记为“待部署/线上复验”，不能冒充 live 已修；72 小时和灾备待补；Publisher `not_ready` |
| 外部平台 | NOT CHECKED | `BV1ymux6BEFU` 官方时长 `772s / 12:52` 符合；`4318` 健康可达；成本账本当前 `0`，40/50 gate 测试生效 | 小D真实视频未提交：缺少可确认专用飞书 `chatRef/requestRef`；真实研究未提交：Paperclip 公司预算仅余 `9` cents（`616/625`，hard-stop warning），且 Provider 尚有 `267` 条未知费用未完成总账核销；两平台草稿仍 blocked |
| 人工验收 | NOT CHECKED | 无 | 运行台、飞书、平台私密可见范围 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：当前时间已过今晚窗口；真实外发、付费、停服和回滚均未获阶段二次确认；`xiaod` Hermes 白名单已 apply，但尚未重启 Gateway 验证 live 生效；Publisher 缺 6 项 production readiness；候选版本尚未整理成独立提交。console 相关源码候选修复目前已通过定向与规模化隔离复验，但 `4321` 尚未部署；因此只能记为“候选修复待部署/线上复验”，不得覆盖 live 旧版 30 分钟 FAIL。真实研究还受 Paperclip 公司预算仅余 `9` cents 与 Provider `267` 条未知费用未核销双重阻塞。72 小时观察仍未启动，5 分钟错误率/积压的权威来源与 24/48/72 小时真实探针仍待外部确认；灾备明日窗口只读预检已完成，但 A君 真实回滚当前不能保证切回现版，需基于新事实再次确认。
- 不得复制或展示的信息：`.env`、token、Cookie、授权链接、私人聊天、Prompt 正文和平台用户标识。
- 需要谁确认：本机负责人需确认是否允许重启 `xiaod` Gateway 以复读白名单生效；并在真实外发、Provider、平台写入、服务中断及线上回滚前分别确认。
- 关闭条件：所有计划项均有 PASS/FAIL/BLOCKED；最终运行指纹与数据完整性复核完成；验收记录同步。
- 关闭证据链接：[稳定性验收](../../reviews/system-stability-2026-08-17/acceptance.md)。
