# Agent军团

Agent军团是一套以飞书为日常业务入口、以 Hermes 等运行时承载各 Agent、以 Paperclip 作为组织级治理总控、以 A君本地运行时承载通用能力与故障恢复的数字员工系统。用户既可以把目标交给飞书中的“ A君·军团总管”，也可以按需直接私聊独立员工；每名员工拥有自己的 Hermes Profile、会话/记忆、岗位 Prompt、Skill 与最小 MCP 作用域。A君局域网页只作为授权、诊断和应急入口，不与飞书重复日常派活。

这个仓库的根目录用于承载军团级架构、岗位定义、公共能力、平台集成和运维设施。每个可独立运行的业务 Agent 放在 `apps/` 下，不再让某一个 Agent 代表整个项目。

## 目录结构

正式产品、按需工具、共享 Module 与历史回滚资产的唯一分类见
[仓库产品地图](./docs/product/repository-map.md)；机器可读真相由
[`repository-catalog.json`](./repository-catalog.json) 保存，并由架构检查验证。

```text
agent-agent/
├── apps/           正式产品、业务 Agent、按需工具及显式标记的历史回滚资产
├── agents/         数字员工的岗位、职责、权限和质量标准
├── integrations/   Paperclip、Hermes、飞书等平台适配层
├── packages/       多个 Agent 共用的代码与能力模块
├── ops/            本地运行、部署、监控和恢复工具
├── tasks/          总 PRD、里程碑 PRD 和实施状态
├── docs/           产品、设计、架构、契约、规范和验收记录
└── designs/        可运行的 UI 原型与设计资产
```

`apps/ajun-runtime` 与 `apps/xiaod-media-transcriber` 是当前主要产品运行面；
`apps/mac-worker` 是受控运行桥，`apps/project-progress-board` 与 `apps/animated-chart` 按需运行。
`apps/boom-monitor` 仅保留旧 Python/Docker 回滚资产，不是正式产品入口，也不属于 npm Workspace。

### 局域网项目进度看板

多项目进度 H5 位于 `apps/project-progress-board/`，项目、阶段和任务保存在本机 SQLite。它是按需开发工具，不属于五个常驻服务；需要时执行 `cd apps/project-progress-board && npm run dev`，再访问 `http://127.0.0.1:4320`。详见 [项目进度看板 README](./apps/project-progress-board/README.md) 和 [设计说明](./docs/design/project-progress-board.md)。

仓库已经具备多个真实应用和跨消费者共享模块，因此根目录现使用轻量 npm Workspace；不引入额外构建框架。`npm run test:affected` 按变更触达选择包级回归，`npm run check:architecture` 检查共享包依赖方向，发布前仍保留四个核心运行包的全量测试。

## 当前状态

### 当前机器事实（2026-08-10）

- A君 `4321` 绑定 clean 不可变 release 正常运行；`runtime:fingerprint` 必须确认当前源码与 live 为 `same_git_head`，精确 PID、release、payload 与 Git 身份以当前 release manifest 和该只读指纹为准。本轮真实业务 E2E 运行在代码 release `9a5ab1c1…` / payload `df15752d…` / Git `334c664…`，其后的文档收口 release 保持同一 payload，不重复执行模型任务。
- Paperclip `3100`、Hermes Gateway 和小D运行面可达；Paperclip roster 已同步 12 个岗位，小拆与 A君 Hermes Profile 再次 dry-run 均为 `changed=false`。Publisher `4390` 未运行，Campaign 与 M5 Cron 继续关闭。
- Business Workflow、能力真相、并列否定策略和人工评价写回已进入 `4321` live；飞书任务 `#167203DF` 完成一条真实只读 Workflow，并将 `useful` / `accepted` 写回任务账本。

### 当前产品结论

- M0–M3 已完成；M4 本地岗位质量与模型回归已完成，剩余项均为明确的外部或人工验收；M5 仍为 **PARTIAL**。
- Business Workflow 已作为新任务主对象，TypeScript Policy、CapabilityAdapter、ExecutionReceipt、Evaluation 和五层能力真相已在 live 生效；历史任务只读分类，不改写旧终态。
- 任务与待办数量以 live `/api/overview.taskFocus` 为准，README 不再固化会持续变化的计数。真正的 `waiting_acceptance` Workflow 会进入 `ownerActionable`；等待自动验证的 `waiting_test` 或产物门禁未通过会显示为 `waiting_validation`，不再冒充老板待办。历史分类仍只读，不改写旧任务终态。
- live `agent.army/validation-campaign/v1` 已收敛为 `taskCount=0`、`groupCount=0`。首次真实小拆 `#716FA2E8` 因模式结构未通过停在 `waiting_test`；修复后的 `#B5403CD9` 以 `paperclip_hermes_completed` 成功，结构校验由 `false` 经一次 deterministic repair 变为 `true`，生成 7077 bytes、194 字摘要报告。
- 两条真实小拆均各调用 DeepSeek 1 次：首次 5218/13466 tokens、估算 0.004501 USD；成功任务 3043/8809 tokens、估算 0.0028986328 USD。两次都未调用视觉 Provider。任务账本未报告外部写入，也没有独立外写回执，因此不能断言外部写入为零；Paperclip 本机 completion sync 不等于外部发布。
- 真实 `runtime.sqlite` 只读回放复用了任务 `#10E4F814` 的实际确认稿、10 帧和 1 个故事板，在无 Advisor、无视觉 Provider 时生成 13 模块 `deterministic_fallback` 报告，并正确标记 `partial` / `unavailable`；数据库写入、live 任务写入、Provider 调用和付费调用均为 0，临时目录已清理。M3 无 Provider 本机纵向验收同样通过。
- 模型账本以 live `/api/overview.billing` 的滚动窗口为准，不再在 README 固化过期 API 次数。账本分开 `task`、`system`、`agent_session` 和真正 `unattributed`；仅有可对账的 Hermes session 才绑定具体任务/Workflow，其余会话不再被笼统说成“未归属”。历史窗口分析见[产品收口运行账本](./docs/reviews/operations-health/product-closure-2026-08-08.md)。

