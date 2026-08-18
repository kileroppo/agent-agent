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

### 当前产品结论（2026-08-18）

- A君与小D是当前产品运行面；飞书负责日常派活和交付，A君运行台只负责当前状态、唯一下一步、授权、验收和恢复。
- Hermes 的 12 个正式 Profile 直接使用 StepFun 官方入口；此前用于虚拟钥匙、逐岗位日美元硬停和统一用量报表的 LiteLLM + PostgreSQL 本地 Docker 栈已退役。Hermes 的单次 `max_tokens`、轮次/压缩控制与 Paperclip 组织级预算仍保留；没有付费探针前，这只证明配置和运行切换，不证明真实模型传输或业务质量。
- 当前改进主线是“减负与闭环”：只让真实业务工作流进入负责人待办，任务执行状态与人工验收决定分开保存；验证任务和系统任务不再冒充用户待办。
- M5、Boom Radar 自动扫描和产品成熟度批次保留代码与历史数据，但默认按需或冻结，不参与核心启动和核心健康判定。Campaign、Cron、Publisher 与外部写入继续关闭，重开必须重新授权。
- `/api/health` 是轻量核心健康入口，`/api/console-overview` 是运行台紧凑读模型；账单和完整清单按页读取。`/api/overview` 只作短期兼容，不再作为探活、首页刷新或当前任务真相入口。
- 历史任务终态、产品成熟度第二批的 `revision_required` 决定及既有验收证据保持不变；历史运行快照见[产品收口运行账本](./docs/reviews/operations-health/product-closure-2026-08-08.md)和[历史运行状态](./docs/archive/product-state-history-2026-08-08.md)。

### 唯一下一步

- A君、小D 的线上 release、PID、cwd、argv 与 HTTP 回读都是实时事实，**不在 README 手写 hash**。需要确认时运行 `npm run runtime:fingerprint`；A君页面“系统 → 版本”会区分线上版本、候选提交、候选验证/可发布状态和可回滚版本。历史快照只以带时间戳的验收记录为准。
- 唯一真实业务待办已由负责人在运行台选择“有用”，工作流决定持久化为 `accepted`，首页负责人待办回到 0；验证任务与系统任务没有进入负责人队列。
- A君 当前线上版本的 30 分钟观测已自然完成并通过；72 小时有效观测仍在进行，不能用旧版 10 分钟或当前短测证据提前宣称长期稳定。进度与机器门禁见[用户体验与稳定性 1–7 验收账本](./docs/reviews/ux-stability-1-7-2026-08-17/acceptance.md)。
- 当前没有需要负责人处理的业务待办；唯一工程收口项是等待上述 72 小时观测自然完成并做最终运行态、版本真相与真实页面回读。保持 M5、Boom 自动扫描和成熟度复验关闭，只有出现新的真实业务需求或故障时再建立新的业务下一步。
- 本轮证据已归档到[产品成熟度总交接](./docs/archive/handoffs/agent-army-product-maturity-handoff.md)；已关闭、冻结或仅剩可选人工抽查的交接不与当前工作竞争优先级。

## 正式文档入口

### 产品与计划

- [Agent军团项目说明](./docs/overview/Agent军团项目说明.md)
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
- [上下文、记忆与成本治理](./docs/architecture/context-memory-and-cost-governance.md)
- [能力 Plan B 与运行事件架构](./docs/architecture/capability-routing-and-run-events.md)
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
- [ADR-0013：正式岗位主推理模型切回 StepFun](./docs/adr/0013-stepfun-primary-reasoning-restoration.md)
- [ADR-0014：本地 AI 插件运行时与项目发布隔离](./docs/adr/0014-local-ai-plugin-runtime-isolation.md)
- [本地 AI 插件安装与迁移说明](./ops/local-ai/README.md)
- [现成能力复用调研与采用边界](./docs/research/2026-07-agent-army-reuse-landscape.md)

### 治理与依据

- [文档迭代与治理规范](./docs/governance/document-lifecycle.md)
- [项目交接与闭环](./docs/handoffs/README.md)
- [验收记录入口](./docs/reviews/README.md)
- [模型网关退役验收](./docs/reviews/model-gateway-retirement/acceptance.md)
- [Claude 交叉 AI 审核任务书](./docs/reviews/cross-ai-audit-prompt.md)
- [AI 推测内容评估与采纳](./docs/standards/AI推测内容评估与采纳.md)
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

## 安装本地 AI 插件

本地 AI 是可拔插能力，不是项目发布包的一部分。新 Apple Silicon Mac 克隆项目并安装依赖后执行：

```bash
brew install uv ffmpeg jq
ops/local-ai/install-plugin.sh --bootstrap --download-models
npm run local-ai:plugin:status
npm run local-ai:smoke
```

成功标准：状态里有 `currentReleaseHash`，`18082` 为 ready，smoke 最后输出 `local AI smoke: ok`。完整的新机安装、升级和回滚见[本地 AI 插件说明](./ops/local-ai/README.md)。
