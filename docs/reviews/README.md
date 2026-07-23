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

- [M0 文档与设计基线验收](./m0-documentation-baseline/acceptance.md)
- [M1 小D飞书受控验证](./m1-xiaod-feishu-closure/acceptance.md)
- [M2 授权连接与内容获取验收](./m2-authorization-connectors/acceptance.md)：公开视频字幕闭环、撤销恢复已验证；浏览器授权媒体获取未通过。
- [M2 A君运行台与基础岗位骨架验收](./m2-army-runtime-skeleton/acceptance.md)：本地任务协调、岗位登记与审批占位已验证。
- [M2 第一批 Agent 创建与治理闭环验收](./m2-first-batch-agent-governance/acceptance.md)：飞书低风险命令已完成真实闭环；创建 Agent、审批卡与业务产物仍待逐项验收。配套的[军团总管避坑清单](./m2-first-batch-agent-governance/lessons-learned-2026-07-21.md)是新 Agent 接入的上线门禁。
- [Hermes Agent 与飞书 Bot 接线教程](../guides/创建Hermes-Agent与飞书Bot接线教程.md)：记录独立 Profile、模型、长连接及私聊/群聊真实验收的可复用流程。
