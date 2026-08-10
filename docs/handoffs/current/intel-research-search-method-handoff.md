# 小R多路线搜索与证据方法交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 核心链路已验收；GitHub真实通道待恢复 |
| 创建时间 | 2026-08-04（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | A君运行时维护者 / 负责人 |
| 关联任务 | [M2 第一批 Agent PRD](../../../tasks/prd-m2-first-batch-agent-governance.md)、[核心契约](../../contracts/core-contracts.md) |
| 截止条件 | 新不可变 A君 release 加载候选执行器，并由一条真实小R公开研究任务回读六路计划、五条来源预算和主张级证据账本 |

## 1. 接手目标

- 目标：把小R从单次关键词搜索升级为中性、一手、人物、实践、利益审查和反向验证六路发现，在最多五条精读来源内交付可审计证据。
- 用户约束与不可做事项：搜索排名、互动量、头衔和“真相/内幕/黑幕”等措辞不能作为真实性信号；不得扩大登录态、付费、发布或外部写入权限。
- 做完的定义：共享 Yichen 技能、Hermes `intel-researcher` Profile、A君执行器和真实小R任务使用同一方法；报告区分搜索覆盖、原文证据、来源独立性、利益冲突未知和反证未知。
- 唯一下一步：如需关闭全部来源通道，只诊断并复验当前 `github_unavailable` 的 GitHub 只读适配器；静态公开网页研究主链路无需重复执行。
- 允许继续的前提：不得把当前工作树的本地 AI、UI、微信或其他未提交变更带进该 release；Publisher、Cron 和外部写入保持关闭；切换前保留当前 `0a49f0dc…` release 回滚路径。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | `LocalIntelResearcher` 已实现六路并行发现、URL 去重、证据价值优先的五来源选择、路线覆盖和主张级账本；核心契约已补充 `agent.army/research-method/v1` | `apps/ajun-runtime/src/local-intel-researcher.js`、`apps/ajun-runtime/test/local-intel-researcher.test.js`、`docs/contracts/core-contracts.md` | 已验证 |
| 共享技能 | `yichen-unified-search` 新增离线查询规划器、方法说明、候选路线与证据账本约定；`yichen-web-research` 已声明宽泛研究目标进入六路规划 | `/Users/pengaro/Documents/work/AIcode/skills-lib/yichen-unified-search/`、`/Users/pengaro/Documents/work/AIcode/skills-lib/yichen-web-research/SKILL.md` | 已验证 |
| 本地运行时 | 最终不可变 release `2f8309d7…`、payload `da95f8fd…`、PID `82330` 运行于 `4321`；11 个 Hermes Profile 0 drift，完整冻结验证通过 | release manifest、PID/cwd、HTTP 200、Profile dry-run | 已验证 |
| 外部平台 | 真实公开研究任务 `c107107f…` 成功，Paperclip `AGE-1125` 与 run `7e63fffe…` 均完成；报告使用两条 Node.js 官方公开资料，包含来源时间、哈希、主张绑定和限制说明。GitHub 只读适配器在另一次真实探针中返回 `github_unavailable` | 任务、Issue、run 与 Work Product 脱敏回读 | 静态公开网页已验证；GitHub未通过，动态网页/PDF未做本轮外部E2E |
| 人工确认 | 负责人授权在其休息期间自主选择无登录、无付费的公开研究题完成验收 | 当前任务 | 已确认执行范围；报告质量仍可后续抽查 |

## 3. 变更与决策

- 已完成：六路查询规划；搜索结果按 `primary → practice → investigative → counterevidence → baseline → expert` 选择；最多精读五条；候选保留命中路线；报告记录来源评估、单/多来源片段、独立性未知和反证状态。
- 关键文件或外部配置位置：`apps/ajun-runtime/src/local-intel-researcher.js`、`apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs`、共享技能库与小R Hermes Profile。
- 已确定的边界与兼容性约束：六路搜索是发现覆盖，不是六条事实证据；多个域名最多写 `multiple_domains_not_proven_independent`；利益冲突默认 `not_established`；执行反向搜索但未发现反证写 `not_identified_at_claim_level`。
- 不要重复创建的产物：不要另建搜索控制台、独立搜索数据库或第二套候选 schema；复用现有 Yichen、`PublicWebSearch`、`candidate-schema` 和 Artifact 契约。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 小R/顾问、开放任务、Work Product schema、哈希与规范化 checksum 定向测试通过；最终不可变冻结全套验证通过 | 无 |
| 运行时 | PASS | release `2f8309d7…`、PID `82330`、cwd、HTTP 200 与 11 Profile 0 drift 均已回读 | 无 |
| 外部平台 | PARTIAL PASS | 真实任务 `c107107f-ea23-4db6-b887-8cf07a22767a` 成功；ResearchReport `ec342370-add3-4b98-b798-8eeb2bc32590` 为 healthy，`sourceCount=2`、`minimumSourcesMet=true`、`claimEvidenceBound=true`、`currentRun=true` | GitHub 通道真实失败；动态网页与 PDF 未做外部 E2E |
| 人工验收 | PARTIAL | 执行范围已获负责人授权，报告可读性未要求即时确认 | 后续按需抽查业务价值，不阻塞主链路 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：主链路已在干净构建副本冻结并切入活动 release；GitHub 只读适配器当前不可用，动态网页和 PDF 只完成代码/测试证据，不能写成外部已验证。
- 不得复制或展示的信息：任何 `.env`、模型/API 凭据、Cookie、飞书身份、搜索账号授权和私密查询。
- 需要谁确认：主链路无需再确认；若需要 GitHub、登录态平台或付费搜索，必须另行按平台与关键词授权。
- 关闭条件：新不可变 release 的 PID、端口、cwd、release hash 回读通过；真实公开研究产物含 6 条 `queryPlan`、不超过 5 条已读取来源、`sourceAssessments`、`claimLedger`，并明确未知和分歧。
- 关闭证据链接：任务 `c107107f-ea23-4db6-b887-8cf07a22767a`、Paperclip `AGE-1125`、run `7e63fffe-3141-4d54-9415-4bf1fe55222c`、ResearchReport `ec342370-add3-4b98-b798-8eeb2bc32590`。
