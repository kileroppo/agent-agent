# M3 内容增长与知识归档交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 已关闭 |
| 创建时间 | 2026-07-27（Asia/Shanghai） |
| 交出者 | Codex 工作台 |
| 接手者 | 当前实施会话 / A 君 |
| 关联任务 | [M3 PRD](../../../tasks/prd-m3-content-analysis-and-knowledge-archive.md)、[验收账本](../../reviews/m3-content-growth/acceptance.md) |
| 截止条件 | 两个新增岗位完成真实闭环，或外部人工门禁明确保留为待验收 |
| 关闭时间 | 2026-07-30 Asia/Shanghai |

## 1. 接手目标

- 目标：完成小D证据链、小拆、小创和小办知识归档的 M3 首批闭环。
- 用户约束与不可做事项：不自动发布，不读取/记录 Cookie、token 或微信明文数据库；转录默认自动质量确认，但不得冒充真人完整听审。
- 做完的定义：以 M3 PRD 完成门禁和验收账本为准。
- 唯一下一步：M3 无剩余动作；后续 M4 记录见 [已归档交接](./m4-autonomous-agent-capabilities-handoff.md)。
- 允许继续的前提：不得把历史 `partial` 或 `deterministic_fallback` 当作正式图文稿；当前草稿保持 `draft_only`，任何飞书测试消息或对外发布都需另行明确授权。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 两个岗位、视频拆解/草稿/可拍脚本/表现复盘工具、小D时间轴/视觉证据、小办归档已实现；“保存短剧脚本为生产包”不会再误派办公助理，明确成品请求必须创建真实任务 | `apps/ajun-runtime/src/business-task-routing.js`、`agents/ajun/prompts/system.md`、相关 Manifest | 已验证 |
| 本地运行时 | 2026-07-29 A君 500 项测试通过；Hermes 飞书补丁 7 项与岗位契约 10 项通过。A君运行台和真实接管飞书的 default Gateway 已重启加载，活动任务与待审批均为 0 | 本交接单验证账本、[验收账本](../../reviews/m3-content-growth/acceptance.md) | 已验证 |
| Paperclip | 两个岗位已完成审核批准、测试实例、激活和真实 heartbeat | [heartbeat 证据](../../reviews/m3-content-growth/paperclip-heartbeat-evidence-2026-07-27.md) | 已验证 |
| 微信本机 Vault 候选岗位 | Proposal `430380ef-932d-4eea-98c3-27e905668771` 已由 StepFun 审核官完成受限测试审核，合成验收通过；仍处于 `testing`，未激活且未读取真实聊天 | [M3-REAL-008](../../reviews/m3-content-growth/acceptance.md#m3-real-008微信本机-vault-岗位受控合成验收) | 合成 PASS；真实读取未执行 |
| 外部平台 | 旧版真实 URL、听审、确认及 13 模块报告已走过 A君原飞书会话；新版图文复验按授权边界只在本机运行 | [验收账本](../../reviews/m3-content-growth/acceptance.md) | 新版未发送飞书 |
| 人工确认 | 负责人已完成旧链路听审，并于 2026-07-30 确认已在 2026-07-29 完成新版报告、草稿和最终脚本闭环验收 | [M3-REAL-009](../../reviews/m3-content-growth/acceptance.md#m3-real-009负责人最终内容与飞书闭环验收) | 已验证 |

## 3. 变更与决策

- 已完成：证据化转录、自动/人工确认版本、图文联合拆解、基于真实报告的小创草稿、参考案例自动匹配、一版可拍脚本、五件生产包、试用/验证/退役规则、小办真实任务受限归档、A君路由和 MCP 工具。
- 2026-07-29 修复：服务端会把误选的 `office.briefing-package` 短剧脚本请求纠正为 `content.video-script-package`；A君 Prompt 明确禁止只在聊天里写成品而不建任务；飞书关闭压缩排队、长时心跳和记忆更新等内部通知，原生操作授权卡改为中文业务文案。
- 新默认：质量门禁通过时由小D自动生成系统确认稿；异常或用户明确要求时仍进入人工听审。自动确认与人工确认使用不同证明产物和 `completeListen` 值。
- 关键文件：见 M3 PRD 和验收账本。
- 兼容性约束：顶层 Task/Artifact/ContentPackage 不变；新岗位无独立飞书 Gateway；正式创作只接受确认稿与正式拆解。
- 不要重复创建：任务队列、审批系统、账号系统、控制台，以及抖音/小红书直连脚本。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 2026-07-29：A君 500/500、Hermes 飞书补丁 7/7、岗位契约 10/10；此前小D与 M3 验收见关联账本 | 不替代外部平台与人工验收 |
| 运行时 | PASS | A君运行台 PID 55055 监听 `127.0.0.1:4321`；default Hermes Gateway 由 launchd 以 PID 55904 监督；活动任务 0、待审批 0 | 不证明修复后的真实飞书消息呈现 |
| Hermes | PASS | 两个隔离 Profile 真实调用 `openai-codex / gpt-5.6-terra`；新增可拍脚本真实调用见 M3-REAL-007 | 不证明飞书或人工质量 |
| Paperclip | PASS | `AGE-433`、`AGE-434` 合成 heartbeat、旧版真实视频 `AGE-452`、新版图文任务 `AGE-506` 与真实小创任务 `AGE-510` 均成功；[验收账本](../../reviews/m3-content-growth/acceptance.md) | 人工内容质量 |
| 微信本机 Vault | SYNTHETIC PASS | StepFun 审核 `AGE-582`；测试审批投影 `AGE-583`；受控验收产物见 M3-REAL-008 | 真实联系人/群与时间范围下的逐次授权读取 |
| 外部平台 | PASS | 旧版原飞书会话闭环已通过；负责人确认 2026-07-29 已完成修复后的最终脚本自然语言闭环 | 无 M3 关闭阻塞 |
| 人工验收 | PASS | 负责人已完整听审旧任务，并完成新版图文拆解、草稿和可拍脚本质量判断 | 无 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：M3 关闭条件已满足。错误任务 `b4f237bb-ea67-4b66-a9f3-7d773732f8fe` 继续作为历史失败记录保留，没有生成视频或发布。
- 旧任务曾把 `deterministic_fallback` 误算为成功并只回传“2/2”；后续两个图文任务又因跨句时间戳校验误判保持 `partial`。失败记录均保留。新任务 `9c9b745a-7d15-4315-b3b3-10ed076e638a` 已原生通过文本与画面语义门禁，报告 SHA-256 为 `2d853e85c5e36cda47c5d03169f83d86abbce7813eb4643ea1c871802bb31898`。
- 不得复制或展示的信息：任何 secret、token、Cookie、私密聊天和微信明文数据。
- 微信专项继续条件：真实验收必须由负责人另行指定唯一联系人或群、开始时间和结束时间，并完成与该请求绑定的一次性审批；当前合成通过不得视为真实读取或生产激活。
- 需要谁确认：负责人已于 2026-07-30 完成最终确认。
- 关闭条件：M3 验收账本关闭条件已全部满足。
- 关闭证据链接：[M3 验收账本](../../reviews/m3-content-growth/acceptance.md)。
