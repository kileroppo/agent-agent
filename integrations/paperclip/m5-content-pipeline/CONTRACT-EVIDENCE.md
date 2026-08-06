# Paperclip 2026.722.0 契约核验

核验对象是本机实际运行的 `@paperclipai/server@2026.722.0`、
`@paperclipai/shared@2026.722.0` 和同版本 CLI。契约发现阶段只执行 GET、读取已安装
包源码及内存 Fake Adapter；之后经负责人授权，声明已幂等写入本机
`127.0.0.1:3100`，真实活动仍保持未批准。

## 真实接口

| 资源 | 请求 | 本模块行为 |
| --- | --- | --- |
| Goal | `GET/POST /api/companies/:companyId/goals` | 使用官方 `createGoalSchema` |
| Project | `GET/POST /api/companies/:companyId/projects` | 使用官方 `createProjectSchema` |
| Routine | `GET/POST /api/companies/:companyId/routines` | 使用官方 `createRoutineSchema` |
| Trigger | `GET /api/routines/:id`、`POST /api/routines/:id/triggers` | 解包 `{ trigger, revision }` |
| Pipeline | `GET/POST /api/companies/:companyId/pipelines` | Pipeline创建响应直接含 `stages` |
| Transition | `PUT /api/pipelines/:id/transitions` | 发送 `fromStageKey/toStageKey` |
| Case | `POST /api/pipelines/:id/cases` | 解包 `{ case, created }` |
| Case Batch | `POST /api/pipelines/:id/cases/batch` | 按返回顺序解包每项 `{ ok, case, created }` |
| Case Blockers | `PUT /api/cases/:id/blockers` | 用真实 Case ID 声明并行分支汇聚依赖 |
| Review | `POST /api/cases/:id/review` | `approve/reject/request_changes` + `expectedVersion` |
| Budget | `POST /api/companies/:companyId/budgets/policies` | 使用官方 `upsertBudgetPolicySchema` |

Pipeline尚未出现在本机生成的 OpenAPI 中，因此它的字段证据来自同版本
`@paperclipai/server/dist/routes/pipelines.js`、`services/pipelines.js` 和
`paperclipai pipelines --help`，不能拿 OpenAPI 缺失误判为功能不存在。

## 核验后修正

1. Paperclip创建Pipeline时强制至少一个 `done` 和一个 `cancelled` 阶段。
   旧版 live 声明2个活动控制阶段、14个可执行内容阶段、独立 `done` 和
   `cancelled` 终态，合计18阶段；复盘不再冒充 `done`。
2. Transition替换接口接收阶段key，不接收阶段UUID；HTTP Adapter已改为原样发送
   `fromStageKey/toStageKey`。
3. Trigger创建响应是 `{ trigger, revision }`，Case ingest响应是
   `{ case, created }`；Adapter现在统一返回内部资源，父子Case不会拿到空ID。
4. Goal、Project、Routine、Trigger、Stage Config和Budget均使用同版本官方
   `@paperclipai/shared` schema校验。
5. 系统 Agent 的普通字段与权限必须分端点对账：`PATCH /agents/:id` 不接受
   `permissions`，权限使用 `/agents/:id/permissions`；适配器已按结构而非 JSON
   键顺序比较。
6. 目标源码使用 daily、parallel、publisher、metrics、retrospective 五个无模型 HTTP
   控制器。publisher、metrics、retrospective 分别写回 `PublishReceipt`、
   `MetricSnapshot` 和版本化 Retrospective Work Product；复盘达到5条同类型真实
   72h指标后也只附带待审核 `LearningProposal`。
7. 2h/24h/72h 复用 Issue `executionPolicy.monitor`，不创建第二个 Cron。
8. 当前 live v2 已对账为 17 个 Routine、15 个 Pipeline 阶段和 5 个无模型 HTTP
   控制器；新活动仍为未批准草案 `0/14`，每日 Cron 关闭。该结果只证明控制面结构
   已部署，不证明任何内容阶段已执行或平台发布已经发生。
9. 原实现没有研究证据、素材、画面分析、生图、配音五个子 Case；
   `maxConcurrency: 4` 只在
   自定义 `m5Policy` 中出现。2026.722 Case ingest 原生接受 `parentCaseId`、
   `requestKey`、`blockedByCaseIds/blockedByCaseKeys`，并提供 Batch ingest 和
   blockers 替换接口，因此本模块现已增加固定五分支和显式汇聚 Case 契约。
