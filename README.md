# Agent军团

Agent军团是一套以飞书为日常业务入口、以 Hermes 等运行时承载各 Agent、以 Paperclip 作为组织级治理总控、以 A君本地运行时承载通用能力与故障恢复的数字员工系统。用户日常只与飞书中的“ A君·军团总管”交互：手机可在任何地点下任务、看进度、收结果和处理审批；A君局域网页只作为授权、诊断和应急入口，不与飞书重复日常派活。

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
- M2 已进入受控验收：小D 已接入统一账号管家、通用内容获取中心和脱敏运维事件；旧浏览器会话/Cookie 读取路径已关闭。YouTube 公开视频字幕统一由内置 `yt-dlp` 读取，已完成真实交付；不要求登录，不读取 Cookie。登录型平台连接仍待选择已有可复用连接器后再做受控验收。
- M1 已完成真实飞书闭环：受控失败会先回原会话说明“运维官已接手”，网关重启后恢复并只交付一次；小D已在原会话交付公开视频文档。验收账本见 [ARMY-008 / ARMY-009](./docs/reviews/m2-real-small-army/acceptance.md#army-008--army-009)。
- M2 第一批军团能力已完成最小真实验收：公开资料报告员从真实飞书接到公开网页、生成摘要并回到原会话；两份含风险描述的岗位草案已在飞书分别实际批准和拒绝，A君 与 Paperclip 都保留可追踪记录。没有真实执行能力的批准草案只转为待补能力，不试用、不上线。其余 M2 的预算续办、登录型授权读取、跨员工长任务等仍未验收。
- 当前持续迭代：现在不只是小D，任何普通员工执行报错都会先交给运维官；安全条件满足时只重试一次，再失败则升级技术专家。恢复任务和技术修理任务本身失败不会无限套娃；技术检查卡住就标为待测试，其他工作继续。总管会在有人接手时主动说明，并继续等待最后的真实结果，普通处理中不刷屏；飞书入口重启后也不会重复通知已经说过的变化。已经补上过期确认的自动清理：确认一旦过期，普通任务会自动关闭，暂停/继续类确认只会作废这次确认，不会误停原工作；A君不再把过期旧事报成需要你处理，总控也会同步标为停住。A君 自动检查覆盖恢复、技术修复和小D路由；当前测试结果以 `cd apps/ajun-runtime && npm test` 为准。真实飞书的受控网页故障回归仍在验收账本 ARMY-024 中等待验证。审核官已能独立检查新岗位草案，架构师已能从真实任务中寻找重复工作，技术专家现已完成一次真实 A君 控制台故障的“AI 找范围 → 独立副本修复 → 自动检查 → 恢复确认 → A君 安全带回 → Paperclip 留证”闭环。A君现已能把安全的军团盘点拆给运维官和架构师，Paperclip 会保留总工作、分工和汇总；所有已上岗员工现在都会同步登记到 Paperclip，新员工一通过受限试用就立即登记，无需重启 A君。如果总管理处短暂不可用，A君 会每分钟重新补一次登记；新增登记只用于组织归属、分工和审计，保持暂停以避免 Paperclip 重复启动本机工作。零预算多人任务已真实证明“批准前不派活、批准后自动分工完成”，不会让子工作重复要求确认。实际验证发现 Paperclip 不能可靠地给每个修复任务分开独立副本，因此技术专家不再依赖它决定工作地点；A君 会按任务建立自己的独立修理房，并在没有完整证据时把任务标为待测试、继续处理其他工作。真实飞书主动提醒与飞书真人点击预算卡片仍待人工验收，但不会阻塞开发。统一进度和待测试项见 [真实小军团验收账本](./docs/reviews/m2-real-small-army/acceptance.md)。
- 小D任务现在还支持安全暂停与继续：飞书里提出暂停或继续时，先由 Paperclip 记录确认；确认前原任务不变，确认后小D只会在安全位置停下。当前没有活跃素材任务可做真人飞书验证，因此此项仍明确列为待测试。
- 运维官已开始由 Paperclip 安排本机巡检：每半小时读取 A君、小D和 Paperclip 的真实状态；首次受控手动触发已经完成，按时间自动触发仍在验收清单中等待复核。
- 总管开始记住你对结果的评价：在同一飞书聊天里说“不错/有用”或“不行/需要改进”，它会关联刚完成的那件工作；架构师后续复盘会优先看被说“不行”的重复工作。不会自动重做或擅自外发；真实飞书回归仍登记为待验收。
- 每件新工作也开始留下真实使用记录：小D接单、网页读取和本机检查会记住实际发生的次数。你问“今天花了多少”时，只有执行方真实回传的费用才会显示；没回传就明确说不知道，不会猜金额。真实飞书回归仍登记为待验收。
- 对当前还没有对应员工的陌生目标，A君会先用 AI 把你想要的结果、最终交付物、缺少材料和安全下一步说清楚，而不是只回“请补充”。它不会因此假装已经完成、编造员工或擅自执行外部操作；真实飞书效果仍登记为待验收。
- 飞书官方现已提供专门给 Agent 使用的聊天接线、最小权限创建员工应用和飞书内容操作能力。项目已决定逐步采用它们，避免继续给 Hermes 堆消息和卡片补丁；当前已验证的 A君入口保持运行，等官方接线通过自动检查和真实飞书回归后再替换。需要多人协作时，先让 A君 和一位已能真实交付的员工在协作群里完成可见接力，不会先创建一堆空壳机器人。详见 [ADR-0006](./docs/adr/0006-prefer-official-feishu-agent-stack.md)。
- 公开资料报告员现在可以一次对比一到五条公开网页：它会分别保留来源和中文重点；AI 只根据这些已读取内容写出共同点、差别和建议，暂时不可用时仍会交付逐条重点。超过五条会请你分批发送，不会偷偷漏掉内容。真实飞书两条链接的回归仍登记为待验收。
- 公开资料报告员现在也能在目标明确、但你没给链接时，先自己找最多三条公开网页再交付中文重点和来源；它只看公开网页，不登录、不付费、不外发。找不到或网页打不开时，会直接说明并请你补链接，不会编结论。真实飞书验收仍登记为 ARMY-031。
- 对当前没人能直接完成、但没有登录、付费、外发等风险的工作，A君 会先让 AI 看懂你要的结果，再自动交给架构师评估缺什么能力、最小下一步怎么补；架构师会直接说明还缺什么材料、现有哪位员工可接下一步，不会要求你再说“继续”。它不会因此擅自新建员工或执行外部操作；真实飞书回归仍登记为待验收。
- 你问“你能干什么”时，A君 会直接按当前上岗员工实际会做的事告诉你现在能办什么；即使员工是后来新建、名字不同，也会自动显示对应能力，而不是让你选择内部岗位或说固定口令。真实飞书回归仍登记为待验收。

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
- [任务与 PRD 状态](./tasks/README.md)

### 设计

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
