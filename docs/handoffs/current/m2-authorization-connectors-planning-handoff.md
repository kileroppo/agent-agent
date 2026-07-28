# M2 通用访问底座规划交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-07-27 Asia/Shanghai（更新） |
| 交出者 | Codex |
| 接手者 | M2 实施负责人 |
| 关联任务 | `tasks/prd-m2-authorization-connectors.md` |
| 截止条件 | 已完成：用户从 A君正式入口登录、刷新并授权，新连接完成真实只读任务 |

## 1. 接手目标

- 目标：以 Paperclip 作为军团总控，交付 A君本地执行适配与业务入口；同时把跨网站/软件登录和内容获取从各 Agent 的隐式实现中移出。用户不维护内部工具，运行时提供账号管家、双通道内容获取中心和运维官。
- 用户约束与不可做事项：不读取、回显、传输或记录密码、Cookie、token、授权 URL、用户标识或私密内容；不绕过验证码、二次验证、访问控制或付费墙；未经明确授权不得连接真实外部账号或外发。
- 做完的定义：一个低风险任务完成“Paperclip 创建/分配 → heartbeat 唤醒 A君执行适配器 → 受控业务执行 → 回报阶段、产物、成本、失败 → Paperclip 显示预算、审批和审计”，并由一个已授权读取型平台完成“用户自行授权 → 深度通道优先/通用通道兜底 → 受限 Agent 消费统一内容包 → 脱敏运维事件 → 过期或撤销 → 安全恢复”的真实闭环。
- 唯一下一步：无；M2 已完成。来源链接敏感参数安全保存仅在进入多人、云端或远程访问前重新立项。
- 允许继续的前提：只由本机所有者操作，不在聊天或页面粘贴 Cookie、密码或 token；遇到验证码、二次验证或平台拒绝立即停下，由所有者本人处理。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | A君已提供白名单平台登录、刷新已登录账号、创建连接、续期、暂时禁用和撤销；小D连接存储支持同 ID 续期恢复，所有动作保持原最小权限 | `apps/ajun-runtime/src/access-connection-service.js`、`apps/ajun-runtime/public/`、`apps/xiaod-media-transcriber/src/server.js`、`integrations/access/connection-store.js` | 已验证 |
| 本地运行时 | launchd 管理的 A君与小D已重启加载当前工作区；`4321`、`4318` 和登录选项接口均返回 HTTP 200 | [验收记录](../../reviews/m2-authorization-connectors/acceptance.md) | 已验证 |
| 运行台骨架 | A君运行台能读取五个岗位、登记标准任务、唯一路由和拦截高风险任务；该本地任务存储是过渡业务入口，不是军团控制面 | `apps/ajun-runtime/`、`docs/reviews/m2-army-runtime-skeleton/acceptance.md` | 已验证（本地） |
| Paperclip 总控 | 组织级任务、heartbeat、预算/审批门禁、审计投影、跨员工任务和失败恢复已有独立验收；A君不复制第二套控制面 | M2 PRD 与对应验收记录 | 已验证 |
| 外部平台 | 小红书低风险素材已完成命名连接读取、转录、飞书交付、撤销前拦截、重新授权和恢复交付；连接随后又完成暂时禁用与同 ID 续期 | [验收记录](../../reviews/m2-authorization-connectors/acceptance.md) | 已验证 |
| 人工确认 | 所有者已确认首次飞书文档，并从 A君入口完成实际登录和授权；新连接随后完成真实任务 | 当前会话、[验收记录](../../reviews/m2-authorization-connectors/acceptance.md) | 已确认 |

## 3. 变更与决策

