# 小R多路线搜索与证据方法交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 专项交接入口已关闭并归档；业务结论仍为 `revision_required`，由产品总交接接管 |
| 创建时间 | 2026-08-04（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | A君运行时维护者 / 负责人 |
| 关联任务 | [M2 第一批 Agent PRD](../../../tasks/prd-m2-first-batch-agent-governance.md)、[核心契约](../../contracts/core-contracts.md) |
| 截止条件 | 最终事实见 [`agent-army-product-maturity-handoff.md`](./agent-army-product-maturity-handoff.md)；本文件只保留历史专项证据 |

## 1. 接手目标

- 目标：把小R从单次关键词搜索升级为中性、一手、人物、实践、利益审查和反向验证六路发现，在最多五条精读来源内交付可审计证据。
- 用户约束与不可做事项：搜索排名、互动量、头衔和“真相/内幕/黑幕”等措辞不能作为真实性信号；不得扩大登录态、付费、发布或外部写入权限。
- 做完的定义：共享 Yichen 技能、Hermes `intel-researcher` Profile、A君执行器和真实小R任务使用同一方法；报告区分搜索覆盖、原文证据、来源独立性、利益冲突未知和反证未知。
- 唯一下一步：无。本专项已被产品总交接替代，不再作为 `current/` 待办。
- 允许继续的前提：负责人明确重开独立产品修复；范围必须一次性包含两条来源读取和三条具体建议，之后只允许一次最终 E2E。Publisher、Cron 和外部写入继续关闭。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码与文档 | `LocalIntelResearcher` 已实现六路并行发现、URL 去重、证据价值优先的五来源选择、路线覆盖和主张级账本；核心契约已补充 `agent.army/research-method/v1` | `apps/ajun-runtime/src/local-intel-researcher.js`、`apps/ajun-runtime/test/local-intel-researcher.test.js`、`docs/contracts/core-contracts.md` | 已验证 |
| 共享技能 | `yichen-unified-search` 新增离线查询规划器、方法说明、候选路线与证据账本约定；`yichen-web-research` 已声明宽泛研究目标进入六路规划 | `/Users/pengaro/Documents/work/AIcode/skills-lib/yichen-unified-search/`、`/Users/pengaro/Documents/work/AIcode/skills-lib/yichen-web-research/SKILL.md` | 已验证 |
| 本地运行时 | 2026-08-12 后续 live 为 PID `39004`、release `01b12068…`、payload `48dc755…`、Git `bbde76f…`；release clean，可见根工作树因其他未提交改动显示 `different_git_head` | release manifest、PID/cwd、单一 4321 listener、HTTP 200 | 交付门禁继续保留；本次运行更新不改变小R暂停结论 |
| 外部平台 | 任务 `2cb79a68…` 真实进入 Paperclip/Hermes，最终 `waiting_test`；只读取 1/2 来源，缺 `process.env`，建议 1/3；7 calls / 估算 0.005862007 USD | 任务、Issue、专用产物与员工回报脱敏回读 | 门禁行为通过，业务交付失败 |
| 人工确认 | 用户要求停止反复修复/部署/重试，以实际工作流为准；仍未授权新成熟度批次 | 当前任务 | 已确认暂停 |

## 3. 变更与决策

- 已完成：六路查询规划；搜索结果按 `primary → practice → investigative → counterevidence → baseline → expert` 选择；最多精读五条；候选保留命中路线；报告记录来源评估、单/多来源片段、独立性未知和反证状态。
- 关键文件或外部配置位置：`apps/ajun-runtime/src/local-intel-researcher.js`、`apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs`、共享技能库与小R Hermes Profile。
- 已确定的边界与兼容性约束：六路搜索是发现覆盖，不是六条事实证据；多个域名最多写 `multiple_domains_not_proven_independent`；利益冲突默认 `not_established`；执行反向搜索但未发现反证写 `not_identified_at_claim_level`。
- 不要重复创建的产物：不要另建搜索控制台、独立搜索数据库或第二套候选 schema；复用现有 Yichen、`PublicWebSearch`、`candidate-schema` 和 Artifact 契约。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | `e10b783…` 新增 `local-intel-research-delivery.ts`，按显式证据词抽取后段片段，缺合同/证据/交付数均 fail closed，Paperclip 文字回报不能覆盖；定向 50/50 + 集成 1/1、全量 `npm test`、`npm run check`、architecture、TS 47/208、diff-check 通过 | 不替代新门禁版 live E2E |
| 运行时 | PASS | 当前 release `530d86bf…`、PID `94582`、cwd、HTTP 200、source/live same_git_head 已回读 | 不替代付费真实业务 E2E |
| 外部平台 | FAIL CLOSED（门禁 PASS） | 任务 `2cb79a68-c09b-40d4-8458-68b68a2e6467` 为 `waiting_test`；缺 `process.env`、建议 1/3、来源 1/2；7 calls / 估算 0.005862007 USD | 小R业务能力未通过；GitHub、动态网页与 PDF 仍未验证 |
| 人工验收 | PARTIAL | 执行范围已获负责人授权，报告可读性未要求即时确认 | 后续按需抽查业务价值，不阻塞主链路 |

## 5. 历史风险与业务门禁

- 当前阻塞或风险：门禁已有效，但真实业务能力仍缺第二条来源读取与三条具体建议。继续逐层修复会再次进入验收循环，因此当前主动暂停。GitHub、动态网页和 PDF 仍不能写成外部已验证。
- 不得复制或展示的信息：任何 `.env`、模型/API 凭据、Cookie、飞书身份、搜索账号授权和私密查询。
- 需要谁确认：默认无需确认或动作。只有负责人明确重开独立产品修复时，才重新声明范围、费用和一次最终 E2E。
- 历史业务通过条件（未达成）：新不可变 release 的 PID、端口、cwd、release hash 回读通过；真实公开研究产物显式记录 `researchDeliveryGate.accepted=true`，所有必需证据词都有原文片段，建议数达到事前合同，且 Paperclip 终态不能仅由文字回报放行。后续是否重开只看产品总交接。
- 关闭证据链接：门禁版真实失败任务 `2cb79a68-c09b-40d4-8458-68b68a2e6467`；已部署门禁提交 `e10b7835bd8b37cddb99fd5aa1dc8a5f6dc7b87c`；live release `530d86bf6058d589c5ce8012dacdde76cf51f80d1e79b836fc28b7c7d7dc7d29`。
