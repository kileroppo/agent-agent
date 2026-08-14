# ADR-0008：岗位开放任务、自主计划与统一 StepFun 模型策略

| 字段 | 内容 |
| --- | --- |
| 状态 | 部分废止：模型策略由 ADR-0013 重新定义；开放任务类型保留，本地自主控制面由 M5 纠偏 |
| 日期 | 2026-07-29 |
| 决策者 | A君 |

## 决策

保留 11 个活动岗位。每个岗位在原专有任务之外增加一个开放任务类型，并复用原岗位执行器。

M5 纠偏后，A君生产运行时只做无状态的“开放任务类型 → 岗位专有任务类型”映射，并按岗位 Manifest 白名单拒绝未登记能力。原 ADR 中由 A君生成 GoalSpec 派生 DAG、checkpoint、预算和任务级 CapabilityGrant 的部分只保留为历史迁移代码，不再接入生产。组织任务、Issue、预算、审批、恢复和技能激活真相统一由 Paperclip 保存；Hermes 保存执行会话和运行检查点。

历史决策曾将 11 个正式岗位的主推理模型统一为 `stepfun/step-3.5-flash-2603`，并仅在 `transport_unavailable` 时回退到 DeepSeek；2026-08-02 曾由 [ADR-0011](./0011-deepseek-primary-reasoning-model.md) 切为 DeepSeek。自 2026-08-14 起，[ADR-0013](./0013-stepfun-primary-reasoning-restoration.md) 恢复 StepFun 主模型但不恢复 DeepSeek 回退；开放任务与治理边界继续有效。

## 原因

- 空心岗位的问题是缺少可验收执行与证据链，不是岗位数量本身；
- 仅加强 Prompt 无法提供预算、权限、恢复和完成真相；
- 复用原专有执行器可避免建立第二套不一致执行栈；
- 统一主模型降低运行漂移，有限传输回退保留可用性；
- 仓库元数据与真实凭据/调用证据分离，避免把配置声明冒充可用。

## 后果

- 开放任务不再生成 `autonomous_work_plan`、能力授权报告或 `capability-grants.json`；
- 未登记能力按岗位 Manifest 白名单直接进入 `needs_input`，不会被模型临时“发明”或形成临时授权；
- 计划、预算、审批、恢复和能力审计只读取 Paperclip/Hermes 的同一份事实；
- Profile 切换是一次性运行变更，只有两条模型传输均验证后才执行；
- 尚未授权的 Profile 会显示 `model_transport_pending`，不会维持旧的“已验证”标记。
