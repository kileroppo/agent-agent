# 用户体验与稳定性 1–7 收口交接单

| 字段 | 内容 |
| --- | --- |
| 状态 | 当前正式线上 `0b5b08d / ef6ed69c…` 的独立 30 分钟已 PASS，唯一 72 小时 staggered2 观察进行中 |
| 创建时间 | 2026-08-18 01:28 CST |
| 交出者 | Codex |
| 接手者 | Codex / 本机负责人 |
| 关联任务 | [1–7 验收账本](../../reviews/ux-stability-1-7-2026-08-17/acceptance.md) |
| 截止条件 | 最终线上版本的 72 小时有效观测自然完成，全部机器门禁与最终运行/UI 回读闭环 |

## 1. 接手目标

- 目标：关闭健康与性能真相、发布真相、Hermes 默认拒绝、热路径减负、送达回执、控制台减法和核心状态类型 1–7 项。
- 用户约束与不可做事项：保留用户脏工作区；不夹带发布；不发送真实飞书、不公开发布、不调用付费 Provider；发布、回滚和常驻服务变更必须按既有受控边界执行。
- 做完的定义：1–7 代码和自动化、最终版本真实发布/失败恢复、真实浏览器 UI、独立 30 分钟与最终 72 小时门禁都有当前线上 `0b5b08d / ef6ed69c…` 同版本证据；未知项不冒充成功。
- 唯一下一步：只读守护唯一长测 `ux-stability-72h-0b5b08d-ef6ed69c-cpuv2-effective-staggered2-20260818T012800Z` 至自然完成并关闭账本。
- 允许继续的前提：不得把早期样本或进程存活写成 72 小时通过；不得继承旧 run 的 startedAt、样本或有效观察时长；除只读守护和既有 observer 自然采样外，不发送飞书、不公开发布、不调用付费 Provider。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 1–7 与复审加固基线仍完整包含在 `0b5b08d`；相对 `a56f8c0` 的新增提交只触达小D公开视频直达链路与其测试/安装器，没有改动 observer、release helper、health、delivery、types 主干 | `git merge-base --is-ancestor a56f8c0 0b5b08d = yes`、`git diff --name-only a56f8c0..0b5b08d`、定向测试 | 已验证 |
| 最终发布 | 用户已授权切换；当前已激活完整 Git `0b5b08d88f11a9673a7f3d54886f462929b10e8e` / release `ef6ed69cc2982917aa0f86e388d453e10d5bc043ebf653e5e5736499b50aceea` / payload `b397a646…`；正式 validator `7347` entries 与 smoke 通过 | validator、发布助手记录、release API | 已验证并上线 |
| 本地运行时 | 线上为 Git `0b5b08d88f11a9673a7f3d54886f462929b10e8e` / release `ef6ed69cc2982917aa0f86e388d453e10d5bc043ebf653e5e5736499b50aceea` / payload `b397a646…` / PID `78965`，八项运行身份检查全 true；回滚入口为 `a56f8c0 / 60c09c36… / 7828…` | `status.json`、4321 API、PID/cwd/argv/监听与 HTTP 回读 | 已验证 |
| 历史观测收口 | `a56f8c0 / 60c09c36…` 两条 run 因身份漂移 fail-closed；首轮普通权限 `0b5` 两条 run 在 19 样本受控停止；同秒启动的安全 72 小时 run 因双探针同步 timeout 在 29 样本 `stopRequested=true` 受控停止；staggered1 因实际偏移 `9.6s < 10s` 在 4 样本受控停止。所有旧长测均锁释放、证据保留且禁止 resume | 历史 manifest、observations、summary、锁与 launchd 回读 | 正确终止；非最终结果失败 |
| 独立短期观测 | 安全 run `ux-stability-30m-0b5b08d-ef6ed69c-cpuv2-effective-20260818T010227Z` 自然完成：61 样本/`1801.37s`/remaining 0/`stopRequested=false`/`identityFailure=null`；required `243/244 = 99.5902%`，唯一 overview `3001ms` timeout；CPU v2 `60/60`、coverage 1、P95 `4.30%`；RSS `185.81→172.36 MB`、max `195.30 MB`、ratio `0.928`；identity、cost `0/open`、61 个 externalEffects=false 全通过。observer 自然退出、锁释放、supervisor runs=1 未重启，label 已清理、证据保留 | summary、manifest、observations、cost ledger、launchd/锁回读 | 已完成 PASS |
| 长期观测 | 唯一安全 run `ux-stability-72h-0b5b08d-ef6ed69c-cpuv2-effective-staggered2-20260818T012800Z`，label `ai.agent-army.stability-72h-0b5b08d-ef6ed69c-staggered2-012800`，supervisor/observer PID `36484/36489`；`resumeCount=0`，实际错峰 `14.779–15.660s`；首 6 样本 required `24/24`、CPU v2 P95 `4.23%`、RSS/identity/cost/externalEffects 当前通过 | 私有 acceptance run 的 manifest、observations、cost ledger、launchd print | 远未完成，阶段性通过，未裁决 |
| 外部平台 | 本轮未发送真实飞书、未公开发布、未调用付费 Provider；线上 5 条 `delivery_unknown` 仍显示为未知、停止自动重发并留给人工核对 | 验收账本、live console overview | 边界已验证，外部送达未执行 |

