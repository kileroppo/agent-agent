# M2 通用访问底座规划交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 接手中 |
| 创建时间 | 2026-07-20 Asia/Shanghai |
| 交出者 | Codex |
| 接手者 | M2 实施负责人 |
| 关联任务 | `tasks/prd-m2-authorization-connectors.md` |
| 截止条件 | Paperclip 通过 A君执行适配器完成首个低风险任务闭环，且首个低风险授权连接完成真实闭环，或负责人调整范围 |

## 1. 接手目标

- 目标：以 Paperclip 作为军团总控，交付 A君本地执行适配与业务入口；同时把跨网站/软件登录和内容获取从各 Agent 的隐式实现中移出。用户不维护内部工具，运行时提供账号管家、双通道内容获取中心和运维官。
- 用户约束与不可做事项：不读取、回显、传输或记录密码、Cookie、token、授权 URL、用户标识或私密内容；不绕过验证码、二次验证、访问控制或付费墙；未经明确授权不得连接真实外部账号或外发。
- 做完的定义：一个低风险任务完成“Paperclip 创建/分配 → heartbeat 唤醒 A君执行适配器 → 受控业务执行 → 回报阶段、产物、成本、失败 → Paperclip 显示预算、审批和审计”，并由一个已授权读取型平台完成“用户自行授权 → 深度通道优先/通用通道兜底 → 受限 Agent 消费统一内容包 → 脱敏运维事件 → 过期或撤销 → 安全恢复”的真实闭环。
- 唯一下一步：复用已验证的 Paperclip HTTP Adapter 路径，把第二个低风险、无外部副作用的 A君业务岗位接入；先核对现成 Adapter/官方 API，不新增 A君 调度或控制台能力。
- 允许继续的前提：不新增 A君 军团组织、排程、预算、审批或审计页面；不触发飞书、账号连接或外部执行；受限 YouTube 路径和其余 M1 验收按负责人决定后置。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | M2 已实现连接存储/策略、内容路由、通用 `yt-dlp` 适配器、CookieBridge → MediaCrawlerPro 内部深度适配器、运维事件和小D调用；PRD、架构、契约、设计与 ADR 已同步 | `integrations/access/`、`apps/xiaod-media-transcriber/src/content-runtime.js`、实施计划 | 已验证（本地） |
| 本地运行时 | 小D本地文件/公开来源路径保留；隔离服务已验证连接创建、撤销、脱敏事件和页面入口 | `apps/xiaod-media-transcriber` 测试与本地 API 验证 | 已验证（本地） |
| 运行台骨架 | A君运行台能读取五个岗位、登记标准任务、唯一路由和拦截高风险任务；该本地任务存储是过渡业务入口，不是军团控制面 | `apps/ajun-runtime/`、`docs/reviews/m2-army-runtime-skeleton/acceptance.md` | 已验证（本地） |
| Paperclip 总控 | 本机 Paperclip `2026.707.0` 已以私有 loopback 模式运行；内置 HTTP Adapter 已完成 `AGE-18` 从任务分配、heartbeat、A君执行、同任务回报到 done 的闭环 | `apps/ajun-runtime/src/paperclip-heartbeat.js`、`apps/ajun-runtime/src/paperclip-bridge.js`、M2 PRD | 已验证（本机真实集成）；预算/审批待验证 |
| 外部平台 | 同一条所有者授权的 YouTube 视频已通过公开字幕路径完成小D转录、整理和飞书交付；强制浏览器连接的音频获取失败 | `docs/reviews/m2-authorization-connectors/acceptance.md` | P5 部分通过 |
| 人工确认 | A 君已确认登录和内容获取是跨 Agent 通用能力；MediaCrawlerPro 优先、通用能力兜底；运维官纳入 M2；先搭底座后以 YouTube 验证 | 当前会话 | 已确认 |

## 3. 变更与决策

