# M2 第一批 Agent 创建与治理闭环交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 实施中：本机治理闭环、军团总管路由、local 与组织级审批服务层已验证；真实飞书审批与业务验收待完成 |
| 创建时间 | 2026-07-20 CST |
| 关联 PRD | `tasks/prd-m2-first-batch-agent-governance.md` |
| 关联计划 | `docs/plans/m2-first-batch-agent-governance-plan.md` |

## Continue with this

- Goal: 用一个飞书“ A君·军团总管”证明“手机命令 → Mac 路由 → Agent 执行 → 飞书结果”的日常闭环；创建 Agent 再走 Paperclip 审核、受限测试与上线。
- Exact next action: 在手机飞书确认“检查系统状态”的同会话回执；随后发送“外发本次健康摘要”点击 local 审批卡，再发送“公开发布系统摘要”点击组织级审批卡，确认卡片点击后 Paperclip 审批状态与 A君任务状态一致。最后发送“小D整理 + 公开链接”和“创建一个 Agent”。
- Continue only when: Mac 运行时保持本机受控；测试仍保持公开、只读、无生产账号；不得把模型配置、密钥或飞书用户信息写入仓库、日志或验收记录。

## 已确认决策

- 小D是首个已有业务闭环的 Agent，保持飞书直达；
- 简单、低风险、单 Agent 请求不强制进入 Paperclip；
- 普通一次性审批由飞书卡片与 A君本地审批记录闭环；Paperclip 只在创建审核、扩权/外发/预算、跨 Agent 长任务、暂停终止或审计需要时介入；
- 飞书“ A君·军团总管”是唯一日常入口；治理 Agent 不以多个日常机器人形式暴露；
- 自然语言创建请求只生成 `draft`，必须经人工审核、受限测试和真实验收才能 `active`；
- A君仅提供本机能力、授权、健康、恢复与执行适配；治理 Agent 不读取凭据、不自行扩权。

## 验证账本

| 层级 | 当前事实 | 未完成 |
| --- | --- | --- |
| 文档与契约 | 第一批 PRD、飞书手机控制流程、审批分流 ADR、`AgentProposalContract`、治理 SOP 已写入；已明确 Paperclip 离线时组织级请求必须等待治理、不可降级为 local | 组织级 Paperclip 卡待实现 |
| 本机运行时 | 创建草案、状态机、受限测试实例、公开网页能力与防内网读取已验证；`publicreport` 已生成受限报告产物；军团总管可路由三类命令并以飞书事件幂等；local 审批批准后只恢复原任务；飞书卡补丁与回调 API 已接通 | 真实手机点击待验证 |
| 外部平台 | Paperclip 审核任务与批准记录曾真实创建；2026-07-21 已恢复为 `ai.agent-army.paperclip` LaunchAgent，`127.0.0.1:3100` 健康检查通过；Hermes 隔离 Profile 已创建；xiaod Gateway 已连接飞书长连接；军团总管已收到一条真实飞书健康检查并使运维官完成任务 | 飞书回执可见性、local/组织级真实卡片点击、小D/创建 Agent 真实路由与候选 Agent 上线未验证 |

## 当前本机运行事实（2026-07-21）

- 现有 Hermes Gateway 已由 LaunchAgent 重启，当前启动项包含 `AJUN_FEISHU_COMMANDER_INGRESS_URL`；仓库的总管升级补丁已安装到其 Feishu 适配器；
- A君当前由 `ai.agent-army.ajun-runtime` LaunchAgent 在 `127.0.0.1:4321` 运行，工作目录为本仓库 `apps/ajun-runtime`；启动项来源为 `ops/launchd/ai.agent-army.ajun-runtime.plist`，不向局域网开放；
- 本机已实测军团总管“检查系统状态”返回运维结果，重复事件不二次执行；另已实测 `waiting_approval → approve → health_report_ready`；
- 这些是本机运行证据，不等同于飞书用户收到消息。真实入站仍须由飞书客户端发送一条命令验证。
- Paperclip 已恢复：`ai.agent-army.paperclip` 以 `--no-repair` 常驻运行，`127.0.0.1:3100/health` 返回 200。组织级飞书审批服务层会先调用 Paperclip 原生 approve/reject API，再更新 A君任务；真实手机点击尚未验证。

## 风险与关闭条件

- 风险：Paperclip 启动项目前引用本机已缓存的 CLI 版本，升级或清理 npm 缓存前需更新该启动项；飞书卡片回调、飞书统一入口和 Hermes Profile 自动创建能力仍需实测，不能从文档推断可用；
- 关闭条件：手机飞书可完成三条首批命令与一次 local 审批；首个新 Agent 经 Paperclip 审核、受限测试、真实飞书调用和产物验证后上线；失败、拒绝和权限不足路径也有可验证记录；小D回归通过。
