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

### 当前机器事实（2026-08-08）

- A君 `4321` 正常运行，PID `49100`，绑定 clean 不可变 release `869473aa…`、payload `057f082f…` 和源码提交 `d071098…`；核心概览、任务详情及静态资源均可读。
- Paperclip `3100`、Hermes `9119` 与小D运行面可达；Publisher `4390` 未运行，Campaign、M5 Cron 和所有真实外写继续关闭。
- 当前源码与 live 并非同一 Git HEAD：源码含运行切换后的文档收口，live 仍绑定已验证代码提交；运行身份必须以 `npm run runtime:fingerprint` 为准。

### 当前产品结论

- M0–M3 已完成；M4 本地岗位质量与模型回归已完成，剩余项均为明确的外部或人工验收；M5 仍为 **PARTIAL**。
- 当前任务账本共 789 条：506 成功、122 取消、74 待测试、67 失败、20 待输入；没有进行中任务，控制台只保留 1 条负责人可操作任务。
- 本周账本的 1284 次模型 API 调用中，1050 次来自运维官；绝大多数发生在 8 月 1–5 日旧模型巡检路径。无模型健康巡检切换后，8 月 7–8 日运维官合计只有 10 次调用。当前问题是历史窗口和任务归因，不是费用失控；详见[产品收口运行账本](./docs/reviews/operations-health/product-closure-2026-08-08.md)。

### 当前边界与下一步

- M5 活动 `8dd29a3b…` 当前已经 `stopped`，不是旧文档中的 `paused`；旧 Profile lease 已过期。重新运行必须创建新授权草案，不能恢复旧授权。
- 先维护只读 readiness、任务恢复和审计质量；恢复 Campaign、注入 Provider、启动 Publisher、付费调用或平台写入仍需独立授权。
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