- 已完成：M2 子 PRD、总 PRD、系统架构、设计、README 和 ADR 已同步；Paperclip 是军团唯一总控，飞书承担日常业务入口，A君是本机能力、执行适配、授权、诊断和恢复底座的边界已明确。
- 已完成：本机 Paperclip `2026.707.0` 已安装并以私有 loopback 模式运行；`A君本机健康官` 使用内置 HTTP Adapter 完成 `AGE-18` 真实闭环。Paperclip 的重复 heartbeat 由 A君按任务 ID 合并，只有一条业务执行回报。
- 已完成：调研 `yt-dlp`、MediaCrawlerPro、`web-access`、`agent-reach`、`scout`、`last30days-skill`、AutoCLI 与 bb-browser；M2 PRD 已记录各自的可复用边界。它们只能作为授权网关内部的候选执行器或规则参考，不能向 Agent 暴露浏览器会话或原始凭据。
- 关键文件：`tasks/prd-m2-authorization-connectors.md`、`tasks/prd-agent-army-master.md`、`docs/architecture/system-architecture.md`、`docs/contracts/core-contracts.md`。
- 已确定的边界：业务 Agent 不保存/读取原始凭据，不直接绑定底层工具；账号管家只按命名连接与动作授予能力；内容获取中心按注册表路由；运维读取健康元数据，审核控制范围与扩权。
- 已完成的首个技术切片：已实现账号管家、`ContentAcquisitionCenter.fetch(source, requestedCapabilities, connectionId?)`、一个通用 `yt-dlp` 适配器、一个 CookieBridge → MediaCrawlerPro 深度适配器和脱敏运维事件；返回统一内容包或安全失败，不返回凭据。P5 发现通用适配器仍用 `--cookies-from-browser` 尝试消费浏览器会话，不能作为合规授权实现。
- 已确定的产品边界：`yt-dlp`、MediaCrawler、CookieBridge、AutoCLI、bb-browser 等不作为用户需安装和维护的独立软件；它们只能是 A君内部实现候选，进入发行包前仍需许可证、供应链、macOS 兼容性和平台条款审查。用户日常面对 A君.app；需要登录时仅按需启用 A君浏览器伴侣。
- 不要重复创建的产物：不要继续把 A君 扩展成军团组织图、任务队列、定时调度、预算、审批或审计后台；这些能力以 Paperclip 的真实适配链路为准。
- 不要重复创建的产物：不要为每个平台创建保存 Cookie 的独立 Agent；不要在飞书补充输入中请求 Cookie；不要让业务 Agent 直接调用 MediaCrawlerPro、`yt-dlp`、CookieBridge 或浏览器会话。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASSED | `apps/xiaod-media-transcriber npm test` 21/21 | 真实浏览器授权媒体获取 |
| 运行时 | PARTIAL | 连接创建、撤销与脱敏恢复事件已验证 | 受控浏览器媒体获取、转录整理与交付 |
| 外部平台 | PARTIAL | 一条所有者授权的公开视频字幕路径已转录、整理并交付；浏览器连接任务在“下载音频”后失败 | 受控浏览器授权媒体获取 |
| 人工验收 | PARTIAL | A 君授权了单条只读验证并收到飞书交付 | 修复后确认受限视频路径 |
| Paperclip 总控 | PARTIAL | `AGE-18`：内置 HTTP Adapter → A君本机健康检查 → 同任务 done；重复 heartbeat 仅一条 A君业务执行回报 | 预算、审批、非健康岗位与外部能力 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：运行台与基础岗位仍是本地骨架，尚未接入 Paperclip 的真实 Agent 调度；P5 浏览器授权路径、系统密钥链、MediaCrawlerPro 深度通道、许可证和运行兼容性均已按负责人决定后置。
- 不得复制或展示的信息：任何凭据、Cookie、token、授权 URL、浏览器会话、用户标识、私密媒体内容。
- 需要谁确认：A 君指定首个平台与读取范围；审核策略负责人确认读取范围；实施者选择安全存储与授权入口后需架构复核。
- 关闭条件：完成 Paperclip Agent 适配/heartbeat/预算/审批/审计/回报验证、M2 契约测试、受控运行时、深度/通用通道切换、运维事件和一个真实低风险连接的完整验收，并同步验收记录与 README。
- 关闭证据链接：[M2 授权连接与内容获取验收](../../reviews/m2-authorization-connectors/acceptance.md)。
