# 小D岗位

小D是 Agent军团第一条岗位生产线样板，负责已获授权音视频的转录、整理和飞书交付。

## 当前状态

- Manifest：`draft`；
- 业务执行器：`apps/xiaod-media-transcriber/`，已有本地能力；
- Hermes 映射：仓库基线已建立，本机隔离 `xiaod` Profile 已创建但 Gateway 未启动；
- 飞书入口：测试应用已发布，仅保留消息接收事件，尚未连接 Hermes 或完成真实消息验证；
- 上线结论：未上线，不能对组织公开承接任务。

## 文件职责

- `manifest.json`：岗位和治理硬边界；
- `prompts/system.md`：模型行为说明，不能覆盖 Manifest；
- `prompts/task-guides/`：按任务类型拆分的工作步骤；
- `evals/cases.json`：上线前必须覆盖的典型与风险样例。

## 激活门禁

只有 Manifest 校验、隔离 Hermes Profile、真实飞书任务、产物权限验证和 M1 验收全部通过后，才能将状态从 `draft` 改为 `active`。
