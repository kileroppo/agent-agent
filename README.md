# Agent军团

Agent军团是一套以飞书为日常业务入口、以 Hermes 等运行时承载各 Agent、以 Paperclip 作为组织级治理总控、以 A君本地运行时承载通用能力与故障恢复的数字员工系统。用户既可以把目标交给飞书中的“ A君·军团总管”，也可以按需直接私聊独立员工；每名员工拥有自己的 Hermes Profile、会话/记忆、岗位 Prompt、Skill 与最小 MCP 作用域。A君局域网页只作为授权、诊断和应急入口，不与飞书重复日常派活。

这个仓库的根目录用于承载军团级架构、岗位定义、公共能力、平台集成和运维设施。每个可独立运行的业务 Agent 放在 `apps/` 下，不再让某一个 Agent 代表整个项目。

## 目录结构

```text
agent-agent/
├── apps/           可独立运行、部署和验收的业务 Agent
│   └── xiaod-media-transcriber/  小D：音视频转录整理与飞书交付
├── agents/         数字员工的岗位、职责、权限和质量标准
├── integrations/   Paperclip、Hermes、飞书等平台适配层
├── packages/       多个 Agent 共用的代码与能力模块
├── ops/            本地运行、部署、监控和恢复工具
├── tasks/          总 PRD、里程碑 PRD 和实施状态
├── docs/           产品、设计、架构、契约、规范和验收记录
└── designs/        可运行的 UI 原型与设计资产
```

### 局域网项目进度看板

多项目进度 H5 位于 `apps/project-progress-board/`，项目、阶段和任务保存在本机 SQLite，默认访问 `http://127.0.0.1:4320`。详见 [项目进度看板 README](./apps/project-progress-board/README.md) 和 [设计说明](./docs/design/project-progress-board.md)。

这些目录先定义清楚职责，不提前引入 monorepo、统一构建或部署框架。出现第二个真实应用或共享模块后，再根据实际依赖补充工作区工具。

## 当前状态

