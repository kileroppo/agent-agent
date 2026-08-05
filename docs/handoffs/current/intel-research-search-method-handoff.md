# 小R多路线搜索与证据方法交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 待验收 |
| 创建时间 | 2026-08-04（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | A君运行时维护者 / 负责人 |
| 关联任务 | [M2 第一批 Agent PRD](../../../tasks/prd-m2-first-batch-agent-governance.md)、[核心契约](../../contracts/core-contracts.md) |
| 截止条件 | 新不可变 A君 release 加载候选执行器，并由一条真实小R公开研究任务回读六路计划、五条来源预算和主张级证据账本 |

## 1. 接手目标

- 目标：把小R从单次关键词搜索升级为中性、一手、人物、实践、利益审查和反向验证六路发现，在最多五条精读来源内交付可审计证据。
- 用户约束与不可做事项：搜索排名、互动量、头衔和“真相/内幕/黑幕”等措辞不能作为真实性信号；不得扩大登录态、付费、发布或外部写入权限。
- 做完的定义：共享 Yichen 技能、Hermes `intel-researcher` Profile、A君执行器和真实小R任务使用同一方法；报告区分搜索覆盖、原文证据、来源独立性、利益冲突未知和反证未知。
- 唯一下一步：从只包含本交接相关变更的独立干净 Git worktree 冻结并切换 A君不可变 release，随后运行一条无登录、无付费的真实公开研究任务并回读产物。
- 允许继续的前提：不得把当前工作树的本地 AI、UI、微信或其他未提交变更带进该 release；Publisher、Cron 和外部写入保持关闭；切换前保留当前 `0a49f0dc…` release 回滚路径。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | `LocalIntelResearcher` 已实现六路并行发现、URL 去重、证据价值优先的五来源选择、路线覆盖和主张级账本；核心契约已补充 `agent.army/research-method/v1` | `apps/ajun-runtime/src/local-intel-researcher.js`、`apps/ajun-runtime/test/local-intel-researcher.test.js`、`docs/contracts/core-contracts.md` | 已验证 |
| 共享技能 | `yichen-unified-search` 新增离线查询规划器、方法说明、候选路线与证据账本约定；`yichen-web-research` 已声明宽泛研究目标进入六路规划 | `/Users/pengaro/Documents/work/AIcode/skills-lib/yichen-unified-search/`、`/Users/pengaro/Documents/work/AIcode/skills-lib/yichen-web-research/SKILL.md` | 已验证 |
| 本地运行时 | `intel-researcher` Profile 已经审计同步 6 个声明技能；PID `59658` 仍运行，Profile 内规划器真实输出六路计划。A君 PID `6388` 仍来自不可变 release `0a49f0dc…`，尚未加载本次执行器源码 | `~/.hermes/profiles/intel-researcher/skills/`、`~/Library/LaunchAgents/ai.agent-army.ajun-runtime.plist` | 部分验证 |
| 外部平台 | 没有调用真实搜索站、DeepSeek、飞书或其他外部 Provider；没有发布、付费或账号读取 | 本交接验证账本 | 未验证 |
| 人工确认 | 方法方向已由负责人确认并授权落地；尚未人工检查一份真实研究报告 | 当前任务 | 待确认 |

## 3. 变更与决策

- 已完成：六路查询规划；搜索结果按 `primary → practice → investigative → counterevidence → baseline → expert` 选择；最多精读五条；候选保留命中路线；报告记录来源评估、单/多来源片段、独立性未知和反证状态。
- 关键文件或外部配置位置：`apps/ajun-runtime/src/local-intel-researcher.js`、`apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs`、共享技能库与小R Hermes Profile。
- 已确定的边界与兼容性约束：六路搜索是发现覆盖，不是六条事实证据；多个域名最多写 `multiple_domains_not_proven_independent`；利益冲突默认 `not_established`；执行反向搜索但未发现反证写 `not_identified_at_claim_level`。
- 不要重复创建的产物：不要另建搜索控制台、独立搜索数据库或第二套候选 schema；复用现有 Yichen、`PublicWebSearch`、`candidate-schema` 和 Artifact 契约。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | Yichen `unittest` 39 项；小R/顾问定向 Node 11 项；Hermes 配置器 21 项；`npm test --workspace=ajun-runtime` 退出码 0 | 未做真实互联网结果质量对比 |
| 运行时 | PARTIAL | `configure-governance-hermes-runtime.mjs --skills-only intel-researcher` 成功；Profile 规划器真实输出六路；Gateway PID `59658` 在运行 | A君不可变 release 仍是旧执行器 |
| 外部平台 | NOT CHECKED | 本轮没有外部请求 | 搜索站可用性、真实结果覆盖和 DeepSeek 综合质量 |
| 人工验收 | PARTIAL | 负责人确认方法并授权实现 | 尚未确认真实报告是否更有用、更客观 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：当前主工作树含大量无关未提交变更，不能直接冻结为正式 A君 release；旧 live 自动任务仍是单次搜索路径。
- 不得复制或展示的信息：任何 `.env`、模型/API 凭据、Cookie、飞书身份、搜索账号授权和私密查询。
- 需要谁确认：负责人只需在新 release 后检查一份真实小R报告；若需登录态平台搜索，必须另行按平台与关键词授权。
- 关闭条件：新不可变 release 的 PID、端口、cwd、release hash 回读通过；真实公开研究产物含 6 条 `queryPlan`、不超过 5 条已读取来源、`sourceAssessments`、`claimLedger`，并明确未知和分歧。
- 关闭证据链接：完成后补充到本交接与相关验收记录。
