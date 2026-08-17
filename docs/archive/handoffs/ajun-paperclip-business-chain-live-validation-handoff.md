# A君 / Paperclip 三岗位真实业务链复验交接

> 2026-08-17 归档：原交接已关闭；最终事实见[产品成熟度总交接](./agent-army-product-maturity-handoff.md)。

| 字段 | 内容 |
| --- | --- |
| 状态 | 已归档；原交接已关闭 |
| 创建时间 | 2026-08-17（Asia/Shanghai） |
| 交出者 | Codex |
| 接手者 | Codex / 负责人 |
| 关联任务 | 最终 A君任务 `8367d0f0-643b-456a-9ca3-1d52faea6828`；Paperclip 父任务 `AGE-1645` |
| 截止条件 | 新任务真实完成小D取证、小拆正式拆解、小办本地汇报，且父子任务、Paperclip Issue、运行记录和本地产物一致收口 |

## 1. 接手目标

- 目标：跑通“小D取证 → 小拆正式内容拆解 → 小办老板汇报”的真实业务链，并验证 Paperclip 与 A君控制台能区分进程退出和业务闭环。
- 用户约束与不可做事项：可以充分使用 AI 额度；本轮只做本地交付，不发送飞书消息、不公开发布、不读取或回显凭据；保留现有脏工作区和 Paperclip 中文化改动。
- 做完的定义：父任务和三个子任务按依赖顺序进入真实终态；每个成功岗位有通过任务门禁的可读产物；Paperclip 父子 Issue 与 A君状态一致；控制台能显示关联 Paperclip run 且不把 process `succeeded` 冒充业务成功。
- 唯一下一步：没有自动化遗留动作；负责人如要采用本次内容，打开最终小办简报做人类内容抽查即可。
- 允许继续的前提：只有负责人提出新的业务目标或修改意见时才继续；不得为已经成功的链路重复创建任务。

## 2. 当前事实

| 类别 | 事实 | 证据位置 | 状态 |
| --- | --- | --- | --- |
| 代码 | 父任务由 A君确定性规划；Paperclip 负责父子 Issue、岗位运行和审计；员工完成、独立复核、任务记录与产物门禁已经贯通 | `task-execution-coordinator.ts`、`paperclip-hermes-task-reconciler.ts`、`task-record-service.ts` | 已验证并部署 |
| Hermes | 小D、小拆、小办和审核官使用受控 Profile；小办必须原样采用执行工具给出的终态，不能因等待负责人采用而降级岗位成功 | `agents/office-assistant/prompts/system.md`、受管 Profile 配置 | 已验证并应用 |
| 运行记录 | A君任务详情同时返回 Paperclip Issue 链接和 Run ID/状态；控制台“技术与审计信息”显示 Run，并可直接打开对应 Paperclip Issue | `/api/tasks/<taskId>`、`frontend/src/task-record-workbench.ts` | 已验证并部署 |
| 真实业务链 | `AGE-1645` 已完成；小D `AGE-1646`、小拆 `AGE-1647`、小拆复核 `AGE-1648`、小办 `AGE-1650`、小办复核 `AGE-1651` 均为 `done`，关联 Run 均为 `succeeded` | A君任务 `8367d0f0-643b-456a-9ca3-1d52faea6828`、Paperclip 本机 API | 已验证 |
| 当前 live | A君 PID `86207` 运行 immutable release `79da4ec8…`，Git `deadf49f…`，4321=200；Paperclip PID `10376`、3100=200；小D PID `50174`、4318=200 | `node scripts/runtime-fingerprint.mjs` | 已验证 |

## 3. 变更与决策

- 已完成：复现并保留假成功证据；修正父任务执行边界、岗位预算与 Profile；补齐小D来源传递、小拆证据复核、小办本地工作区和终态语义；控制台展示脱敏 Paperclip Run 与可点击 Issue；完成新鲜真实链路复验。
- 关键文件：`apps/ajun-runtime/src/task-execution-coordinator.ts`、`paperclip-task-projector.ts`、`governance-hermes-runtime.ts`、`paperclip-hermes-task-reconciler.ts`、`task-record-service.ts`、`frontend/src/task-record-workbench.ts`、`apps/ajun-runtime/scripts/configure-governance-hermes-runtime.mjs`、`integrations/hermes/scripts/set-feishu-toolsets.py`。
- 已确定边界：A君本机只负责确定性生成总任务依赖计划；Paperclip 负责父子 Issue、岗位唤醒和审计；小D、小拆、小办仍由各自 Hermes Profile 执行业务。
- 不要重复创建：不要重试 `AGE-1585`、`AGE-1639`、`AGE-1644` 等历史失败，它们保留为故障与恢复证据；最终成功账本以 `AGE-1645` 为准。

## 4. 验证账本

| 层级 | 结论 | 命令或证据 | 未证明部分 |
| --- | --- | --- | --- |
| 自动化 | PASS | Agent 客户端 36/36、任务记录与 reconciler 23/23、岗位契约 20/20；`npm run check --workspace=ajun-runtime`；不可变发布助手完整验证通过 | 未重复执行全仓库测试 |
| Profile | PASS | reviewer 漂移已正式同步；小办 Paperclip 终态契约进入 immutable release，Paperclip adapter 指向当前 release Prompt | 无 |
| 运行时 | PASS | A君/Paperclip/小D 三服务 PID、cwd、端口和 HTTP 回读通过；A君 release `79da4ec8…` / Git `deadf49f…` | Publisher 保持关闭，不在本轮范围 |
| 外部平台 | PASS | Paperclip `AGE-1645/1646/1647/1648/1650/1651` 全部 `done`，五个岗位 Run 全部 `succeeded`；A君子任务详情回读相同 Run ID 和成功状态 | 无飞书、公开发布或其他外发 |
| 业务产物 | PASS | 小D确认稿 1653 bytes；小拆报告 17946 bytes、13 模块、语义/结构/视觉门禁通过；小办简报 3938 bytes、2 个上游引用、未决项和下一步齐全 | 不代表负责人已经采用内容 |
| 人工验收 | PARTIAL | 系统链路与产物存在性已由本轮验收；最终简报可直接打开 | 文案观点和是否采用仍由负责人决定 |

## 5. 风险、权限与关闭

- 当前阻塞或风险：无自动化阻塞。工作区仍保留负责人原有的 1 个已修改和 4 个未跟踪 Paperclip 中文化文件，本轮未纳入提交或 release。
- 不得复制或展示的信息：Hermes/Paperclip Provider 凭据、飞书凭据、Cookie、Profile 原始配置内容、私有路径日志。
- 需要谁确认：链路关闭不再需要确认；内容是否采用由负责人按需确认。
- 关闭条件：已满足——新任务父子状态和 Paperclip Issue 一致；三员工和两次复核均成功；真实产物通过门禁；A君控制台显示 Run 和 Issue；新不可变 release 已生效。
- 关闭证据链接：A君任务 `http://127.0.0.1:4321/tasks/8367d0f0-643b-456a-9ca3-1d52faea6828`；Paperclip `http://127.0.0.1:3100/issues/AGE-1645`。