- 当前里程碑：**M2 军团总控与通用能力——第一批真实验收与完善**。
- 已确认 Agent军团长期目标、M0–M4 路线和 M1 小D需求。
- 已建立文档治理、系统架构、核心契约、代码/目录规范和测试门禁。
- M1 飞书交互原型已通过 A 君人工评审。
- 小D版本化 AgentManifest、Prompt、评测样例和 Hermes Profile 映射已建立并通过本地契约检查；A君可把带公开链接的素材任务委派给本机小D并跟踪其状态，真实素材验收仍按 M1 节奏受控进行。
- 隔离 `xiaod` Hermes Profile 与传统飞书机器人测试应用已创建并发布；传统机器人已完成真实文本消息收发与模型回复验证。短媒体已真实完成转录、飞书文档权限与交付，并通过一次“受控失败 → 飞书重试 → 同一任务单次交付”回归；约 10 分钟媒体已完成真实阶段与交付验证；后台阶段更新故障与其余M1场景仍待验证；Paperclip 已确认延后到 M2。
- M2 已进入受控验收：小D 已接入统一账号管家、通用内容获取中心和脱敏运维事件；旧浏览器会话/Cookie 读取路径已关闭。YouTube 公开视频字幕统一由内置 `yt-dlp` 读取，已完成真实交付；不要求登录，不读取 Cookie。A君运行台现复用同一账号管家，只显示脱敏连接状态并允许本机撤销，不另存 Cookie/Token；特定登录型平台的新增授权读取仍需单独验收。
- M1 已完成真实飞书闭环：受控失败会先回原会话说明“运维官已接手”，网关重启后恢复并只交付一次；小D已在原会话交付公开视频文档。验收账本见 [ARMY-008 / ARMY-009](./docs/reviews/m2-real-small-army/acceptance.md#army-008--army-009)。
- M2 第一批军团能力已完成最小真实验收：公开资料报告员从真实飞书接到公开网页、生成摘要并回到原会话；两份含风险描述的岗位草案已在飞书分别实际批准和拒绝；零预算多人工作也已由真人点击飞书审批卡，随后自动分工、完成并同步 Paperclip。没有真实执行能力的批准草案只转为待补能力，不试用、不上线。登录型授权读取等高风险外部能力仍未验收。
- 当前持续迭代：现在不只是小D，任何普通员工执行报错都会先交给运维官；安全条件满足时只重试一次，再失败则升级技术专家。恢复任务和技术修理任务本身失败不会无限套娃；技术检查卡住就标为待测试，其他工作继续。2026-07-24 的真实飞书受控网页故障已完整看到“运维接手 → 安全重试 → 技术专家待测试”，ARMY-024 通过。总管会在有人接手时主动说明，并继续等待最后的真实结果；A君 在小D恢复任务处理中重启后，原会话仍只收到一次最终交付。审核官现可只读复核已上岗岗位，技术专家拿到真实任务号后可直接给出只读故障链判断；创建官、审核官、架构师、技术专家的独立飞书岗位任务均已通过。A君 自动检查覆盖恢复、技术修复、小D路由和这些岗位边界；当前测试结果以 `cd apps/ajun-runtime && npm test` 为准。所有已上岗员工会同步登记到 Paperclip；新员工通过受限试用后立即登记。统一进度见 [真实小军团验收账本](./docs/reviews/m2-real-small-army/acceptance.md)。
- 小D任务支持安全暂停与继续：飞书提出暂停或继续后先由 Paperclip 记录确认，确认前原任务不变；ARMY-020 已用真实任务验证 22% 安全暂停、确认继续和最终完成，两张审批卡都替换成无按钮终态。
- 运维官由 Paperclip 每半小时巡检 A君、小D和 Paperclip；受控手动触发与 2026-07-22 11:30 的真实定时触发均已完成，ARMY-021 通过。
- 总管会把同一飞书聊天里的“不错/有用”或“不行/需要改进”关联到刚完成的工作，不新建任务也不自动重做；真实负面评价和后续架构复盘已完成，ARMY-022 通过。
- 每件新工作保存实际处理次数；只有执行方真实回传费用才显示金额。真实飞书已验证“今天花了多少”会返回处理记录并明确不猜金额，ARMY-023 通过。
- 对当前没有员工能直接完成的陌生目标，A君 会说明目标、交付物、缺少材料和安全下一步，不编造员工或结果；真实客户投诉分类请求已验证，ARMY-025 通过。
- 现用 `A君·军团总管` 已由 Hermes 原生 Gateway 承载日常飞书对话：同一会话能自然追问，Gateway 重启后仍能承接指代；能力、员工、任务和审批通过本机 Agent Army MCP 读取 A君/Paperclip 真相，不另建记忆库或任务队列。真实飞书已完成“小D状态不建任务”“审批拒绝不执行”“运维官只读健康检查单次执行并返回已验证报告”验收，ARMY-041 通过。官方 Channel SDK 继续承载尚未迁移的独立员工入口并作为回退，既有私聊、卡片、重启恢复和群内 @ 能力不删除；小R与小办已改由各自独立 Hermes Profile Gateway 承接。详见 [ADR-0007](./docs/adr/0007-hermes-native-feishu-runtime-and-agent-army-mcp.md)、ARMY-032 与 ARMY-041。
- 六名治理员工（创建官、任务协调官、审核官、架构师、运维官、技术专家）已切换为独立 Hermes Profile Gateway，并在 Paperclip 中各自使用 `hermes_local` 运行时、岗位 Skill 和受限 Agent Army MCP。创建、分工、审核、架构评估、健康核对与隔离技术修复均完成真实本机 heartbeat 验收；回写评论归属员工身份且终验每项只启动一次运行。六名员工随后均完成老板真实飞书私聊、岗位边界回复和独立会话落库；创建官在 Gateway 重启后继续记住原会话代号，并纠正了此前把“草案可申请能力”误说成个人当前能力的问题。运行 `apps/ajun-runtime` 下的 `npm run acceptance:governance-feishu` 可用脱敏会话元数据复验六人直聊、会话隔离和跨重启连续性。
- 数字员工公司体验已完成本机三员工闭环：A君可用一次 `mission_create` 把最多三项工作分给小D、小R和办公助理，独立工作并行，办公汇报按依赖等待，最后只给老板一份基于真实产物的统一汇报；同一幂等请求不会重复招工或重复交付，服务重启后任务仍可继续读取。真实飞书回归已验证自动分工、3/3 产物、只回最终汇报，以及 A君与 Hermes 同时重启后在原会话继续“刚才任务”且任务数不变；模型把最终汇报误派给小R或父任务标题含“老板汇报”时，服务端契约会阻止错误路由。三员工独立 Hermes Profile 与最小 MCP 权限边界已建立；私人云端办公室与 Mac 工作间的出站短租约桥接、无 Mac 轻量员工执行、重启恢复、上线前体检和隔离运行验收也已完成。小R与小办的最小权限独立飞书应用已创建并发布，两名员工均已完成独立模型真实调用，并由各自 Hermes Gateway 完成老板真实私聊入站、同会话任务执行、产物回传和连续追问；本机和云端还有唯一接管门，避免迁移时重复收消息。运行台对 Hermes 已接管员工只显示脱敏真实状态，不再提供会造成双连接的凭据修改入口。真实云主机上的 Mac 关机后验收仍未完成，因此目前是本机持续可用，不是全天云端在线。证据见 [数字员工公司体验验收账本](./docs/reviews/m2-digital-employee-company/acceptance.md)。
- 公开资料报告员可以一次对比一到五条公开网页并保留来源、中文重点、共同点、差别和建议；真实飞书两条 CERN 链接回归已通过 ARMY-026。
- 公开资料报告员现在也能在目标明确、但你没给链接时，先自己找最多三条公开网页再交付中文重点和来源；它只看公开网页，不登录、不付费、不外发。2026-07-24 已在真实飞书完成无链接 AutoGen 主题检索并交付两条可读来源；第三条返回 403 时如实忽略，ARMY-031 通过，资料提炼质量仍可继续优化。
- 对当前没人能直接完成、但没有登录、付费、外发等风险的工作，A君 会自动交给架构师评估能力缺口与最小下一步，不要求用户再说“继续”；真实飞书回归已通过 ARMY-027。
- 你问“你能干什么”时，A君 会按当前上岗员工的真实能力直接列出可办事项，不新建任务、不暴露内部岗位选择；真实飞书回归已通过 ARMY-028。

## 正式文档入口

### 产品与计划

- [Agent军团项目说明](./docs/Agent军团项目说明.md)
- [Agent军团总 PRD](./tasks/prd-agent-army-master.md)
- [M1 小D飞书业务闭环 PRD](./tasks/prd-m1-xiaod-feishu-closure.md)
- [M2 A君独立运行时、通用连接与内容获取、治理控制面 PRD](./tasks/prd-m2-authorization-connectors.md)
- [M2 第一批 Agent 创建与治理闭环 PRD](./tasks/prd-m2-first-batch-agent-governance.md)
- [M2 通用访问底座实施计划](./docs/plans/m2-common-access-foundation-implementation-plan.md)
- [M2 军团运行骨架实施约定](./docs/plans/m2-army-runtime-skeleton-plan.md)
- [M2 第一批 Agent 创建与治理闭环实施计划](./docs/plans/m2-first-batch-agent-governance-plan.md)
- [M2 真实小军团持续迭代计划](./docs/plans/m2-real-small-army-iteration-plan.md)
- [M2 数字员工公司体验实施计划](./docs/plans/m2-digital-employee-company-implementation-plan.md)
- [任务与 PRD 状态](./tasks/README.md)

### 设计

- [数字员工公司体验设计](./docs/design/digital-employee-company-experience.md)
- [M1 飞书用户流程](./docs/design/m1-feishu-user-flow.md)
- [M1 飞书交互规范](./docs/design/m1-feishu-interaction-spec.md)
- [M1 可点击原型](./designs/agent-army-m1/feishu-xiaod-task-flow.html)
- [M2 通用访问底座设计](./docs/design/m2-common-access-foundation.md)
- [飞书手机控制军团流程](./docs/design/feishu-mobile-army-control.md)
- [飞书手机控制交互图](./designs/feishu-mobile-army-control/feishu-mobile-army-control.html)

### 技术与工程

- [系统架构](./docs/architecture/system-architecture.md)
- [M1 平台兼容性验证](./docs/architecture/m1-platform-compatibility-validation.md)
- [核心契约](./docs/contracts/core-contracts.md)
- [Agent 搭建与上线流程](./agents/agent-build-and-release.md)
- [创建 Hermes Agent 与飞书 Bot 接线教程](./docs/guides/创建Hermes-Agent与飞书Bot接线教程.md)
- [目录与代码规范](./docs/standards/repository-and-code.md)
- [测试与验收规范](./docs/standards/testing-and-acceptance.md)
- [ADR-0001：控制面、运行时与交互通道分离](./docs/adr/0001-control-plane-runtime-and-channel.md)
- [ADR-0002：先闭合运行链路，再接入 Paperclip 军团总控](./docs/adr/0002-phase-paperclip-after-m1-runtime-closure.md)
- [ADR-0003：M1 使用传统飞书机器人接入 Hermes](./docs/adr/0003-m1-use-traditional-feishu-bot.md)
- [ADR-0004：通用账号连接、内容获取与运维观察边界](./docs/adr/0004-common-access-foundation.md)
- [ADR-0005：飞书手机总管与审批分流边界](./docs/adr/0005-feishu-mobile-command-and-approval-boundary.md)
- [现成能力复用调研与采用边界](./docs/research/2026-07-agent-army-reuse-landscape.md)

### 治理与依据

- [文档迭代与治理规范](./docs/governance/document-lifecycle.md)
- [项目交接与闭环](./docs/handoffs/README.md)
- [验收记录入口](./docs/reviews/README.md)
- [Claude 交叉 AI 审核任务书](./docs/reviews/cross-ai-audit-prompt.md)
- [AI 推测内容评估与采纳](./docs/AI推测内容评估与采纳.md)
- [仓库协作规则](./AGENTS.md)

## 编码前门禁

当前 M1 首批实现前需要完成：

- 创建版本化小D AgentManifest 和 Hermes Profile 映射；
- 由所有者在隔离 Profile 配置真实凭据后，完成飞书与 Hermes 的真实受控验证；
- 将验证结果写入契约映射和验收记录。

小而明确、不改变工作流和跨系统契约的修复仍可直接处理。

## 运行小D

```bash
cd apps/xiaod-media-transcriber
npm install
npm run dev
```

默认访问地址：`http://127.0.0.1:4318`。

凭据保存在应用自己的 `.env` 中，不应放在仓库根目录、任务正文或项目文档里。

## 运行 A君运行台

```bash
cd apps/ajun-runtime
npm test
npm run dev
```

默认访问地址：`http://127.0.0.1:4321`。它是本机连接授权、组件健康、恢复和脱敏诊断页；已能作为本机 Paperclip HTTP Agent 的执行适配端，完成低风险健康任务并回报同一 Paperclip 任务单。日常派活、结果交付和用户审批在飞书完成；A君不维护第二套军团队列。小D任务仅调用本机 `4318` 服务，公开链接以外的外部账号、飞书和 Hermes 不由运行台直接调用。