10. Paperclip 2026.722 的 Pipeline/Case schema 与 service 没有
    `maxConcurrency` 数字信号量；Routine 的 `concurrencyPolicy` 只有
    `coalesce_if_active`、`always_enqueue`、`skip_if_active`，语义不是跨 Routine、
    跨日期的“全局最多4”。apps 侧现通过遍历 Pipeline 并行分支的 Case Issue links
    和真实 Issue 状态计数，达到4即拒绝新 Routine run。
11. 目标拓扑是15阶段、17 Routine、5个无模型控制器。日期主线不再线性重复
    research/assets/voice；研究分支以 `m5-evidence` 直接生成可核验
    `EvidencePackage`，生图为 `m5-image-generation` 专属 Routine。五分支先以
    `draft` 创建，协调器通过 Routine run 派发并把 Issue 同时链接分支与日期 Case；
    只有终态 Issue 与健康 Work Product 同时成立才完成分支和汇聚。
12. 专用 clone cutover 已应用到 live；v1 Pipeline、22个 Case、Issue 和 Work Product
    原样保留，v2 新建15阶段、17 Routine、5控制器和未批准草案。没有唤醒岗位。
13. v2 迁移新增只读审计入口：读取旧 Pipeline/Case/Routine/Cron，完整解压并核验
    显式 `.sql.gz` 备份，输出精确确认串和回滚步骤。Paperclip 2026.722 缺少
    Campaign/每日入口的原子 Pipeline 引用切换接口，因此 `applySupported=false`，
    没有提供迁移写命令。
14. 专用 clone cutover 不依赖原子引用切换：v1 资源只读保留，v2 Routine identity
    使用 deployment namespace；活动服务用显式 activePipelineId、Case pipelineId
    和 Project 范围 Routine 校验。Fake 验证重复执行只创建同一个 v2 草案；
    旧草案进入 superseded/cancelled 且不可恢复，回滚只取消未批准的 v2 草案。
    live apply 已执行；A君显式绑定 v2 ID/key，新旧每日 Cron 均保持关闭。

## 可重复验证

```bash
npm test
npm run test:fake-e2e
npm run acceptance:fake-e2e
npm run validate
npm run dry-run
```

2026-07-31 当前本机重跑 `npm test` 为 `66/66`（61个顶层测试），覆盖全部声明、
Transition字段、Trigger/Case响应解包、五分支 caseKey/父子树/blockers/幂等、
loopback限制、回滚和恢复边界，以及新增的 Fake 全链纵切。

`npm run test:fake-e2e` 为 `5/5`：其中1条纵切从活动草案、选题、并行汇聚、脚本、
渲染、退回修订、审核、Fake发布一路走到2h/24h/72h指标、复盘和done；另4条直接
执行真实 `M5ParallelWorkCoordinator`，验证研究/素材/生图首波派发、画面分析和
配音前置依赖、全局活动Issue达到4时停止新派发，以及五分支终态且健康Work Product
齐全才解除汇聚。

`npm run acceptance:fake-e2e` 的结构化 ledger 实测为：

- 父活动、7个日期、14个平台共22个 Case，重复创建复用相同 `caseKey`；
- 成功路径覆盖15阶段声明中的全部非取消阶段，所有迁移边均来自正式 Bootstrap plan；
- 五分支实测并发峰值4，波次为`[4,1]`；
- `request_changes` 精确退回脚本1次；
- render安全重试1次，模拟重启后复用已核验Work Product且数量未增加；
- 预算硬停1次，Connector调用为0，CampaignGrant暂停且Cron关闭；未恢复Grant前仍拒绝；
- 受控恢复后Fake发布Connector只调用1次，controller和gateway重放返回同一Receipt；
- 指标Connector只调用3次并分别写回2h、24h、72h，重复采集为0；
- `externalEffects=false`、`paidCalls=0`，ledger敏感字段、凭据值和绝对路径审计通过。

`dry-run` 现在精确创建17个 Routine和5个无模型控制器，且
`writesToLivePaperclip=false`。本轮同时删除了没有任何分支引用的空
`m5-research` Routine；研究事实与逐claim来源核验统一由`m5-evidence`分支落
`EvidencePackage`，避免干跑18条与正式15/17/5拓扑长期漂移。

这些证据只证明本地内存Paperclip、Fake岗位、真实无模型协调器/恢复/发布控制器和
Fake平台契约；不证明live Paperclip已加载新声明、Hermes岗位真实执行、StepFun付费
调用或抖音/小红书真实发布与72小时自然等待。`dry-run`只写内存；live apply 的独立
证据见M5验收，Cron仍为禁用状态。
