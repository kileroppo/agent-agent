# 验收记录

本目录保存里程碑和高风险变更的验收证据，不存放 secret、Cookie、授权链接或无关私人内容。

建议结构：

```text
docs/reviews/
└── m1-xiaod-feishu-closure/
    ├── acceptance.md
    └── evidence/       仅保存可安全提交的截图或摘要
```

验收记录必须区分：自动化验证、本地运行验证、外部平台验证、人工验收和仍未证明的内容。具体要求见 [测试与验收规范](../standards/testing-and-acceptance.md)。

当前记录：

- [11 岗位能力 E2E 覆盖矩阵](./agent-capability-e2e-coverage-2026-08-10.md)：按 `declared/configured/live/verified/humanAccepted` 盘点当前 11 个正式岗位；只选出一条需另行授权的小创本地待审脚本验证，没有创建任务或调用 Provider。
- [Boom Monitor 收敛到 A君验收](./boom-monitor-ajun-convergence/acceptance.md)：原生服务、同源页面、历史数据迁移、在线备份、唯一 writer、Docker 退役和受控回滚门禁均已完成真实本机验收。
- [M0 文档与设计基线验收](./m0-documentation-baseline/acceptance.md)
- [M1 小D飞书受控验证](./m1-xiaod-feishu-closure/acceptance.md)
- [M2 授权连接与内容获取验收](./m2-authorization-connectors/acceptance.md)：已完成；公开视频、小红书从零登录只读、撤销恢复，以及 A君续期/禁用入口均已验证。敏感来源参数本机保存风险已由负责人在当前单用户边界内接受。
- [M2 A君运行台与基础岗位骨架验收](./m2-army-runtime-skeleton/acceptance.md)：本地任务协调、岗位登记与审批占位已验证。
- [Agent 军团收缩与废弃机器人清理验收](./agent-roster-consolidation/acceptance.md)：五常驻、四按需、历史保留和飞书停用已验证；空闲后 Gateway RSS 较迁移前下降约 33%。
- [M2 第一批 Agent 创建与治理闭环验收](./m2-first-batch-agent-governance/acceptance.md)：飞书低风险命令已完成真实闭环；创建 Agent、审批卡与业务产物仍待逐项验收。配套的[军团总管避坑清单](./m2-first-batch-agent-governance/lessons-learned-2026-07-21.md)是新 Agent 接入的上线门禁。
- [M3 内容增长与知识归档验收](./m3-content-growth/acceptance.md)：旧链路真实飞书/真人听审已通过；两个新增岗位已激活并完成 Paperclip/Hermes 运行。新版图文报告、真实草稿和 Obsidian 归档已在本机闭环，负责人内容质量判断仍待完成。
- [M5 高权限内容自治验收](./m5-high-autonomy-content-operations/acceptance.md)：18 阶段/15 Routine/4 控制器已对账到 live，草案未批准且 Cron 关闭；付费多模态、真实 PublishReceipt、平台指标和双平台发布均未验收。
- [Hermes Agent 与飞书 Bot 接线教程](../guides/创建Hermes-Agent与飞书Bot接线教程.md)：记录独立 Profile、模型、长连接及私聊/群聊真实验收的可复用流程。
