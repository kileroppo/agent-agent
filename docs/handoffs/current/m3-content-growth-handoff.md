# M3 内容增长与知识归档交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 接手中 |
| 创建时间 | 2026-07-27（Asia/Shanghai） |
| 交出者 | Codex 工作台 |
| 接手者 | 当前实施会话 / A 君 |
| 关联任务 | [M3 PRD](../../../tasks/prd-m3-content-analysis-and-knowledge-archive.md)、[验收账本](../../reviews/m3-content-growth/acceptance.md) |
| 截止条件 | 两个新增岗位完成真实闭环，或外部人工门禁明确保留为待验收 |

## 1. 接手目标

- 目标：完成小D证据链、小拆、小创和小办知识归档的 M3 首批闭环。
- 用户约束与不可做事项：不自动发布，不读取/记录 Cookie、token 或微信明文数据库；转录默认自动质量确认，但不得冒充真人完整听审。
- 做完的定义：以 M3 PRD 完成门禁和验收账本为准。
- 唯一下一步：由负责人阅读真实可拍脚本 `apps/ajun-runtime/data/content-growth-artifacts/m3-script-package-hermes-v2-20260728/video-script-package/script.md`，给出“用这版”或一句具体修改意见；如需验证飞书自然语言闭环，再单独授权发送测试消息。
- 允许继续的前提：不得把历史 `partial` 或 `deterministic_fallback` 当作正式图文稿；当前草稿保持 `draft_only`，任何飞书测试消息或对外发布都需另行明确授权。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | 两个岗位、视频拆解/草稿/可拍脚本/表现复盘工具、小D时间轴/视觉证据、小办归档已实现 | 相关 Manifest、`apps/ajun-runtime/src/`、`apps/xiaod-media-transcriber/src/` | 已验证 |
| 本地运行时 | 550 项自动测试、真实 B站 48 帧图文分析、本地上传路由、真实小创草稿和统一知识库写入均通过 | [验收账本](../../reviews/m3-content-growth/acceptance.md) | 已验证 |
| Paperclip | 两个岗位已完成审核批准、测试实例、激活和真实 heartbeat | [heartbeat 证据](../../reviews/m3-content-growth/paperclip-heartbeat-evidence-2026-07-27.md) | 已验证 |
| 外部平台 | 旧版真实 URL、听审、确认及 13 模块报告已走过 A君原飞书会话；新版图文复验按授权边界只在本机运行 | [验收账本](../../reviews/m3-content-growth/acceptance.md) | 新版未发送飞书 |
| 人工确认 | 负责人已完成旧链路听审；新版自动确认稿明确 `completeListen=false`，故事板已抽查可读 | `transcript-review.js`、[验收账本](../../reviews/m3-content-growth/acceptance.md) | 新版拆解与草稿质量待验收 |

## 3. 变更与决策

- 已完成：证据化转录、自动/人工确认版本、图文联合拆解、基于真实报告的小创草稿、参考案例自动匹配、一版可拍脚本、五件生产包、试用/验证/退役规则、小办真实任务受限归档、A君路由和 MCP 工具。
- 新默认：质量门禁通过时由小D自动生成系统确认稿；异常或用户明确要求时仍进入人工听审。自动确认与人工确认使用不同证明产物和 `completeListen` 值。
- 关键文件：见 M3 PRD 和验收账本。
- 兼容性约束：顶层 Task/Artifact/ContentPackage 不变；新岗位无独立飞书 Gateway；正式创作只接受确认稿与正式拆解。
- 不要重复创建：任务队列、审批系统、账号系统、控制台，以及抖音/小红书直连脚本。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | A君与小D完整测试通过；新增参考匹配、五件生产包、“用这版”、模板生命周期和 ASR 置信门禁均有回归 | 不替代外部平台与人工验收 |
| 运行时 | PASS | `npm run acceptance:m3-content-growth -- --write-real-vault` | 不证明外部平台或人工质量 |
| Hermes | PASS | 两个隔离 Profile 真实调用 `openai-codex / gpt-5.6-terra`；新增可拍脚本真实调用见 M3-REAL-007 | 不证明飞书或人工质量 |
| Paperclip | PASS | `AGE-433`、`AGE-434` 合成 heartbeat、旧版真实视频 `AGE-452`、新版图文任务 `AGE-506` 与真实小创任务 `AGE-510` 均成功；[验收账本](../../reviews/m3-content-growth/acceptance.md) | 人工内容质量 |
| 外部平台 | PARTIAL | 旧版原飞书会话闭环已通过；新版 `AGE-506` 按授权只做本机真实复验 | 新版图文报告飞书交付 |
| 人工验收 | PARTIAL | 负责人已完整听审旧任务；新版故事板已抽查 | 新版图文拆解与草稿质量 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：图文、真实小创草稿、可拍脚本生产包与真实任务归档已经完成本机闭环；当前只剩负责人对新版内容质量的判断。新版飞书交付未获本轮测试消息授权，因此没有执行。
- 旧任务曾把 `deterministic_fallback` 误算为成功并只回传“2/2”；后续两个图文任务又因跨句时间戳校验误判保持 `partial`。失败记录均保留。新任务 `9c9b745a-7d15-4315-b3b3-10ed076e638a` 已原生通过文本与画面语义门禁，报告 SHA-256 为 `2d853e85c5e36cda47c5d03169f83d86abbce7813eb4643ea1c871802bb31898`。
- 不得复制或展示的信息：任何 secret、token、Cookie、私密聊天和微信明文数据。
- 需要谁确认：A 君本人阅读新版报告与草稿并判断内容质量；自动确认稿不要求补做人工听审，除非质量异常或负责人明确要求。
- 关闭条件：M3 验收账本关闭条件全部满足。
- 关闭证据链接：[M3 验收账本](../../reviews/m3-content-growth/acceptance.md)。
