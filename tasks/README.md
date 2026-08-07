# 任务与 PRD

本目录保存项目总 PRD、里程碑 PRD 和当前交付状态。它回答“为什么做、做什么、何时算完成”，不替代架构、接口或实现文档。

## 当前基线

| 文档 | 职责 | 状态 |
| --- | --- | --- |
| [Agent军团总 PRD](./prd-agent-army-master.md) | 长期目标、M0–M4、全局边界和成功指标 | 已确认 |
| [M1 小D飞书业务闭环 PRD](./prd-m1-xiaod-feishu-closure.md) | M1 用户故事、功能要求和验收 | 已完成：真实飞书任务、阶段状态、文档权限、失败恢复、重启幂等和原会话单次交付均已有证据 |
| [M2 A君独立运行时、通用连接与内容获取、治理控制面 PRD](./prd-m2-authorization-connectors.md) | Paperclip 军团总控、A君本地执行适配、账号连接、双通道内容获取、运维治理与验收 | 已完成：A君正式登录、续期/禁用和小红书读取恢复均已验证；单用户本机阶段已接受敏感来源参数的已知风险 |
| [M2 第一批 Agent 创建与治理闭环 PRD](./prd-m2-first-batch-agent-governance.md) | 飞书创建请求、治理 Agent、Paperclip 审核、受限测试实例与上线门禁 | 本机闭环完成：草案、审核、受限测试、真实飞书上线、复杂协作及六名治理员工独立化均已验证 |
| [M3 内容分析与知识归档](./prd-m3-content-analysis-and-knowledge-archive.md) | 小D证据链、小拆正式拆解、小创平台草稿和小办统一知识归档 | 已验收：两个新增岗位、真实内容链路、知识归档和负责人内容质量确认均已完成 |
| [M4 岗位自主执行与能力深化](./prd-m4-autonomous-agent-capabilities.md) | 11 个活动岗位的开放任务、岗位能力和统一模型回退 | 已完成并由 M5 纠偏：开放任务保留，无状态复用岗位执行器；本地 DAG、预算和 CapabilityGrant Store 已退出生产 |
| [M5 高权限内容自治](./prd-m5-high-autonomy-content-operations.md) | Paperclip 内容流水线、StepFun/媒体工具、确定性发布、指标与受控学习闭环 | 源码16/18/6，r3已冻结且双smoke通过但未激活；live仍15/17/5。本轮无真实Provider调用或发布 |
| [小办演示文稿能力](./prd-office-presentation-capability.md) | `office.presentation-package`、PPTD 自包含交付和受控 PPTX 外部导出 | 首版代码与离线/降级验证完成；PPTD `ready`，PPTX 因兼容依赖为 `needs_capability`，尚无 Kimi 外部 E2E |

M2 已用小红书完成“从零登录 → 命名连接 → 真实读取 → 飞书交付 → 撤销 → 获取前拒绝 → 重新授权 → 再次交付”的登录型平台闭环。A君现已提供白名单平台登录、刷新账号、续期、暂时禁用和撤销入口，真实连接完成禁用与同 ID 续期恢复。当前单用户、本机回环阶段由负责人接受来源链接敏感参数的已知风险，该项不阻塞 M2；CookieBridge 仍只是 A君内部连接器，不是万能登录器。

## 使用规则

- 新里程碑开始前，必须在总 PRD 中有位置，并拥有独立子 PRD。
- 小而明确的修复或文案改动可以直接实施，不要求新建 PRD。
- 子 PRD 不能静默改变总 PRD 的目标；如需改变，先更新总 PRD并记录原因。
- 代码完成不等于需求完成；真实验收和相关文档同步后才能标记“已验收”。
- 被替代的 PRD 移入 `docs/archive/`，并在旧文件顶部写明替代文件。
