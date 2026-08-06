# ADR-0009：M5 内容自治执行内核与 Publisher Gateway

| 字段 | 内容 |
| --- | --- |
| 状态 | 已确认 |
| 日期 | 2026-07-30 |
| 决策人 | A君 |

## 决策

1. Paperclip 继续是唯一组织控制面；Hermes 继续提供 Profile、Session、Skill、MCP、Cron、Project 与 checkpoint。
2. 不在 A君运行时新增文件状态机或技能注册表。内容阶段用 Paperclip Pipeline/Case，日程与唤醒用 Routine/Issue，预算、审批、审计、并发和恢复使用 Paperclip 原生能力。
3. 业务缺口以 `@agent-army/paperclip-content-autonomy` 插件实现：StepFun 多模态、受控 FFmpeg、CampaignGrant/ContentVersion/PublishReceipt 领域校验与发布连接器。插件状态只保存业务幂等和平台凭证，不保存任务真相。
4. 内容模型不持有发布工具。小创只产生经过审核的 ContentVersion，确定性 Publisher Gateway 才能消费 CampaignGrant 执行发布。
5. 岗位工具权限使用 Paperclip agent tool grants 和独立 Hermes Profile 的工具/MCP开关；技能来源、版本与更新使用 Paperclip/Hermes 的现成 skills audit，不维护第二份注册表。
6. 抖音优先官方 API；官方能力不可用时才能在明确授权下使用隔离 Computer Use。小红书首版使用隔离 Computer Use，不使用逆向 API 或 Cookie 导出。
7. 本 ADR 最初采用 StepFun 文本主模型；该部分已由 [ADR-0011](./0011-deepseek-primary-reasoning-model.md) 取代。11 个正式岗位现使用 `deepseek/deepseek-v4-flash` 且无 StepFun 文本回退；M5 StepFun 多模态工具仍是独立媒体能力。
8. 目标源码使用 5 个职责隔离的无模型 HTTP 控制器：daily 只激活当天 Case，
   parallel 只核验并行分支和 blocker 汇聚门禁，publisher 只消费可信授权和内容产物并写回 `PublishReceipt` Work Product，
   metrics 只从该凭证派生 2h/24h/72h 检查点并写回 `MetricSnapshot`，
   retrospective 只写版本化复盘 Work Product。指标唤醒复用 Paperclip Issue
   `executionPolicy.monitor`，不增加指标 Cron、`metricSchedules` 或进程内定时器。
9. retrospective 少于 5 条同类型真实 72h 指标时只写 `insufficient_sample`；
   达到 5 条才允许附带状态为 `proposed` 的 `LearningProposal`。提案必须经过
   离线回放、审核与单条灰度，不能直接修改生产 Prompt、权限、发布频率或投流。
10. 小红书静态卡不新增 Pipeline 阶段或第二套内容控制面。它由现有 `render` 阶段从
    baseline 脚本、可信图片账本、版权依据和已批准生产模板绑定派生，固定渲染
    1080×1440 PNG，并以 `SocialCardPackage` 嵌入 `RenderPackage`。该工具不联网、
    不调用付费 Provider、不持有发布能力；审批、启用和发布仍由既有独立门禁控制。

## 原因

- 当前 M4 开放任务仍把复杂目标委派给一个固定执行器，DAG 没有逐步 Observation；
- 直接把浏览器或发布能力给内容模型，会把创作判断和外部副作用混在一起；
- 复用 Hermes 与 Paperclip 可以获得持久会话、技能、检查点、调度和治理，而不复制控制面；
- 发布是高风险外部写入，需要确定性策略、幂等、活动级授权和停止开关。

## 后果

- 删除原拟议的独立内容活动持久化文件与技能注册表；
- 新增 Paperclip 业务插件，但按“源码审计→官方测试宿主→负责人批准→安装激活”推进；
- 新增真实连接器前必须通过模拟连接器契约；
- Computer Use、付费多模态和真实发布仍需逐层授权与验证；
- 首个纵向切片可以在没有平台凭据的情况下完整证明状态机和安全门禁。

## 已核对的现成能力

调研结论与选择依据见 [M5 工具与执行框架复用调研](../research/m5-tooling-reuse-survey.md)。

## 当前落地边界

截至 2026-07-30，目标源码已声明 15 个 Pipeline 阶段、17 个 Routine 和 daily、
parallel、publisher、metrics、retrospective 5 个 HTTP 控制器；其中 publish、metrics、
retrospective 分别通过专用 Work Product 保存 `PublishReceipt`、`MetricSnapshot`
和版本化复盘/待审核 `LearningProposal`。Pipeline 本地测试为 `21/21`，复盘相关
聚焦回归为 `34/34`，这些证据只证明本地契约。

当前 live 已应用为 17 个 Routine、15 个 Pipeline 阶段和 5 个 HTTP 控制器；
活动仍为未批准草案 `0/14`。Screen Recording 当前为 `true`，但真实 selector、
命名 Profile lease、平台账号写授权和真实 connector 仍未配置或批准。Publisher
production composition 与 A君延迟授权源码已经接线，但 live 未注入 production
access 或真实 connector dependencies，不能据此宣称生产 Runtime 已启用。
因此只能宣称控制器和生产构造代码已经接线，不能宣称 publisher/retrospective 已处理
真实 Case，更不能把本地 Fake Connector、代码测试或 Work Product 契约写成真实
PublishReceipt、真实指标、学习效果或双平台发布成功。
