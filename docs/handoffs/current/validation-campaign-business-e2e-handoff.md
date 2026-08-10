# 历史能力验证批次业务 E2E 交接

| 字段 | 内容 |
| --- | --- |
| 状态 | 自动化闭环完成 / 待可选人工质量验收 |
| 创建时间 | 2026-08-10（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | A君 / 负责人 |
| 关联任务 | [Business Workflow 与能力治理验收记录](../../reviews/workflow-capability-validation-2026-08-10.md) |
| 截止条件 | 自动化已完成；如负责人需要最终采用结论，抽查成功报告并登记 `accepted` 或 `revision_required` |

## 1. 接手目标

- 目标：保留历史验证批次已经在 live 自动化闭环的证据，并明确最后仅剩人工内容质量边界，不改写历史终态。
- 用户约束与不可做事项：不自动发布、不恢复 M5 Campaign、不启动 Publisher、不绕过预算 Policy、不无限重试。
- 做完的定义：已满足——live release 与源码同 HEAD，真实小拆成功，`validationCampaign=0/0`，review/verification/unresolved 均为 0。
- 唯一可选人类动作：负责人抽查 `#B5403CD9` 的精华提炼是否忠于原视频并可直接采用，然后登记 `accepted` 或 `revision_required`。若当前不需要形成采用结论，则没有新的技术、部署或自动复验动作。
- 允许关闭的前提：人工结论已写入任务账本，或负责人明确接受“未做人工内容质量验收”为保留边界。本交接仍留在 `current/`，因为尚无人工采用记录；未越过允许编辑的文件范围移动或归档。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 当前 live 运行时 | clean 不可变 release `80c6a818…` / payload `7dd3863d…` / Git `8cf685a…`，HTTP 200；从干净主线源执行 `runtime:fingerprint` 为 `same_git_head` | release manifest 与 `runtime:fingerprint` | 已验证 |
| live 任务账本 | 802 条任务；owner 1 且只指向 `#B5403CD9` 的可选内容验收，review 0、verification 0、unresolved 0、历史归档 184、后续证据 92；`validationCampaign=0/0` | live `/api/overview` | 已验证 |
| 能力与用量真相 | 所有已验证能力均有时间与证据引用；7 天 Hermes 账本为 task 5、agent session 164、system 0、未知 0 | live `/api/overview.capabilities` 与 `.billing.attribution` | 已验证 |
| 岗位运行面 | Paperclip roster 同步 12 个岗位；小拆与 A君 Hermes Profile 二次 dry-run 均 `changed=false` | roster/Profile 对账 | 已验证 |
| 外部写入 | 任务账本没有报告外部写入，也没有独立外写回执；Paperclip completion sync 是本机任务同步 | 任务账本与 Paperclip 回读 | 不能断言外写为零 |
| 人工确认 | 本地回放不替代小拆结果的忠实度与业务可用性抽查 | `validationCampaign.groups[].humanCheck` | 待确认 |

## 3. 变更与决策

- 已完成：92 条旧任务由严格的后续成功产物、正式委派或已激活岗位证据消债；5 条符合安全拒绝契约的失败按 `expected_boundary_rejection` 归档；live 已无 unresolved 和验证批次。
- 关键文件：`workflow/backlog-classification.ts`、`workflow/validation-campaign.ts`、`task-validation-overview.ts`。
- 边界：模型能力先走岗位 Manifest 与预算 Policy；本机暂时故障只恢复一次、重试一次；仍不可用才提示用户。
- 证据规则：mission 必须有已验证子产物被后续正式交付消费且计划项完整；研究委托必须匹配委托类型及同一来源/主题；恢复链的同源成功必须晚于原失败和恢复任务创建时间。
- 不要重复创建：不得重复运行旧 M5 StepFun 批次，不得重新创建已成功的小D确认稿任务，也不得为了把 `0/0` 再证明一次而新增模型任务。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | 根目录 `npm test`、`npm run check`、`npm run check:architecture`；主线 `8cf685a…` 的严格分类、单次确定性结构修复、Workflow 状态、能力证据和用量归因回归通过 | 模型输出业务质量 |
| 只读本地回放 | PASS | 只读 `#10E4F814` 实际确认稿 + 10 帧 + 1 故事板；13 模块 `deterministic_fallback`，`partial` / `unavailable`；临时目录已清理 | 新业务任务终态、视觉结论 |
| M3 本机纵向 | PASS / NO PROVIDER | 分析、草稿、知识归档纵向链通过，未启用 Provider | Paperclip、飞书、真人听审和内容质量 |
| 首次真实任务 | EXPECTED WAITING TEST | `#716FA2E8` 的任务终态为 `waiting_test`，Workflow 为 `waiting_validation` 且没有 owner action；DeepSeek 1 次，5218/13466 tokens，估算 0.004501 USD；结构未通过；视觉 Provider 未调用 | 没有成功终态 |
| 修复后真实任务 | PASS | `#B5403CD9` 为 `succeeded` / `paperclip_hermes_completed`；结构 `false → 单次 deterministic repair → true`；报告 7077 bytes、摘要 194 字；DeepSeek 1 次，3043/8809 tokens，估算 0.0028986328 USD；视觉 Provider 未调用 | 人工内容质量 |
| live 运行时 | PASS | 当前 manifest 与 `runtime:fingerprint` 显示 clean immutable release、HTTP 200、`same_git_head`；release `80c6a818…` / payload `7dd3863d…` / Git `8cf685a…`；验证批次 0/0 | 无自动化剩余项 |
| 外部平台 | NOT REPORTED | 两条真实任务没有独立外写回执；Paperclip 本机 completion sync 不等于外部发布 | 账本未报告，不能断言外部写入为零 |
| 人工验收 | NOT CHECKED | 自动结构门禁已通过，但尚无 `accepted` / `revision_required` | 精华提炼和内容判断是否忠于原视频、可被采用 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：没有技术或自动化阻塞；唯一未关闭证据层是人工内容质量。机器结构通过不能升级为人工采用结论。
- 不得复制或展示的信息：Provider Secret、飞书凭据、Cookie、原始私有素材路径。
- 需要谁确认：仅负责人决定是否进行人工质量抽查；不再需要部署负责人或新的模型费用授权。
- 关闭条件：负责人登记 `accepted` / `revision_required`，或明确接受人工质量未验收这一边界；自动化闭环无需重复执行。
- 关闭证据链接：[Business Workflow 与能力治理验收记录](../../reviews/workflow-capability-validation-2026-08-10.md)。