- 已完成：M2 子 PRD、总 PRD、系统架构、设计、README 和 ADR 已同步；Paperclip 是军团唯一总控，飞书承担日常业务入口，A君是本机能力、执行适配、授权、诊断和恢复底座的边界已明确。
- 已完成：A君正式账号页只开放小红书、抖音、哔哩哔哩和快手的固定登录页；用户可刷新浏览器伴侣账号、授权给小D、续期、暂时禁用或永久撤销。
- 已完成：真实小红书连接经 A君完成 `active → disabled → active`，连接 ID、允许员工、动作和数据范围保持不变；浏览器页面续期提交返回 HTTP 200。
- 已完成：本机 Paperclip `2026.707.0` 已安装并以私有 loopback 模式运行；`A君本机健康官` 使用内置 HTTP Adapter 完成 `AGE-18` 真实闭环。Paperclip 的重复 heartbeat 由 A君按任务 ID 合并，只有一条业务执行回报。
- 已完成：调研 `yt-dlp`、MediaCrawlerPro、`web-access`、`agent-reach`、`scout`、`last30days-skill`、AutoCLI 与 bb-browser；M2 PRD 已记录各自的可复用边界。它们只能作为授权网关内部的候选执行器或规则参考，不能向 Agent 暴露浏览器会话或原始凭据。
- 关键文件：`tasks/prd-m2-authorization-connectors.md`、`tasks/prd-agent-army-master.md`、`docs/architecture/system-architecture.md`、`docs/contracts/core-contracts.md`。
- 已确定的边界：业务 Agent 不保存/读取原始凭据，不直接绑定底层工具；账号管家只按命名连接与动作授予能力；内容获取中心按注册表路由；运维读取健康元数据，审核控制范围与扩权。
- 已完成的首个技术切片：已实现账号管家、`ContentAcquisitionCenter.fetch(source, requestedCapabilities, connectionId?)`、一个通用公开适配器和脱敏运维事件；返回统一内容包或安全失败，不返回凭据。旧 `--cookies-from-browser` 已被拒绝，不能再作为授权实现。
- 已确定的产品边界：`yt-dlp`、MediaCrawler、CookieBridge、AutoCLI、bb-browser 等不作为用户需安装和维护的独立软件；它们只能是 A君内部实现候选，进入发行包前仍需许可证、供应链、macOS 兼容性和平台条款审查。用户日常面对 A君.app；需要登录时先检索已有合规连接器，不预设浏览器伴侣实现。
- 不要重复创建的产物：不要继续把 A君 扩展成军团组织图、任务队列、定时调度、预算、审批或审计后台；这些能力以 Paperclip 的真实适配链路为准。
- 不要重复创建的产物：不要为每个平台创建保存 Cookie 的独立 Agent；不要在飞书补充输入中请求 Cookie；不要让业务 Agent 直接调用 MediaCrawlerPro、`yt-dlp`、CookieBridge 或浏览器会话。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASSED | A君 `411/411`；小D `31/31`；聚焦连接测试 `20/20` | 用户从零登录 |
| 运行时 | PASSED | launchd 重启后 A君、小D与登录选项 HTTP 200；真实禁用、续期、非法平台拒绝和页面续期提交均通过 | 无 |
| 外部平台 | PASSED | 小红书从零登录、真实读取、撤销拦截、重新授权和恢复交付均通过 | 无 |
| 人工验收 | PASSED | 所有者确认首次飞书文档，并从 A君完成实际登录与新连接授权 | 无 |
| Paperclip 总控 | PASSED | 组织任务、heartbeat、预算/审批和审计已有独立验收 | 本交接不重复验收 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：M2 无阻塞。当前单用户、本机回环阶段由负责人接受来源链接敏感参数保存在本机任务状态的已知风险；使用边界扩大前必须重新处理。
- 不得复制或展示的信息：任何凭据、Cookie、token、授权 URL、浏览器会话、用户标识、私密媒体内容。
- 需要谁确认：已由所有者确认。
- 关闭条件：已满足；新连接“授权测试0727”完成获准只读任务，PRD、验收记录和本交接已同步。
- 关闭证据链接：[M2 授权连接与内容获取验收](../../reviews/m2-authorization-connectors/acceptance.md)。