### 当前边界与下一步

- M5 活动 `8dd29a3b…` 当前已经 `stopped`，不是旧文档中的 `paused`；旧 Profile lease 已过期。重新运行必须创建新授权草案，不能恢复旧授权。
- 先维护只读 readiness、任务恢复和审计质量；恢复 Campaign、启动 Publisher 或平台写入仍需独立授权。模型型验证必须先通过现有预算 Policy；本轮真实小拆已产生两次有账本的 DeepSeek 调用，未调用视觉 Provider。
- 新任务通过 `Model → Agent Runtime → Skills/Workflow → Policy/Permission → MCP/Tool Gateway → Provider` 执行；Model 不得自批权限。已登记同机只读能力可自动恢复一次并重试一次，仍失败才提示负责人。
- `334c664…` 已完成不可变部署、真实 DeepSeek 小拆终态和 Paperclip 本机完成同步；自动结构通过只证明产物满足机器门禁，不等于负责人已经采用内容。
- 历史能力验证批次的自动化闭环已完成，该批次仅保留可选人工内容质量抽查：如需形成最终采用结论，可对 `#B5403CD9` 登记 `accepted` 或 `revision_required`。项目其他外部/人工验收仍以[当前交接](./docs/handoffs/README.md#当前交接)为准，不将某一批次的闭环误说成整个项目只剩一件事。
- 仍需负责人参与的真实验收统一见[当前交接](./docs/handoffs/README.md#当前交接)；已经完成或被替代的事项不得继续占用当前状态。
- 2026-08-08 以前的详细运行快照已移至[历史运行状态](./docs/archive/product-state-history-2026-08-08.md)，不再作为当前 PID、版本或唯一下一步依据。

## 正式文档入口

### 产品与计划

- [Agent军团项目说明](./docs/Agent军团项目说明.md)
- [Agent军团总 PRD](./tasks/prd-agent-army-master.md)
- [M1 小D飞书业务闭环 PRD](./tasks/prd-m1-xiaod-feishu-closure.md)
- [M2 A君独立运行时、通用连接与内容获取、治理控制面 PRD](./tasks/prd-m2-authorization-connectors.md)
- [M2 第一批 Agent 创建与治理闭环 PRD](./tasks/prd-m2-first-batch-agent-governance.md)
- [M3 内容分析与知识归档 PRD](./tasks/prd-m3-content-analysis-and-knowledge-archive.md)
- [M4 岗位自主执行与能力深化 PRD](./tasks/prd-m4-autonomous-agent-capabilities.md)
- [M5 高权限内容自治 PRD](./tasks/prd-m5-high-autonomy-content-operations.md)
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
- [Agent军团使用说明书](./docs/guides/Agent军团使用说明书.md)
- [Agent 搭建与上线流程](./agents/agent-build-and-release.md)
- [创建 Hermes Agent 与飞书 Bot 接线教程](./docs/guides/创建Hermes-Agent与飞书Bot接线教程.md)
- [目录与代码规范](./docs/standards/repository-and-code.md)
- [测试与验收规范](./docs/standards/testing-and-acceptance.md)
- [ADR-0001：控制面、运行时与交互通道分离](./docs/adr/0001-control-plane-runtime-and-channel.md)
- [ADR-0002：先闭合运行链路，再接入 Paperclip 军团总控](./docs/adr/0002-phase-paperclip-after-m1-runtime-closure.md)
- [ADR-0003：M1 使用传统飞书机器人接入 Hermes](./docs/adr/0003-m1-use-traditional-feishu-bot.md)
- [ADR-0004：通用账号连接、内容获取与运维观察边界](./docs/adr/0004-common-access-foundation.md)
- [ADR-0005：飞书手机总管与审批分流边界](./docs/adr/0005-feishu-mobile-command-and-approval-boundary.md)
- [ADR-0012：以业务工作流为主对象的能力治理与验收架构](./docs/adr/0012-workflow-first-capability-policy-and-evaluation.md)
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