## 3. 变更与决策

- 已完成：1–7 实现；历史版本真实发布→回滚→再发布；CPU 累计时间差 v2；睡眠 gap 有效时长；launchd supervisor；费用/自然完成/外部副作用 fail-closed summary；发布、送达、Hermes 迁移、可靠性锁与状态类型复审加固；当前 `0b5b08d` 的 validator `7347` entries、smoke、八项身份检查与真实 DOM/移动详情/list 503 恢复回读通过；安全独立 30 分钟 run 已自然完成 PASS；同步 72 小时与 staggered1 均按工具边界受控停止，staggered2 已成为唯一长测。
- 关键文件或外部配置位置：`scripts/stability-observer.mjs`、`scripts/stability-observer-supervisor.mjs`、[1–7 验收账本](../../reviews/ux-stability-1-7-2026-08-17/acceptance.md)；原始运行证据仅保存在本机私有 acceptance 目录。
- 已确定的边界与兼容性约束：已完成的 30 分钟 healthy 结论不得被同身份未完成长测覆盖，live UI 必须明确它只代表 30 分钟；长测只有成本 open、自然完成、全样本无外部副作用、CPU v2、RSS、端点与身份全部可判定时才允许 healthy。所有已终止长测均不得恢复、resume 或改绑；只有 staggered2 是当前 72 小时真相。
- 不要重复创建的产物：不要新建平行任务账本、稳定性 run、发布控制面或可靠性快照格式。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 当前最终 release 的正式 validator 核对 `7347` entries，smoke 通过；发布与运行身份八项检查全 true | 72 小时运行证据不由 validator 或 smoke 替代 |
| 运行时 | IN PROGRESS | 当前线上 `0b5b08d / ef6ed69c… / b397a646… / PID 78965` 八项检查全 true；安全独立 30 分钟 run 已自然完成 PASS，0600 runtime-reliability 为 healthy；唯一 72 小时 staggered2 run 首 6 样本 required `24/24`、CPU v2 P95 `4.23%`、RSS/identity/cost/externalEffects 当前通过 | 72 小时尚未自然完成；阶段性 pass 不是长期结论 |
| UI | PASS | 当前 live `0b5b08d / ef6ed69c…` 的 1440/390/320、移动详情与 list 503 恢复路径真实回读全部通过；reliability 文案已回读 healthy，并明确只代表 30 分钟结论 | 报告 `/tmp/ajun-live-ui-0b5b08d.JkknDE`；72 小时完成后仍需归档最终回读 |
| 外部平台 | NOT CHECKED | 本轮明确没有真实外发、公开发布或付费调用；5 条 `delivery_unknown` 保持人工核对边界 | 不属于本轮已通过结论，继续保持未验证 |
| 人工验收 | PARTIAL | 用户已授权持久运行态切换，切换与新 run 启动已执行 | 最终 72 小时结论尚待回报 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：没有待确认的切换阻塞。独立 30 分钟已自然完成 PASS；唯一未完成项是 staggered2 72 小时 run，首 6 样本通过但距离自然完成仍很远。同步 timeout 与不足 10 秒错峰的历史证据均保留，不并入当前 run。系统睡眠和大 gap 最多记一个 interval，会顺延而不会虚增完成时长。5 条 `delivery_unknown` 继续留给人工核对。
- 不得复制或展示的信息：`.env`、token、Cookie、授权链接、私人聊天、Prompt 正文和平台用户标识。
- 需要谁确认：持久运行态切换已获用户授权并完成；无需再次确认只读守护。真实飞书发送、公开发布或付费 Provider 仍不在本次授权范围内。
- 关闭条件：summary 明确 `effectiveObservedSeconds >= 259200`、`remainingDurationSeconds = 0`、`stopRequested = false`；availability/P95/CPU v2 coverage 与 P95/RSS/identity/cost/external-effects 全部通过；observer 自然退出、supervisor 不重启、锁释放；4321 运行身份和真实 UI 回读一致；验收账本与索引提交。
- 关闭证据链接：[1–7 验收账本](../../reviews/ux-stability-1-7-2026-08-17/acceptance.md)。
