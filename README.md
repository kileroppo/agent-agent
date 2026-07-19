# Agent军团

Agent军团是一套以飞书为工作入口、以 A君本地运行时承载智能体与业务执行、以 Hermes 为当前运行适配底座、并从 M2 引入 Paperclip 组织治理控制面的数字员工系统。

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

这些目录先定义清楚职责，不提前引入 monorepo、统一构建或部署框架。出现第二个真实应用或共享模块后，再根据实际依赖补充工作区工具。

## 当前状态

- 当前里程碑：**M1 小D飞书业务闭环——首批实装与受控验证**。
- 已确认 Agent军团长期目标、M0–M4 路线和 M1 小D需求。
- 已建立文档治理、系统架构、核心契约、代码/目录规范和测试门禁。
- M1 飞书交互原型已通过 A 君人工评审。
- 小D版本化 AgentManifest、Prompt、评测样例和 Hermes Profile 映射骨架已建立并通过本地契约检查，岗位状态仍为 `draft`。
- 隔离 `xiaod` Hermes Profile 与传统飞书机器人测试应用已创建并发布；传统机器人已完成真实文本消息收发与模型回复验证。短媒体已真实完成转录、飞书文档权限与交付，并通过一次“受控失败 → 飞书重试 → 同一任务单次交付”回归；约 10 分钟媒体已完成真实阶段与交付验证；后台阶段更新故障与其余M1场景仍待验证；Paperclip 已确认延后到 M2。
- M2 已将跨网站/软件登录授权收敛为“A君独立运行时 + 按需浏览器伴侣”的待确认 PRD；尚未实现启动器、连接器或浏览器伴侣，也未授权任何真实外部账号。

## 正式文档入口

### 产品与计划

- [Agent军团项目说明](./docs/Agent军团项目说明.md)
- [Agent军团总 PRD](./tasks/prd-agent-army-master.md)
- [M1 小D飞书业务闭环 PRD](./tasks/prd-m1-xiaod-feishu-closure.md)
- [M2 A君独立运行时、授权连接器与治理控制面 PRD](./tasks/prd-m2-authorization-connectors.md)
- [任务与 PRD 状态](./tasks/README.md)

### 设计

- [M1 飞书用户流程](./docs/design/m1-feishu-user-flow.md)
- [M1 飞书交互规范](./docs/design/m1-feishu-interaction-spec.md)
- [M1 可点击原型](./designs/agent-army-m1/feishu-xiaod-task-flow.html)

### 技术与工程

- [系统架构](./docs/architecture/system-architecture.md)
- [M1 平台兼容性验证](./docs/architecture/m1-platform-compatibility-validation.md)
- [核心契约](./docs/contracts/core-contracts.md)
- [Agent 搭建与上线流程](./agents/agent-build-and-release.md)
- [目录与代码规范](./docs/standards/repository-and-code.md)
- [测试与验收规范](./docs/standards/testing-and-acceptance.md)
- [ADR-0001：控制面、运行时与交互通道分离](./docs/adr/0001-control-plane-runtime-and-channel.md)
- [ADR-0002：先闭合运行链路，再接入 Paperclip 治理](./docs/adr/0002-phase-paperclip-after-m1-runtime-closure.md)
- [ADR-0003：M1 使用传统飞书机器人接入 Hermes](./docs/adr/0003-m1-use-traditional-feishu-bot.md)
- [现成能力复用调研与采用边界](./docs/research/2026-07-agent-army-reuse-landscape.md)

### 治理与依据

- [文档迭代与治理规范](./docs/governance/document-lifecycle.md)
- [项目交接与闭环](./docs/handoffs/README.md)
- [验收记录入口](./docs/reviews/README.md)
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
